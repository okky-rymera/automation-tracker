/**
 * Command line tool for the feature-mapping skill (.claude/skills/map-features).
 * The skill takes one unit at a time: one Playwright spec file, one Cypress
 * .feature file, or one code area. It writes features (with their lists, labels
 * and scopes) and links,
 * and marks the unit as processed, in one transaction.
 *
 *   npm run -s map -- status   <project>
 *   npm run -s map -- next     <project> playwright|cypress|code
 *   npm run -s map -- features <project>
 *   npm run -s map -- feature  <project> <feature id> [--all]
 *   npm run -s map -- code     <project> <repo file>
 *   npm run -s map -- apply    <project> <payload.json>
 *   npm run -s map -- skip     <project> <kind> <ref> <reason> [--files a.php,b.php]  (--files is needed for code)
 *   npm run -s map -- reset    <project> <kind> <ref>
 *
 * Output is JSON, so the skill can read it. Rules that protect people's work:
 *  - Text that a person wrote or checked is never replaced or removed. Empty fields can be filled.
 *    Each field has its own AI mark (ai_fields), so filling one empty field gives no right to change another.
 *  - Labels, list items, scopes and link scopes are only added.
 *  - A link that a person removed is never added again.
 *  - Links made here have source "ai", so the app can show them as AI links.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, json, now, tx } from './db.ts';
import { getProject, importProjectsJson, safeRepoPath, type ProjectConfig } from './projects.ts';
import { syncProject } from './scan.ts';
import { EditError, ITEM_KINDS, LABEL_KINDS, PRIORITIES, labelValue, labelsInUse } from './features.ts';
import { loadCoverage } from './coverage.ts';
import { listPlaywright } from './playwright.ts';

type Kind = 'playwright' | 'cypress' | 'code';
const KINDS: Kind[] = ['playwright', 'cypress', 'code'];
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function projectOf(id: string | undefined): ProjectConfig {
  if (!id) fail('Give the project ID. "npm run project -- list" shows them.');
  const p = getProject(id);
  if (!p) fail(`Unknown project "${id}". "npm run project -- list" shows them.`);
  return p;
}
const kindOf = (k: string | undefined): Kind => (KINDS.includes(k as Kind) ? (k as Kind) : fail(`Kind must be one of: ${KINDS.join(', ')}`));

/** Repo-relative path of a test file (the tests table keeps it relative to the framework folder). */
function testRepoPath(p: ProjectConfig, kind: 'playwright' | 'cypress', file: string) {
  const dir = kind === 'playwright' ? p.playwrightDir : p.cypressDir;
  return dir ? path.posix.join(dir, file) : file;
}

/**
 * Absolute path of a repo-relative file the skill may read: any file type, but
 * inside the repo and not hidden (.git, .env). The file can be missing.
 */
function repoFile(p: ProjectConfig, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part.startsWith('.'))) return null;
  const root = path.resolve(p.path);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null; // symlink that leaves the repo
  } catch {
    /* missing file: allowed, it hashes as empty */
  }
  return full;
}

