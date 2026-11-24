/**
 * GitHub issues for scopes with no test.
 *
 * A person clicks "Create test issue" on a scope (in its popup) or on a feature ("all scopes without
 * tests"). The app then runs headless Claude (`claude -p`) with the project:create-issue skill. Claude
 * writes one "Automation Plan" issue with no plan yet (the plan comes later, with /plan-test), and
 * posts it to the plugin repo with no questions. The app keeps the issue number and link.
 *
 * The daily check (syncDueIssues, called by the daily sync timer) asks GitHub for the state of the
 * open issues and their linked pull requests: one GraphQL call for each repo. A closed issue is not
 * checked again.
 *
 * Claude runs in an empty temporary folder, with --repo, so the skill's files (.tmp/create-issue)
 * do not go into the plugin repo copy.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now, tx } from './db.ts';
import { EditError, featureData } from './features.ts';
import { loadProjects, type ProjectConfig } from './projects.ts';
import { childEnv, processAlive, run, type Job } from './sync.ts';
import { notePlanUse, readPlanLine } from './plan-limit.ts';
import { setting } from './settings.ts';

const execFileAsync = promisify(execFile);

/** One issue run that takes longer than this is stopped, and fails. */
const CREATE_TIMEOUT_MS = 10 * 60 * 1000;
/** The model of the issue runs. The skill itself asks for sonnet. */
const MODEL = 'sonnet';

export interface IssuePr { number: number; title: string; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED' }
export interface IssueRow {
  id: number;
  /** automation-plan: the app made it with the AI · linked: a person added an issue that was on GitHub. */
  kind: string;
  featureId: number | null;
  scopeIds: number[];
  repo: string;
  status: 'creating' | 'created' | 'failed';
  number: number | null;
  url: string | null;
  title: string | null;
  /** GitHub state: OPEN or CLOSED. Null before the first check. */
  state: string | null;
  prs: IssuePr[];
  error: string | null;
  createdAt: string;
  syncedAt: string | null;
}

// ---- Read ----

/** True when the process is an issue run of claude. A process number can come back for another program after a restart. */
function isIssueRun(pid: number): boolean {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('claude') && cmd.includes('--json-schema');
  } catch {
    return false;
  }
}

/**
 * Rows that wait for a run whose process is gone (a server restart) become "failed". A row older than
 * the run time limit fails too: its process number can belong to another program now.
 */
