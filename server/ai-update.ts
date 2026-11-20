/**
 * AI update: after a code change, headless Claude (`claude -p`) checks each feature that the
 * change report marks for review, and proposes changes to its text, scopes and links.
 *
 * The steps for each feature:
 *  1. Collect the facts: the feature data, why it needs a review, the diff of its code and tests,
 *     and the new tests that no feature links yet.
 *  2. Run `claude -p` with a JSON schema, a spend limit, and only the read tools (Read, Grep, Glob).
 *     It reads the plugin code at the new commit. It does not write to the database.
 *  3. Save the answer with `npm run -s map -- apply` (unit kind "update"). The apply rules stay:
 *     new text has the AI draft mark, and text that a person wrote or checked is never changed.
 *     A suggestion for such text goes into the feature's questions.
 *
 * Each run is a row in ai_updates, with its cost (total_cost_usd of the JSON output).
 * The AI step is separate from the sync: the fixed steps never need it.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now } from './db.ts';
import { changeReport, type ChangeReport } from './changes.ts';
import { ITEM_KINDS } from './features.ts';
import { getProject, ROOT, type ProjectConfig } from './projects.ts';
import { childEnv, processAlive, run, syncRunning, type Job } from './sync.ts';

const execFileAsync = promisify(execFile);

export type AuthMode = 'login' | 'bare';

export interface AiUpdateOptions {
  from: string;
  to: string;
  /** A saved change report of from..to (a sync's). Without it, the report is made again. */
  report?: ChangeReport;
  /** Features to check. Default: the features to review in the change report. */
  features?: number[];
  /** Model alias or full name. Default: opus. */
  model?: string;
  /** Spend limit for each feature, in US dollars. */
  budgetUsd?: number;
  /**
   * login: the user's Claude login, with the user's settings and CLAUDE.md files.
   * bare: --bare with ANTHROPIC_API_KEY: the same result on each machine, no personal settings.
   */
  auth?: AuthMode;
  /** false: keep the answer in ai_updates only, and do not save it to the feature. */
  apply?: boolean;
  syncId?: number | null;
  onLine?: (line: string) => void;
}

export const DEFAULTS = { model: 'opus', budgetUsd: 1, auth: 'login' as AuthMode };

export interface AiUpdateRow {
  id: number;
  featureId: number;
  syncId: number | null;
  fromCommit: string;
  toCommit: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'waiting' | 'running' | 'no-change' | 'applied' | 'proposed' | 'failed';
  costUsd: number | null;
  durationMs: number | null;
  summary: string;
  proposal: Proposal | null;
  applyReport: string[] | null;
  error: string | null;
}

const toRow = (r: any): AiUpdateRow => ({
  id: r.id, featureId: r.feature_id, syncId: r.sync_id, fromCommit: r.from_commit, toCommit: r.to_commit, model: r.model,
  startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, costUsd: r.cost_usd, durationMs: r.duration_ms,
  summary: r.summary, proposal: r.proposal ? JSON.parse(r.proposal) : null, applyReport: r.apply_report ? JSON.parse(r.apply_report) : null, error: r.error,
});

export function aiUpdates(projectId: string, limit = 50): AiUpdateRow[] {
  return (db.prepare('SELECT * FROM ai_updates WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as any[]).map(toRow);
}

/**
 * Projects whose AI update this process prepares now, before its rows exist (the change report and
 * the code checkout). After that, the rows with owner_pid show the running update to each process.
 */
const preparing = new Set<string>();
/** The last error of an update that stopped before it wrote rows, for the app. */
const lastError = new Map<string, string>();

const isClaude = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude');
  } catch {
    return false;
  }
};

/**
 * Rows of an update whose process is gone (a server restart, a crash, Ctrl+C) become "failed".
 * Their claude run is stopped (it is detached, so it outlives the server), and the temporary
 * checkouts of the copy are removed when no update of the project runs.
 */