/** One hash of the files' contents. A missing file counts as empty. */
function hashFiles(p: ProjectConfig, files: string[]) {
  const h = crypto.createHash('sha1');
  for (const f of [...files].sort()) {
    const full = repoFile(p, f);
    h.update(f + '\0');
    if (full && fs.existsSync(full) && fs.statSync(full).isFile()) h.update(fs.readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex');
}

interface Unit {
  kind: Kind;
  ref: string;
  status: string;
  files: string[];
  hash: string;
  features: number[];
  note: string;
  processed_at: string;
}
function units(projectId: string, kind?: Kind): Unit[] {
  const rows = (kind
    ? db.prepare('SELECT * FROM processed_units WHERE project_id = ? AND kind = ?').all(projectId, kind)
    : db.prepare('SELECT * FROM processed_units WHERE project_id = ?').all(projectId)) as any[];
  return rows.map((r) => ({ ...r, files: json(r.files), features: json(r.features) }));
}

function linksOf(projectId: string, testId: string) {
  return db
    .prepare(
      `SELECT l.id, l.feature_id AS featureId, f.title AS feature, l.source, l.removed
       FROM links l JOIN features f ON f.id = l.feature_id
       WHERE l.project_id = ? AND l.test_id = ?`,
    )
    .all(projectId, testId)
    .map(({ id, ...l }: any) => ({ ...l, removed: !!l.removed, scopes: scopeNames(id) }));
}

/** Test files of one framework, with their state against processed_units. */
function testFiles(p: ProjectConfig, kind: 'playwright' | 'cypress') {
  const rows = db
    .prepare('SELECT id, file, title, line, tags, data, first_seen FROM tests WHERE project_id = ? AND framework = ? AND removed_at IS NULL ORDER BY file, line')
    .all(p.id, kind) as any[];
  const byFile = new Map<string, any[]>();
  for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const done = new Map(units(p.id, kind).map((u) => [u.ref, u]));
  return [...byFile.entries()].map(([file, tests]) => {
    const repoFile = testRepoPath(p, kind, file);
    const unit = done.get(file);
    // Compare against the same files the unit saved (the test file, plus any extra files).
    const state = !unit ? 'new' : unit.hash !== hashFiles(p, unit.files.length ? unit.files : [repoFile]) ? 'changed' : unit.status;
    return { file, repoFile, tests, unit, state };
  });
}

// ---- Commands ----

function status(p: ProjectConfig) {
  const res: Record<string, unknown> = {};
  for (const kind of ['playwright', 'cypress'] as const) {
    const files = testFiles(p, kind);
    const count = (s: string) => files.filter((f) => f.state === s).length;
    res[kind] = { files: files.length, done: count('done'), skipped: count('skipped'), changed: count('changed'), new: count('new') };
  }
  const code = units(p.id, 'code');
  const php = (db.prepare("SELECT COUNT(*) AS n FROM source_files WHERE project_id = ? AND lang = 'php'").get(p.id) as any).n;
  const phpSet = new Set((db.prepare("SELECT path FROM source_files WHERE project_id = ? AND lang = 'php'").all(p.id) as any[]).map((r) => r.path));
  const covered = new Set(code.flatMap((u) => u.files).filter((f) => phpSet.has(f)));
  res.code = { areas: code.length, phpFiles: php, phpFilesInAreas: covered.size, changed: code.filter((u) => u.hash !== hashFiles(p, u.files)).map((u) => u.ref) };
  const f = db.prepare("SELECT COUNT(*) AS n, SUM(ai_fields <> '[]') AS ai FROM features WHERE project_id = ?").get(p.id) as any;
  res.features = { total: f.n, aiDraft: f.ai ?? 0 };
  out(res);
}

function next(p: ProjectConfig, kind: Kind) {
  if (kind === 'code') return nextCode(p);
  const files = testFiles(p, kind);
  // Changed files first: they keep done work true. Then new files.
  const pick = files.find((f) => f.state === 'changed') ?? files.find((f) => f.state === 'new');
  if (!pick) return out({ kind, done: true, message: `Every ${kind} file is processed and has not changed since.` });
  const since = pick.unit?.processed_at;
  out({
    kind,
    ref: pick.file,
    repoFile: pick.repoFile,
    absPath: path.join(p.path, pick.repoFile),
    state: pick.state,
    previous: pick.unit ? { processedAt: pick.unit.processed_at, status: pick.unit.status, features: pick.unit.features, note: pick.unit.note } : null,
    remaining: { new: files.filter((f) => f.state === 'new').length, changed: files.filter((f) => f.state === 'changed').length },
    tests: pick.tests.map((t) => {
      const d = json(t.data);
      return {
        id: t.id,
        title: t.title,
        line: t.line,
        context: kind === 'playwright' ? (d.describes ?? []).join(' > ') : d.feature,
        tags: json(t.tags),
        newSinceLastTime: since ? t.first_seen > since : undefined,
        links: linksOf(p.id, t.id),
      };
    }),
  });
}

/** PHP files that no code area holds yet, most untested functions first. */
function nextCode(p: ProjectConfig) {
  const inAreas = new Set(units(p.id, 'code').flatMap((u) => u.files));
  const php = (db.prepare("SELECT path FROM source_files WHERE project_id = ? AND lang = 'php' ORDER BY path").all(p.id) as any[]).map((r) => r.path as string);
  const cov = loadCoverage(p);
  const list = php
    .filter((f) => !inAreas.has(f))
    .map((f) => {
      const fns = cov?.functionsByFile.get(f) ?? [];
      const by = (s: string) => fns.filter((x) => x.state === s).length;
      return { file: f, functions: fns.length, tested: by('tested'), notTested: fns.length - by('tested') - by('library'), never: by('never') };
    })
    .sort((a, b) => b.notTested - a.notTested || a.file.localeCompare(b.file));
  out({
    kind: 'code',
    coverageRun: p.coverageRun ?? null,
    message: list.length
      ? 'Pick one plugin feature or settings area. Read the files it needs, then name the area as the unit ref.'
      : 'Every PHP file is in a processed code area.',
    remainingFiles: list.length,
    candidates: list.slice(0, 20),
  });
}

/** Functions in one repo file, with their coverage state and the Playwright tests that ran them. */
function code(p: ProjectConfig, file: string | undefined) {
  if (!file || !safeRepoPath(p, file)) fail('Give a file path relative to the plugin repo.');
  const cov = loadCoverage(p);
  const runToTest = new Map<string, string>();
  for (const t of listPlaywright(p)) for (const r of t.run ?? []) runToTest.set(r.runId, t.id);
  const fns = cov?.functionsByFile.get(file) ?? [];
  out({
    file,
    coverageRun: p.coverageRun ?? null,
    functions: fns.map((fn) => {
      const tests = [...new Set(fn.tests.map((t) => runToTest.get(t)).filter(Boolean))] as string[];
      // Library code runs on every request, so its test list says nothing about one feature.
      if (fn.state === 'library') return { name: fn.function, lines: `${fn.start}-${fn.end}`, state: fn.state, testCount: tests.length };
      return {
        name: fn.function,
        lines: `${fn.start}-${fn.end}`,
        state: fn.state,
        tests: tests.map((id) => ({ id, links: linksOf(p.id, id).filter((l) => !l.removed).map((l) => `F-${l.featureId} ${l.feature}`) })),
      };
    }),
  });
}

const SCOPE_RE = /^S-?(\d+)$/i;
const scopeNames = (linkId: number) =>
  (db.prepare('SELECT s.id, s.title FROM link_scopes ls JOIN scopes s ON s.id = ls.scope_id WHERE ls.link_id = ? ORDER BY s.id').all(linkId) as any[]).map(
    (s) => `S-${s.id} ${s.title}`,
  );
const labelsOf = (fid: number, kind: string) =>
  (db.prepare('SELECT value FROM feature_labels WHERE feature_id = ? AND kind = ? ORDER BY value COLLATE NOCASE').all(fid, kind) as any[]).map((r) => r.value as string);
const itemsOf = (fid: number, kind: string) =>
  (db.prepare('SELECT id, text, ai_draft FROM feature_items WHERE feature_id = ? AND kind = ? ORDER BY sort, id').all(fid, kind) as any[]).map((i) => ({
    id: i.id as number,
    text: i.text as string,
    aiDraft: !!i.ai_draft,
  }));

function features(p: ProjectConfig) {
  const groups = db.prepare('SELECT id, title FROM feature_groups WHERE project_id = ? ORDER BY sort, id').all(p.id) as any[];
  const rows = db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY sort, id').all(p.id) as any[];
  out({
    groups: groups.map((g) => g.title),
    // Use these spellings, so one role or need does not show two times.
    labelsInUse: Object.fromEntries(Object.entries(LABEL_KINDS).map(([key, kind]) => [key, labelsInUse(p.id, kind).slice(0, 40).map((l) => l.value)])),
    features: rows.map((f) => ({
      id: f.id,
      title: f.title,
      group: groups.find((g) => g.id === f.group_id)?.title ?? null,
      aiFields: json(f.ai_fields),
      ...(f.description ? { description: f.description.length > 160 ? `${f.description.slice(0, 160)}… (cut: see "feature")` : f.description } : {}),
      roles: labelsOf(f.id, LABEL_KINDS.roles),
      scopes: (db.prepare('SELECT id, title FROM scopes WHERE feature_id = ? ORDER BY sort, id').all(f.id) as any[]).map((s) => `S-${s.id} ${s.title}`),
      links: (db.prepare('SELECT COUNT(*) AS n FROM links WHERE feature_id = ? AND removed = 0').get(f.id) as any).n,
    })),
  });
}

function feature(p: ProjectConfig, id: string | undefined, all = false) {
  const f = db.prepare('SELECT * FROM features WHERE id = ? AND project_id = ?').get(Number(id), p.id) as any;
  if (!f) fail(`No feature ${id} in project ${p.id}`);
  const links = db
    .prepare(
      `SELECT l.id, l.test_id AS testId, t.title, t.framework, l.source, l.removed
       FROM links l LEFT JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id WHERE l.feature_id = ? ORDER BY l.id`,
    )
    .all(f.id) as any[];
  out({
    id: f.id,
    title: f.title,
    group: (db.prepare('SELECT title FROM feature_groups WHERE id = ?').get(f.group_id) as any)?.title ?? null,
    description: f.description,
    priority: f.priority,
    aiFields: json(f.ai_fields),
    ...Object.fromEntries(Object.entries(LABEL_KINDS).map(([key, kind]) => [key, labelsOf(f.id, kind)])),
    ...Object.fromEntries(Object.entries(ITEM_KINDS).map(([key, kind]) => [key, itemsOf(f.id, kind)])),
    scopes: (db.prepare('SELECT id, title, description, ai_fields FROM scopes WHERE feature_id = ? ORDER BY sort, id').all(f.id) as any[]).map((s) => ({
      id: `S-${s.id}`, title: s.title, description: s.description, aiFields: json(s.ai_fields),
    })),
    links: links.slice(0, all ? undefined : 25).map((l) => ({
      testId: l.testId, title: l.title, framework: l.framework, source: l.source, removed: !!l.removed, scopes: scopeNames(l.id),
    })),
    linkCount: links.length,
    ...(all || links.length <= 25 ? {} : { note: 'At most 25 links shown. Add --all to see every link.' }),
  });
}

// ---- apply ----

type ItemIn = string | { id: number; text: string };
interface LinkIn {
  testId: string;
  /** Scopes the test checks: titles or S-ids. */
  scopes?: (string | number)[];
  scope?: string | number;
}
interface FeatureIn {
  id?: number;
  title?: string;
  group?: string;
  description?: string;
  priority?: string;
  roles?: string[];
  needs?: string[];
  rules?: ItemIn[];
  outOfScope?: ItemIn[];
  where?: ItemIn[];
  questions?: ItemIn[];
  /** IDs of list items to delete (only AI draft items). */
  removeItems?: number[];
  scopes?: { id?: number | string; title: string; description?: string }[];
  links?: LinkIn[];
}
interface Payload {
  unit: { kind: Kind; ref: string; files?: string[]; note?: string };
  features: FeatureIn[];
}

const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = <T>(v: unknown, what: string): T[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new EditError(`${what} must be a list`);
  return v as T[];
};

function apply(p: ProjectConfig, file: string | undefined) {
  if (!file) fail('Give the path of the payload JSON file.');
  let body: Payload;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Cannot read ${file}: ${(e as Error).message}`);
  }
  const unit = body.unit ?? ({} as Payload['unit']);
  const kind = kindOf(unit.kind);
  const ref = str(unit.ref, 500);
  if (!ref) fail('unit.ref is empty');
  if (!Array.isArray(body.features) || !body.features.length) fail('features is empty. Use the skip command for a unit with no feature.');

  // Files the unit read: the test file, or the code files of the area.
  let files = (unit.files ?? []).map((f) => str(f, 500)).filter(Boolean);
  if (kind !== 'code') {
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND framework = ? AND file = ? AND removed_at IS NULL').get(p.id, kind, ref))
      fail(`No ${kind} file "${ref}" in the last scan. Use the ref that "next" gave.`);
    files = [...new Set([testRepoPath(p, kind, ref), ...files])];
  } else if (!files.length) fail('A code unit needs unit.files: the repo files that the area uses.');
  for (const f of files) {
    const full = repoFile(p, f);
    if (!full) fail(`File path is outside the plugin repo, or hidden: ${f}`);
    if (!fs.existsSync(full)) fail(`No file ${f} in the plugin repo. Give paths relative to the repo root.`);
  }

  const report: string[] = [];
  const touched: number[] = [];
  try {
    tx(() => {
      for (const inF of body.features) {
        const fid = writeFeature(p, inF, report);
        touched.push(fid);
        for (const [key, kind] of Object.entries(LABEL_KINDS)) writeLabels(p, fid, kind, list<string>((inF as any)[key], key), report);
        // Remove first: a payload that removes an item and adds the same text again keeps the text.
        removeItems(fid, list<number>(inF.removeItems, 'removeItems'), report);
        for (const [key, kind] of Object.entries(ITEM_KINDS)) writeItems(fid, kind, list<ItemIn>((inF as any)[key], key), report);
        const scopeIds = new Map<string, number>();
        for (const s of list<FeatureIn['scopes'] & {}>(inF.scopes, 'scopes') as any[]) {
          const sid = writeScope(fid, s, report);
          scopeIds.set(str(s.title).toLowerCase(), sid);
        }
        for (const l of list<LinkIn>(inF.links, 'links')) writeLink(p, fid, l, scopeIds, report);
      }
      db.prepare(
        `INSERT INTO processed_units (project_id, kind, ref, status, files, hash, features, note, processed_at)
         VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, kind, ref) DO UPDATE SET status = 'done', files = excluded.files, hash = excluded.hash,
           features = excluded.features, note = excluded.note, processed_at = excluded.processed_at`,
      ).run(p.id, kind, ref, JSON.stringify(files), hashFiles(p, files), JSON.stringify([...new Set(touched)]), str(unit.note), now());
    });
  } catch (e) {
    if (e instanceof EditError) fail(`${e.message}. Nothing was saved.`);
    throw e;
  }
  out({ saved: true, unit: { kind, ref }, features: [...new Set(touched)].map((id) => `F-${id}`), report });
}

function groupId(p: ProjectConfig, title: string | undefined): number | null | undefined {
  const t = str(title, 200);
  if (!t) return undefined;
  const g = db.prepare('SELECT id FROM feature_groups WHERE project_id = ? AND lower(title) = lower(?)').get(p.id, t) as any;
  if (g) return g.id;
  const n = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM feature_groups WHERE project_id = ?').get(p.id) as any).n;
  return Number(db.prepare('INSERT INTO feature_groups (project_id, title, sort) VALUES (?, ?, ?)').run(p.id, t, n).lastInsertRowid);
}

/**
 * Sets one field only if it is empty, or if the AI skill wrote it and no person
 * checked it (the field is in ai). Adds the field to ai when it writes. Returns true when it changed.
 */
function setText(table: 'features' | 'scopes', row: any, ai: Set<string>, field: string, col: string, value: string | number | null, label: string, report: string[]) {
  if (value === '' || value === null || value === undefined || row[col] === value) return false;
  const empty = row[col] === '' || row[col] === null;
  if (!empty && !ai.has(field)) {
    report.push(`${label}: kept the ${field} that a person wrote or checked. Suggested ${field} was not saved.`);
    return false;
  }
  if (!empty) report.push(`${label}: replaced the earlier AI draft ${field}.`);
  else if (!row.isNew) report.push(`${label}: filled the empty ${field}. It shows as AI draft until a person checks it.`);
  db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(value, row.id);
  ai.add(field);
  return true;
}
const saveAi = (table: 'features' | 'scopes', id: number, ai: Set<string>) =>
  db.prepare(`UPDATE ${table} SET ai_fields = ? WHERE id = ?`).run(JSON.stringify([...ai].sort()), id);

/** Title, description, priority and group. The lists, labels, scopes and links are written after it. */
function writeFeature(p: ProjectConfig, f: FeatureIn, report: string[]): number {
  const priority = str(f.priority).toLowerCase();
  if (!PRIORITIES.includes(priority)) throw new EditError(`Priority "${f.priority}" must be high, medium, low or empty`);
  const g = groupId(p, f.group);
  let row: any;
  if (f.id) {
    row = db.prepare('SELECT * FROM features WHERE id = ? AND project_id = ?').get(Number(f.id), p.id);
    if (!row) throw new EditError(`No feature F-${f.id} in this project`);
  } else {
    const title = str(f.title, 2000);
    if (!title) throw new EditError('A new feature needs a title');
    const same = db.prepare('SELECT id FROM features WHERE project_id = ? AND lower(title) = lower(?)').get(p.id, title) as any;
    if (same) throw new EditError(`Feature F-${same.id} already has the title "${title}". Give "id": ${same.id} to add to it`);
    const n = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM features WHERE project_id = ?').get(p.id) as any).n;
    const id = db.prepare(`INSERT INTO features (project_id, title, sort, ai_fields) VALUES (?, ?, ?, '["title"]')`).run(p.id, title, n).lastInsertRowid;
    row = { ...(db.prepare('SELECT * FROM features WHERE id = ?').get(id) as any), isNew: true };
    report.push(`F-${row.id}: new feature "${title}".`);
  }
  const label = `F-${row.id}`;
  const ai = new Set<string>(json(row.ai_fields));
  if (f.id && f.title) setText('features', row, ai, 'title', 'title', str(f.title, 2000), label, report);
  setText('features', row, ai, 'description', 'description', str(f.description), label, report);
  setText('features', row, ai, 'priority', 'priority', priority, label, report);
  if (g !== undefined) setText('features', row, ai, 'group', 'group_id', g, label, report);
  saveAi('features', row.id, ai);
  return row.id;
}

/** Labels are only added. The project's spelling of a value wins. */
function writeLabels(p: ProjectConfig, fid: number, kind: string, values: string[], report: string[]) {
  const added: string[] = [];
  for (const v of values) {
    const value = labelValue(p.id, kind, v);
    if (db.prepare('INSERT OR IGNORE INTO feature_labels (feature_id, kind, value) VALUES (?, ?, ?)').run(fid, kind, value).changes) added.push(value);
  }
  if (added.length) report.push(`F-${fid}: added ${kind} ${added.map((a) => `"${a}"`).join(', ')}.`);
}

/** A string adds an item (the same text again adds nothing). { id, text } changes an AI draft item. */
function writeItems(fid: number, kind: string, values: ItemIn[], report: string[]) {
  for (const v of values) {
    if (typeof v === 'string') {
      const t = str(v, 2000);
      if (!t) continue;
      if (db.prepare('SELECT 1 FROM feature_items WHERE feature_id = ? AND kind = ? AND lower(text) = lower(?)').get(fid, kind, t)) continue;
      const n = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM feature_items WHERE feature_id = ?').get(fid) as any).n;
      const id = db.prepare('INSERT INTO feature_items (feature_id, kind, text, sort, ai_draft) VALUES (?, ?, ?, ?, 1)').run(fid, kind, t, n).lastInsertRowid;
      report.push(`F-${fid}: new ${kind} item #${id}.`);
    } else if (v && typeof v === 'object') {
      const row = db.prepare('SELECT * FROM feature_items WHERE id = ? AND feature_id = ? AND kind = ?').get(Number(v.id), fid, kind) as any;
      if (!row) throw new EditError(`No ${kind} item #${v.id} in F-${fid}`);
      const t = str(v.text, 2000);
      if (!t || t === row.text) continue;
      if (!row.ai_draft) report.push(`F-${fid}: kept the ${kind} item #${row.id} that a person wrote or checked.`);
      else {
        db.prepare('UPDATE feature_items SET text = ? WHERE id = ?').run(t, row.id);
        report.push(`F-${fid}: changed AI draft ${kind} item #${row.id}.`);
      }
    } else throw new EditError(`A ${kind} item must be text or { "id", "text" }`);
  }
}

