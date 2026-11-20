/**
 * Command line tool for the feature-mapping skill (.claude/skills/map-features).
 * The skill takes one unit at a time: one Playwright spec file, one Cypress
 * .feature file, or one code area. It writes features (with their lists, labels
 * and scopes) and links,
 * and marks the unit as processed, in one transaction.
 *
 *   npm run -s map -- status   <project>
 *   npm run -s map -- next     <project> [playwright|cypress|code]   (no kind: Playwright, then Cypress, then code)
 *   npm run -s map -- features <project>
 *   npm run -s map -- feature  <project> <feature id> [--all]
 *   npm run -s map -- code     <project> <repo file>
 *   npm run -s map -- test-code <project> playwright|cypress <test file ref>
 *   npm run -s map -- apply    <project> <payload.json>   (unit kind "update": an AI update, see server/ai-update.ts;
 *                                                            unit kind "answer": the answer-questions skill)
 *   npm run -s map -- skip     <project> <kind> <ref> <reason> [--files a.php,b.php]  (--files is needed for code)
 *   npm run -s map -- reset    <project> <kind> <ref>
 *   npm run -s map -- move-scope <project> <scope id> <feature id>   (a person's edit: see edits.moveScope)
 *   npm run -s map -- screenshots <project> <feature id> <folder>   (writes the images of the feature, to look at them)
 *
 * Output is JSON, so the skill can read it. Rules that protect people's work:
 *  - Text that a person wrote or checked is never replaced or removed. Empty fields can be filled.
 *    Each field has its own AI mark (ai_fields), so filling one empty field gives no right to change another.
 *  - Labels, list items, scopes and link scopes are only added.
 *  - A link that a person removed is never added again.
 *  - Links made here have source "ai", so the app can show them as AI links.
 *  - Mapped code (feature_code) is only added. Code that a person removed is never added again.
 *  - One exception to the first rule: with unit kind "answer", "answeredQuestions" deletes open questions,
 *    also a person's. The person asked the answer-questions skill to answer them. The automatic AI update
 *    cannot send this field (its schema in server/ai-update.ts is closed).
 *    The text of an answered question is remembered (answered_questions), and a question with that text is never added again.
 *  - Screenshots are only added. The skill finds its own by a key from the first caption it sent
 *    (captionKey), so a person can change the caption. A screenshot that a person deleted is never added again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, json, now, tx } from './db.ts';
import { getProject, importProjectsJson, repoFile, safeRepoPath, testRepoPath, type ProjectConfig } from './projects.ts';
import { syncProject } from './scan.ts';
import { EditError, edits, idNumber, NEW_SCOPE_ID, ITEM_KINDS, LABEL_KINDS, SCOPE_ITEM_KIND, PRIORITIES, SCREENSHOT_MAX_BYTES, captionKey, imageType, labelValue, labelsInUse, nextSort, requirementClash, scopeGroupId, findScopeGroup, dropEmptyAiGroup, keepBefore, dropBefore, sweepBefore } from './features.ts';
import { loadCoverage, resolveView } from './coverage.ts';
import { runTestOwners } from './run-tests.ts';
import { functionNames } from './feature-code.ts';

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
  const noCode = (db.prepare('SELECT COUNT(*) AS n FROM features f WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM feature_code c WHERE c.feature_id = f.id AND c.removed = 0)').get(p.id) as any).n;
  const noShots = (db.prepare('SELECT COUNT(*) AS n FROM features f WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM screenshots s WHERE s.feature_id = f.id AND s.removed = 0)').get(p.id) as any).n;
  res.features = { total: f.n, aiDraft: f.ai ?? 0, withoutCode: noCode, withoutScreenshots: noShots };
  res.order = 'Playwright files first, then Cypress files, then code areas. "next <project>" with no kind follows this order.';
  out(res);
}

/** The order of the work: Playwright files first, then Cypress files, then the code that is left. */
function nextAny(p: ProjectConfig) {
  for (const kind of ['playwright', 'cypress'] as const) {
    if (testFiles(p, kind).some((f) => f.state === 'changed' || f.state === 'new')) return next(p, kind);
  }
  return nextCode(p);
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
  const view = resolveView(p, 'both');
  const cov = view && loadCoverage(p, view);
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
    coverage: cov?.label ?? null,
    message: list.length
      ? 'Pick one plugin feature or settings area. Read the files it needs, then name the area as the unit ref.'
      : 'Every PHP file is in a processed code area.',
    remainingFiles: list.length,
    candidates: list.slice(0, 20),
  });
}