export function markStopped(p: ProjectConfig) {
  const rows = db.prepare("SELECT id, owner_pid, claude_pid FROM ai_updates WHERE project_id = ? AND status IN ('running', 'waiting')").all(p.id) as any[];
  for (const r of rows) {
    if (r.owner_pid === process.pid ? preparing.has(p.id) || live.has(r.id) : processAlive(r.owner_pid)) continue;
    if (r.claude_pid && processAlive(r.claude_pid) && isClaude(r.claude_pid)) {
      try {
        process.kill(-r.claude_pid, 'SIGTERM'); // its process group: setpriv, claude and its children
      } catch {
        /* gone already */
      }
    }
    db.prepare("UPDATE ai_updates SET status = 'failed', finished_at = ?, claude_pid = NULL, error = 'The update stopped before the end (the process that ran it is gone)' WHERE id = ?").run(now(), r.id);
  }
  if (!aiRunning(p.id, false)) removeCheckouts(p);
}

/** Rows that this process runs now. */
const live = new Set<number>();

/** True when a process (server or command line) runs an AI update of the project now. */
export function aiRunning(projectId: string, check = true): boolean {
  if (preparing.has(projectId)) return true;
  if (check) {
    const p = getProject(projectId);
    if (p) markStopped(p);
  }
  const rows = db.prepare("SELECT id, owner_pid FROM ai_updates WHERE project_id = ? AND status IN ('running', 'waiting')").all(projectId) as any[];
  return rows.some((r) => (r.owner_pid === process.pid ? live.has(r.id) : processAlive(r.owner_pid)));
}

/** Temporary checkouts of the copy that an AI update left (git worktree list). */
function removeCheckouts(p: ProjectConfig) {
  let list = '';
  try {
    list = git(p.path, ['worktree', 'list', '--porcelain']);
  } catch {
    return;
  }
  const prefix = path.join(os.tmpdir(), 'tracker-ai-');
  for (const line of list.split('\n')) {
    const dir = line.startsWith('worktree ') ? line.slice(9) : '';
    if (!dir.startsWith(prefix)) continue;
    try {
      git(p.path, ['worktree', 'remove', '--force', dir]);
    } catch {
      /* the prune below removes the entry when the folder is gone */
    }
  }
  try {
    git(p.path, ['worktree', 'prune']);
  } catch {
    /* not important */
  }
}

/** For the app: the recent AI updates, their total cost, if one runs now, and the last start error. */
export function aiUpdateState(projectId: string) {
  const running = aiRunning(projectId);
  const rows = aiUpdates(projectId);
  const total = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM ai_updates WHERE project_id = ?').get(projectId) as any;
  return { running, rows, totalUsd: total.usd as number, count: total.n as number, defaults: DEFAULTS, error: lastError.get(projectId) ?? null };
}

/**
 * Starts an AI update in the background for the features to review of the last sync that
 * saved a change report. It uses that saved report: the same commits and features that the app shows.
 * Throws when an update or a sync runs, or when no sync has features to review.
 */
export function startAiUpdate(p: ProjectConfig, o: { model?: string; budgetUsd?: number }): { syncId: number } {
  if (aiRunning(p.id)) throw new AiUpdateError('An AI update runs already for this project.');
  if (syncRunning(p.id)) throw new AiUpdateError('A sync runs now. Start the AI update when it ends.');
  const s = db.prepare('SELECT id, report FROM syncs WHERE project_id = ? AND report IS NOT NULL ORDER BY id DESC LIMIT 1').get(p.id) as any;
  if (!s) throw new AiUpdateError('No sync has a change report yet. Sync first.');
  const saved = JSON.parse(s.report) as ChangeReport;
  if (!saved.review?.length) throw new AiUpdateError('The last sync has no features to review.');
  lastError.delete(p.id);
  aiUpdate(p, { from: saved.from, to: saved.to, report: saved, syncId: s.id, model: o.model, budgetUsd: o.budgetUsd }).catch((e) => {
    lastError.set(p.id, `The AI update did not start: ${(e as Error).message}`);
    console.error(`AI update of ${p.id} failed:`, e);
  });
  return { syncId: s.id };
}

export class AiUpdateError extends Error {}

// ---- The answer of the model ----

type ItemOut = string | { id: number; text: string };
export interface Proposal {
  /** false: the feature data is still correct. Then all other fields are empty. */
  changed: boolean;
  /** 1–3 plain sentences: what changed in the code, and what the update does to the feature. */
  summary: string;
  title?: string;
  description?: string;
  requirements?: ItemOut[];
  notes?: ItemOut[];
  outOfScope?: ItemOut[];
  where?: ItemOut[];
  questions?: ItemOut[];
  removeItems?: number[];
  scopes?: { id?: string; title: string; group?: string; description?: string; requirements?: ItemOut[] }[];
  links?: { testId: string; scopes?: string[] }[];
}

