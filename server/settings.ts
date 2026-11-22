/**
 * Tracker settings that a person changes on the Settings screen (all projects).
 *
 * Each setting has a default, and can have a value in the database (table settings). An environment
 * variable that is set wins over both: the Settings screen shows that setting as locked, with the
 * variable name. An environment value keeps the meaning it had before the Settings screen: an on/off
 * variable is off only for off, false, 0 or no; a number counts when it is above 0, also outside the
 * limits of the screen (for example 0.5 hours for a trial); the model can be any model name. A value
 * that cannot be read is ignored, with a line in the server log and a note on the Settings screen. The code reads a setting each time it needs it, so a change works at once, with no
 * restart of the server.
 */
import { db, now } from './db.ts';

type Kind = 'bool' | 'number' | 'choice';

interface Def {
  key: string;
  env: string;
  group: string;
  label: string;
  help: string;
  kind: Kind;
  default: boolean | number | string;
  min?: number;
  max?: number;
  /** A whole number. */
  int?: boolean;
  unit?: string;
  choices?: { value: string; label: string }[];
  /** Reads an environment value. Null: the value cannot be read, so it does not count. */
  fromEnv?: (v: string) => boolean | number | string | null;
}

/** As before the Settings screen: each value other than off, false, 0 or no is on. */
const bool = (v: string) => !/^(off|false|0|no)$/i.test(v.trim());

export const SETTINGS: Def[] = [
  {
    key: 'dailySync', env: 'TRACKER_DAILY_SYNC', group: 'Daily sync', kind: 'bool', default: true, fromEnv: bool,
    label: 'Sync each project once a day',
    help: 'The server syncs each project with sync on when it is due, with the tests on "when code changed". Off: only a person starts a sync.',
  },
  {
    key: 'dailySyncHours', env: 'TRACKER_DAILY_SYNC_HOURS', group: 'Daily sync', kind: 'number', default: 24, min: 1, max: 168, unit: 'hours',
    label: 'Time between 2 syncs of a project',
    help: 'A project is due this many hours after its last sync started.',
  },
  {
    key: 'dailyAi', env: 'TRACKER_DAILY_AI', group: 'AI step after the sync', kind: 'bool', default: true, fromEnv: bool,
    label: 'Run the AI after the daily sync',
    help: 'After the syncs, Claude checks the changed features and maps the next units of each project. It uses your Claude plan. Off: the AI runs only when you press its buttons.',
  },
  {
    key: 'dailyAiModel', env: 'TRACKER_DAILY_AI_MODEL', group: 'AI step after the sync', kind: 'choice', default: 'sonnet', fromEnv: (v) => v.trim() || null,
    choices: [{ value: 'sonnet', label: 'Sonnet (uses less of the plan)' }, { value: 'opus', label: 'Opus (more detail)' }],
    label: 'Model',
    help: 'The model of the daily AI step. The buttons on the "Map with AI" and Sync screens have their own choice.',
  },
  {
    key: 'dailyAiUnits', env: 'TRACKER_DAILY_AI_UNITS', group: 'AI step after the sync', kind: 'number', default: 10, min: 1, max: 200, int: true, unit: 'units',
    label: 'Mapping units for each project each day',
    help: 'One unit is one test file or one code area. A unit takes about 2 to 5 minutes and $0.20 to $0.60 of plan use with Sonnet.',
  },
  {
    key: 'dailyAiMaxUse', env: 'TRACKER_DAILY_AI_MAX_USE', group: 'AI step after the sync', kind: 'number', default: 80, min: 10, max: 100, int: true, unit: '%',
    label: 'Stop at this plan use',
    help: 'The AI step waits when a run reports this use of the 5-hour or weekly limit, or more, until that limit resets. The rest of the plan stays free for your own Claude sessions.',
  },
  {
    key: 'fullRunDays', env: 'TRACKER_FULL_RUN_DAYS', group: 'Test runs', kind: 'number', default: 7, min: 1, max: 90, unit: 'days',
    label: 'Full test run each',
    help: 'Between full runs, a sync runs only the tests that the changed code touches. A full run tests the library changes again.',
  },
  {
    key: 'libraryShare', env: 'TRACKER_LIBRARY_SHARE', group: 'Test runs', kind: 'number', default: 90, min: 50, max: 100, int: true, unit: '%',
    fromEnv: (v) => {
      // The variable is a share (0.9); the screen shows a percent (90).
      const n = Number.parseFloat(v);
      return n > 0 && n <= 1 ? n * 100 : null;
    },
    label: 'Library code limit',
    help: 'A changed function that this share of the tests runs, or more, is library code (start-up, hooks). It selects no test until the next full run.',
  },
  {
    key: 'testWorkers', env: 'TRACKER_TEST_WORKERS', group: 'Test runs', kind: 'number', default: 0, min: 0, max: 8, int: true, unit: 'sites',
    label: 'Test sites at the same time',
    help: '0: automatic (half the CPUs, at most 4). All sites share one PHP server: more sites can make requests slow and tests time out.',
  },
];