function removeItems(fid: number, ids: number[], report: string[]) {
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM feature_items WHERE id = ? AND feature_id = ?').get(Number(id), fid) as any;
    if (!row) throw new EditError(`No list item #${id} in F-${fid}`);
    if (!row.ai_draft) report.push(`F-${fid}: kept item #${id}: a person wrote or checked it. Name the problem in "questions".`);
    else {
      db.prepare('DELETE FROM feature_items WHERE id = ?').run(row.id);
      report.push(`F-${fid}: removed AI draft item #${id}.`);
    }
  }
}

function writeScope(fid: number, s: { id?: number | string; title: string; description?: string }, report: string[]): number {
  const title = str(s.title, 2000);
  if (!title) throw new EditError(`A scope of F-${fid} has no title`);
  const sid = s.id !== undefined ? Number(SCOPE_RE.exec(String(s.id))?.[1] ?? s.id) : null;
  let row: any = sid
    ? db.prepare('SELECT * FROM scopes WHERE id = ? AND feature_id = ?').get(sid, fid)
    : db.prepare('SELECT * FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, title);
  if (sid && !row) throw new EditError(`No scope S-${sid} in feature F-${fid}`);
  if (!row) {
    const n = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM scopes WHERE feature_id = ?').get(fid) as any).n;
    const desc = str(s.description);
    const id = db
      .prepare('INSERT INTO scopes (feature_id, title, description, sort, ai_fields) VALUES (?, ?, ?, ?, ?)')
      .run(fid, title, desc, n, JSON.stringify(desc ? ['description', 'title'] : ['title'])).lastInsertRowid;
    report.push(`F-${fid}: new scope S-${id} "${title}".`);
    return Number(id);
  }
  const label = `S-${row.id}`;
  const ai = new Set<string>(json(row.ai_fields));
  setText('scopes', row, ai, 'title', 'title', title, label, report);
  setText('scopes', row, ai, 'description', 'description', str(s.description), label, report);
  saveAi('scopes', row.id, ai);
  return row.id;
}

function writeLink(p: ProjectConfig, fid: number, l: LinkIn, scopeIds: Map<string, number>, report: string[]) {
  const testId = str(l.testId, 100);
  if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL').get(p.id, testId))
    throw new EditError(`Unknown test ${testId}. Use the test IDs that "next" or "code" gave`);
  const keys = [...list<string | number>(l.scopes, `scopes of ${testId}`), ...(l.scope !== undefined && l.scope !== null ? [l.scope] : [])]
    .map((k) => String(k).trim())
    .filter(Boolean);
  const want = [
    ...new Set(
      keys.map((key) => {
        const byId = SCOPE_RE.exec(key);
        const found = byId
          ? (db.prepare('SELECT id FROM scopes WHERE id = ? AND feature_id = ?').get(Number(byId[1]), fid) as any)?.id
          : scopeIds.get(key.toLowerCase()) ?? (db.prepare('SELECT id FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, key) as any)?.id;
        if (!found) throw new EditError(`Link ${testId}: scope "${key}" is not in F-${fid}`);
        return found as number;
      }),
    ),
  ];
  const names = (ids: number[]) => ids.map((s) => `S-${s}`).join(', ');
  const addScopes = (linkId: number, ids: number[]) => {
    const add = db.prepare('INSERT OR IGNORE INTO link_scopes (link_id, scope_id) VALUES (?, ?)');
    for (const s of ids) add.run(linkId, s);
  };

  const cur = db.prepare('SELECT * FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p.id, testId, fid) as any;
  if (!cur) {
    const id = Number(db.prepare("INSERT INTO links (project_id, test_id, feature_id, source) VALUES (?, ?, ?, 'ai')").run(p.id, testId, fid).lastInsertRowid);
    addScopes(id, want);
    report.push(`${testId} -> F-${fid}${want.length ? ` / ${names(want)}` : ' (no scope)'}: new link.`);
    return;
  }
  if (cur.removed) {
    report.push(`${testId} -> F-${fid}: a person removed this link before. Not added again.`);
    return;
  }
  const have = new Set((db.prepare('SELECT scope_id FROM link_scopes WHERE link_id = ?').all(cur.id) as any[]).map((r) => r.scope_id as number));
  const missing = want.filter((s) => !have.has(s));
  if (!missing.length) return;
  // A person made or changed this link: leave it as it is, and only suggest.
  if (cur.source === 'manual') {
    report.push(`${testId} -> F-${fid}: a person made this link. Not changed. Suggested scopes: ${names(missing)}.`);
    return;
  }
  addScopes(cur.id, missing);
  // New AI scopes on the link: a person must check the link again.
  db.prepare('UPDATE links SET checked = 0 WHERE id = ?').run(cur.id);
  report.push(`${testId} -> F-${fid}: added ${names(missing)}.`);
}

function skip(p: ProjectConfig, kind: Kind, ref: string | undefined, reason: string | undefined, codeFiles: string[]) {
  if (!ref || !reason) fail('Usage: skip <project> <kind> <ref> <reason> [--files a.php,b.php]');
  let files: string[];
  if (kind === 'code') {
    // The files of a skipped area leave the "next" list too, so name them.
    if (!codeFiles.length) fail('A code unit needs --files: the repo files of the area, separated by commas.');
    for (const f of codeFiles) if (!repoFile(p, f) || !fs.existsSync(repoFile(p, f)!)) fail(`No file ${f} in the plugin repo.`);
    files = codeFiles;
  } else {
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND framework = ? AND file = ?').get(p.id, kind, ref)) fail(`No ${kind} file "${ref}" in the last scan.`);
    files = [testRepoPath(p, kind, ref)];
  }
  // A skipped unit wrote to no feature, so its feature list is empty (also when it was done before).
  db.prepare(
    `INSERT INTO processed_units (project_id, kind, ref, status, files, hash, features, note, processed_at) VALUES (?, ?, ?, 'skipped', ?, ?, '[]', ?, ?)
     ON CONFLICT (project_id, kind, ref) DO UPDATE SET status = 'skipped', files = excluded.files, hash = excluded.hash,
       features = '[]', note = excluded.note, processed_at = excluded.processed_at`,
  ).run(p.id, kind, ref, JSON.stringify(files), hashFiles(p, files), str(reason), now());
  out({ skipped: true, kind, ref, files });
}

function reset(p: ProjectConfig, kind: Kind, ref: string | undefined) {
  if (!ref) fail('Usage: reset <project> <kind> <ref>');
  const r = db.prepare('DELETE FROM processed_units WHERE project_id = ? AND kind = ? AND ref = ?').run(p.id, kind, ref);
  out({ reset: r.changes > 0, kind, ref });
}

// ---- main ----

importProjectsJson();
const [cmd, projectId, ...args] = process.argv.slice(2);
const commands: Record<string, () => void> = {
  status: () => status(projectOf(projectId)),
  next: () => next(projectOf(projectId), kindOf(args[0])),
  features: () => features(projectOf(projectId)),
  feature: () => feature(projectOf(projectId), args[0], args.includes('--all')),
  code: () => code(projectOf(projectId), args[0]),
  apply: () => apply(projectOf(projectId), args[0]),
  skip: () => {
    const at = args.indexOf('--files');
    const files = at >= 0 ? (args.splice(at, 2)[1] ?? '').split(',').map((f) => f.trim()).filter(Boolean) : [];
    skip(projectOf(projectId), kindOf(args[0]), args[1], args.slice(2).join(' '), files);
  },
  reset: () => reset(projectOf(projectId), kindOf(args[0]), args[1]),
};
if (!commands[cmd]) {
  console.log('Commands: status, next, features, feature, code, apply, skip, reset. See server/map.ts.');
  process.exit(cmd ? 1 : 0);
}
// A fresh scan first for the commands that use test IDs and files, so they match the repo now.
// The read-only feature commands skip it: the scan reads every test file.
if (['status', 'next', 'apply', 'skip'].includes(cmd) && projectId && getProject(projectId)) syncProject(getProject(projectId)!, true);
commands[cmd]();