const item = {
  anyOf: [
    { type: 'string', description: 'New item text' },
    { type: 'object', properties: { id: { type: 'integer' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false, description: 'New text for an AI draft item' },
  ],
};
const items = { type: 'array', items: item };

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changed', 'summary'],
  properties: {
    changed: { type: 'boolean' },
    summary: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    requirements: items,
    notes: items,
    outOfScope: items,
    where: items,
    questions: items,
    removeItems: { type: 'array', items: { type: 'integer' } },
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          id: { type: 'string', description: 'S-id of an existing scope' },
          title: { type: 'string' },
          group: { type: 'string', description: 'Group name of the scope, as in the feature data' },
          description: { type: 'string' },
          requirements: items,
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['testId'],
        properties: { testId: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
};

// ---- Facts for the prompt ----

const MAX_DIFF = 80_000;

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Runs "npm run map" without a wait in the server (map.ts runs its command when it is imported). */
async function mapCommand(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npx', ['tsx', path.join(ROOT, 'server', 'map.ts'), ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    });
    return stdout;
  } catch (e: any) {
    throw new Error(String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' | '));
  }
}

/** The feature as "map feature --all" shows it (the same JSON that the mapping skill reads). */
async function featureJson(p: ProjectConfig, id: number): Promise<any> {
  return JSON.parse(await mapCommand(['feature', p.id, String(id), '--all']));
}

function repoTestPath(p: ProjectConfig, framework: string, file: string) {
  const dir = framework === 'playwright' ? p.playwrightDir : p.cypressDir;
  return dir ? path.posix.join(dir.replace(/\/+$/, ''), file) : file;
}

export async function buildPrompt(p: ProjectConfig, r: ChangeReport, featureId: number): Promise<{ prompt: string; feature: any }> {
  const feature = await featureJson(p, featureId);
  const reasons = r.review.find((x) => x.featureId === featureId)?.reasons ?? ['asked for by a person'];

  // Files of the feature: its code, and the test files of its links.
  const code = (db.prepare('SELECT DISTINCT file FROM feature_code WHERE feature_id = ? AND removed = 0').all(featureId) as any[]).map((x) => x.file as string);
  const testFiles = (
    db.prepare('SELECT DISTINCT t.framework, t.file FROM links l JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id WHERE l.feature_id = ? AND l.removed = 0').all(featureId) as any[]
  ).map((x) => repoTestPath(p, x.framework, x.file));
  // A linked test that the report lists as removed or changed: its file at the old commit.
  const linked = new Set((db.prepare('SELECT test_id FROM links WHERE feature_id = ? AND removed = 0').all(featureId) as any[]).map((x) => x.test_id));
  for (const t of [...r.tests.changed, ...r.tests.removed]) if (linked.has(t.id)) testFiles.push(repoTestPath(p, t.framework, t.file));
  const moved = r.files.filter((f) => f.oldPath && [...code, ...testFiles].includes(f.oldPath)).map((f) => f.path);
  const files = [...new Set([...code, ...testFiles, ...moved])];

  let diff = files.length
    ? (await execFileAsync('git', ['-C', p.path, 'diff', '-M', '--unified=6', r.from, r.to, '--', ...files], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })).stdout
    : '';
  const cut = diff.length > MAX_DIFF;
  if (cut) diff = diff.slice(0, MAX_DIFF);
  const fns = r.functions.filter((f) => files.includes(f.file));
  const gone = r.codeGone.filter((g) => g.featureId === featureId);
  const renames = r.renames.filter((x) => linked.has(x.from.id));
  const unlinked = r.tests.added.filter((t) => t.links === 0).slice(0, 40);

  const prompt = `You update one feature in a feature tracker for the WordPress plugin "${p.name}".
The plugin code changed. Your job: check if the feature data is still correct, and propose changes.

The current folder is the plugin code at the new commit ${r.to.slice(0, 12)}. Read files there when the diff is not enough.
Do not guess. Check each claim in the code.

## Why this feature needs a review
${reasons.map((x) => `- ${x}`).join('\n')}

## The feature now (JSON)
Each list item has an "id" and "aiDraft". aiDraft true: the AI wrote it and no person checked it yet.
"aiFields" lists the fields (title, description) that are still AI draft. Other text was written or checked by a person.
\`\`\`json
${JSON.stringify(feature, null, 2)}
\`\`\`

## Changed PHP functions in the files of this feature
${fns.length ? fns.map((f) => `- ${f.change}: ${f.file} ${f.name}`).join('\n') : '- none'}
${gone.length ? `\n## Code of this feature that is not in the code now\n${gone.map((g) => `- ${g.file} ${g.function ?? '(whole file)'}: ${g.reason}${g.movedTo ? ' -> ' + g.movedTo : ''}`).join('\n')}\n` : ''}${renames.length ? `\n## Linked tests that were likely renamed (a person moves the links in the app)\n${renames.map((x) => `- ${x.from.id} "${x.from.title}" -> ${x.to.id} "${x.to.title}"`).join('\n')}\n` : ''}
## New tests that no feature links yet
${unlinked.length ? unlinked.map((t) => `- ${t.id} (${t.framework}, ${t.file}): ${t.title}`).join('\n') : '- none'}

## Diff ${r.from.slice(0, 12)}..${r.to.slice(0, 12)} of the feature's code and test files${cut ? ` (cut at ${MAX_DIFF} characters: read the files for the rest)` : ''}
\`\`\`diff
${diff || '(no changes in these files)'}
\`\`\`

## How to answer
- If the feature data is still correct, answer {"changed": false, "summary": "<why, in one or two sentences>"} and nothing else.
- Else set "changed": true and send only what you add or change:
  - "title", "description": only when they are AI draft (in aiFields). Else write the problem as a new item in "questions".
  - List fields (requirements, notes, outOfScope, where, questions): a string adds an item. {"id", "text"} changes an AI draft item.
  - "removeItems": IDs of AI draft items that are now wrong. For example, a question that the new code answers: remove it, and put the answer in "notes" or in a scope.
  - Text that a person wrote or checked (aiDraft false) cannot change. When it is now wrong, add a question that says what is wrong and what the code does now.
  - "scopes": a new behavior that a test can check is a new scope (a title, and its own "requirements" if it needs them). To add requirements to an existing scope, give its "id" (for example "S-4") and its title. Give a new scope the "group" of the existing scopes on the same topic, if one fits. A scope that is now wrong cannot be deleted here: add a question for it.
  - "links": only for a test in "New tests that no feature links yet" that really checks this feature. Give the S-ids or the titles of the scopes it checks.
- "summary": 1–3 plain sentences for the person who checks your work: what changed in the code, and what you changed in the feature.

## Writing style
Plain, simple English: short sentences, active voice, common words. Write about behavior that a store owner or tester sees, not about tests.
Put code names (hooks, option keys, classes) only in "where" or "requirements", and only when they help a tester find the thing.
For a setting that turns something off, quote its label and say "checked" or "unchecked". Do not write "on" or "off".
`;
  return { prompt, feature };
}