const byKey = new Map(SETTINGS.map((d) => [d.key, d]));

function check(d: Def, v: unknown): boolean | number | string {
  if (d.kind === 'bool') {
    if (typeof v !== 'boolean') throw new SettingError(`${d.label}: send true or false`);
    return v;
  }
  if (d.kind === 'choice') {
    if (!d.choices!.some((c) => c.value === v)) throw new SettingError(`${d.label}: send one of ${d.choices!.map((c) => c.value).join(', ')}`);
    return v as string;
  }
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || (d.int && !Number.isInteger(n)) || n < d.min! || n > d.max!) {
    throw new SettingError(`${d.label}: send a ${d.int ? 'whole ' : ''}number from ${d.min} to ${d.max}`);
  }
  return n;
}

export class SettingError extends Error {}

/** Environment values that could not be read, by setting key, logged once. */
const ignored = new Map<string, string>();

function envValue(d: Def): boolean | number | string | null {
  const raw = process.env[d.env];
  if (raw === undefined || raw.trim() === '') return null;
  let v: boolean | number | string | null;
  if (d.fromEnv) v = d.fromEnv(raw);
  else if (d.kind === 'number') {
    const n = Number.parseFloat(raw);
    v = Number.isFinite(n) && n > 0 ? (d.int ? Math.max(1, Math.round(n)) : n) : null;
  } else v = raw.trim();
  if (v === null) {
    if (!ignored.has(d.key)) console.warn(`Setting "${d.label}": ${d.env}=${raw} cannot be read, so it is ignored.`);
    ignored.set(d.key, raw);
    return null;
  }
  ignored.delete(d.key);
  return v;
}

function stored(key: string): unknown {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  if (!r) return undefined;
  try {
    return JSON.parse(r.value);
  } catch {
    return undefined;
  }
}

/** The value of a setting now: the environment, else the database, else the default. */
export function setting<T extends boolean | number | string>(key: string): T {
  const d = byKey.get(key);
  if (!d) throw new Error(`No setting ${key}`);
  const e = envValue(d);
  if (e !== null) return e as T;
  const s = stored(key);
  if (s !== undefined) {
    try {
      return check(d, s) as T;
    } catch {
      /* an old, bad value: use the default */
    }
  }
  return d.default as T;
}

/** All settings for the Settings screen. */
export function listSettings() {
  return SETTINGS.map(({ fromEnv, ...d }) => {
    const locked = envValue(byKey.get(d.key)!) !== null;
    return { ...d, value: setting(d.key), locked, changed: stored(d.key) !== undefined, envIgnored: ignored.get(d.key) ?? null };
  });
}

/** Saves the given settings (key: value). null puts a setting back to its default. Throws SettingError. */
export function saveSettings(body: Record<string, unknown>) {
  const rows: [string, string | null][] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    const d = byKey.get(k);
    if (!d) throw new SettingError(`No setting ${k}`);
    if (envValue(d) !== null) throw new SettingError(`${d.label} is set by ${d.env} in the environment of the server. Remove the variable to change it here.`);
    rows.push([k, v === null ? null : JSON.stringify(check(d, v))]);
  }
  const put = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const [k, v] of rows) (v === null ? del.run(k) : put.run(k, v, now()));
  return listSettings();
}
