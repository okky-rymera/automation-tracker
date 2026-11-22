/**
 * The Claude plan limits of headless `claude -p` runs (the mapping loop, the AI update).
 *
 * The runs use the claude.ai login (the plan), the same plan as the user's own Claude sessions.
 * With `--output-format stream-json --verbose`, Claude Code writes a rate_limit_event line with the
 * use of each limit window. readPlanLine reads one line. notePlanUse keeps the highest use that a run
 * reported last, so the daily AI step (server/daily-sync.ts) can stop below the limit. It keeps it
 * in data/plan-use.json too: the dev server restarts on each saved file, and a restart must not
 * forget a high use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE } from './db.ts';

const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
const windowName = (k: unknown) => WINDOW_NAMES[String(k)] ?? String(k ?? 'plan').replace(/_/g, ' ');
const OK_STATUS = new Set(['allowed', 'allowed_warning']);

/** What one output line of `claude -p --output-format stream-json` says about the plan limits. */
export interface PlanLine {
  /** Set when the run must stop: the plan limit is reached, or extra usage (paid) started. */
  stop?: string;
  /** The plan use, for the log, for example "5-hour 24%, weekly 53%". */
  use?: string;
  /** The highest use (0 to 1) of the windows that apply to the model, and when that window resets (ms). */
  maxUse?: { value: number; window: string; resetsAt: number | null };
  /** The use of each window of the event, by its key (five_hour, seven_day_opus …). A full window has 1. */
  windows?: Record<string, { value: number; resetsAt: number | null }>;
}

/**
 * Reads a rate_limit_event line (Claude Code 2.1, checked on 20 Nov 2026):
 * { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: <unix s>,
 *   rateLimitType: "five_hour", isUsingOverage: false,
 *   unifiedWindows: { five_hour: { utilization: 0.24, resetsAt, status }, seven_day: {...} } } }
 * Each status other than "allowed" and "allowed_warning" stops the run. A limit of one model (for
 * example seven_day_opus) stops only a run of that model: a Sonnet run can go on when the Opus
 * limit is used up. Gives null for other lines.
 */
export function readPlanLine(line: string, model: string): PlanLine | null {
  if (!line.startsWith('{') || !line.includes('"rate_limit_event"')) return null;
  let v: any;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (v?.type !== 'rate_limit_event') return null;
  const info = v.rate_limit_info ?? {};
  const windows: [string, any][] = Object.entries(info.unifiedWindows ?? {});
  const use = windows
    .filter(([, w]) => typeof w?.utilization === 'number')
    .map(([k, w]) => `${windowName(k)} ${Math.round(w.utilization * 100)}%`)
    .join(', ');
  const out: PlanLine = use ? { use } : {};
  const all: Record<string, { value: number; resetsAt: number | null }> = {};
  for (const [k, w] of windows) {
    if (typeof w?.utilization !== 'number' && typeof w?.status !== 'string') continue;
    const full = typeof w?.status === 'string' && !OK_STATUS.has(w.status);
    all[k] = { value: full ? 1 : Number(w.utilization ?? 0), resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null };
  }
  if (typeof info.status === 'string' && !OK_STATUS.has(info.status) && info.rateLimitType) {
    all[String(info.rateLimitType)] = { value: 1, resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : all[String(info.rateLimitType)]?.resetsAt ?? null };
  }
  if (Object.keys(all).length) out.windows = all;
  const top = windows
    .filter(([k, w]) => appliesTo(k, model) && typeof w?.utilization === 'number')
    .sort((a, b) => b[1].utilization - a[1].utilization)[0];
  if (top) out.maxUse = { value: top[1].utilization, window: windowName(top[0]), resetsAt: typeof top[1].resetsAt === 'number' ? top[1].resetsAt * 1000 : null };
  const resets = (t: unknown) => (typeof t === 'number' ? ` It resets ${new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : '');
  if (info.isUsingOverage === true) {
    out.stop = 'The run started to use extra usage (paid, past the plan), so the loop stopped it.';
    return out;
  }
  const bad = windows.find(([k, w]) => appliesTo(k, model) && typeof w?.status === 'string' && !OK_STATUS.has(w.status));
  if (typeof info.status === 'string' && !OK_STATUS.has(info.status) && appliesTo(info.rateLimitType, model)) {
    out.stop = `The ${windowName(info.rateLimitType)} limit of the Claude plan is reached.${resets(info.resetsAt)}`;
  } else if (bad) {
    out.stop = `The ${windowName(bad[0])} limit of the Claude plan is reached.${resets(bad[1].resetsAt)}`;
  }
  // A stop: the window is full, and it resets at resetsAt.
  if (out.stop) {
    const t = typeof info.resetsAt === 'number' ? info.resetsAt : typeof bad?.[1]?.resetsAt === 'number' ? bad[1].resetsAt : null;
    out.maxUse = { value: 1, window: windowName(info.rateLimitType ?? bad?.[0]), resetsAt: t !== null ? t * 1000 : out.maxUse?.resetsAt ?? null };
  }
  return out;
}

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
/** A limit window applies to all models, or only to one model family (its name has the family). */
function appliesTo(windowKey: unknown, model: string): boolean {
  const k = String(windowKey ?? '').toLowerCase();
  const family = MODEL_FAMILIES.find((f) => k.includes(f));
  return !family || model.toLowerCase().includes(family);
}

/**
 * The plan limit message of Claude Code itself (a fallback when no event came), at the start of a
 * line: "You've hit your 5-hour limit", "Claude AI usage limit reached". Only at the start: a
 * report about a plugin setting (WooCommerce has a coupon "Usage limit") must not match.
 */
export const LIMIT_TEXT = /^\s*(?:You've hit your [\w -]*limit|You've reached your [\w -]*limit|Claude AI usage limit reached|Usage limit reached|You're out of usage)/i;

/** Next to the database, so a test on a copy of the database has its own file. */
const FILE = path.join(path.dirname(DB_FILE), 'plan-use.json');
/** The last reported use of each limit window, by its key. */
type Windows = Record<string, { value: number; resetsAt: number | null; at: number }>;
let windows: Windows = {};
let readMtime = -1;

/** Reads the file again when another process (a loop from the command line) wrote it. */
function load() {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (m === readMtime) return;
    readMtime = m;
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    windows = v && typeof v === 'object' && !Array.isArray(v) && !('value' in v) ? (v as Windows) : {};
  } catch {
    /* no file yet */
  }
}

/** Keeps the use of each window of a rate_limit_event line. */
export function notePlanUse(line: PlanLine | null) {
  if (!line?.windows) return;
  load();
  const at = Date.now();
  for (const [k, w] of Object.entries(line.windows)) windows[k] = { ...w, at };
  try {
    fs.writeFileSync(FILE, JSON.stringify(windows));
    readMtime = fs.statSync(FILE).mtimeMs;
  } catch {
    /* only a help: the next event sets it again */
  }
}

/**
 * The highest last-reported use of the windows that apply to the model, or null. A window that has
 * reset since does not count. The weekly Opus window does not stop a Sonnet run.
 */
export function planUse(model: string) {
  load();
  const now = Date.now();
  let top: { value: number; window: string; resetsAt: number | null; at: number } | null = null;
  for (const [k, w] of Object.entries(windows)) {
    if (!appliesTo(k, model)) continue;
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    if (!top || w.value > top.value) top = { value: w.value, window: windowName(k), resetsAt: w.resetsAt, at: w.at };
  }
  return top;
}