// ---- Running Claude ----

interface ClaudeResult {
  ok: boolean;
  proposal: Proposal | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
}

/** A detached checkout of commit `to`, when the copy is not at that commit or has changed files. */
function codeDir(p: ProjectConfig, to: string): { dir: string; done: () => void } {
  const head = git(p.path, ['rev-parse', 'HEAD']).trim();
  const clean = git(p.path, ['status', '--porcelain']).trim() === '';
  if (head === to && clean) return { dir: p.path, done: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-ai-'));
  git(p.path, ['worktree', 'add', '--detach', '--quiet', dir, to]);
  return {
    dir,
    done: () => {
      try {
        git(p.path, ['worktree', 'remove', '--force', dir]);
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
        git(p.path, ['worktree', 'prune']);
      }
    },
  };
}

export async function runClaude(
  prompt: string, cwd: string, o: { model: string; budgetUsd: number; auth: AuthMode }, onLine?: (l: string) => void, onStart?: (pid: number | undefined) => void,
): Promise<ClaudeResult> {
  const args = [
    // The prompt goes on standard input: one argument can hold at most 128 KB on Linux.
    '-p',
    '--model', o.model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA),
    '--max-budget-usd', String(o.budgetUsd),
    // Only the read tools exist in the session: no Bash, no Edit or Write, no web.
    '--tools', 'Read,Grep,Glob',
    // No MCP servers, skills or slash commands of the user's setup.
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  const env = childEnv();
  if (o.auth === 'bare') {
    if (!process.env.ANTHROPIC_API_KEY) return { ok: false, proposal: null, costUsd: null, durationMs: null, error: 'Bare mode needs ANTHROPIC_API_KEY in the environment.' };
    args.push('--bare');
  } else {
    // Login mode uses the claude.ai subscription. An API key in the environment would win over
    // the login and bill the key, so the run does not get it.
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];
  }
  const job: Job = { syncId: 0, child: null, cancelled: false, abort: new AbortController() };
  const started = run(job, 'claude', args, { cwd, env, quiet: true, input: prompt });
  onStart?.(job.child?.pid); // run() starts the process at once
  const res = await started;
  // The JSON result is one line (output format json). Other lines (stderr, hooks) can come after it,
  // so each line is read alone, from the last line back.
  const lines = res.out.trim().split('\n');
  let out: any = null;
  for (let i = lines.length - 1; i >= 0 && !out; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && v.type === 'result') out = v;
    } catch {
      /* not the start of the JSON yet */
    }
  }
  if (!out) {
    const tail = res.out.trim().split('\n').slice(-3).join(' | ');
    onLine?.(`claude exit ${res.code ?? res.signal}: ${tail}`);
    return { ok: false, proposal: null, costUsd: null, durationMs: null, error: `claude gave no JSON result (exit ${res.code ?? res.signal}): ${tail}` };
  }
  const costUsd = typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null;
  const durationMs = typeof out.duration_ms === 'number' ? out.duration_ms : null;
  if (out.is_error || out.subtype !== 'success' || !out.structured_output) {
    return { ok: false, proposal: null, costUsd, durationMs, error: `claude stopped: ${out.subtype ?? 'error'}${out.result ? ': ' + String(out.result).slice(0, 300) : ''}` };
  }
  return { ok: true, proposal: out.structured_output as Proposal, costUsd, durationMs, error: null };
}