function markGone(projectId: string) {
  const rows = db.prepare("SELECT id, owner_pid, claude_pid, created_at FROM issues WHERE project_id = ? AND status = 'creating'").all(projectId) as any[];
  for (const r of rows) {
    // This process stops its own runs at the time limit.
    if (r.owner_pid === process.pid && live.has(r.id)) continue;
    const tooOld = Date.now() - Date.parse(r.created_at) > CREATE_TIMEOUT_MS + 60_000;
    if (r.owner_pid !== process.pid && !tooOld && processAlive(r.owner_pid)) continue;
    if (r.claude_pid && processAlive(r.claude_pid) && isIssueRun(r.claude_pid)) {
      try {
        process.kill(-r.claude_pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    db.prepare("UPDATE issues SET status = 'failed', error = ?, claude_pid = NULL WHERE id = ?").run(
      'The run stopped before the end (the server stopped). Check GitHub before you try again: the issue can be there.', r.id,
    );
  }
}

export function listIssues(projectId: string): IssueRow[] {
  markGone(projectId);
  const scopes = new Map<number, number[]>();
  for (const r of db.prepare('SELECT s.issue_id, s.scope_id FROM issue_scopes s JOIN issues i ON i.id = s.issue_id WHERE i.project_id = ? ORDER BY s.scope_id').all(projectId) as any[])
    scopes.set(r.issue_id, [...(scopes.get(r.issue_id) ?? []), r.scope_id]);
  return (db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id DESC').all(projectId) as any[]).map((r) => ({
    id: r.id, kind: r.kind, featureId: r.feature_id, scopeIds: scopes.get(r.id) ?? [], repo: r.repo, status: r.status, number: r.number, url: r.url,
    title: r.title, state: r.state, prs: JSON.parse(r.prs), error: r.error, createdAt: r.created_at, syncedAt: r.synced_at,
  }));
}

/** Takes an issue off the tracker. The issue on GitHub stays. */
export function forgetIssue(projectId: string, id: number) {
  const r = db.prepare('SELECT status FROM issues WHERE id = ? AND project_id = ?').get(id, projectId) as any;
  if (!r) throw new EditError(`Issue row ${id} is not in this project`);
  if (r.status === 'creating') throw new EditError('The issue is still being created. Wait for the end.');
  db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  return { ok: true };
}

// ---- Which scopes ----

/** owner/repo of the plugin repo, from its "origin" remote. */
export function repoOf(p: ProjectConfig): string {
  let url = '';
  try {
    url = execFileSync('git', ['-C', p.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* no remote */
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) throw new EditError(`The plugin repo has no GitHub "origin" remote (${url || 'none'}). The app cannot know where to create the issue.`);
  return `${m[1]}/${m[2]}`;
}

/** A scope to put in the issue: a normal scope, or a scope with the variations that need a test. */
interface Unit { scope: any; variations: any[] }

/** Scope IDs that have an issue that is open, or that is being created. */
function scopesWithOpenIssue(projectId: string): Set<number> {
  return new Set(
    (db
      .prepare(
        `SELECT s.scope_id FROM issue_scopes s JOIN issues i ON i.id = s.issue_id
         WHERE i.project_id = ? AND (i.status = 'creating' OR (i.status = 'created' AND COALESCE(i.state, 'OPEN') = 'OPEN'))`,
      )
      .all(projectId) as any[]).map((r) => r.scope_id as number),
  );
}

/**
 * The scopes of the issue.
 *  - One scope (scopeId): that scope. A scope with variations gives its variations with no test (all of
 *    them when each has a test). The person chose it, so a scope that has a test can get an issue too.
 *  - The whole feature: each scope and variation with no test, not marked "To remove", and with no open issue.
 */
function unitsFor(projectId: string, f: any, scopeId: number | null): Unit[] {
  const tested = new Set(f.links.filter((l: any) => !l.missing).flatMap((l: any) => l.scopeIds as number[]));
  const open = scopesWithOpenIssue(projectId);
  const marked = (s: any) => !!s.toRemove;
  const varsOf = (s: any) => f.scopes.filter((v: any) => v.parentId === s.id);
  if (scopeId !== null) {
    const s = f.scopes.find((x: any) => x.id === scopeId && x.parentId === null);
    if (!s) throw new EditError(`S-${scopeId} is not a scope of F-${f.id}`);
    if (marked(s)) throw new EditError(`S-${s.id} is marked "To remove". It does not need a test.`);
    if (!s.columns) return [{ scope: s, variations: [] }];
    const vars = varsOf(s).filter((v: any) => !marked(v));
    if (!vars.length) throw new EditError(`Each variation of S-${s.id} is marked "To remove". They do not need a test.`);
    const untested = vars.filter((v: any) => !tested.has(v.id));
    return [{ scope: s, variations: untested.length ? untested : vars }];
  }
  const out: Unit[] = [];
  for (const s of f.scopes.filter((x: any) => x.parentId === null && !marked(x))) {
    if (!s.columns) {
      if (!tested.has(s.id) && !open.has(s.id)) out.push({ scope: s, variations: [] });
      continue;
    }
    const vars = varsOf(s).filter((v: any) => !marked(v) && !tested.has(v.id) && !open.has(v.id));
    if (vars.length) out.push({ scope: s, variations: vars });
  }
  return out;
}

// ---- Create ----

/** Issue rows whose run this process holds now. */
const live = new Set<number>();

/** The structured answer of the Claude run. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'number', 'url', 'title', 'error'],
  properties: {
    ok: { type: 'boolean', description: 'true when the issue was created' },
    number: { type: 'integer', description: 'The issue number. 0 when no issue was created.' },
    url: { type: 'string', description: 'The issue URL. Empty when no issue was created.' },
    title: { type: 'string', description: 'The issue title. Empty when no issue was created.' },
    error: { type: 'string', description: 'Why no issue was created. Empty on success.' },
  },
};

function buildPrompt(repo: string, f: any, units: Unit[]): string {
  const facts = {
    feature: {
      id: `F-${f.id}`,
      title: f.title,
      description: f.description,
      requirements: (f.requirements ?? []).map((r: any) => r.text),
      roles: f.roles ?? [],
    },
    scopes: units.map((u) => ({
      id: `S-${u.scope.id}`,
      sentence: u.scope.title,
      description: u.scope.description,
      requirements: u.scope.requirements.map((r: any) => r.text),
      ...(u.scope.columns
        ? { variations: u.variations.map((v: any) => ({ id: `SV-${v.id}`, ...Object.fromEntries(u.scope.columns.map((c: string, i: number) => [c, v.values?.[i] ?? ''])) })) }
        : {}),
    })),
  };
  return `Use the Skill tool to load the project:create-issue skill. Then follow it to create ONE GitHub issue.

No person watches this run. So:
- Do not ask questions. Do not show a draft. Do not wait for approval. Do not search for duplicate issues.
- The issue type is an Automation Plan (new test coverage) with NO plan yet. Use the "no plan file exists yet" (plan pending) form of template-automation-plan.md, with the PLAN_PENDING markers.
- The repository is ${repo}. Pass --repo ${repo} to get_repo_info.sh and to create_issue.sh.
- Label: automation. No assignee, no milestone, no parent.
- Create exactly one issue. If create_issue.sh fails, try one more time at most, then stop and report the error.

How to fill the issue:
${units.length === 1
    ? `- This issue is for ONE scope (S-${units[0].scope.id}), not for the whole feature. Name the issue after that scope.
- Title: "Automation: <the check of that scope>", from its sentence, with enough of the feature to know where it is. Keep it short.
  Example: for the scope "The column shows one line for each role when a product has prices for more than one role" of the feature
  "Wholesale price column on the admin product list", write "Automation: Wholesale price column shows one line for each role".
- Automation Description: 1 or 2 sentences: what that scope checks, and where in the plugin. Use the feature facts only as context. No bullet list.`
    : `- Title: "Automation: <the feature or flow>", from the facts below. Keep it short.
- Automation Description: 1 or 2 sentences: what plugin area or flow to automate, and what the tests must verify. No bullet list.`}
- After the Automation Description, before the Test Plan block, add a section "## Scopes to cover" with one bullet for each scope:
  "<scope sentence> (<scope ID>)". For a scope with variations, add one sub-bullet for each variation: its values and its SV- ID.
  These IDs come from the automation tracker. The person who writes the plan uses them.
- Leave out "Related Issues".
- Use only the facts below. Do not read the plugin code.

Facts from the automation tracker (JSON):
${JSON.stringify(facts, null, 2)}

When you are done, give the issue number, URL and title in the structured output. If no issue was created, set ok to false and give the reason.
`;
}

/**
 * Starts the issue run for one scope (scopeId) or for all scopes of a feature with no test.
 * Returns at once with the issue row ID. The run goes on in the background.
 */
export function startIssue(p: ProjectConfig, featureId: number, scopeId: number | null): { id: number; scopes: number } {
  const f = featureData(p.id).features.find((x: any) => x.id === featureId);
  if (!f) throw new EditError(`F-${featureId} is not in this project`);
  if (f.toRemove) throw new EditError(`F-${f.id} is marked "To remove". It does not need tests.`);
  const units = unitsFor(p.id, f, scopeId);
  if (!units.length) throw new EditError(`F-${f.id} has no scope without a test and without an open issue.`);
  const repo = repoOf(p);
  skillDir(); // refuse at once when the skill is not installed
  const scopeIds = units.flatMap((u) => [u.scope.id, ...u.variations.map((v: any) => v.id)]);
  const id = tx(() => {
    const r = db
      .prepare("INSERT INTO issues (project_id, feature_id, repo, status, owner_pid, created_at) VALUES (?, ?, ?, 'creating', ?, ?)")
      .run(p.id, f.id, repo, process.pid, now());
    const iid = Number(r.lastInsertRowid);
    const add = db.prepare('INSERT OR IGNORE INTO issue_scopes (issue_id, scope_id) VALUES (?, ?)');
    for (const sid of scopeIds) add.run(iid, sid);
    return iid;
  });
  live.add(id);
  createIssue(p, id, repo, buildPrompt(repo, f, units), scopeIds[0])
    .catch((e) => db.prepare("UPDATE issues SET status = 'failed', error = ? WHERE id = ?").run(String((e as Error).message ?? e), id))
    .finally(() => {
      live.delete(id);
      db.prepare('UPDATE issues SET claude_pid = NULL WHERE id = ?').run(id);
    });
  return { id, scopes: units.length };
}

/** The folder of the installed create-issue skill (the "project" plugin of rymera-marketplace). */
function skillDir(): string {
  const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let base = '';
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    base = (d.plugins ?? d)['project@rymera-marketplace']?.[0]?.installPath ?? '';
  } catch {
    /* not installed */
  }
  const dir = base && path.join(base, 'skills', 'create-issue');
  if (!dir || !fs.existsSync(path.join(dir, 'scripts', 'create_issue.sh')))
    throw new EditError(`The create-issue skill is not installed (no "project@rymera-marketplace" plugin in ${file}).`);
  return dir;
}

/** The tools of the issue run: the skill's scripts, read-only gh commands, and files in the run's own folder. */
export function allowedTools(): string[] {
  const scripts = path.join(skillDir(), 'scripts');
  return [
    'Skill', 'Read', 'Glob', 'Grep',
    'Edit(./**)', // covers Write too
    ...['get_repo_info.sh', 'create_issue.sh'].map((f) => `Bash(bash ${path.join(scripts, f)}:*)`),
    'Bash(gh --version)', 'Bash(gh issue view:*)', 'Bash(gh label list:*)',
    'Bash(mkdir -p .tmp/create-issue)', 'Bash(ls:*)', 'Bash(cat:*)',
  ];
}

/** The issue link that create_issue.sh printed, from a tool result line of the stream. */
export function postedIssue(line: string, repo: string): { number: number; url: string } | null {
  if (!line.includes('"type":"user"')) return null;
  const esc = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\\\?"url\\\\?":\\s*\\\\?"(https://github\\.com/${esc}/issues/(\\d+))`, 'i'));
  return m ? { url: m[1], number: Number(m[2]) } : null;
}

/**
 * An issue that this run posted, found on GitHub: made by you since the run started, with the first
 * scope ID in its body. Used when the run failed after the post, so that a new click does not post it again.
 */
export async function findPosted(repo: string, since: string, scopeId: number): Promise<{ number: number; url: string; title: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh', ['issue', 'list', '--repo', repo, '--author', '@me', '--state', 'all', '--limit', '5', '--json', 'number,url,title,body,createdAt',
        '--search', `created:>=${since.slice(0, 10)} in:body S-${scopeId}`],
      { env: childEnv(), encoding: 'utf8', timeout: 60_000 },
    );
    const hit = (JSON.parse(stdout) as any[]).find((x) => Date.parse(x.createdAt) >= Date.parse(since) - 60_000 && new RegExp(`\\bS[V]?-${scopeId}\\b`).test(x.body ?? ''));
    return hit ? { number: hit.number, url: hit.url, title: hit.title } : null;
  } catch {
    return null;
  }
}

