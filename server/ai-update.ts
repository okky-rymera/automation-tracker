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
 *     new text has the AI draft mark. Text that a person wrote or checked can change too: the review
 *     shows the old text with "Change back". Screenshots can get tags, lose tags, or be marked as old.
 *     A suggestion for such text goes into the feature's questions.
 *     A linked test that the change report lists as a likely rename: the model checks the new test, and a
 *     confirmed pair ("renames") moves the feature's link to the new test ID, with its scopes.
 *
 * Each run is a row in ai_updates, with its cost (total_cost_usd of the JSON output).
 * The AI step is separate from the sync: the fixed steps never need it.
 *
 * The review list (docs/sync-plan.md phase 8). runReview, which the app button and the daily sync
 * use, does not use only the last sync's list: a day with no AI update must not lose features.
 *  - queueReview adds the features to review of ai_reviewed_commit..HEAD of the copy to
 *    ai_review_pending, and moves ai_reviewed_commit to HEAD. A feature that is in the list already
 *    keeps its older from commit, so its diff covers all changes since its last check.
 *  - runReview checks the pending features, one group for each from commit. A feature that ends as
 *    applied, no-change or proposed leaves the list. A failed feature stays, with one fail for each
 *    day. After MAX_FAIL_DAYS failed days it is parked: a person sees it and clicks "Try again".
 *  - A plan limit or a stop (shouldStop) is not a fail: those features stay in the list as they are.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now, tx } from './db.ts';
import { changeReport, type ChangeReport } from './changes.ts';
import { ITEM_KINDS, featuresToRemove, jsonList, variationTitle, variationValues } from './features.ts';
import { getProject, ROOT, type ProjectConfig } from './projects.ts';
import { childEnv, mapLoopRunning, processAlive, run, syncRunning, type Job } from './sync.ts';
import { LIMIT_TEXT, notePlanUse, readPlanLine } from './plan-limit.ts';

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
  /** Checked before each feature. A reason stops the update there (the daily sync: a sync is due). */
  shouldStop?: () => string | null;
}

/** A check of one feature that takes longer than this is stopped, and counts as failed. */
const FEATURE_TIMEOUT_MS = 20 * 60 * 1000;

/** The error of a feature that did not run (a plan limit, or a stop). It is not a fail of the feature. */
export const NOT_RUN = 'Not run: ';

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
  return { running, rows, pending: pendingReviews(projectId), totalUsd: total.usd as number, count: total.n as number, defaults: DEFAULTS, error: lastError.get(projectId) ?? null };
}

/**
 * Starts an AI update in the background for the features to review of the last sync that
 * saved a change report. It uses that saved report: the same commits and features that the app shows.
 * Throws when an update or a sync runs, or when no sync has features to review.
 */
export function startAiUpdate(p: ProjectConfig, o: { model?: string; budgetUsd?: number }): { pending: number } {
  if (aiRunning(p.id)) throw new AiUpdateError('An AI update runs already for this project.');
  if (syncRunning(p.id)) throw new AiUpdateError('A sync runs now. Start the AI update when it ends.');
  if (mapLoopRunning(p.id)) throw new AiUpdateError('A mapping loop runs now. Start the AI update when it ends.');
  const line = queueReview(p);
  const pending = pendingReviews(p.id).filter((x) => !x.parked).length;
  if (!pending) throw new AiUpdateError(`No feature to review. ${line}`);
  lastError.delete(p.id);
  runReview(p, { model: o.model, budgetUsd: o.budgetUsd }).catch((e) => {
    lastError.set(p.id, `The AI update did not start: ${(e as Error).message}`);
    console.error(`AI update of ${p.id} failed:`, e);
  });
  return { pending };
}

export class AiUpdateError extends Error {}

// ---- The review list ----

/** Failed days after which a pending feature is parked until a person clicks "Try again". */
export const MAX_FAIL_DAYS = 2;
const today = () => new Date().toISOString().slice(0, 10);