// ---- From the answer to an apply payload ----

/**
 * Keeps only what "map apply" can save for this feature. A wrong item ID, scope or test would make
 * apply refuse the whole payload (and lose the good part of a paid answer), so they are dropped
 * here and named in the notes.
 */
export function toPayload(p: ProjectConfig, featureId: number, pr: Proposal, ref: string): { payload: any | null; dropped: string[] } {
  const dropped: string[] = [];
  if (!pr.changed) return { payload: null, dropped };
  const itemRows = db.prepare('SELECT id, kind, scope_id FROM feature_items WHERE feature_id = ?').all(featureId) as any[];
  // apply removes items first: a new text for a removed item would then point at nothing.
  const removing = new Set(pr.removeItems ?? []);
  const f: any = { id: featureId };
  if (pr.title?.trim()) f.title = pr.title;
  if (pr.description?.trim()) f.description = pr.description;
  for (const [key, kind] of Object.entries(ITEM_KINDS)) {
    const list = ((pr as any)[key] ?? []) as ItemOut[];
    const ok = list.filter((v) => {
      if (typeof v === 'string') return !!v.trim();
      if (removing.has(v.id)) return void dropped.push(`${key}: item #${v.id} is also in removeItems: it is removed, not changed`), false;
      const good = itemRows.some((x) => x.id === v.id && x.kind === kind && x.scope_id === null);
      if (!good) dropped.push(`${key}: no ${kind} item #${v.id} in F-${featureId}`);
      return good;
    });
    if (ok.length) f[key] = ok;
  }
  const remove = (pr.removeItems ?? []).filter((id) => {
    const good = itemRows.some((x) => x.id === id);
    if (!good) dropped.push(`removeItems: no item #${id} in F-${featureId}`);
    return good;
  });
  if (remove.length) f.removeItems = remove;
  const scopeIds = new Set((db.prepare('SELECT id FROM scopes WHERE feature_id = ?').all(featureId) as any[]).map((x) => x.id));
  const scopes = (pr.scopes ?? []).filter((s) => {
    if (!s.title?.trim()) return false;
    if (s.id === undefined) return true;
    const n = Number(String(s.id).replace(/^S-/i, ''));
    if (!scopeIds.has(n)) {
      dropped.push(`scopes: no scope ${s.id} in F-${featureId}`);
      return false;
    }
    return true;
  }).map((s) => {
    const sid = s.id === undefined ? undefined : Number(String(s.id).replace(/^S-/i, ''));
    const reqs = (s.requirements ?? []).filter((v) => {
      if (typeof v === 'string') return !!v.trim();
      if (removing.has(v.id)) return void dropped.push(`scope requirements: item #${v.id} is also in removeItems: it is removed, not changed`), false;
      const good = sid !== undefined && itemRows.some((x) => x.id === v.id && x.kind === ITEM_KINDS.requirements && x.scope_id === sid);
      if (!good) dropped.push(`scope requirements: no item #${v.id} in ${s.id ?? s.title}`);
      return good;
    });
    return {
      ...(sid !== undefined ? { id: sid } : {}),
      title: s.title,
      ...(s.group?.trim() ? { group: s.group } : {}),
      ...(s.description?.trim() ? { description: s.description } : {}),
      ...(reqs.length ? { requirements: reqs } : {}),
    };
  });
  if (scopes.length) f.scopes = scopes;
  // Scope names that apply can find: the scopes of this answer, the feature's scopes (S-id or title),
  // and old titles or IDs of scopes that a person renamed, moved or deleted (apply skips those with a note).
  // The same rule as apply: "S-12" or "S12" is an ID, other text is a title.
  const norm = (k: string) => {
    const m = /^S-?(\d+)$/i.exec(k.trim());
    return m ? `s-${Number(m[1])}` : k.trim().toLowerCase();
  };
  const known = new Set<string>(scopes.map((s) => norm(s.title)));
  for (const x of db.prepare('SELECT id, title FROM scopes WHERE feature_id = ?').all(featureId) as any[]) {
    known.add(`s-${x.id}`);
    known.add(norm(String(x.title)));
  }
  for (const x of db.prepare('SELECT scope_id, title_key FROM scope_titles_gone WHERE feature_id = ?').all(featureId) as any[]) {
    known.add(`s-${x.scope_id}`);
    known.add(String(x.title_key));
  }
  const tests = db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL');
  const links = (pr.links ?? []).flatMap((l) => {
    if (!tests.get(p.id, l.testId)) return void dropped.push(`links: no test ${l.testId} in the last scan`), [];
    const keys = (l.scopes ?? []).map((k) => String(k).trim()).filter(Boolean);
    const good = keys.filter((k) => known.has(norm(k)));
    for (const k of keys.filter((k) => !good.includes(k))) dropped.push(`links: ${l.testId} names the scope "${k}", which is not in F-${featureId}`);
    // A link whose scopes are all unknown would say only "about the feature": leave it to a person.
    if (keys.length && !good.length) return void dropped.push(`links: ${l.testId} not linked, because none of its scopes is in F-${featureId}`), [];
    return [{ testId: l.testId, ...(good.length ? { scopes: good } : {}) }];
  });
  if (links.length) f.links = links;
  if (Object.keys(f).length === 1) return { payload: null, dropped };
  return { payload: { unit: { kind: 'update', ref }, features: [f] }, dropped };
}