/** Functions in one repo file, with their coverage state and the tests (Playwright and Cypress) that ran them. */
function code(p: ProjectConfig, file: string | undefined) {
  if (!file || !safeRepoPath(p, file)) fail('Give a file path relative to the plugin repo.');
  const view = resolveView(p, 'both');
  const cov = view && loadCoverage(p, view);
  const runToTest = runTestOwners(p);
  const fns = cov?.functionsByFile.get(file) ?? [];
  out({
    file,
    coverage: cov?.label ?? null,
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

/**
 * A hint for the "code" field of a test file's features: the plugin functions that the tests
 * of one test file ran (library code left out). otherTests = tests in other files that ran the
 * function too: a high number means shared code, not code of this feature alone.
 */
function testCode(p: ProjectConfig, kind: Kind, ref: string | undefined) {
  if (kind === 'code' || !ref) fail('Usage: test-code <project> playwright|cypress <test file ref from "next">');
  const ids = new Set((db.prepare('SELECT id FROM tests WHERE project_id = ? AND framework = ? AND file = ? AND removed_at IS NULL').all(p.id, kind, ref) as any[]).map((r) => r.id));
  if (!ids.size) fail(`No ${kind} file "${ref}" in the last scan. Use the ref that "next" gave.`);
  const view = resolveView(p, 'both');
  const cov = view && loadCoverage(p, view);
  const owners = runTestOwners(p);
  const ranAny = cov?.tests.some((t) => ids.has(owners.get(t.id) ?? ''));
  const files: { file: string; functions: { name: string; lines: string; state: string; tests: number; otherTests: number }[] }[] = [];
  for (const [file, fns] of cov?.functionsByFile ?? []) {
    const list = [];
    for (const fn of fns) {
      if (fn.state === 'library') continue;
      const tests = new Set(fn.tests.map((t) => owners.get(t)).filter(Boolean) as string[]);
      const mine = [...tests].filter((t) => ids.has(t)).length;
      if (mine) list.push({ name: fn.function, lines: `${fn.start}-${fn.end}`, state: fn.state, tests: mine, otherTests: tests.size - mine });
    }
    if (list.length) files.push({ file, functions: list.sort((a, b) => a.otherTests - b.otherTests || b.tests - a.tests) });
  }
  files.sort((a, b) => b.functions.length - a.functions.length || a.file.localeCompare(b.file));
  out({
    kind,
    ref,
    coverage: cov?.label ?? null,
    testsInRun: !!ranAny,
    note: !cov
      ? 'The project has no coverage run. Find the code by reading it.'
      : !ranAny
        ? `The ${kind} tests of this file are not in the coverage run. Find the code by reading it.`
        : 'A hint only. Setup through REST (Cypress) and shared helpers also show here. Put in a feature only the code that does the feature.',
    files,
  });
}

/** Mapped code from a payload: { file, functions? }. No functions = the whole file. */
interface CodeIn {
  file: string;
  functions?: string[];
}

function writeCode(p: ProjectConfig, fid: number, entries: CodeIn[], report: string[]) {
  for (const e of entries) {
    const file = str(e?.file, 500);
    const full = file && repoFile(p, file);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new EditError(`code: no file "${file}" in the plugin repo. Give paths relative to the repo root`);
    const fns = list<string>(e.functions, 'code.functions').map((x) => str(x, 300)).filter(Boolean);
    if (fns.length) {
      // Names must match the coverage run, so the app can find the lines.
      const known = functionNames(p, file);
      const bad = known ? fns.filter((n) => !known.has(n)) : [];
      if (bad.length) throw new EditError(`code: ${file} has no function ${bad.map((b) => `"${b}"`).join(', ')} in the coverage run. Use the names that "code" lists`);
    }
    for (const fn of fns.length ? fns : ['']) {
      const cur = db.prepare('SELECT id, removed FROM feature_code WHERE feature_id = ? AND file = ? AND function = ?').get(fid, file, fn) as any;
      const what = fn ? `${file} ${fn}` : `${file} (whole file)`;
      if (cur?.removed) {
        report.push(`F-${fid} code ${what}: a person removed it. Not added again.`);
        continue;
      }
      if (cur) continue;
      db.prepare("INSERT INTO feature_code (project_id, feature_id, file, function, source) VALUES (?, ?, ?, ?, 'ai')").run(p.id, fid, file, fn);
      report.push(`F-${fid} code: added ${what}.`);
    }
  }
}

// "S-14", "S14", or a copied "F-3/S-14" (the feature part is only a help for people).
const SCOPE_RE = /^(?:F-?\d+\/)?S-?(\d+)$/i;
const scopeNames = (linkId: number) =>
  (db.prepare('SELECT s.id, s.title FROM link_scopes ls JOIN scopes s ON s.id = ls.scope_id WHERE ls.link_id = ? ORDER BY s.id').all(linkId) as any[]).map(
    (s) => `S-${s.id} ${s.title}`,
  );
const labelsOf = (fid: number, kind: string) =>
  (db.prepare('SELECT value FROM feature_labels WHERE feature_id = ? AND kind = ? ORDER BY value COLLATE NOCASE').all(fid, kind) as any[]).map((r) => r.value as string);
/** Items of one list. scopeId null: the feature's own list. */
const itemsOf = (fid: number, kind: string, scopeId: number | null = null) =>
  (db.prepare('SELECT id, text, ai_draft FROM feature_items WHERE feature_id = ? AND scope_id IS ? AND kind = ? ORDER BY sort, id').all(fid, scopeId, kind) as any[]).map((i) => ({
    id: i.id as number,
    text: i.text as string,
    aiDraft: !!i.ai_draft,
  }));

function features(p: ProjectConfig) {
  const groups = db.prepare('SELECT id, title FROM feature_groups WHERE project_id = ? ORDER BY sort, id').all(p.id) as any[];
  const rows = db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY sort, id').all(p.id) as any[];
  const shotCount = new Map(
    (db.prepare('SELECT feature_id, COUNT(*) AS n FROM screenshots WHERE project_id = ? AND removed = 0 GROUP BY feature_id').all(p.id) as any[]).map((r) => [r.feature_id, r.n]),
  );
  out({
    groups: groups.map((g) => g.title),
    // Use these spellings, so one role does not show two times.
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
      screenshots: shotCount.get(f.id) ?? 0,
    })),
  });
}

/**
 * Screenshots of a feature, for the skill. firstCaption: the caption the skill sent first (a person can
 * change the caption since). removed: a person deleted it. The skill cannot add that screenshot again.
 */