/** True when the copy has this commit. */
function hasCommit(p: ProjectConfig, sha: string): boolean {
  try {
    git(p.path, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function copyHead(p: ProjectConfig): string | null {
  try {
    return git(p.path, ['rev-parse', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Adds the features to review of ai_reviewed_commit..HEAD to the pending list, and moves
 * ai_reviewed_commit to HEAD. The first time, the range starts at the from commit of the last sync
 * with a change report. Returns a line for the log.
 */
export function queueReview(p: ProjectConfig): string {
  const to = copyHead(p);
  if (!to) return 'The copy has no commit.';
  const cur = (db.prepare('SELECT ai_reviewed_commit AS c FROM projects WHERE id = ?').get(p.id) as any)?.c as string | null;
  const lastSync = db.prepare('SELECT from_commit FROM syncs WHERE project_id = ? AND report IS NOT NULL ORDER BY id DESC LIMIT 1').get(p.id) as any;
  const from = cur ?? lastSync?.from_commit ?? null;
  const setCommit = () => db.prepare('UPDATE projects SET ai_reviewed_commit = ? WHERE id = ?').run(to, p.id);
  if (!from || from === to) {
    setCommit();
    return from ? 'No new commit since the last AI review.' : 'No sync with a change report yet: the AI review starts from this commit.';
  }
  // The old commit is gone (a force push): no report can start there. Start again from HEAD.
  if (!hasCommit(p, from)) {
    setCommit();
    return `The commit ${from.slice(0, 8)} is not in the copy now (a force push?). The AI review starts again from ${to.slice(0, 8)}.`;
  }
  let r: ChangeReport;
  try {
    r = changeReport(p, from, to);
  } catch (e) {
    // Another error (a git lock, a read error): keep the commit, so the next run tries the same range.
    return `No change report for ${from.slice(0, 8)}..${to.slice(0, 8)} (${(e as Error).message}). The next AI review tries again.`;
  }
  const add = db.prepare('INSERT INTO ai_review_pending (project_id, feature_id, from_commit) VALUES (?, ?, ?) ON CONFLICT (project_id, feature_id) DO NOTHING');
  // A feature marked "To remove" goes in the list too. runReview skips it while it has the mark, so a
  // cleared mark does not lose the review of these changes.
  // A feature with a link to a test that is gone from the repo, also from an earlier sync: the AI moves or
  // removes the link (buildPrompt lists them). Else its scopes stay "not covered", and no one sees why.
  // One time only: not when an AI review of the feature finished after the test went (the AI saw it then),
  // and not when a person changed the AI's move or remove of that link back (the person keeps the link).
  const gone = (db
    .prepare(
      `SELECT DISTINCT l.feature_id AS id FROM links l LEFT JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id
       WHERE l.project_id = ? AND l.removed = 0 AND (t.id IS NULL OR t.removed_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM ai_rejected r WHERE r.kind = 'link' AND r.row_id = l.id AND r.field IN ('test', 'removed'))
         AND NOT EXISTS (
           SELECT 1 FROM ai_updates u WHERE u.project_id = l.project_id AND u.feature_id = l.feature_id
             AND u.status IN ('applied', 'no-change', 'proposed')
             AND u.finished_at > COALESCE(t.removed_at, strftime('%Y-%m-%dT%H:%M:%fZ', l.created_at)))`,
    )
    .all(p.id) as any[]).map((x) => x.id as number);
  const ids = new Set([...r.review.map((x) => x.featureId), ...gone]);
  tx(() => {
    for (const id of ids) add.run(p.id, id, from);
    setCommit();
  });
  return `${from.slice(0, 8)}..${to.slice(0, 8)}: ${ids.size} features to review.`;
}

export interface PendingReview {
  featureId: number;
  title: string;
  fromCommit: string;
  fails: number;
  lastError: string | null;
  parked: boolean;
}

export function pendingReviews(projectId: string): PendingReview[] {
  return (db
    .prepare('SELECT r.*, f.title FROM ai_review_pending r JOIN features f ON f.id = r.feature_id WHERE r.project_id = ? ORDER BY r.fails, r.feature_id')
    .all(projectId) as any[]).map((r) => ({ featureId: r.feature_id, title: r.title, fromCommit: r.from_commit, fails: r.fails, lastError: r.last_error, parked: r.fails >= MAX_FAIL_DAYS }));
}

/** "Try again": a parked feature goes back into the next AI update. */
export function retryReview(projectId: string, featureId: number): boolean {
  return db.prepare('UPDATE ai_review_pending SET fails = 0, last_fail_day = NULL WHERE project_id = ? AND feature_id = ?').run(projectId, featureId).changes > 0;
}

export interface ReviewOptions {
  model?: string;
  budgetUsd?: number;
  onLine?: (line: string) => void;
  shouldStop?: () => string | null;
}

/**
 * Checks the pending features (queueReview first). Returns the number of features that ran, and the
 * reason when a plan limit or a stop ended it early.
 */
export async function runReview(p: ProjectConfig, o: ReviewOptions = {}): Promise<{ checked: number; stoppedBy: string | null }> {
  const say = o.onLine ?? (() => {});
  say(`AI review: ${queueReview(p)}`);
  const to = copyHead(p);
  // A feature marked "To remove" waits in the list: the AI does not change it while it has the mark.
  const marked = featuresToRemove(p.id);
  const waiting = pendingReviews(p.id).filter((x) => marked.has(x.featureId)).length;
  if (waiting) say(`${waiting} features marked "To remove" wait. They are reviewed when the mark is cleared.`);
  const pending = pendingReviews(p.id).filter((x) => !x.parked && !marked.has(x.featureId));
  if (!to || !pending.length) return { checked: 0, stoppedBy: null };
  const groups = new Map<string, number[]>();
  for (const x of pending) groups.set(x.fromCommit, [...(groups.get(x.fromCommit) ?? []), x.featureId]);
  const fail = db.prepare(
    `UPDATE ai_review_pending SET fails = fails + CASE WHEN last_fail_day IS ? THEN 0 ELSE 1 END, last_fail_day = ?, last_error = ?
     WHERE project_id = ? AND feature_id = ?`,
  );
  const done = db.prepare('DELETE FROM ai_review_pending WHERE project_id = ? AND feature_id = ?');
  let checked = 0;
  for (let [from, ids] of groups) {
    // A start commit that is gone (a force push): check these features against the code now.
    if (!hasCommit(p, from)) {
      say(`The commit ${from.slice(0, 8)} is not in the copy now: ${ids.length} features are checked against ${to.slice(0, 8)} only.`);
      const move = db.prepare('UPDATE ai_review_pending SET from_commit = ? WHERE project_id = ? AND feature_id = ?');
      for (const fid of ids) move.run(to, p.id, fid);
      from = to;
    }
    let report: ChangeReport;
    try {
      report = changeReport(p, from, to);
    } catch (e) {
      const msg = `No change report for ${from.slice(0, 8)}..${to.slice(0, 8)}: ${(e as Error).message}`;
      for (const fid of ids) fail.run(today(), today(), msg, p.id, fid);
      say(msg);
      continue;
    }
    const rows = await aiUpdate(p, { from, to, report, features: ids, model: o.model, budgetUsd: o.budgetUsd, onLine: o.onLine, shouldStop: o.shouldStop });
    let stoppedBy: string | null = null;
    for (const r of rows) {
      if (r.status === 'applied' || r.status === 'no-change' || r.status === 'proposed') {
        done.run(p.id, r.featureId);
        checked++;
      } else if (r.error?.startsWith(NOT_RUN)) {
        stoppedBy ??= r.error.slice(NOT_RUN.length);
      } else {
        fail.run(today(), today(), r.error ?? 'failed', p.id, r.featureId);
        checked++;
      }
    }
    if (stoppedBy) return { checked, stoppedBy };
  }
  return { checked, stoppedBy: null };
}

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
  settings?: ItemOut[];
  questions?: ItemOut[];
  removeItems?: number[];
  scopes?: { id?: string; title: string; group?: string; description?: string; requirements?: ItemOut[]; variations?: Record<string, string>[] }[];
  links?: { testId: string; scopes?: string[]; removeScopes?: string[]; remove?: boolean }[];
  /** Scopes (S-ids or SV-ids) that are wrong now: the plugin does not do this, or another scope says the same. */
  deleteScopes?: string[];
  /** Plugin code to take out of the feature: it is gone, or it does not do this feature. function "" or none: the whole-file entry. */
  removeCode?: { file: string; function?: string }[];
  /** Linked tests that the model confirmed as renamed: the feature's link moves from the old ID to the new one. */
  renames?: { from: string; to: string }[];
  screenshots?: { id: string; addScopes?: string[]; removeScopes?: string[]; caption?: string; remove?: boolean; stale?: string }[];
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
    settings: items,
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
          variations: {
            type: 'array',
            description: 'New variations of the scope only: each one an object with the column names as keys, for example {"Page": "Checkout page"}',
            items: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['testId'],
        properties: {
          testId: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes (S-ids, SV-ids or titles) that the test checks: added to the link' },
          removeScopes: { type: 'array', items: { type: 'string' }, description: 'Scopes on the link that the test does not check: taken off' },
          remove: { type: 'boolean', description: 'true: the test does not check this feature. The link is removed' },
        },
      },
    },
    deleteScopes: {
      type: 'array',
      description: 'S-ids or SV-ids of scopes that are wrong now: the plugin does not do this any more, or another scope says the same',
      items: { type: 'string' },
    },
    removeCode: {
      type: 'array',
      description: 'Code entries of this feature to take out: the code is gone, or it does not do this feature',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: { file: { type: 'string' }, function: { type: 'string', description: 'Function name, or "" for the whole-file entry' } },
      },
    },
    renames: {
      type: 'array',
      description: 'A linked test that is gone from the repo, and the new test that checks the same thing',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: { from: { type: 'string', description: 'Old test ID' }, to: { type: 'string', description: 'New test ID' } },
      },
    },
    screenshots: {
      type: 'array',
      description: 'Changes to screenshots that are there. You cannot see the images: judge by the caption, the scopes and the code.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'IMG-id of a screenshot of this feature' },
          addScopes: { type: 'array', items: { type: 'string' }, description: 'S-ids or SV-ids that the image shows and that it has no tag for' },
          removeScopes: { type: 'array', items: { type: 'string' }, description: 'S-ids or SV-ids whose tag is wrong now' },
          caption: { type: 'string', description: 'A new caption, only when the old one is wrong now' },
          remove: { type: 'boolean', description: 'true: the screenshot shows nothing of this feature now' },
          stale: { type: 'string', description: 'Why the screen looks different now: the image needs a new picture' },
        },
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
  const goneCount = (db
    .prepare('SELECT COUNT(*) AS n FROM links l LEFT JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id WHERE l.feature_id = ? AND l.removed = 0 AND (t.id IS NULL OR t.removed_at IS NOT NULL)')
    .get(featureId) as any).n as number;
  const reasons = r.review.find((x) => x.featureId === featureId)?.reasons ?? (goneCount ? [`${goneCount} linked tests are gone from the repo`] : ['asked for by a person']);

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
  // The scopes of the feature's code entries (code_scopes): the AI checks those scopes first.
  const codeScopes = new Map<string, string[]>();
  for (const c of db
    .prepare(
      `SELECT c.file, c.function, s.id, s.title FROM feature_code c JOIN code_scopes cs ON cs.code_id = c.id JOIN scopes s ON s.id = cs.scope_id
       WHERE c.feature_id = ? AND c.removed = 0`,
    )
    .all(featureId) as any[]) {
    const k = `${c.file}\0${c.function}`;
    codeScopes.set(k, [...(codeScopes.get(k) ?? []), `S-${c.id} "${c.title}"`]);
  }
  const scopesOf = (file: string, name: string) => [...(codeScopes.get(`${file}\0${name}`) ?? []), ...(codeScopes.get(`${file}\0`) ?? [])];
  const gone = r.codeGone.filter((g) => g.featureId === featureId);
  // Every linked test that is gone from the repo, also from an earlier sync: until the AI moves or removes
  // the link, its scopes count as not covered. The change report gives a likely new test for some of them.
  const likely = new Map(r.renames.map((x) => [x.from.id, x.to]));
  const goneLinks = db
    .prepare(
      `SELECT l.test_id AS id, t.title FROM links l LEFT JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id
       WHERE l.feature_id = ? AND l.removed = 0 AND (t.id IS NULL OR t.removed_at IS NOT NULL)`,
    )
    .all(featureId) as { id: string; title: string | null }[];
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
${fns.length ? fns.map((f) => { const sc = scopesOf(f.file, f.name); return `- ${f.change}: ${f.file} ${f.name}${sc.length ? ` (code of ${sc.join(', ')})` : ''}`; }).join('\n') : '- none'}
${gone.length ? `\n## Code of this feature that is not in the code now\n${gone.map((g) => `- ${g.file} ${g.function ?? '(whole file)'}: ${g.reason}${g.movedTo ? ' -> ' + g.movedTo : ''}`).join('\n')}\n` : ''}${goneLinks.length ? `\n## Linked tests that are gone from the repo\nThe link still points at the old ID, so its scopes count as not covered. Fix each one: move it with "renames", or remove it with "links".\n${goneLinks.map((x) => { const to = likely.get(x.id); return `- ${x.id}${x.title ? ` "${x.title}"` : ''}${to ? ` (likely renamed to ${to.id} "${to.title}")` : ''}`; }).join('\n')}\n` : ''}
## New tests that no feature links yet
${unlinked.length ? unlinked.map((t) => `- ${t.id} (${t.framework}, ${t.file}${t.tags?.length ? `, tags: ${t.tags.join(' ')}` : ''}): ${t.title}`).join('\n') : '- none'}

## Diff ${r.from.slice(0, 12)}..${r.to.slice(0, 12)} of the feature's code and test files${cut ? ` (cut at ${MAX_DIFF} characters: read the files for the rest)` : ''}
\`\`\`diff
${diff || '(no changes in these files)'}
\`\`\`

## How to answer
- If the feature data is still correct, answer {"changed": false, "summary": "<why, in one or two sentences>"} and nothing else.
- Else set "changed": true and send only what you add or change:
  - You can change any text: AI draft text and text that a person wrote or checked. A person sees each change of their text in the review, with "Change back". So change a person's text only when the code proves it wrong now, never for style or wording.
  - "title", "description": a new text replaces the old one.
  - List fields (requirements, notes, outOfScope, where, settings, questions): a string adds an item. {"id", "text"} changes an item.
  - "removeItems": IDs of items that are now wrong, also items that a person wrote. For example, a question that the new code answers: remove it, and put the answer in "notes" or in a scope.
  - "screenshots": you cannot see the images. Use the caption, the scopes and the code. Add a tag ("addScopes") when the caption shows that the image shows a scope. Take a tag off ("removeScopes") when the scope is gone or the image does not show it now. Fix a caption that is wrong now. When the code changed what the screen shows (a label, a field, a layout), set "stale" to the reason: a later run takes a new image. Use "remove" only when the screen is gone from the plugin.
  - "scopes": a new behavior that a test can check is a new scope (a title, and its own "requirements" if it needs them). To add requirements to an existing scope, give its "id" (for example "S-4") and its title. Give a new scope the "group" of the existing scopes on the same topic, if one fits. When an existing scope has "variations" (one check in several places, for example a row for each page) and the new behavior is that check in one more place, send that scope with its "id" and title and a "variations" list with the new variation only, an object with the column names as keys (for example [{"Page": "Checkout page"}]). Write only variations that the plugin really has, not all combinations. A variation has no description and no requirements: its scope has them. A scope that is now wrong (the plugin does not do it any more, or another scope says the same): put its S-id or SV-id in "deleteScopes". Its links and screenshots lose the tag.
  - "renames": for each test in "Linked tests that are gone from the repo", find the test that checks the same thing now (the likely rename, or another test in the code). Send {"from": "<old ID>", "to": "<new ID>"}. The link moves with its scopes. Do not also put the new test in "links". When no test checks it now, remove the link: {"testId": "<old ID>", "remove": true} in "links".
  - "removeCode": a code entry of the feature ("code" in the feature JSON) that is gone from the plugin, or that does not do this feature now. Give its "file" and "function" ("" for a whole-file entry). You can remove every entry, also one that a person added.
  - "links": for a new test that checks this feature, and to correct a link that is there: "scopes" adds scopes, "removeScopes" takes off scopes that the test does not check, "remove": true removes a link whose test does not check this feature. You can change every link, also one that a person made. A person sees each change in the review, with "Change back". Give the S-ids or the titles of the scopes it checks. For a scope with variations, give the SV-ids of the variations that the test checks, not the S-id of the scope. For a new variation of this answer, which has no SV-id yet, give its title: the scope title and the values in brackets, with commas, for example "Price shows (Checkout page)".
  - A scope with "toRemove": a person decided that it must go. Do not change it, link a test to it, or add the same behavior again as a new scope.
  - Do not add a scope for the page before this feature changes it (for example "Guest sees the price by default" on a feature that hides the price). The page then shows what WooCommerce or another feature makes. One scope "turn the setting on, then off: the result comes back" is allowed.
  - Behavior that needs another plugin (Premium, Lead Capture, Order Form, Payments, or a third-party plugin) belongs to a feature in an "Integration/<plugin>" group. If this feature is not in such a group, do not add such a scope here and do not link a test from an "Integration/" folder or with an "@integration:" tag. Add a question that names the behavior or the test instead.
- "summary": 1–3 plain sentences for the person who checks your work: what changed in the code, and what you changed in the feature.

## Writing style
Plain, simple English: short sentences, active voice, common words. Write about behavior that a store owner or tester sees, not about tests.
"settings": one item for each setting of this feature: its label and place, its choices, and its default value, for example 'Wholesale > Settings > Price tab > "Hide Retail Price" checkbox. Choices: checked, unchecked. Default: unchecked.' Add the option key at the end when you know it: "Option key: <key>." A setting of another feature that changes a scope goes in that scope's requirements, with the feature ID.
"where": the pages, admin screens and API routes where the feature shows or where a person or a program uses it. Do not put the settings of this feature in "where": "settings" has them. Code facts (AJAX actions, cron events, files, filters) go in "notes".
Put code names (hooks, option keys, classes) only in "where" (page addresses, API routes), "settings" (the option key), "notes" (code facts) or "requirements", and only when they help a tester find the thing.
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
  /** Set when the plan limit (or paid extra usage) stopped the run: the reason, with the reset time. */
  planLimit?: string | null;
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
    // One JSON line for each event: the plan limit events (rate_limit_event) come only in this format.
    // The last line is the result, with the answer in structured_output, as with --output-format json.
    '--output-format', 'stream-json',
    '--verbose',
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
  // Read each line as it comes: a plan limit event stops the run at once (claude can wait for the
  // reset). The result line is kept. Other lines (stderr, hooks) are only for the error text.
  let out: any = null;
  let planLimit: string | null = null;
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  /** SIGTERM to the process group now, and SIGKILL after a grace time: claude can ignore SIGTERM. */
  const stopRun = () => {
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (job.child?.pid) process.kill(-job.child.pid, sig);
      } catch {
        /* gone */
      }
    };
    kill('SIGTERM');
    timers.push(setTimeout(() => kill('SIGKILL'), 30_000));
  };
  const readLine = (l: string, stream: 'stdout' | 'stderr') => {
    if (stream !== 'stdout' || !l.startsWith('{')) return;
    const plan = readPlanLine(l, o.model);
    notePlanUse(plan);
    if (plan) {
      if (plan.stop && !planLimit) {
        planLimit = plan.stop;
        stopRun();
      }
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
  const started = run(job, 'claude', args, { cwd, env, quiet: true, input: prompt, onLine: readLine });
  onStart?.(job.child?.pid); // run() starts the process at once
  // One feature must not hold the update (and the daily sync after it) for ever.
  timers.push(
    setTimeout(() => {
      timedOut = true;
      stopRun();
    }, FEATURE_TIMEOUT_MS),
  );
  const res = await started.finally(() => timers.forEach(clearTimeout));
  if (timedOut && !out) {
    return { ok: false, proposal: null, costUsd: null, durationMs: FEATURE_TIMEOUT_MS, error: `The check took longer than ${FEATURE_TIMEOUT_MS / 60000} minutes and was stopped.` };
  }
  if (planLimit) {
    return { ok: false, proposal: null, costUsd: typeof out?.total_cost_usd === 'number' ? out.total_cost_usd : null, durationMs: null, error: planLimit, planLimit };
  }
  if (!out) {
    const hit = res.out.split('\n').find((l) => LIMIT_TEXT.test(l));
    if (hit) return { ok: false, proposal: null, costUsd: null, durationMs: null, error: `The Claude plan limit is reached: ${hit.trim()}`, planLimit: `The Claude plan limit is reached: ${hit.trim()}` };
    const tail = res.out.trim().split('\n').slice(-3).join(' | ');
    onLine?.(`claude exit ${res.code ?? res.signal}: ${tail}`);
    return { ok: false, proposal: null, costUsd: null, durationMs: null, error: `claude gave no JSON result (exit ${res.code ?? res.signal}): ${tail}` };
  }
  const costUsd = typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null;
  const durationMs = typeof out.duration_ms === 'number' ? out.duration_ms : null;
  if (out.is_error && typeof out.result === 'string' && LIMIT_TEXT.test(out.result)) {
    const limit = `The Claude plan limit is reached: ${out.result.slice(0, 300)}`;
    return { ok: false, proposal: null, costUsd, durationMs, error: limit, planLimit: limit };
  }
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
  // The proposal sends a feature title only to change it: a rename, also of a person's title.
  if (pr.title?.trim()) f.newTitle = pr.title;
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
    const n = Number(String(s.id).replace(/^SV?-/i, ''));
    if (!scopeIds.has(n)) {
      dropped.push(`scopes: no scope ${s.id} in F-${featureId}`);
      return false;
    }
    return true;
  }).map((s) => {
    const sid = s.id === undefined ? undefined : Number(String(s.id).replace(/^SV?-/i, ''));
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
      ...(Array.isArray(s.variations) && s.variations.length ? { variations: s.variations } : {}),
    };
  });
  if (scopes.length) f.scopes = scopes;
  // Scope names that apply can find: the scopes of this answer, the feature's scopes (S-id or title),
  // and old titles or IDs of scopes that a person renamed, moved or deleted (apply skips those with a note).
  // The same rule as apply: "S-12" or "S12" is an ID, other text is a title.
  const norm = (k: string) => {
    const m = /^SV?-?(\d+)$/i.exec(k.trim());
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
  // A scope with variations takes no test itself: a link names its variations (SV-ids). Apply refuses the
  // whole payload for such a link, so it is dropped here, with a note.
  const varied = new Set<string>();
  for (const s of scopes.filter((s) => s.variations?.length)) {
    varied.add(norm(s.title));
    if (s.id !== undefined) varied.add(`s-${s.id}`);
  }
  for (const x of db.prepare('SELECT id, title FROM scopes WHERE feature_id = ? AND columns IS NOT NULL').all(featureId) as any[]) {
    varied.add(`s-${x.id}`);
    varied.add(norm(String(x.title)));
  }
  for (const x of db.prepare('SELECT g.title_key FROM scope_titles_gone g JOIN scopes s ON s.id = g.scope_id WHERE g.feature_id = ? AND s.feature_id = g.feature_id AND s.columns IS NOT NULL').all(featureId) as any[])
    varied.add(String(x.title_key));
  // A new variation of this answer has no SV-id yet: a link can name it by its title, "<scope title> (<values>)".
  // Apply uses the new title of the answer, or the old one when a person wrote it: both are known.
  for (const s of scopes) {
    const cur = s.id !== undefined ? (db.prepare('SELECT title, columns FROM scopes WHERE id = ?').get(s.id) as any) : undefined;
    for (const v of (s.variations ?? []) as unknown[]) {
      try {
        const cols = cur?.columns ? jsonList(cur.columns) : [];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const k of Object.keys(v)) if (!cols.some((c) => c.toLowerCase() === k.replace(/\s+/g, ' ').trim().toLowerCase())) cols.push(k.replace(/\s+/g, ' ').trim());
        }
        const values = variationValues(cols, v);
        for (const t of [s.title, cur?.title].filter(Boolean)) known.add(norm(variationTitle(String(t).trim(), values)));
      } catch {
        // Values that apply refuses: apply says why in its report.
      }
    }
  }
  const tests = db.prepare('SELECT file, tags FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL');
  // An integration test (in an "Integration/" folder, or with an "@integration:" tag) needs another plugin.
  // It links only to a feature in an "Integration/<plugin>" group. The prompt says this too, but the model can ignore it.
  const group = db.prepare('SELECT g.title FROM features f LEFT JOIN feature_groups g ON g.id = f.group_id WHERE f.id = ?').get(featureId) as { title: string | null } | undefined;
  const integrationFeature = !!group?.title?.startsWith('Integration/');
  const isIntegrationTest = (row: { file: string; tags: string }) => {
    const tags = JSON.parse(row.tags || '[]') as string[];
    return row.file.startsWith('Integration/') || tags.some((t) => t === '@integration' || t.startsWith('@integration:'));
  };
  const linkOf = db.prepare('SELECT 1 FROM links WHERE project_id = ? AND feature_id = ? AND test_id = ? AND removed = 0');
  type LinkOut = { testId: string; scopes?: string[]; removeScopes?: string[]; remove?: boolean };
  const links = (pr.links ?? []).flatMap((l): LinkOut[] => {
    // A remove needs only a link of this feature: its test can be gone from the repo.
    if (l.remove) {
      if (!linkOf.get(p.id, featureId, l.testId)) return void dropped.push(`links: F-${featureId} has no link to ${l.testId}, so there is nothing to remove`), [];
      return [{ testId: l.testId, remove: true }];
    }
    const row = tests.get(p.id, l.testId) as { file: string; tags: string } | undefined;
    if (!row) return void dropped.push(`links: no test ${l.testId} in the last scan`), [];
    if (isIntegrationTest(row) && !integrationFeature) {
      return void dropped.push(`links: ${l.testId} not linked, because it is an integration test and F-${featureId} is not in an "Integration/" group`), [];
    }
    const keys = (l.scopes ?? []).map((k) => String(k).trim()).filter(Boolean);
    const good = keys.filter((k) => known.has(norm(k)) && !varied.has(norm(k)));
    for (const k of keys.filter((k) => !good.includes(k)))
      dropped.push(varied.has(norm(k)) ? `links: ${l.testId} names the scope "${k}", which has variations. Name its variations (SV-ids) instead` : `links: ${l.testId} names the scope "${k}", which is not in F-${featureId}`);
    const offKeys = (l.removeScopes ?? []).map((k) => String(k).trim()).filter(Boolean);
    const off = offKeys.filter((k) => known.has(norm(k)) && !varied.has(norm(k)));
    for (const k of offKeys.filter((k) => !off.includes(k))) dropped.push(`links: ${l.testId} removeScopes names "${k}", which is not a scope or variation of F-${featureId}`);
    // A new link whose scopes are all unknown would say only "about the feature".
    if (keys.length && !good.length && !off.length) return void dropped.push(`links: ${l.testId} not linked, because none of its scopes is in F-${featureId}`), [];
    return [{ testId: l.testId, ...(good.length ? { scopes: good } : {}), ...(off.length ? { removeScopes: off } : {}) }];
  });
  if (links.length) f.links = links;
  // Renames: an old test that this feature links, and a new test that is in the repo. Apply checks the rest.
  const renames = (pr.renames ?? []).flatMap((x) => {
    const from = String(x?.from ?? '').trim();
    const to = String(x?.to ?? '').trim();
    if (!linkOf.get(p.id, featureId, from)) return void dropped.push(`renames: F-${featureId} has no link to ${from || '(empty)'}`), [];
    const row = tests.get(p.id, to) as { file: string; tags: string } | undefined;
    if (!row) return void dropped.push(`renames: no test ${to || '(empty)'} in the last scan`), [];
    if (isIntegrationTest(row) && !integrationFeature)
      return void dropped.push(`renames: ${from} -> ${to} not moved, because ${to} is an integration test and F-${featureId} is not in an "Integration/" group`), [];
    return [{ from, to }];
  });
  if (renames.length) f.renames = renames;
  const codeRow = db.prepare('SELECT 1 FROM feature_code WHERE feature_id = ? AND file = ? AND function = ? AND removed = 0');
  const removeCode = (pr.removeCode ?? []).flatMap((x) => {
    const file = String(x?.file ?? '').trim();
    const fn = String(x?.function ?? '').trim();
    if (!codeRow.get(featureId, file, fn)) return void dropped.push(`removeCode: F-${featureId} has no code entry ${file || '(empty)'} ${fn || '(whole file)'}`), [];
    return [{ file, function: fn }];
  });
  if (removeCode.length) f.removeCode = removeCode;
  const marked = db.prepare('SELECT 1 FROM scopes s LEFT JOIN scopes p ON p.id = s.parent_id WHERE s.id = ? AND (s.remove_reason IS NOT NULL OR p.remove_reason IS NOT NULL)');
  const deleteScopes = (pr.deleteScopes ?? []).filter((k) => {
    const n = Number(String(k).replace(/^.*?SV?-/i, ''));
    if (!scopeIds.has(n)) return void dropped.push(`deleteScopes: no scope ${k} in F-${featureId}`), false;
    if (marked.get(n)) return void dropped.push(`deleteScopes: ${k} is marked "To remove": a person deletes it`), false;
    return true;
  });
  if (deleteScopes.length) f.deleteScopes = deleteScopes;
  // Screenshot changes: only screenshots of this feature, and only scopes that apply can find.
  const shotIds = new Set((db.prepare('SELECT id FROM screenshots WHERE feature_id = ? AND removed = 0').all(featureId) as any[]).map((x) => x.id as number));
  const shots = (pr.screenshots ?? []).flatMap((x) => {
    const n = Number(String(x.id ?? '').replace(/^.*?IMG-/i, ''));
    if (!shotIds.has(n)) return void dropped.push(`screenshots: no screenshot ${x.id} in F-${featureId}`), [];
    const scopesOk = (list: string[] | undefined, what: string) =>
      (list ?? []).filter((k) => {
        if (varied.has(norm(k))) return void dropped.push(`screenshots: ${x.id} ${what} names the scope "${k}", which has variations. Name its variations (SV-ids) instead`), false;
        const good = known.has(norm(k));
        if (!good) dropped.push(`screenshots: ${x.id} ${what} names "${k}", which is not in F-${featureId}`);
        return good;
      });
    const add = scopesOk(x.addScopes, 'addScopes');
    const off = scopesOk(x.removeScopes, 'removeScopes');
    const out = {
      id: n,
      ...(add.length ? { scopes: add } : {}),
      ...(off.length ? { removeScopes: off } : {}),
      ...(x.caption?.trim() ? { newCaption: x.caption.trim() } : {}),
      ...(x.remove ? { remove: true } : {}),
      ...(x.stale?.trim() ? { stale: x.stale.trim() } : {}),
    };
    return Object.keys(out).length > 1 ? [out] : [];
  });
  if (shots.length) f.screenshots = shots;
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
  if (mapLoopRunning(p.id)) throw new AiUpdateError('A mapping loop runs now. Start the AI update when it ends.');
  preparing.add(p.id);
  const ids: number[] = [];
  const rowOf = new Map<number, number>();
  let r: ChangeReport;
  try {
    // Let the caller (an HTTP request) answer first: the steps below can take some seconds.
    await new Promise((res) => setImmediate(res));
    r = o.report ?? changeReport(p, o.from, o.to);
    // Never a feature marked "To remove": apply would save nothing for it, so the model run is a waste.
    const marked = featuresToRemove(p.id);
    const asked = o.features?.length ? o.features : r.review.map((x) => x.featureId);
    const skip = asked.filter((id) => marked.has(id));
    if (skip.length) say(`Skipped, marked "To remove": ${skip.map((id) => `F-${id}`).join(', ')}`);
    ids.push(...asked.filter((id) => !marked.has(id)));
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
      const stop = o.shouldStop?.();
      if (stop) {
        say(`Stopped before F-${fid}: ${stop}`);
        break;
      }
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
        if (c.planLimit) {
          finish(id, { ...base(), status: 'failed', error: `${NOT_RUN}${c.planLimit}` });
        } else if (!c.ok || !c.proposal) {
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
      // The plan limit: the next features would stop at once too.
      if (c?.planLimit) break;
    }
  } finally {
    // Rows that did not end (an error outside the loop body) must not stay "waiting".
    for (const id of rowOf.values()) if (live.has(id)) finish(id, { status: 'failed', error: `${NOT_RUN}the update stopped before this feature` });
    code.done();
  }
  // The rows of the features that did not run, too: the caller keeps them for the next update.
  for (const fid of ids) if (!rows.some((r) => r.featureId === fid)) rows.push(toRow(db.prepare('SELECT * FROM ai_updates WHERE id = ?').get(rowOf.get(fid)!)));
  return rows;
}