async function createIssue(p: ProjectConfig, id: number, repo: string, prompt: string, firstScope: number) {
  const since = now();
  let posted: { number: number; url: string } | null = null;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-issue-'));
  const args = [
    '-p',
    '--model', MODEL,
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(SCHEMA),
    '--max-budget-usd', '2',
    // No prompts: a tool that is not in this list is refused. The skill runs its scripts with bash and gh.
    '--permission-mode', 'dontAsk',
    // No prompts: a tool that is not in this list is refused. The scope texts come from the mapping AI,
    // so the run can only run the skill's two scripts, read GitHub, and write files in its own folder.
    '--allowedTools', ...allowedTools(),
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  const env = childEnv();
  // The claude.ai login, not an API key in the environment (as in server/ai-update.ts).
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k];
  const job: Job = { syncId: 0, child: null, cancelled: false, abort: new AbortController() };
  let out: any = null;
  let planStop: string | null = null;
  const stop = () => {
    try {
      if (job.child?.pid) process.kill(-job.child.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  };
  const onLine = (l: string, stream: 'stdout' | 'stderr') => {
    if (stream !== 'stdout' || !l.startsWith('{')) return;
    posted ??= postedIssue(l, repo);
    const plan = readPlanLine(l, MODEL);
    notePlanUse(plan);
    if (plan) {
      if (plan.stop && !planStop) (planStop = plan.stop), stop();
      return;
    }
    if (l.includes('"type":"result"')) {
      try {
        const v = JSON.parse(l);
        if (v?.type === 'result') out = v;
      } catch {
        /* not JSON */
      }
    }
  };
  const started = run(job, 'claude', args, { cwd, env, quiet: true, input: prompt, onLine });
  db.prepare('UPDATE issues SET claude_pid = ? WHERE id = ?').run(job.child?.pid ?? null, id);
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), stop()), CREATE_TIMEOUT_MS);
  try {
    const res = await started.catch((e) => ({ code: null, signal: null, out: String(e?.message ?? e) }));
    const a = out?.structured_output;
    const cost = typeof out?.total_cost_usd === 'number' ? out.total_cost_usd : null;
    if (a?.ok && a.number > 0 && typeof a.url === 'string' && a.url.startsWith('https://github.com/')) {
      db.prepare("UPDATE issues SET status = 'created', number = ?, url = ?, title = ?, state = 'OPEN', error = NULL, cost_usd = ? WHERE id = ?").run(a.number, a.url, a.title || null, cost, id);
      await syncIssues(p.id, [id]).catch(() => {}); // the first check: the issue is there, and its state
      return;
    }
    // The run failed, but the issue can be on GitHub already (a time or budget stop after the post).
    // Save it, so the scopes keep their open issue and a new click does not post it again.
    const found = posted ?? (await findPosted(repo, since, firstScope));
    if (found) {
      db.prepare("UPDATE issues SET status = 'created', number = ?, url = ?, title = ?, state = 'OPEN', error = ?, cost_usd = ? WHERE id = ?").run(
        found.number, found.url, (found as any).title ?? null, 'The run stopped with an error after it posted the issue. Check the issue text on GitHub.', cost, id,
      );
      await syncIssues(p.id, [id]).catch(() => {});
      return;
    }
    const why = timedOut
      ? `The run took longer than ${CREATE_TIMEOUT_MS / 60000} minutes and was stopped.`
      : planStop ?? (a?.error || out?.result || res.out.split('\n').filter(Boolean).slice(-5).join('\n') || 'Claude gave no answer.');
    db.prepare("UPDATE issues SET status = 'failed', error = ?, cost_usd = ? WHERE id = ?").run(
      `${why}\nCheck GitHub before you try again: the issue can be there.`, cost, id,
    );
  } finally {
    clearTimeout(timer);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// ---- Check the state on GitHub ----

/**
 * Gets the state and linked pull requests of the open issues (or of the given rows) from GitHub.
 * One GraphQL call for each repo. Linked PRs: the "Development" PRs of the issue (a PR that says
 * "Fixes #12", or that a person linked), merged and closed ones too.
 */
export async function syncIssues(projectId: string, ids?: number[]): Promise<{ checked: number }> {
  const rows = (ids
    ? db.prepare(`SELECT id, repo, number FROM issues WHERE project_id = ? AND status = 'created' AND id IN (${ids.map(() => '?').join(',')})`).all(projectId, ...ids)
    : db.prepare("SELECT id, repo, number FROM issues WHERE project_id = ? AND status = 'created' AND COALESCE(state, 'OPEN') = 'OPEN'").all(projectId)) as any[];
  const byRepo = new Map<string, any[]>();
  for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  for (const [repo, list] of byRepo) {
    const found = await fetchIssues(repo, list.map((r) => r.number));
    const at = now();
    for (const r of list) {
      const v = found.get(r.number);
      // A deleted issue, or one in a repo that you cannot see now: keep the last known state, and show why.
      // The check time is set too, so the next check is the next day, not the next minute.
      if (!v) {
        db.prepare('UPDATE issues SET error = ?, synced_at = ? WHERE id = ?').run(NOT_FOUND, at, r.id);
        continue;
      }
      db.prepare('UPDATE issues SET state = ?, title = ?, url = ?, prs = ?, error = CASE WHEN error = ? THEN NULL ELSE error END, synced_at = ? WHERE id = ?').run(v.state, v.title, v.url, JSON.stringify(v.prs), NOT_FOUND, at, r.id);
    }
  }
  return { checked: rows.length };
}

const NOT_FOUND = 'Not found on GitHub at the last check: the issue was deleted, or you cannot see its repo now.';

interface GhIssue { state: string; title: string; url: string; prs: IssuePr[] }

/** State, title, URL and linked PRs of issues in one repo, by number. One GraphQL call for each 50 issues. A missing issue is not in the map. */
async function fetchIssues(repo: string, numbers: number[]): Promise<Map<number, GhIssue>> {
  const [owner, name] = repo.split('/');
  const out = new Map<number, GhIssue>();
  numbers = [...new Set(numbers)];
  for (let i = 0; i < numbers.length; i += 50) {
    const part = numbers.slice(i, i + 50);
    const fields = part
      .map((n) => `i${Number(n)}: issue(number: ${Number(n)}) { state title url closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number title url state } } }`)
      .join('\n');
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    // gh exits with an error when one issue is not found, but still prints the data of the others.
    const { stdout } = await execFileAsync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`], {
      env: childEnv(), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    }).catch((e: any) => {
      if (typeof e?.stdout === 'string' && e.stdout.includes('"data"')) return { stdout: e.stdout as string };
      throw new Error(String(e?.stderr || e?.message || e).trim());
    });
    const data = JSON.parse(stdout)?.data?.repository ?? {};
    for (const n of part) {
      const v = data[`i${n}`];
      if (v) out.set(n, { state: v.state, title: v.title, url: v.url, prs: (v.closedByPullRequestsReferences?.nodes ?? []).map((x: any) => ({ number: x.number, title: x.title, url: x.url, state: x.state })) });
    }
  }
  return out;
}

// ---- Add an issue that is on GitHub ----

/**
 * Reads an issue reference: a number (an issue of the plugin repo), owner/repo#12, or an issue link
 * (https://github.com/owner/repo/issues/12). A pull request link is refused.
 */
function parseIssueRef(p: ProjectConfig, ref: unknown): { repo: string; number: number } {
  const s = String(ref ?? '').trim();
  let m = s.match(/^#?(\d+)$/);
  if (m) return { repo: repoOf(p), number: Number(m[1]) };
  m = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = s.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/);
  if (m) {
    if (m[2] === 'pull') throw new EditError('This is a pull request link. Add the issue: a pull request shows on its issue when it is linked to it.');
    return { repo: m[1], number: Number(m[3]) };
  }
  throw new EditError('Give an issue number (1162), owner/repo#1162, or an issue link (https://github.com/owner/repo/issues/1162).');
}

/**
 * Adds an issue that is on GitHub to a feature (no scopeId) or to one scope. The app checks it on
 * GitHub first: an issue that is not there is not saved.
 */
export async function linkIssue(p: ProjectConfig, featureId: number, body: any): Promise<{ id: number }> {
  const f = db.prepare('SELECT id FROM features WHERE id = ? AND project_id = ?').get(featureId, p.id) as any;
  if (!f) throw new EditError(`F-${featureId} is not in this project`);
  const raw = body?.scopeId;
  const scopeId = raw === undefined || raw === null || raw === '' ? null : Number(String(raw).replace(/^.*?S[V]?-/i, ''));
  if (scopeId !== null && !db.prepare('SELECT 1 FROM scopes WHERE id = ? AND feature_id = ?').get(scopeId, featureId)) throw new EditError(`S-${raw} is not a scope of F-${featureId}`);
  const { repo, number } = parseIssueRef(p, body?.issue);
  const same = db
    .prepare(
      `SELECT i.id FROM issues i WHERE i.project_id = ? AND i.repo = ? AND i.number = ? AND i.status = 'created' AND (
         (? IS NULL AND i.feature_id = ? AND NOT EXISTS (SELECT 1 FROM issue_scopes s WHERE s.issue_id = i.id))
         OR EXISTS (SELECT 1 FROM issue_scopes s WHERE s.issue_id = i.id AND s.scope_id = ?))`,
    )
    .get(p.id, repo, number, scopeId, featureId, scopeId);
  if (same) throw new EditError(`${repo}#${number} is already on this ${scopeId === null ? 'feature' : 'scope'}.`);
  let v: GhIssue | undefined;
  try {
    v = (await fetchIssues(repo, [number])).get(number);
  } catch (e) {
    throw new EditError(`GitHub did not answer for ${repo}: ${(e as Error).message}`);
  }
  if (!v) throw new EditError(`${repo}#${number} is not an issue on GitHub (or you cannot see it).`);
  const id = tx(() => {
    const r = db
      .prepare("INSERT INTO issues (project_id, feature_id, kind, repo, status, number, url, title, state, prs, created_at, synced_at) VALUES (?, ?, 'linked', ?, 'created', ?, ?, ?, ?, ?, ?, ?)")
      .run(p.id, featureId, repo, number, v!.url, v!.title, v!.state, JSON.stringify(v!.prs), now(), now());
    const iid = Number(r.lastInsertRowid);
    if (scopeId !== null) db.prepare('INSERT INTO issue_scopes (issue_id, scope_id) VALUES (?, ?)').run(iid, scopeId);
    return iid;
  });
  return { id };
}

/**
 * Called by the daily sync timer each minute. Checks the open issues of a project when its last check
 * is as old as the daily sync hours (or when an open issue was never checked).
 */
let checking = false;
export async function syncDueIssues(log: (l: string) => void = console.log) {
  if (checking) return;
  checking = true;
  try {
    const hours = setting<number>('dailySyncHours');
    const before = new Date(Date.now() - hours * 3_600_000).toISOString();
    for (const p of loadProjects()) {
      const due = db
        .prepare("SELECT 1 FROM issues WHERE project_id = ? AND status = 'created' AND COALESCE(state, 'OPEN') = 'OPEN' AND (synced_at IS NULL OR synced_at < ?) LIMIT 1")
        .get(p.id, before);
      if (!due) continue;
      try {
        const r = await syncIssues(p.id);
        log(`Issue check: ${p.id}, ${r.checked} open issue${r.checked === 1 ? '' : 's'}`);
      } catch (e) {
        // Mark the check as done, so a GitHub error does not repeat each minute. It tries again the next day.
        db.prepare("UPDATE issues SET synced_at = ? WHERE project_id = ? AND status = 'created' AND COALESCE(state, 'OPEN') = 'OPEN'").run(now(), p.id);
        log(`Issue check of ${p.id} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    checking = false;
  }
}