function screenshotsOf(fid: number) {
  const tags = new Map<number, string[]>();
  for (const r of db
    .prepare('SELECT ss.screenshot_id AS shot, s.id, s.title FROM screenshot_scopes ss JOIN scopes s ON s.id = ss.scope_id WHERE s.feature_id = ? ORDER BY s.id')
    .all(fid) as any[])
    tags.set(r.shot, [...(tags.get(r.shot) ?? []), `S-${r.id} ${r.title}`]);
  return (db.prepare('SELECT id, caption, match_key, source, checked, removed FROM screenshots WHERE feature_id = ? ORDER BY sort, id').all(fid) as any[]).map((x) => ({
    caption: x.caption,
    ...(x.match_key !== null && x.match_key !== captionKey(x.caption) ? { firstCaption: x.match_key } : {}),
    source: x.source,
    checked: !!x.checked,
    removed: !!x.removed,
    scopes: tags.get(x.id) ?? [],
  }));
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
    scopeGroups: (db.prepare('SELECT title FROM scope_groups WHERE feature_id = ? ORDER BY sort, id').all(f.id) as any[]).map((g) => g.title),
    scopes: (db.prepare('SELECT s.id, s.title, s.description, g.title AS grp, s.ai_fields FROM scopes s LEFT JOIN scope_groups g ON g.id = s.group_id WHERE s.feature_id = ? ORDER BY s.sort, s.id').all(f.id) as any[]).map((s) => ({
      id: `S-${s.id}`, title: s.title, group: s.grp ?? null, description: s.description, requirements: itemsOf(f.id, SCOPE_ITEM_KIND, s.id), aiFields: json(s.ai_fields),
    })),
    links: links.slice(0, all ? undefined : 25).map((l) => ({
      testId: l.testId, title: l.title, framework: l.framework, source: l.source, removed: !!l.removed, scopes: scopeNames(l.id),
    })),
    linkCount: links.length,
    code: (db.prepare('SELECT file, function, source, removed FROM feature_code WHERE feature_id = ? ORDER BY file, function').all(f.id) as any[]).map((c) => ({
      file: c.file, function: c.function || null, source: c.source, removed: !!c.removed,
    })),
    screenshots: screenshotsOf(f.id),
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
  /** What must be true for every scope: settings, data, the user. */
  requirements?: ItemIn[];
  /** Only what no test can check. A testable rule is a scope. */
  notes?: ItemIn[];
  outOfScope?: ItemIn[];
  where?: ItemIn[];
  questions?: ItemIn[];
  /** IDs of list items to delete (only AI draft items), scope requirements too. */
  removeItems?: number[];
  /** Unit kind "answer" only: IDs of open questions that the answer-questions skill answered. Deleted also when a person wrote them. */
  answeredQuestions?: number[];
  scopes?: ScopeIn[];
  links?: LinkIn[];
  /** Plugin code of the feature: a whole file, or functions in it. */
  code?: CodeIn[];
  /** Images of the feature: a local image file, a caption, and the scopes it shows. */
  screenshots?: ShotIn[];
}
interface ScopeIn {
  id?: number | string;
  title: string;
  /** null deletes an AI draft description. */
  description?: string | null;
  /** Group name: scopes about one topic of the feature show together, like a describe block of tests. */
  group?: string;
  /** What must be true for this scope only, on top of the feature's requirements. */
  requirements?: ItemIn[];
}
interface ShotIn {
  file: string;
  caption: string;
  scopes?: (string | number)[];
}
interface Payload {
  /**
   * kind "update": an AI update after a code change (server/ai-update.ts).
   * kind "answer": the answer-questions skill answered open questions.
   * Neither is a unit of the mapping order.
   */
  unit: { kind: Kind | 'update' | 'answer'; ref: string; files?: string[]; note?: string };
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
  // An update is not in KINDS, so next, skip, reset and status do not see it.
  const update = unit.kind === 'update' || unit.kind === 'answer';
  const answer = unit.kind === 'answer';
  const kind = update ? unit.kind : kindOf(unit.kind);
  const ref = str(unit.ref, 500);
  if (!ref) fail('unit.ref is empty');
  if (!Array.isArray(body.features) || !body.features.length) fail('features is empty. Use the skip command for a unit with no feature.');

  // Files the unit read: the test file, or the code files of the area.
  let files = (unit.files ?? []).map((f) => str(f, 500)).filter(Boolean);
  if (kind === 'update' || kind === 'answer') files = [];
  else if (kind !== 'code') {
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND framework = ? AND file = ? AND removed_at IS NULL').get(p.id, kind, ref))
      fail(`No ${kind} file "${ref}" in the last scan. Use the ref that "next" gave.`);
    files = [...new Set([testRepoPath(p, kind, ref), ...files])];
  } else if (!files.length) fail('A code unit needs unit.files: the repo files that the area uses.');
  for (const f of files) {
    const full = repoFile(p, f);
    if (!full) fail(`File path is outside the plugin repo, or hidden: ${f}`);
    if (!fs.existsSync(full)) fail(`No file ${f} in the plugin repo. Give paths relative to the repo root.`);
  }

  // Old field names, checked before anything is written.
  for (const inF of body.features) {
    if ((inF as any)?.needs !== undefined) fail('"needs" is now "requirements": a list of sentences. Nothing was saved.');
    if ((inF as any)?.rules !== undefined) fail('"rules" is gone: write a rule that a test can check as a scope, and other text as "notes". Nothing was saved.');
    for (const s of Array.isArray(inF?.scopes) ? inF.scopes : [])
      if ((s as any)?.rules !== undefined || (s as any)?.notes !== undefined) fail('A scope has only "requirements", no "rules" or "notes". Nothing was saved.');
    if (!answer && inF?.answeredQuestions !== undefined) fail('"answeredQuestions" works only with unit kind "answer". Nothing was saved.');
  }