/** Saves a payload with "map apply". It returns the lines of the apply report. */
async function applyPayload(p: ProjectConfig, payload: any): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-payload-'));
  const file = path.join(dir, 'payload.json');
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return JSON.parse(await mapCommand(['apply', p.id, file])).report ?? [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Main ----

/**
 * Checks each feature in turn. Returns the rows it wrote.
 * Each feature gets a row at once ("waiting"), with this process as owner, so each process sees
 * the running update (a sync waits), and a later process can tell when this one stopped.
 */
export async function aiUpdate(p: ProjectConfig, o: AiUpdateOptions): Promise<AiUpdateRow[]> {
  const model = o.model ?? DEFAULTS.model;
  const budgetUsd = o.budgetUsd ?? DEFAULTS.budgetUsd;
  const auth = o.auth ?? DEFAULTS.auth;
  const say = o.onLine ?? (() => {});
  if (aiRunning(p.id)) throw new AiUpdateError('An AI update runs already for this project.');
  if (syncRunning(p.id)) throw new AiUpdateError('A sync runs now. Start the AI update when it ends.');
  preparing.add(p.id);
  const ids: number[] = [];
  const rowOf = new Map<number, number>();
  let r: ChangeReport;
  try {
    // Let the caller (an HTTP request) answer first: the steps below can take some seconds.
    await new Promise((res) => setImmediate(res));
    r = o.report ?? changeReport(p, o.from, o.to);
    ids.push(...(o.features?.length ? o.features : r.review.map((x) => x.featureId)));
    say(`${r.from.slice(0, 8)}..${r.to.slice(0, 8)}: ${ids.length} features to check with ${model}, at most $${budgetUsd} each`);
    const insert = db.prepare(
      "INSERT INTO ai_updates (project_id, feature_id, sync_id, from_commit, to_commit, model, started_at, status, owner_pid) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)",
    );
    for (const fid of ids) {
      const id = Number(insert.run(p.id, fid, o.syncId ?? null, r.from, r.to, model, now(), process.pid).lastInsertRowid);
      rowOf.set(fid, id);
      live.add(id);
    }
  } finally {
    preparing.delete(p.id);
  }
  if (!ids.length) return [];

  const finish = (id: number, fields: Record<string, unknown>) => {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE ai_updates SET finished_at = ?, claude_pid = NULL, ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(now(), ...cols.map((c) => fields[c] as any), id);
    live.delete(id);
  };
  const rows: AiUpdateRow[] = [];
  let code: { dir: string; done: () => void } | null = null;
  try {
    code = codeDir(p, r.to);
  } catch (e) {
    for (const id of rowOf.values()) finish(id, { status: 'failed', error: `No checkout of the new commit: ${(e as Error).message}` });
    return ids.map((fid) => toRow(db.prepare('SELECT * FROM ai_updates WHERE id = ?').get(rowOf.get(fid)!)));
  }
  try {
    for (const fid of ids) {
      const id = rowOf.get(fid)!;
      db.prepare("UPDATE ai_updates SET status = 'running', started_at = ? WHERE id = ?").run(now(), id);
      // The answer and its cost stay known when a later step fails, so the cost is never lost.
      let c: ClaudeResult | null = null;
      const base = () => ({ cost_usd: c?.costUsd ?? null, duration_ms: c?.durationMs ?? null, proposal: c?.proposal ? JSON.stringify(c.proposal) : null, summary: c?.proposal?.summary ?? '' });
      try {
        const { prompt } = await buildPrompt(p, r, fid);
        say(`F-${fid}: asking ${model} (${Math.round(prompt.length / 1000)} KB of facts)`);
        c = await runClaude(prompt, code.dir, { model, budgetUsd, auth }, say, (pid) =>
          db.prepare('UPDATE ai_updates SET claude_pid = ? WHERE id = ?').run(pid ?? null, id),
        );
        if (!c.ok || !c.proposal) {
          finish(id, { ...base(), status: 'failed', error: c.error });
        } else {
          const { payload, dropped } = toPayload(p, fid, c.proposal, `${r.from.slice(0, 8)}..${r.to.slice(0, 8)} F-${fid}`);
          const notes = dropped.map((d) => `Not saved: ${d}.`);
          if (!payload) finish(id, { ...base(), status: 'no-change', apply_report: notes.length ? JSON.stringify(notes) : null });
          else if (o.apply === false) finish(id, { ...base(), status: 'proposed', apply_report: notes.length ? JSON.stringify(notes) : null });
          else {
            try {
              const report = await applyPayload(p, payload);
              finish(id, { ...base(), status: 'applied', apply_report: JSON.stringify([...report, ...notes]) });
            } catch (e) {
              finish(id, { ...base(), status: 'failed', apply_report: notes.length ? JSON.stringify(notes) : null, error: `Save failed: ${(e as Error).message}` });
            }
          }
        }
      } catch (e) {
        finish(id, { ...base(), status: 'failed', error: (e as Error).message });
      }
      const row = toRow(db.prepare('SELECT * FROM ai_updates WHERE id = ?').get(id));
      say(`F-${fid}: ${row.status}${row.costUsd !== null ? `, $${row.costUsd.toFixed(2)}` : ''}${row.error ? `: ${row.error}` : row.summary ? `: ${row.summary}` : ''}`);
      rows.push(row);
    }
  } finally {
    // Rows that did not end (an error outside the loop body) must not stay "waiting".
    for (const id of rowOf.values()) if (live.has(id)) finish(id, { status: 'failed', error: 'The update stopped before this feature' });
    code.done();
  }
  return rows;
}