  const report: string[] = [];
  const touched: number[] = [];
  // The features that got a real change. A feature in the payload with no new data must not get a
  // new ai_changed_at: then the next edit of a person would mark it "reviewed" (sweepReviewed).
  const changed = new Set<number>();
  const totalChanges = () => (db.prepare('SELECT total_changes() AS n').get() as any).n as number;
  try {
    tx(() => {
      // Old "before" values whose row is gone or whose mark went: an ID can come back for a new row.
      // Before the loop: the change count of each feature must not see it.
      sweepBefore();
      for (const inF of body.features) {
        const before = totalChanges();
        const fid = writeFeature(p, inF, report);
        touched.push(fid);
        for (const [key, kind] of Object.entries(LABEL_KINDS)) writeLabels(p, fid, kind, list<string>((inF as any)[key], key), report);
        // Remove first: a payload that removes an item and adds the same text again keeps the text.
        // An ID in both lists is an answered question: removeAnswered deletes it and remembers its text.
        const answered = list<number>(inF.answeredQuestions, 'answeredQuestions').map(Number);
        removeItems(fid, list<number>(inF.removeItems, 'removeItems').filter((id) => !answered.includes(Number(id))), report);
        removeAnswered(fid, answered, report);
        for (const [key, kind] of Object.entries(ITEM_KINDS)) writeItems(fid, kind, list<ItemIn>((inF as any)[key], key), report);
        const scopeIds = new Map<string, number | null>();
        for (const s of list<ScopeIn>(inF.scopes, 'scopes')) {
          const sid = writeScope(fid, s, report);
          scopeIds.set(str(s.title).toLowerCase(), sid);
          if (s.id !== undefined) scopeIds.set(String(s.id).trim().toLowerCase(), sid);
          if (sid !== null) writeItems(fid, SCOPE_ITEM_KIND, list<ItemIn>(s.requirements, 'scope requirements'), report, sid);
        }
        for (const l of list<LinkIn>(inF.links, 'links')) writeLink(p, fid, l, scopeIds, report);
        writeCode(p, fid, list<CodeIn>(inF.code, 'code'), report);
        for (const x of list<ShotIn>(inF.screenshots, 'screenshots')) writeScreenshot(p, fid, x, scopeIds, report);
        if (totalChanges() > before) changed.add(fid);
      }
      // The review state in the app: the AI changed these features after their last review.
      const stamp = now();
      for (const fid of changed) db.prepare('UPDATE features SET ai_changed_at = ? WHERE id = ?').run(stamp, fid);
      if (!update) db.prepare(
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

/** The ID of the group with this title, or undefined. */
function findGroup(p: ProjectConfig, title: string): number | undefined {
  return (db.prepare('SELECT id FROM feature_groups WHERE project_id = ? AND lower(title) = lower(?)').get(p.id, title) as any)?.id;
}
function createGroup(p: ProjectConfig, t: string): number {
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
  // The value from before, so a person can change it back. A row that this apply made has none.
  if (!row.isNew) keepBefore(table === 'features' ? 'feature' : 'scope', row.id, field, row[col], !ai.has(field));
  db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(value, row.id);
  ai.add(field);
  return true;
}
/**
 * Saves the AI field list. It writes only when the list changed (in any order): apply counts the
 * changed rows to know which features the AI changed.
 */
function saveAi(table: 'features' | 'scopes', row: { id: number; ai_fields: string | null }, ai: Set<string>) {
  const next = JSON.stringify([...ai].sort());
  if (JSON.stringify([...(json(row.ai_fields) ?? [])].sort()) === next) return;
  db.prepare(`UPDATE ${table} SET ai_fields = ? WHERE id = ?`).run(next, row.id);
}

/** Title, description, priority and group. The lists, labels, scopes and links are written after it. */
function writeFeature(p: ProjectConfig, f: FeatureIn, report: string[]): number {
  const priority = str(f.priority).toLowerCase();
  if (!PRIORITIES.includes(priority)) throw new EditError(`Priority "${f.priority}" must be high, medium, low or empty`);
  const groupTitle = str(f.group, 200);
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
  if (groupTitle) {
    // Make a new group only when the feature can take it: else a refused change leaves an empty group.
    let g = findGroup(p, groupTitle);
    const canSet = row.group_id === null || ai.has('group');
    if (g === undefined && canSet) g = createGroup(p, groupTitle);
    if (g !== undefined) setText('features', row, ai, 'group', 'group_id', g, label, report);
    else report.push(`${label}: kept the group that a person wrote or checked. Suggested group "${groupTitle}" was not saved.`);
  }
  saveAi('features', row, ai);
  return row.id;
}

/** Labels are only added. The project's spelling of a value wins. */
function writeLabels(p: ProjectConfig, fid: number, kind: string, values: string[], report: string[]) {
  const added: string[] = [];
  for (const v of values) {
    const value = labelValue(p.id, kind, v);
    if (db.prepare('INSERT OR IGNORE INTO feature_labels (feature_id, kind, value) VALUES (?, ?, ?)').run(fid, kind, value).changes) added.push(value);
  }
  if (added.length) {
    report.push(`F-${fid}: added ${kind} ${added.map((a) => `"${a}"`).join(', ')}.`);
    // A label has no mark of its own: the field ("roles") gets the AI mark, so a person reviews it.
    const field = `${kind}s`;
    const ai = new Set<string>(json((db.prepare('SELECT ai_fields FROM features WHERE id = ?').get(fid) as any).ai_fields));
    if (!ai.has(field)) db.prepare('UPDATE features SET ai_fields = ? WHERE id = ?').run(JSON.stringify([...ai, field]), fid);
  }
}

/** True when a question with this text was answered or removed on this feature before (answered_questions). */
const answeredBefore = (fid: number, text: string) =>
  !!db.prepare('SELECT 1 FROM answered_questions WHERE feature_id = ? AND text_key = lower(trim(?))').get(fid, text);
/** Remembers the text of a removed question, so the AI skills do not ask it again on this feature. */
const rememberAnswered = (fid: number, text: string) =>
  db.prepare('INSERT OR IGNORE INTO answered_questions (feature_id, text_key) VALUES (?, lower(trim(?)))').run(fid, text);

/**
 * A string adds an item (the same text again adds nothing). { id, text } changes an AI draft item.
 * scopeId: the items are requirements of that scope. null: the feature's own list.
 */
function writeItems(fid: number, kind: string, values: ItemIn[], report: string[], scopeId: number | null = null) {
  const label = scopeId === null ? `F-${fid}` : `F-${fid} S-${scopeId}`;
  for (const v of values) {
    if (typeof v === 'string') {
      const t = str(v, 2000);
      if (!t) continue;
      if (db.prepare('SELECT 1 FROM feature_items WHERE feature_id = ? AND scope_id IS ? AND kind = ? AND lower(text) = lower(?)').get(fid, scopeId, kind, t)) continue;
      if (kind === 'question' && answeredBefore(fid, t)) {
        report.push(`${label}: did not add the question "${t}": it was answered or removed on this feature before.`);
        continue;
      }
      // A scope does not repeat a requirement of its feature, and the reverse.
      const clash = requirementClash(fid, scopeId, kind, t);
      if (clash) {
        report.push(`${label}: did not add "${t}": ${clash}`);
        continue;
      }
      const id = db
        .prepare('INSERT INTO feature_items (feature_id, scope_id, kind, text, sort, ai_draft) VALUES (?, ?, ?, ?, ?, 1)')
        .run(fid, scopeId, kind, t, nextSort('feature_items', 'feature_id = ?', fid)).lastInsertRowid;
      report.push(`${label}: new ${kind} item #${id}.`);
    } else if (v && typeof v === 'object') {
      const row = db.prepare('SELECT * FROM feature_items WHERE id = ? AND feature_id = ? AND scope_id IS ? AND kind = ?').get(Number(v.id), fid, scopeId, kind) as any;
      if (!row) throw new EditError(`No ${kind} item #${v.id} in ${label}`);
      const t = str(v.text, 2000);
      if (!t || t === row.text) continue;
      const clash = requirementClash(fid, scopeId, kind, t, row.id);
      if (!row.ai_draft) report.push(`${label}: kept the ${kind} item #${row.id} that a person wrote or checked.`);
      else if (kind === 'question' && answeredBefore(fid, t)) report.push(`${label}: did not change question #${row.id} to "${t}": that question was answered before.`);
      else if (clash) report.push(`${label}: did not change item #${row.id} to "${t}": ${clash}`);
      else {
        db.prepare('UPDATE feature_items SET text = ? WHERE id = ?').run(t, row.id);
        report.push(`${label}: changed AI draft ${kind} item #${row.id}.`);
      }
    } else throw new EditError(`A ${kind} item must be text or { "id", "text" }`);
  }
}

function removeItems(fid: number, ids: number[], report: string[]) {
  for (const id of new Set(ids.map(Number))) {
    const row = db.prepare('SELECT * FROM feature_items WHERE id = ? AND feature_id = ?').get(Number(id), fid) as any;
    if (!row) throw new EditError(`No list item #${id} in F-${fid}`);
    if (!row.ai_draft) report.push(`F-${fid}: kept item #${id}: a person wrote or checked it. Name the problem in "questions".`);
    else {
      db.prepare('DELETE FROM feature_items WHERE id = ?').run(row.id);
      dropBefore('item', row.id);
      // A removed question is answered or wrong: do not ask it again on this feature.
      if (row.kind === 'question') rememberAnswered(fid, row.text);
      report.push(`F-${fid}: removed AI draft item #${id}.`);
    }
  }
}

/** Open questions that the answer-questions skill answered. A person's question is deleted too: the person asked for the answer. */
function removeAnswered(fid: number, ids: number[], report: string[]) {
  // The same ID two times removes the question once.
  for (const id of new Set(ids.map(Number))) {
    const row = db.prepare("SELECT * FROM feature_items WHERE id = ? AND feature_id = ? AND kind = 'question'").get(Number(id), fid) as any;
    if (!row) throw new EditError(`No open question #${id} in F-${fid}`);
    db.prepare('DELETE FROM feature_items WHERE id = ?').run(row.id);
    dropBefore('item', row.id);
    rememberAnswered(fid, row.text);
    report.push(`F-${fid}: removed answered question #${id} (${row.ai_draft ? 'AI draft' : 'a person wrote it'}): "${row.text}"`);
  }
}

/**
 * A scope that the skill names (by S-id or title) and that is not live in feature fid, but has an old
 * title or ID there (scope_titles_gone: a person deleted, moved or renamed it).
 *  - renamed, or moved back: { id } of the scope in fid, so the skill writes to it
 *  - moved to another feature or deleted: { skip } with the reason for the report
 *  - unknown: null
 */
function goneScope(fid: number, key: { id?: number | null; title?: string }): { id: number } | { skip: string } | null {
  const row = (
    key.id
      ? db.prepare('SELECT * FROM scope_titles_gone WHERE feature_id = ? AND scope_id = ? LIMIT 1').get(fid, key.id)
      : db
          .prepare(
            `SELECT g.* FROM scope_titles_gone g LEFT JOIN scopes s ON s.id = g.scope_id
             WHERE g.feature_id = ? AND g.title_key = lower(trim(?)) ORDER BY (s.feature_id = g.feature_id) DESC, g.created_at DESC LIMIT 1`,
          )
          .get(fid, key.title ?? '')
  ) as any;
  if (!row) return null;
  const now = db.prepare('SELECT feature_id, title FROM scopes WHERE id = ?').get(row.scope_id) as any;
  if (now?.feature_id === fid) return { id: row.scope_id };
  return {
    skip: now
      ? `a person moved scope S-${row.scope_id} to F-${now.feature_id}, where it is "${now.title}"`
      : `a person deleted scope S-${row.scope_id}`,
  };
}

/**
 * Adds or fills one scope. Returns its ID, or null when a person deleted the scope or moved it to
 * another feature: the skill does not make it again here (goneScope).
 */
function writeScope(fid: number, s: { id?: number | string; title: string; description?: string | null; group?: string }, report: string[]): number | null {
  const title = str(s.title, 2000);
  if (!title) throw new EditError(`A scope of F-${fid} has no title`);
  const sid = s.id !== undefined ? Number(SCOPE_RE.exec(String(s.id))?.[1] ?? s.id) : null;
  let row: any = sid
    ? db.prepare('SELECT * FROM scopes WHERE id = ? AND feature_id = ?').get(sid, fid)
    : db.prepare('SELECT * FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, title);
  if (!row) {
    const gone = goneScope(fid, { id: sid, title });
    if (gone && 'skip' in gone) {
      report.push(`F-${fid} scope "${title}": ${gone.skip}. Not added again. Its requirements, links and screenshots in this payload were skipped.`);
      return null;
    }
    if (gone) row = db.prepare('SELECT * FROM scopes WHERE id = ?').get(gone.id);
  }
  if (sid && !row) {
    const now = db.prepare('SELECT feature_id FROM scopes WHERE id = ?').get(sid) as any;
    throw new EditError(
      now ? `S-${sid} is in F-${now.feature_id} now, not in F-${fid}. Send it under F-${now.feature_id}` : `No scope S-${sid} in feature F-${fid}`,
    );
  }
  if (!row) {
    const n = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM scopes WHERE feature_id = ?').get(fid) as any).n;
    const desc = str(s.description);
    const group = aiScopeGroup(fid, s.group, `F-${fid} scope "${title}"`, report) ?? null;
    const ai = ['title', ...(desc ? ['description'] : []), ...(group ? ['group'] : [])].sort();
    const id = db
      .prepare(`INSERT INTO scopes (id, feature_id, title, description, group_id, sort, ai_fields) VALUES (${NEW_SCOPE_ID}, ?, ?, ?, ?, ?, ?)`)
      .run(fid, title, desc, group, n, JSON.stringify(ai)).lastInsertRowid;
    report.push(`F-${fid}: new scope S-${id} "${title}".`);
    return Number(id);
  }
  const label = `S-${row.id}`;
  const ai = new Set<string>(json(row.ai_fields));
  setText('scopes', row, ai, 'title', 'title', title, label, report);
  if (s.description === null) clearScopeDescription(row, ai, label, report);
  else setText('scopes', row, ai, 'description', 'description', str(s.description), label, report);
  writeScopeGroup(fid, row, ai, s.group, label, report);
  saveAi('scopes', row, ai);
  return row.id;
}

/**
 * The group that the AI skill names by title, for a scope of feature fid:
 *  - a group of the feature with this title, or the group that a person renamed from this title
 *  - undefined when a person deleted the group with this title (with a line in the report)
 *  - else a new group with this title
 * Empty title: null.
 */
function aiScopeGroup(fid: number, title: unknown, label: string, report: string[], make = true): number | null | undefined {
  const g = findScopeGroup(fid, title);
  if (!g.title) return null;
  if (g.deleted) {
    report.push(`${label}: a person deleted group "${g.title}". The scope was not put in it.`);
    return undefined;
  }
  if (g.id !== null) return g.id;
  // A new title that is too long: skip the group only, so the other changes of the payload are saved.
  if (g.title.length > 200) {
    report.push(`${label}: group title is longer than 200 characters. The scope was not put in a group.`);
    return undefined;
  }
  return make ? scopeGroupId(fid, g.title, true) : null;
}

/**
 * Puts a scope in the group with this title, as setText does for a text: only when no person chose
 * its group (or chose no group), and the scope has no group or the AI skill chose it.
 */
function writeScopeGroup(fid: number, row: any, ai: Set<string>, title: unknown, label: string, report: string[]) {
  if (typeof title !== 'string' || !title.trim()) return;
  const known = aiScopeGroup(fid, title, label, report, false);
  if (known === undefined || (known !== null && known === row.group_id)) return;
  const name = (id: number | null) => (id === null ? null : ((db.prepare('SELECT title FROM scope_groups WHERE id = ?').get(id) as any)?.title as string));
  if (!ai.has('group') && (row.group_id !== null || row.group_by_person)) {
    const was = row.group_id === null ? 'no group' : `group "${name(row.group_id)}"`;
    report.push(`${label}: kept ${was}, which a person chose or checked. Suggested group "${title.trim()}" was not saved.`);
    return;
  }
  const gid = known ?? scopeGroupId(fid, title, true)!;
  const before = name(row.group_id);
  report.push(
    before
      ? `${label}: moved from the AI draft group "${before}" to "${name(gid)}".`
      : `${label}: put in group "${name(gid)}". It shows as AI draft until a person checks it.`,
  );
  keepBefore('scope', row.id, 'group', row.group_id, !ai.has('group'));
  db.prepare('UPDATE scopes SET group_id = ? WHERE id = ?').run(gid, row.id);
  ai.add('group');
  const dropped = dropEmptyAiGroup(row.group_id);
  if (dropped) report.push(`F-${fid}: deleted the AI draft group "${dropped}". It has no scopes now.`);
}

/** "description": null in the payload deletes an AI draft description. A person's description stays. */
function clearScopeDescription(row: any, ai: Set<string>, label: string, report: string[]) {
  if (!row.description) return;
  if (!ai.has('description')) {
    report.push(`${label}: kept the description that a person wrote or checked. It was not deleted.`);
    return;
  }
  db.prepare("UPDATE scopes SET description = '' WHERE id = ?").run(row.id);
  ai.delete('description');
  dropBefore('scope', row.id, ['description']); // no AI mark now, so no "before" value
  report.push(`${label}: deleted the AI draft description.`);
}

const names = (ids: number[]) => ids.map((s) => `S-${s}`).join(', ');
/** Adds scope tags to a link or a screenshot. Tags that are there stay. */
function addScopeTags(table: 'link_scopes' | 'screenshot_scopes', id: number, scopeIds: number[]) {
  const col = table === 'link_scopes' ? 'link_id' : 'screenshot_id';
  const add = db.prepare(`INSERT OR IGNORE INTO ${table} (${col}, scope_id) VALUES (?, ?)`);
  for (const s of scopeIds) add.run(id, s);
}

/**
 * Scope IDs of feature fid from titles (of this payload or the feature) or S-ids.
 * A scope that a person deleted or moved away is left out, with a line in the report.
 */
function resolveScopes(fid: number, keys: (string | number)[], scopeIds: Map<string, number | null>, what: string, report: string[]): number[] {
  const ids = keys
    .map((k) => String(k).trim())
    .filter(Boolean)
    .map((key) => {
      if (scopeIds.has(key.toLowerCase())) return scopeIds.get(key.toLowerCase())!;
      const byId = SCOPE_RE.exec(key);
      const found = byId
        ? (db.prepare('SELECT id FROM scopes WHERE id = ? AND feature_id = ?').get(Number(byId[1]), fid) as any)?.id
        : (db.prepare('SELECT id FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, key) as any)?.id;
      if (found) return found as number;
      const gone = goneScope(fid, byId ? { id: Number(byId[1]) } : { title: key });
      if (gone && 'id' in gone) return gone.id;
      if (gone) return void report.push(`${what}: scope "${key}" left out: ${gone.skip}.`), null;
      throw new EditError(`${what}: scope "${key}" is not in F-${fid}`);
    });
  return [...new Set(ids.filter((id): id is number => id !== null))];
}

/**
 * Adds a screenshot from a local image file. The caption names what it shows. Its fixed form (captionKey)
 * is the match key: the skill does not add a second screenshot with the same key to a feature, also
 * after a person changed the caption. For an AI screenshot that no person checked, missing scope tags
 * are added; else they are only suggested. The image file is read only for a new screenshot.
 */
function writeScreenshot(p: ProjectConfig, fid: number, x: ShotIn, scopeIds: Map<string, number | null>, report: string[]) {
  const caption = str(x?.caption, 500);
  if (!caption) throw new EditError(`A screenshot of F-${fid} has no caption. Say what it shows`);
  const key = captionKey(caption);
  const keys = list<string | number>(x.scopes, `scopes of screenshot "${caption}"`);
  const want = resolveScopes(fid, keys, scopeIds, `Screenshot "${caption}"`, report);
  if (keys.length && !want.length) return void report.push(`F-${fid} screenshot "${caption}": not added, because a person deleted or moved all its scopes.`);
  const label = `F-${fid} screenshot "${caption}"`;

  const cur = db.prepare('SELECT * FROM screenshots WHERE feature_id = ? AND match_key = ? ORDER BY removed, id LIMIT 1').get(fid, key) as any;
  if (cur?.removed) return void report.push(`${label}: a person deleted it before. Not added again.`);
  if (cur) {
    const named = captionKey(cur.caption) === key ? '' : ` (a person changed the caption to "${cur.caption}")`;
    const have = new Set((db.prepare('SELECT scope_id FROM screenshot_scopes WHERE screenshot_id = ?').all(cur.id) as any[]).map((r) => r.scope_id as number));
    const missing = want.filter((s) => !have.has(s));
    if (!missing.length) return void report.push(`${label}: already there${named}. Image not changed.`);
    if (cur.checked) return void report.push(`${label}: a person checked it${named}. Not changed. Suggested scopes: ${names(missing)}.`);
    addScopeTags('screenshot_scopes', cur.id, missing);
    return void report.push(`${label}: already there${named}. Added ${names(missing)}. Image not changed.`);
  }

  // A new screenshot: now the file must be there.
  const file = str(x.file, 4000);
  if (!path.isAbsolute(file)) throw new EditError(`Screenshot "${caption}": give the full path of the image file, not "${file}"`);
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  if (!stat?.isFile()) throw new EditError(`Screenshot "${caption}": no image file "${file}"`);
  if (stat.size > SCREENSHOT_MAX_BYTES) throw new EditError(`Screenshot "${caption}": the image is too large (10 MB or less)`);
  let data: Buffer;
  let mime: string;
  try {
    data = fs.readFileSync(file);
    mime = imageType(data);
  } catch (e) {
    throw new EditError(`Screenshot "${caption}" (${file}): ${(e as Error).message}`);
  }
  const id = Number(
    db
      .prepare("INSERT INTO screenshots (project_id, feature_id, caption, mime, sort, source, match_key) VALUES (?, ?, ?, ?, ?, 'ai', ?)")
      .run(p.id, fid, caption, mime, nextSort('screenshots', 'feature_id = ?', fid), key).lastInsertRowid,
  );
  db.prepare('INSERT INTO screenshot_images (screenshot_id, data) VALUES (?, ?)').run(id, data);
  addScopeTags('screenshot_scopes', id, want);
  report.push(`${label}: added${want.length ? ` with ${names(want)}` : ' (no scope)'}.`);
}

function writeLink(p: ProjectConfig, fid: number, l: LinkIn, scopeIds: Map<string, number | null>, report: string[]) {
  const testId = str(l.testId, 100);
  if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL').get(p.id, testId))
    throw new EditError(`Unknown test ${testId}. Use the test IDs that "next" or "code" gave`);
  const keys = [...list<string | number>(l.scopes, `scopes of ${testId}`), ...(l.scope !== undefined && l.scope !== null ? [l.scope] : [])];
  const want = resolveScopes(fid, keys, scopeIds, `Link ${testId}`, report);
  if (keys.length && !want.length) {
    report.push(`${testId} -> F-${fid}: link not added or changed, because a person deleted or moved all its scopes. Link it by hand if it still belongs here.`);
    return;
  }
  const addScopes = (linkId: number, ids: number[]) => addScopeTags('link_scopes', linkId, ids);

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
  next: () => (args[0] ? next(projectOf(projectId), kindOf(args[0])) : nextAny(projectOf(projectId))),
  features: () => features(projectOf(projectId)),
  feature: () => feature(projectOf(projectId), args[0], args.includes('--all')),
  code: () => code(projectOf(projectId), args[0]),
  'test-code': () => testCode(projectOf(projectId), kindOf(args[0]), args[1]),
  apply: () => apply(projectOf(projectId), args[0]),
  skip: () => {
    const at = args.indexOf('--files');
    const files = at >= 0 ? (args.splice(at, 2)[1] ?? '').split(',').map((f) => f.trim()).filter(Boolean) : [];
    skip(projectOf(projectId), kindOf(args[0]), args[1], args.slice(2).join(' '), files);
  },
  reset: () => reset(projectOf(projectId), kindOf(args[0]), args[1]),
  // Writes the image of each screenshot of a feature (not the deleted ones) to a folder, so the skill
  // can look at them. Only the files f<id>-shot-<screenshot id>.<ext> are written.
  screenshots: () => {
    const fid = idNumber(args[0] ?? '');
    const dir = args[1];
    if (!fid || !dir) fail('Usage: screenshots <project> <feature id> <folder>');
    // In the mapping loop (server/map-loop.ts), the run may write only in its scratch folder.
    const scratch = process.env.MAP_LOOP_SCRATCH;
    if (scratch) {
      const rel = path.relative(path.resolve(scratch), path.resolve(dir));
      if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`In the mapping loop, write the screenshots only in ${scratch}`);
    }
    const p = projectOf(projectId);
    if (!db.prepare('SELECT 1 FROM features WHERE id = ? AND project_id = ?').get(fid, p.id)) fail(`No feature F-${fid} in ${p.id}`);
    fs.mkdirSync(dir, { recursive: true });
    const rows = db
      .prepare('SELECT s.id, s.caption, s.mime, i.data FROM screenshots s JOIN screenshot_images i ON i.screenshot_id = s.id WHERE s.feature_id = ? AND s.removed = 0 ORDER BY s.sort, s.id')
      .all(fid) as any[];
    out(
      rows.map((r) => {
        const ext = String(r.mime).replace('image/', '').replace('jpeg', 'jpg');
        const file = path.join(path.resolve(dir), `f${fid}-shot-${r.id}.${ext}`);
        fs.writeFileSync(file, r.data);
        return { id: `IMG-${r.id}`, caption: r.caption, file };
      }),
    );
  },
  // A person's edit, not a skill step: same code as the "Move to feature" select in the app.
  'move-scope': () => {
    if (!args[0] || !args[1]) fail('Usage: move-scope <project> <scope id> <feature id>');
    try {
      // idNumber reads "40", "S-40" and a copied "F-12/S-40" (server/features.ts).
      out(edits.moveScope(projectOf(projectId).id, String(idNumber(args[0])), { featureId: String(idNumber(args[1])) }));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  },
};
if (!commands[cmd]) {
  console.log('Commands: status, next, features, feature, code, test-code, apply, skip, reset, move-scope, screenshots. See server/map.ts.');
  process.exit(cmd ? 1 : 0);
}
// A fresh scan first for the commands that use test IDs and files, so they match the repo now.
// The read-only feature commands skip it: the scan reads every test file.
if (['status', 'next', 'apply', 'skip'].includes(cmd) && projectId && getProject(projectId)) syncProject(getProject(projectId)!, true);
commands[cmd]();
