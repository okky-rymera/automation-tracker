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
 *   npm run -s map -- park     <project> <kind> <ref> <reason>   (the mapping loop: a unit that failed 2 times)
 *   npm run -s map -- move-scope <project> <scope id> <feature id>   (a person's edit: see edits.moveScope)
 *   npm run -s map -- screenshots <project> <feature id> <folder>   (writes the images of the feature, to look at them)
 *
 * Output is JSON, so the skill can read it. Rules that protect people's work:
 *  - Text that a person wrote or checked can change. The review shows the old text, with "Change back".
 *    Each field has its own AI mark (ai_fields).
 *  - Labels are only added. List items, scopes, links and link scopes can be deleted or taken off too
 *    (removeItems, deleteScopes, links "remove" and "removeScopes"). A change to what a person made or
 *    checked gets the "Changed" mark in the review, with "Change back" (features.ts markAiChange, aiDelete*).
 *  - A link that a person removed is never added again.
 *  - Links made here have source "ai", so the app can show them as AI links.
 *  - Mapped code (feature_code) can be added and taken out (removeCode), also a person's, with the mark.
 *    Code that a person removed is never added again.
 *  - A library or unused decision is refused for code that a person put in a feature or checked.
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
import { leftOutSpec, leftOutTest } from './cypress-rules.ts';
import { getProject, hashFiles, importProjectsJson, repoFile, safeRepoPath, testRepoPath, type ProjectConfig } from './projects.ts';
import { syncProject } from './scan.ts';
import { EditError, edits, idNumber, markAiChange, aiDeleteItem, aiDeleteScope, scopeSetKey, NEW_SCOPE_ID, variationTitle, columnWord, columnList, variationValues, valuesKey, newVariation, resetVariations, moveEvidence, variationsOf, scopeRow, scopeLabel, jsonList, MAX_COLUMNS, ITEM_KINDS, LABEL_KINDS, SCOPE_ITEM_KIND, PRIORITIES, SCREENSHOT_MAX_BYTES, captionKey, imageType, labelValue, labelsInUse, nextSort, requirementClash, scopeGroupId, findScopeGroup, dropEmptyAiGroup, keepBefore, dropBefore, sweepBefore, isRejected, buryScope } from './features.ts';
import { loadCoverage, resolveView } from './coverage.ts';
import { runTestOwners } from './run-tests.ts';
import { functionNames } from './feature-code.ts';
import { addDecisions } from './code-decisions.ts';
import { codeWork, fillFingerprints, workByFile, type WorkItem } from './code-work.ts';
import { currentFingerprint } from './code-fingerprint.ts';
import { addLeftOut, clearLeftOutForLinked, leftOutIds } from './left-out.ts';
import { execFileSync } from 'node:child_process';

/** The commit of the plugin copy now, or null. */
function headCommit(p: ProjectConfig): string | null {
  try {
    return execFileSync('git', ['-C', p.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

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
  // Tests with a link row (also one that a person removed: that is a decision too), and left-out tests.
  const linked = new Set((db.prepare('SELECT DISTINCT test_id FROM links WHERE project_id = ?').all(p.id) as any[]).map((r) => r.test_id as string));
  const leftOut = leftOutIds(p.id);
  const parked = parkedUnits(p.id, kind);
  return [...byFile.entries()].map(([file, tests]) => {
    const repoFile = testRepoPath(p, kind, file);
    const unit = done.get(file);
    // Compare against the same files the unit saved (the test file, plus any extra files).
    const files = unit?.files.length ? unit.files : [repoFile];
    const hash = hashFiles(p, files);
    // A done file with a test that has no link and is not left out: the AI decides that test.
    const undecided = unit?.status === 'done' ? tests.filter((t) => !linked.has(t.id) && !leftOut.has(t.id)) : [];
    let state = !unit ? 'new' : unit.hash !== hash ? 'changed' : undecided.length ? 'unlinked' : unit.status;
    // A unit that failed 2 times in one loop waits until its files change.
    const park = parked.get(file);
    if (park && park.hash === hash && (state === 'new' || state === 'changed' || state === 'unlinked')) state = 'parked';
    return { file, repoFile, tests, unit, state, undecided, park, hash };
  });
}

/** Parked units of one kind, by ref (server/map-loop.ts parks a unit that failed 2 times in one loop). */
function parkedUnits(projectId: string, kind: Kind): Map<string, { hash: string; reason: string; parkedAt: string }> {
  const rows = db.prepare('SELECT ref, hash, reason, parked_at FROM parked_units WHERE project_id = ? AND kind = ?').all(projectId, kind) as any[];
  return new Map(rows.map((r) => [r.ref, { hash: r.hash, reason: r.reason, parkedAt: r.parked_at }]));
}

const OPEN_STATES = ['changed', 'new', 'unlinked'];

// ---- Commands ----

function status(p: ProjectConfig) {
  const res: Record<string, unknown> = {};
  for (const kind of ['playwright', 'cypress'] as const) {
    const files = testFiles(p, kind);
    const count = (s: string) => files.filter((f) => f.state === s).length;
    res[kind] = { files: files.length, done: count('done'), skipped: count('skipped'), changed: count('changed'), new: count('new'), unlinked: count('unlinked'), parked: count('parked') };
  }
  const code = units(p.id, 'code');
  const php = (db.prepare("SELECT COUNT(*) AS n FROM source_files WHERE project_id = ? AND lang = 'php'").get(p.id) as any).n;
  fillFingerprints(p);
  const work = codeWork(p);
  const statusView = resolveView(p, 'both');
  res.code = {
    areas: code.length,
    phpFiles: php,
    // No coverage run: the code work comes from the run, so it cannot be known yet.
    ...(statusView && loadCoverage(p, statusView) ? {} : { noCoverageRun: true }),
    filesWithWork: new Set(work.map((w) => w.file)).size,
    open: work.filter((w) => w.status === 'open').length,
    toCheck: work.filter((w) => w.status === 'check').length,
  };
  const f = db.prepare("SELECT COUNT(*) AS n, SUM(ai_fields <> '[]') AS ai FROM features WHERE project_id = ?").get(p.id) as any;
  const noCode = (db.prepare('SELECT COUNT(*) AS n FROM features f WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM feature_code c WHERE c.feature_id = f.id AND c.removed = 0)').get(p.id) as any).n;
  const noShots = (db.prepare('SELECT COUNT(*) AS n FROM features f WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM screenshots s WHERE s.feature_id = f.id AND s.removed = 0)').get(p.id) as any).n;
  res.features = { total: f.n, aiDraft: f.ai ?? 0, withoutCode: noCode, withoutScreenshots: noShots };
  res.order = 'Playwright files first, then Cypress files, then code areas. In each kind: changed files, new files, then done files with tests that have no link. "next <project>" with no kind follows this order.';
  out(res);
}

/** The order of the work: Playwright files first, then Cypress files, then the code that is left. */
function nextAny(p: ProjectConfig) {
  for (const kind of ['playwright', 'cypress'] as const) {
    if (testFiles(p, kind).some((f) => OPEN_STATES.includes(f.state))) return next(p, kind);
  }
  return nextCode(p);
}

function next(p: ProjectConfig, kind: Kind) {
  if (kind === 'code') return nextCode(p);
  const files = testFiles(p, kind);
  // Changed files first: they keep done work true. Then new files. Then done files with tests that have no link.
  const pick = files.find((f) => f.state === 'changed') ?? files.find((f) => f.state === 'new') ?? files.find((f) => f.state === 'unlinked');
  if (!pick) return out({ kind, done: true, message: `Every ${kind} file is processed and has not changed since.`, parked: files.filter((f) => f.state === 'parked').length });
  const since = pick.unit?.processed_at;
  // Which tests of the file have no coverage yet? The mapping loop makes a short coverage run of the
  // file first when one has none (server/map-loop.ts). Tests that the runs never run do not count:
  // skipped Playwright tests, and Cypress tests that the runs leave out (other plugins, a token).
  const view = resolveView(p, 'both');
  const cov = view && loadCoverage(p, view);
  const owners = cov ? runTestOwners(p) : null;
  const covered = new Set(cov ? cov.tests.map((t) => owners!.get(t.id)).filter(Boolean) : []);
  const fileLeftOut = kind === 'cypress' ? leftOutSpec(p, pick.file) : null;
  const runnable = fileLeftOut
    ? []
    : pick.tests.filter((t) => (kind === 'playwright' ? !json(t.data).skipped : !leftOutTest(json(t.tags), json(t.data).exampleTags)));
  const missingCoverage = runnable.filter((t) => !covered.has(t.id)).map((t) => t.id as string);
  const coverage = !missingCoverage.length;
  // The loop makes one short coverage run for each version of a file. When that run did not fill the
  // gap (a test that fails before it reaches the plugin, a tag the rules do not know), it does not run again.
  const tried = db.prepare('SELECT hash FROM coverage_tries WHERE project_id = ? AND kind = ? AND ref = ?').get(p.id, kind, pick.file) as { hash: string } | undefined;
  const coverageTried = !coverage && tried?.hash === pick.hash;
  out({
    kind,
    ref: pick.file,
    coverage,
    ...(missingCoverage.length ? { missingCoverage, fileHash: pick.hash } : {}),
    ...(coverageTried ? { coverageTried, coverageNote: 'A short coverage run of this file ran already and did not give coverage for these tests. Find their code by reading it.' } : {}),
    ...(fileLeftOut ? { coverageNote: `The test runs leave this file out: ${fileLeftOut}. Find the code by reading it.` } : {}),
    repoFile: pick.repoFile,
    absPath: path.join(p.path, pick.repoFile),
    state: pick.state,
    previous: pick.unit ? { processedAt: pick.unit.processed_at, status: pick.unit.status, features: pick.unit.features, note: pick.unit.note } : null,
    remaining: { new: files.filter((f) => f.state === 'new').length, changed: files.filter((f) => f.state === 'changed').length, unlinked: files.filter((f) => f.state === 'unlinked').length },
    // Only for state "unlinked": the tests to decide. Link each one, or put it in "leftOut" with a reason.
    ...(pick.state === 'unlinked' ? { unlinkedTests: pick.undecided.map((t) => t.id) } : {}),
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

/**
 * PHP files with code that the feature list does not account for yet (server/code-work.ts): "open"
 * items (no feature holds them, no decision) and "check" items (sorted, but the code changed since).
 * The files with the most such lines come first. A parked file (failed 2 times in a loop) is left
 * out until it changes.
 */
function nextCode(p: ProjectConfig) {
  fillFingerprints(p);
  const view = resolveView(p, 'both');
  const cov = view && loadCoverage(p, view);
  const parked = parkedUnits(p.id, 'code');
  const list = workByFile(codeWork(p, undefined, cov)).filter((x) => {
    const park = parked.get(x.file);
    return !park || park.hash !== hashFiles(p, [x.file]);
  });
  const item = (w: WorkItem) => ({
    function: w.function || '(code outside functions)',
    status: w.status,
    ...(w.lines ? { lines: w.lines } : {}),
    featureLines: w.featureLines,
    ...(w.state ? { state: w.state } : {}),
    ...(w.heldBy ? { heldBy: w.heldBy.map((h) => `F-${h.featureId} ${h.feature}${h.source === 'manual' ? ' (a person added it)' : ''}`) } : {}),
    ...(w.decision ? { decision: w.decision } : {}),
  });
  out({
    kind: 'code',
    coverage: cov?.label ?? null,
    message: !cov
      ? 'No coverage run yet: the code work comes from a coverage run, so it is not known. Run the coverage first (the sync does it). No code unit is possible now.'
      : list.length
      ? 'Pick one plugin feature or settings area. Sort every item of each file that you put in unit.files: put it in a feature, or in "library" or "unused". A "check" item changed since it was sorted: keep it, move it, or decide again.'
      : 'All plugin code is in a feature, or has a library or unused decision.',
    remainingFiles: list.length,
    open: list.reduce((n, x) => n + x.open, 0),
    toCheck: list.reduce((n, x) => n + x.check, 0),
    candidates: list.slice(0, 20).map((x) => ({ file: x.file, open: x.open, check: x.check, featureLines: x.featureLines, items: x.items.map(item) })),
  });
}

/** Functions in one repo file, with their coverage state and the tests (Playwright and Cypress) that ran them. */
function code(p: ProjectConfig, file: string | undefined) {
  if (!file || !safeRepoPath(p, file)) fail('Give a file path relative to the plugin repo.');
  const view = resolveView(p, 'both');
  const cov = view && loadCoverage(p, view);
  const runToTest = runTestOwners(p);
  const fns = cov?.functionsByFile.get(file) ?? [];
  // What holds each function now: features (by name, or the whole file) and decisions. "work": the open or "check" status.
  const heldRows = db
    .prepare('SELECT c.function, c.feature_id AS fid, f.title FROM feature_code c JOIN features f ON f.id = c.feature_id WHERE c.project_id = ? AND c.file = ? AND c.removed = 0')
    .all(p.id, file) as any[];
  const decisions = new Map((db.prepare('SELECT function, kind, reason FROM code_decisions WHERE project_id = ? AND file = ?').all(p.id, file) as any[]).map((r) => [r.function as string, r]));
  const work = new Map(codeWork(p, [file], cov).map((w) => [w.function, w.status]));
  const about = (name: string) => {
    const features = heldRows.filter((r) => r.function === name || r.function === '').map((r) => `F-${r.fid} ${r.title}${r.function === '' ? ' (whole file)' : ''}`);
    const d = decisions.get(name);
    return {
      ...(features.length ? { features } : {}),
      ...(d ? { decision: `${d.kind}: ${d.reason}` } : {}),
      ...(work.has(name) ? { work: work.get(name) } : {}),
    };
  };
  const seen = new Set<string>();
  out({
    file,
    coverage: cov?.label ?? null,
    functions: fns.map((fn) => {
      const tests = [...new Set(fn.tests.map((t) => runToTest.get(t)).filter(Boolean))] as string[];
      // Closures share one name: give the holder and work status only on the first one.
      const extra = seen.has(fn.function) ? {} : about(fn.function);
      seen.add(fn.function);
      // Library code runs on every request, so its test list says nothing about one feature.
      if (fn.state === 'library') return { name: fn.function, lines: `${fn.start}-${fn.end}`, state: fn.state, testCount: tests.length, ...extra };
      return {
        name: fn.function,
        lines: `${fn.start}-${fn.end}`,
        state: fn.state,
        tests: tests.map((id) => ({ id, links: linksOf(p.id, id).filter((l) => !l.removed).map((l) => `F-${l.featureId} ${l.feature}`) })),
        ...extra,
      };
    }),
    // The code outside all functions (class lines, properties, start-up code, a template). Name it "" in the payload.
    outsideFunctions: about(''),
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

/** Mapped code from a payload: { file, functions?, scopes? }. No functions = the whole file. scopes: titles or S-ids. */
interface CodeIn {
  file: string;
  functions?: string[];
  scopes?: (string | number)[];
}

/** confirm: a code unit, so sending an entry again sets its fingerprint to the code now (it checked the code). */
function writeCode(p: ProjectConfig, fid: number, entries: CodeIn[], scopeIds: Map<string, number | null>, report: string[], confirm: boolean) {
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
    const keys = list<string | number>(e.scopes, `scopes of code ${file}`);
    const marked = { n: 0 };
    const want = keys.length ? resolveScopes(fid, keys, scopeIds, `Code ${file}`, report, marked) : [];
    // Code of marked scopes only is not added. Code of deleted or moved scopes only is still saved for the whole feature.
    if (keys.length && !want.length && marked.n) {
      report.push(`F-${fid} code ${file}: not added or changed, because its scopes are marked "To remove".`);
      continue;
    }
    for (const fn of fns.length ? fns : ['']) {
      const cur = db.prepare('SELECT id, removed, source, fingerprint, ai_change FROM feature_code WHERE feature_id = ? AND file = ? AND function = ?').get(fid, file, fn) as any;
      const what = fn ? `${file} ${fn}` : `${file} (whole file)`;
      if (cur?.removed && cur.ai_change === null) {
        report.push(`F-${fid} code ${what}: a person removed it. Not added again.`);
        continue;
      }
      // The AI took this code out before, and no person checked it yet: the AI puts it back.
      if (cur?.removed) {
        const ch = JSON.parse(cur.ai_change);
        delete ch.removed;
        db.prepare('UPDATE feature_code SET removed = 0, ai_change = ? WHERE id = ?').run(Object.keys(ch).length ? JSON.stringify(ch) : null, cur.id);
        addScopeTags('code_scopes', cur.id, want);
        report.push(`F-${fid} code ${what}: back in the feature.`);
        continue;
      }
      // The code now: a new entry gets it, and sending an entry again confirms it (server/code-work.ts "check").
      const fp = currentFingerprint(p, file, fn, 'file');
      if (!cur) {
        const id = Number(db.prepare("INSERT INTO feature_code (project_id, feature_id, file, function, source, fingerprint) VALUES (?, ?, ?, ?, 'ai', ?)").run(p.id, fid, file, fn, fp).lastInsertRowid);
        addScopeTags('code_scopes', id, want);
        report.push(`F-${fid} code: added ${what}${want.length ? ` / ${names(want)}` : ''}.`);
        continue;
      }
      if (confirm && fp && cur.fingerprint !== fp) {
        db.prepare('UPDATE feature_code SET fingerprint = ? WHERE id = ?').run(fp, cur.id);
        report.push(`F-${fid} code ${what}: checked again after a change. It stays in the feature.`);
      }
      const haveList = (db.prepare('SELECT scope_id FROM code_scopes WHERE code_id = ?').all(cur.id) as any[]).map((r) => r.scope_id as number);
      const have = new Set(haveList);
      const missing = want.filter((x) => !have.has(x));
      if (!missing.length) continue;
      if (isRejected('code', cur.id, 'scopes', scopeSetKey([...haveList, ...missing]))) {
        report.push(`F-${fid} code ${what}: did not add ${names(missing)}: a person changed the scopes back before.`);
        continue;
      }
      // A change to code that a person added or checked: the review shows it as "Changed", with the old scopes.
      markAiChange('feature_code', cur.id, { scopes: haveList });
      addScopeTags('code_scopes', cur.id, missing);
      report.push(`F-${fid} code ${what}: added scopes ${names(missing)}.`);
    }
  }
}

/**
 * Takes code out of a feature (removeCode). AI code that no person checked: the row goes, and the AI can add it
 * again later. Code that a person added or checked: removed, with the "Changed" mark and "Change back".
 */
function removeCode(fid: number, entries: { file: string; function?: string }[], report: string[]) {
  for (const e of entries) {
    const file = str(e?.file, 500);
    const fn = str(e?.function ?? '', 300);
    const what = fn ? `${file} ${fn}` : `${file} (whole file)`;
    const cur = db.prepare('SELECT id, source, checked, ai_change FROM feature_code WHERE feature_id = ? AND file = ? AND function = ? AND removed = 0').get(fid, file, fn) as any;
    if (!cur) {
      report.push(`F-${fid} removeCode ${what}: the feature does not have this code.`);
      continue;
    }
    removeCodeRow(fid, cur, what, report);
  }
}

/**
 * The AI deletes a scope that is wrong now (deleteScopes). It always keeps a copy, so the review shows the delete with
 * "Change back". A scope marked "To remove" (or a variation of one) is a person's decision: the AI does not delete it.
 */
function deleteScopeAi(p: ProjectConfig, fid: number, k: string | number, report: string[]) {
  const key = String(k).trim();
  const m = SCOPE_RE.exec(key);
  const row = (m
    ? db.prepare('SELECT id, title, remove_reason, parent_id FROM scopes WHERE id = ? AND feature_id = ?').get(Number(m[1]), fid)
    : db.prepare('SELECT id, title, remove_reason, parent_id FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, key)) as any;
  if (!row) return void report.push(`F-${fid} deleteScopes "${key}": no such scope in F-${fid}.`);
  const label = `F-${fid} ${scopeLabel(scopeRow(row.id))} "${row.title}"`;
  if (isRejected('scope', row.id, 'deleted', 1)) return void report.push(`${label}: not deleted: a person brought it back before.`);
  const parentMark = row.parent_id !== null ? (db.prepare('SELECT remove_reason FROM scopes WHERE id = ?').get(row.parent_id) as any)?.remove_reason : null;
  if (row.remove_reason || parentMark) return void report.push(`${label}: not deleted: a person marked it "To remove". A person deletes it when its tests are gone.`);
  aiDeleteScope(p.id, row.id);
  report.push(`${label}: deleted. The review shows it, with "Change back".`);
}

/** Takes one code entry out of a feature: see removeCode. */
function removeCodeRow(fid: number, cur: { id: number; source: string; checked: number; ai_change: string | null }, what: string, report: string[]) {
  if (cur.source === 'ai' && !cur.checked && cur.ai_change === null) {
    db.prepare('DELETE FROM feature_code WHERE id = ?').run(cur.id);
    report.push(`F-${fid} code: removed ${what}.`);
    return;
  }
  if (isRejected('code', cur.id, 'removed', 1)) return void report.push(`F-${fid} code ${what}: not removed: a person put it back before.`);
  const tags = (db.prepare('SELECT scope_id FROM code_scopes WHERE code_id = ?').all(cur.id) as any[]).map((r) => r.scope_id as number);
  markAiChange('feature_code', cur.id, { scopes: tags, removed: true });
  db.prepare('UPDATE feature_code SET removed = 1 WHERE id = ?').run(cur.id);
  db.prepare('DELETE FROM code_scopes WHERE code_id = ?').run(cur.id);
  report.push(`F-${fid} code: removed ${what}. A person added or checked it: the review shows it, with "Change back".`);
}

// "S-14", "S14", or a copied "F-3/S-14" (the feature part is only a help for people).
const SCOPE_RE = /^(?:F-?\d+\/)?SV?-?(\d+)$/i;
const scopeNames = (linkId: number) =>
  (db.prepare('SELECT s.id, s.parent_id, s.title FROM link_scopes ls JOIN scopes s ON s.id = ls.scope_id WHERE ls.link_id = ? ORDER BY s.id').all(linkId) as any[]).map(
    (s) => `${scopeLabel(s)} ${s.title}`,
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
      priority: f.priority || null,
      aiFields: json(f.ai_fields),
      ...(f.remove_reason ? { toRemove: f.remove_reason } : {}),
      ...(f.description ? { description: f.description.length > 160 ? `${f.description.slice(0, 160)}… (cut: see "feature")` : f.description } : {}),
      roles: labelsOf(f.id, LABEL_KINDS.roles),
      // A variation shows under its scope's ID, with its values: "SV-44 (Shop page)".
      scopes: (db.prepare('SELECT id, parent_id, columns, title, var_values, remove_reason FROM scopes WHERE feature_id = ? AND parent_id IS NULL ORDER BY sort, id').all(f.id) as any[])
        .flatMap((s) => [
          `S-${s.id} ${s.title}${s.columns !== null ? ' [variations:]' : ''}${s.remove_reason ? ` [To remove: ${s.remove_reason}]` : ''}`,
          ...(s.columns === null ? [] : (db.prepare('SELECT id, var_values, remove_reason FROM scopes WHERE parent_id = ? ORDER BY sort, id').all(s.id) as any[]).map(
            (v) => `  SV-${v.id} (${jsonList(v.var_values).filter(Boolean).join(', ')})${v.remove_reason ? ` [To remove: ${v.remove_reason}]` : ''}`,
          )),
        ]),
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
    .prepare('SELECT ss.screenshot_id AS shot, s.id, s.parent_id, s.title FROM screenshot_scopes ss JOIN scopes s ON s.id = ss.scope_id WHERE s.feature_id = ? ORDER BY s.id')
    .all(fid) as any[])
    tags.set(r.shot, [...(tags.get(r.shot) ?? []), `${scopeLabel(r)} ${r.title}`]);
  return (db.prepare('SELECT id, caption, match_key, source, checked, removed, ai_change, stale FROM screenshots WHERE feature_id = ? ORDER BY sort, id').all(fid) as any[]).map((x) => ({
    id: `IMG-${x.id}`,
    caption: x.caption,
    ...(x.match_key !== null && x.match_key !== captionKey(x.caption) ? { firstCaption: x.match_key } : {}),
    source: x.source,
    checked: !!x.checked,
    removed: !!x.removed,
    ...(x.ai_change !== null ? { aiChange: json(x.ai_change) } : {}),
    ...(x.stale ? { stale: x.stale } : {}),
    scopes: tags.get(x.id) ?? [],
  }));
}

/** The values of a variation as { column name: value }. */
function valuesObject(columns: string[], values: string[]) {
  return Object.fromEntries(columns.map((c, i) => [c, values[i] ?? '']));
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
    toRemove: f.remove_reason ? { reason: f.remove_reason, by: f.remove_by, at: f.remove_at } : null,
    ...Object.fromEntries(Object.entries(LABEL_KINDS).map(([key, kind]) => [key, labelsOf(f.id, kind)])),
    ...Object.fromEntries(Object.entries(ITEM_KINDS).map(([key, kind]) => [key, itemsOf(f.id, kind)])),
    scopeGroups: (db.prepare('SELECT title FROM scope_groups WHERE feature_id = ? ORDER BY sort, id').all(f.id) as any[]).map((g) => g.title),
    // A scope with variations: its columns, and its variations (SV- IDs) with their values.
    scopes: (db.prepare('SELECT s.id, s.title, s.description, g.title AS grp, s.columns, s.ai_fields, s.remove_reason FROM scopes s LEFT JOIN scope_groups g ON g.id = s.group_id WHERE s.feature_id = ? AND s.parent_id IS NULL ORDER BY s.sort, s.id').all(f.id) as any[]).map((s) => {
      const columns = s.columns === null ? null : jsonList(s.columns);
      return {
        id: `S-${s.id}`, title: s.title, group: s.grp ?? null, description: s.description, requirements: itemsOf(f.id, SCOPE_ITEM_KIND, s.id), aiFields: json(s.ai_fields),
        ...(s.remove_reason ? { toRemove: s.remove_reason } : {}),
        ...(columns ? {
          columns,
          variations: (db.prepare('SELECT id, var_values, ai_fields, remove_reason FROM scopes WHERE parent_id = ? ORDER BY sort, id').all(s.id) as any[]).map((v) => ({
            id: `SV-${v.id}`, values: valuesObject(columns, jsonList(v.var_values)), aiFields: json(v.ai_fields), ...(v.remove_reason ? { toRemove: v.remove_reason } : {}),
          })),
        } : {}),
      };
    }),
    links: links.slice(0, all ? undefined : 25).map((l) => ({
      testId: l.testId, title: l.title, framework: l.framework, source: l.source, removed: !!l.removed, scopes: scopeNames(l.id),
    })),
    linkCount: links.length,
    code: (db.prepare('SELECT id, file, function, source, removed FROM feature_code WHERE feature_id = ? ORDER BY file, function').all(f.id) as any[]).map((c) => ({
      file: c.file, function: c.function || null, source: c.source, removed: !!c.removed,
      scopes: (db.prepare('SELECT s.id, s.parent_id, s.title FROM code_scopes cs JOIN scopes s ON s.id = cs.scope_id WHERE cs.code_id = ? ORDER BY s.sort').all(c.id) as any[]).map((x) => `${scopeLabel(x)} ${x.title}`),
    })),
    screenshots: screenshotsOf(f.id),
    ...(all || links.length <= 25 ? {} : { note: 'At most 25 links shown. Add --all to see every link.' }),
  });
}

// ---- apply ----

type ItemIn = string | { id: number; text: string };
interface LinkIn {
  testId: string;
  /** Scopes the test checks: titles or S-ids. They are added to the link. */
  scopes?: (string | number)[];
  scope?: string | number;
  /** Scopes that the test does not check: they come off the link. */
  removeScopes?: (string | number)[];
  /** true: the test does not check this feature. The link is removed. */
  remove?: boolean;
}
interface FeatureIn {
  id?: number;
  title?: string;
  /** A rename. "title" with "id" only names the feature: it changes only an AI draft title. */
  newTitle?: string;
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
  /** The settings of the feature: one item for each, with its place, its choices and its default value. */
  settings?: ItemIn[];
  questions?: ItemIn[];
  /** IDs of list items to delete, scope requirements too. A person's item gets a copy for "Change back". */
  removeItems?: number[];
  /** Unit kind "answer" only: IDs of open questions that the answer-questions skill answered. Deleted also when a person wrote them. */
  answeredQuestions?: number[];
  scopes?: ScopeIn[];
  links?: LinkIn[];
  /**
   * Unit kind "update" only: linked tests that the AI confirmed as renamed. The links of this feature move
   * from the old test ID to the new one, with their scopes, source and check. The old test must be gone from the repo.
   */
  renames?: { from: string; to: string }[];
  /** Scopes (S-ids, SV-ids or titles) that are wrong now. A scope that a person wrote or checked gets a copy, for "Change back". */
  deleteScopes?: (string | number)[];
  /** Plugin code of the feature: a whole file, or functions in it. Sending code that the feature has already confirms it (a "check" item). */
  code?: CodeIn[];
  /**
   * Code to take out of this feature, to move it to another feature (or to "library" or "unused") after
   * it changed. A person's code is taken out with the "Changed" mark. function "" or no function: the whole-file entry.
   */
  removeCode?: { file: string; function?: string }[];
  /** Images of the feature: a local image file, a caption, and the scopes it shows. */
  screenshots?: ShotIn[];
}
interface ScopeIn {
  id?: number | string;
  title: string;
  /** A rename. "title" with "id" only names the scope: it changes only an AI draft title. */
  newTitle?: string;
  /** null deletes an AI draft description. */
  description?: string | null;
  /** Group name: scopes about one topic of the feature show together, like a describe block of tests. */
  group?: string;
  /** What must be true for this scope only, on top of the feature's requirements. */
  requirements?: ItemIn[];
  /**
   * Variations: one check in several places (pages, roles, product types). Each variation is an object with
   * the column names as keys, for example { "Page": "Cart page", "Product type": "Variation" }. A new key adds
   * a column. Variations are only added: the skill does not change or delete one. A link, screenshot or code
   * entry names a variation by its SV- ID or its title "<scope title> (<value 1>, <value 2>)".
   */
  variations?: Record<string, string>[];
  /** The column names, in order, when the scope gets its first variations. Default: the keys of the variations. */
  columns?: string[];
}
interface ShotIn {
  /** IMG-12 or 12: a screenshot that is there. Else the caption finds it, or a new one is added. */
  id?: string | number;
  /** A local image file: for a new screenshot, or with replace: true. */
  file?: string;
  /** The caption of a new screenshot, or the first caption of one that is there. */
  caption?: string;
  /** Scopes that the image shows: they are added as tags. */
  scopes?: (string | number)[];
  /** Tags to take off. */
  removeScopes?: (string | number)[];
  newCaption?: string;
  /** true: the image of "file" replaces the image. */
  replace?: boolean;
  /** true: delete the screenshot. */
  remove?: boolean;
  /** Why the image is old (for example after a code change). A new image clears it. */
  stale?: string;
}
interface Payload {
  /**
   * kind "update": an AI update after a code change (server/ai-update.ts).
   * kind "answer": the answer-questions skill answered open questions.
   * Neither is a unit of the mapping order.
   */
  unit: { kind: Kind | 'update' | 'answer'; ref: string; files?: string[]; note?: string };
  features: FeatureIn[];
  /**
   * Functions that no test runs and that are library code (startup, helpers, glue), not feature code
   * (server/code-decisions.ts). The coverage data then counts their lines as library, and "next code"
   * does not offer them again. Each needs a reason.
   */
  library?: { file: string; function: string; reason: string }[];
  /**
   * Code that no plugin code loads or calls (server/code-decisions.ts, kind "unused"). It counts apart
   * from library code, so the team can delete it. function "": the code outside all functions (a whole template).
   */
  unused?: { file: string; function?: string; reason: string }[];
  /**
   * Tests of the unit that fit no feature, each with a reason (server/left-out.ts). "next" then does
   * not give the file again for them.
   */
  leftOut?: { testId: string; reason: string }[];
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
  const library = Array.isArray(body.library) ? body.library : [];
  if (body.library !== undefined && !Array.isArray(body.library)) fail('library must be a list');
  const unused = Array.isArray(body.unused) ? body.unused : [];
  if (body.unused !== undefined && !Array.isArray(body.unused)) fail('unused must be a list');
  if ((library.length || unused.length) && kind !== 'code' && !update) fail('"library" and "unused" work only for a code unit. Nothing was saved.');
  const leftOut = Array.isArray(body.leftOut) ? body.leftOut : [];
  if (body.leftOut !== undefined && !Array.isArray(body.leftOut)) fail('leftOut must be a list');
  if (leftOut.length && (kind === 'code' || update)) fail('leftOut works only for a Playwright or Cypress unit. Nothing was saved.');
  if (!Array.isArray(body.features)) body.features = [];
  if (!body.features.length && !(kind === 'code' && (library.length || unused.length)) && !leftOut.length)
    fail('features is empty. Use the skip command for a test unit with no feature (a code unit can send only "library" or "unused"; a test unit can send only "leftOut").');
  for (const [what, items] of [['library', library], ['unused', unused]] as const) {
    for (const it of items as { file: string; function?: string }[]) {
      // A bad entry: addDecisions refuses it with a clear message.
      if (!it || typeof it.file !== 'string') continue;
      const fn = String(it?.function ?? '');
      const known = it && typeof it.file === 'string' ? functionNames(p, it.file) : null;
      if (fn && known && !known.has(fn)) fail(`${what}: ${it.file} has no function "${fn}" in the coverage run. Use the names that "code" lists, or "" for the code outside functions. Nothing was saved.`);
    }
  }
  if (kind !== 'code' && !update && body.features.some((f) => f?.removeCode !== undefined)) fail('"removeCode" works only for a code unit or an update. Nothing was saved.');

  // Files the unit read: the test file, or the code files of the area.
  let files = (unit.files ?? []).map((f) => str(f, 500)).filter(Boolean);
  if (kind === 'update' || kind === 'answer') files = [];
  else if (kind !== 'code') {
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND framework = ? AND file = ? AND removed_at IS NULL').get(p.id, kind, ref))
      fail(`No ${kind} file "${ref}" in the last scan. Use the ref that "next" gave.`);
    files = [...new Set([testRepoPath(p, kind, ref), ...files])];
  } else if (!files.length) fail('A code unit needs unit.files: the repo files whose code the unit sorted.');
  for (const f of files) {
    const full = repoFile(p, f);
    if (!full) fail(`File path is outside the plugin repo, or hidden: ${f}`);
    if (!fs.existsSync(full)) fail(`No file ${f} in the plugin repo. Give paths relative to the repo root.`);
  }

  // A code unit must sort code that was open or to check: else the loop would get the same files again.
  if (kind === 'code') {
    fillFingerprints(p);
    if (!codeWork(p, files).length) fail(`unit.files has no open or "check" code: ${files.join(', ')}. List the files whose code this unit sorts ("next ${p.id} code" lists them). Nothing was saved.`);
  }

  // Old field names, checked before anything is written.
  for (const inF of body.features) {
    if ((inF as any)?.needs !== undefined) fail('"needs" is now "requirements": a list of sentences. Nothing was saved.');
    if ((inF as any)?.rules !== undefined) fail('"rules" is gone: write a rule that a test can check as a scope, and other text as "notes". Nothing was saved.');
    for (const s of Array.isArray(inF?.scopes) ? inF.scopes : [])
      if ((s as any)?.rules !== undefined || (s as any)?.notes !== undefined) fail('A scope has only "requirements", no "rules" or "notes". Nothing was saved.');
    if (!answer && inF?.answeredQuestions !== undefined) fail('"answeredQuestions" works only with unit kind "answer". Nothing was saved.');
    if (unit.kind !== 'update' && inF?.renames !== undefined) fail('"renames" works only with unit kind "update". Nothing was saved.');
    if ((inF as any)?.scopeSets !== undefined) fail('"scopeSets" is gone: a scope has "variations" now. Write the description and requirements on the scope. Nothing was saved.');
    for (const s of Array.isArray(inF?.scopes) ? inF.scopes : [])
      if ((s as any)?.set !== undefined || (s as any)?.values !== undefined || (s as any)?.value !== undefined)
        fail('A scope has no "set", "values" or "value" now: write one scope with a list of "variations". Nothing was saved.');
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
        // A person marked the feature "To remove": the AI skills do not change it or add to it.
        const marked = inF?.id ? (db.prepare('SELECT remove_reason FROM features WHERE id = ? AND project_id = ?').get(Number(inF.id), p.id) as any)?.remove_reason : null;
        if (marked) {
          report.push(`F-${inF.id}: marked "To remove" (${marked}). Nothing written to it: no text, scope, link, code or screenshot.`);
          touched.push(Number(inF.id));
          continue;
        }
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
          // A variation has no requirements: its scope has them.
          const parent = sid === null ? null : scopeRow(sid).parentId;
          if (parent !== null && list<ItemIn>(s.requirements, 'scope requirements').length) report.push(`SV-${sid}: a variation has no requirements. Write them on its scope S-${parent}.`);
          else if (sid !== null) writeItems(fid, SCOPE_ITEM_KIND, list<ItemIn>(s.requirements, 'scope requirements'), report, sid);
        }
        for (const k of list<string | number>(inF.deleteScopes, 'deleteScopes')) deleteScopeAi(p, fid, k, report);
        // Renames first: a link in this payload for the new test then adds to the moved link.
        for (const r of list<{ from: string; to: string }>(inF.renames, 'renames')) moveRenamedLink(p, fid, r, report);
        for (const l of list<LinkIn>(inF.links, 'links')) writeLink(p, fid, l, scopeIds, report);
        removeCode(fid, list<{ file: string; function?: string }>(inF.removeCode, 'removeCode'), report);
        writeCode(p, fid, list<CodeIn>(inF.code, 'code'), scopeIds, report, kind === 'code');
        for (const x of list<ShotIn>(inF.screenshots, 'screenshots')) writeScreenshot(p, fid, x, scopeIds, report);
        if (totalChanges() > before) changed.add(fid);
      }
      if (leftOut.length) {
        const fileTests = new Set((db.prepare('SELECT id FROM tests WHERE project_id = ? AND framework = ? AND file = ? AND removed_at IS NULL').all(p.id, kind, ref) as any[]).map((r) => r.id as string));
        const other = leftOut.filter((x) => !fileTests.has(String(x?.testId ?? '').trim()));
        if (other.length) throw new EditError(`leftOut: ${other.map((x) => x?.testId).join(', ')} is not a test of ${ref}`);
        const n = addLeftOut(p.id, leftOut, 'ai');
        report.push(`Left out: ${n} test${n === 1 ? '' : 's'} (${leftOut.map((x) => x.testId).join(', ')}).`);
      }
      // A test that got a link now is not "left out" any more.
      clearLeftOutForLinked(p.id);
      // Each test of the file needs a decision: a link (also one that a person removed) or a left-out row.
      // Without it, "next" gives the same file again and again.
      if (!update && kind !== 'code') {
        const open = (db
          .prepare(
            `SELECT t.id FROM tests t WHERE t.project_id = ? AND t.framework = ? AND t.file = ? AND t.removed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM links l WHERE l.project_id = t.project_id AND l.test_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM test_left_out o WHERE o.project_id = t.project_id AND o.test_id = t.id)`,
          )
          .all(p.id, kind, ref) as any[]).map((r) => r.id as string);
        if (open.length) throw new EditError(`these tests have no link and are not in "leftOut": ${open.join(', ')}. Link each test, or put it in "leftOut" with a reason`);
      }
      const commit = library.length || unused.length ? headCommit(p) : null;
      const named = (l: { file: string; function?: string }) => `${l.file} ${l.function || '(code outside functions)'}`;
      // A decision makes the lines library or unused: the same code entry in a feature comes out of it.
      // Code that a person added or checked gets the "Changed" mark, with "Change back" (removeCodeRow).
      for (const it of [...library, ...unused] as { file: string; function?: string }[]) {
        if (!it || typeof it.file !== 'string') continue;
        const fn = String(it.function ?? '');
        // In a decision, "" is the code outside functions. In a feature, "" is the whole file: not the same code.
        if (!fn) continue;
        for (const cur of db.prepare('SELECT id, feature_id, source, checked, ai_change FROM feature_code WHERE project_id = ? AND file = ? AND function = ? AND removed = 0').all(p.id, it.file, fn) as any[]) {
          removeCodeRow(cur.feature_id, cur, `${it.file} ${fn || '(code outside functions)'}`, report);
          changed.add(cur.feature_id);
        }
      }
      if (library.length) {
        const n = addDecisions(p, 'library', library, 'ai', commit);
        report.push(`Library code: ${n} item${n === 1 ? '' : 's'} (${library.map(named).join(', ')}).`);
      }
      if (unused.length) {
        const n = addDecisions(p, 'unused', unused, 'ai', commit);
        report.push(`Unused code: ${n} item${n === 1 ? '' : 's'} (${unused.map(named).join(', ')}).`);
      }
      // Each code item of the unit's files must be sorted now. A left-out item would come back in "next"
      // again and again. The check sees the writes above (same transaction).
      if (kind === 'code') {
        const left = codeWork(p, files);
        if (left.length)
          throw new EditError(
            `these items of unit.files are not sorted: ${left.map((w) => `${w.file} ${w.function || '(code outside functions)'}${w.status === 'check' ? ' (changed: confirm, move or decide again)' : ''}`).join('; ')}. Put each one in a feature's "code", or in "library" or "unused". Or take its file out of unit.files`,
          );
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
  // Only the AI skills call this: the group is AI-made until a person changes it.
  return Number(db.prepare('INSERT INTO feature_groups (project_id, title, sort, ai_made) VALUES (?, ?, ?, 1)').run(p.id, t, n).lastInsertRowid);
}

/**
 * Sets one field. The AI can change a value that a person wrote or checked too: the value from before
 * is kept, and the review shows it with "Change back". A title of a person changes only on an explicit
 * rename (newTitle). A value that a person changed back before is not written again (ai_rejected).
 * Adds the field to ai when it writes. Returns true when it changed.
 */
function setText(table: 'features' | 'scopes', row: any, ai: Set<string>, field: string, col: string, value: string | number | null, label: string, report: string[], rename = false) {
  if (value === '' || value === null || value === undefined || row[col] === value) return false;
  const empty = row[col] === '' || row[col] === null;
  // A title also names the row: the AI sends it with the ID, so a new wording is not a rename. A person's title changes only with newTitle.
  if (field === 'title' && !rename && !row.isNew && !empty && !ai.has('title')) {
    report.push(`${label}: kept the title that a person wrote or checked. Suggested title "${value}" was not saved. To rename it because it is wrong, send "newTitle".`);
    return false;
  }
  if (!row.isNew && isRejected(table === 'features' ? 'feature' : 'scope', row.id, field, value)) {
    report.push(`${label}: did not set the ${field} to "${value}": a person changed this value back before.`);
    return false;
  }
  if (!empty && !ai.has(field)) report.push(`${label}: changed the ${field} that a person wrote or checked. The review shows the old value, with "Change back".`);
  else if (!empty) report.push(`${label}: replaced the earlier AI draft ${field}.`);
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
  if (f.id && (f.newTitle || f.title)) {
    const t = str(f.newTitle || f.title, 2000);
    const same = db.prepare('SELECT id FROM features WHERE project_id = ? AND lower(title) = lower(?) AND id <> ?').get(p.id, t, row.id) as any;
    if (same && (ai.has('title') || f.newTitle)) report.push(`${label}: did not change the title to "${t}": F-${same.id} has this title.`);
    else setText('features', row, ai, 'title', 'title', t, label, report, !!f.newTitle);
  }
  setText('features', row, ai, 'description', 'description', str(f.description), label, report);
  setText('features', row, ai, 'priority', 'priority', priority, label, report);
  if (groupTitle && !row.isNew && isRejected('feature', row.id, 'group', groupTitle)) {
    report.push(`${label}: did not put it in group "${groupTitle}": a person changed this group back before.`);
  } else if (groupTitle) {
    let g = findGroup(p, groupTitle);
    const made = g === undefined;
    if (made) g = createGroup(p, groupTitle);
    // A refused change must not leave a new, empty group.
    if (!setText('features', row, ai, 'group', 'group_id', g!, label, report) && made) db.prepare('DELETE FROM feature_groups WHERE id = ?').run(g!);
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
      if (kind === 'question' && answeredBefore(fid, t)) report.push(`${label}: did not change question #${row.id} to "${t}": that question was answered before.`);
      else if (clash) report.push(`${label}: did not change item #${row.id} to "${t}": ${clash}`);
      else if (isRejected('item', row.id, 'text', t)) report.push(`${label}: did not change item #${row.id} to "${t}": a person changed this text back before.`);
      else {
        // The text of a person: keep it for "Change back", and mark the item as an AI change.
        keepBefore('item', row.id, 'text', row.text, !row.ai_draft);
        db.prepare('UPDATE feature_items SET text = ?, ai_draft = 1 WHERE id = ?').run(t, row.id);
        report.push(
          row.ai_draft
            ? `${label}: changed AI draft ${kind} item #${row.id}.`
            : `${label}: changed ${kind} item #${row.id} that a person wrote or checked. The review shows the old text, with "Change back".`,
        );
      }
    } else throw new EditError(`A ${kind} item must be text or { "id", "text" }`);
  }
}

function removeItems(fid: number, ids: number[], report: string[]) {
  for (const id of new Set(ids.map(Number))) {
    const row = db.prepare('SELECT * FROM feature_items WHERE id = ? AND feature_id = ?').get(Number(id), fid) as any;
    if (!row) throw new EditError(`No list item #${id} in F-${fid}`);
    // An item that a person wrote or checked: deleted with a copy, so the review shows it with "Change back".
    const person = !row.ai_draft || !!db.prepare("SELECT 1 FROM ai_before WHERE kind = 'item' AND row_id = ? AND field = 'text'").get(row.id);
    if (person) {
      if (isRejected('item', row.id, 'deleted', 1)) {
        report.push(`F-${fid}: kept item #${id}: a person brought it back before.`);
        continue;
      }
      aiDeleteItem(fid, row);
      if (row.kind === 'question') rememberAnswered(fid, row.text);
      report.push(`F-${fid}: deleted item #${id}, which a person wrote or checked. The review shows it, with "Change back".`);
    } else {
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
function writeScope(fid: number, s: ScopeIn, report: string[]): number | null {
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
  // A variation has the mark of its scope too.
  const mark = row?.remove_reason || (row?.parent_id != null ? (db.prepare('SELECT remove_reason FROM scopes WHERE id = ?').get(row.parent_id) as any)?.remove_reason : null);
  if (mark) {
    report.push(`F-${fid} scope ${scopeLabel(row)} "${row.title}": marked "To remove" (${mark}). Not changed. Its requirements, links and screenshots in this payload were skipped.`);
    return null;
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
    writeVariations(fid, Number(id), s, `S-${id}`, report);
    return Number(id);
  }
  if (row.parent_id !== null) {
    // A variation: its scope has the text and the group. The links of the payload can still name it.
    if (str(s.description) || s.group || s.variations) report.push(`SV-${row.id}: a variation of S-${row.parent_id}. Its text was not changed: write the scope S-${row.parent_id} with "variations".`);
    return row.id;
  }
  const label = `S-${row.id}`;
  const ai = new Set<string>(json(row.ai_fields));
  const rename = str(s.newTitle, 2000);
  const next = rename || title;
  const clash = next.toLowerCase() !== String(row.title).toLowerCase()
    ? (db.prepare('SELECT id, parent_id FROM scopes WHERE feature_id = ? AND lower(title) = lower(?) AND id <> ?').get(fid, next, row.id) as any)
    : null;
  if (clash && (ai.has('title') || rename)) report.push(`${label}: did not change the title to "${next}": ${scopeLabel(clash)} has this title.`);
  else {
    const oldTitle = String(row.title);
    if (setText('scopes', row, ai, 'title', 'title', next, label, report, !!rename)) {
      // Remember the old title, as for a rename by a person: the AI skill finds scopes by title.
      if (oldTitle.trim().toLowerCase() !== next.toLowerCase()) buryScope(fid, row.id, oldTitle);
      // The titles of the variations come from the scope title.
      if (row.columns !== null) resetVariations(scopeRow(row.id), next, (v) => v);
    }
  }
  if (s.description === null) clearScopeDescription(row, ai, label, report);
  else setText('scopes', row, ai, 'description', 'description', str(s.description), label, report);
  writeScopeGroup(fid, row, ai, s.group, label, report);
  saveAi('scopes', row, ai);
  writeVariations(fid, row.id, s, label, report);
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
  // A refused group is remembered by its title (the ID of an AI group changes when it is made again). Old rows have the ID.
  const knownTitle = known === null ? null : ((db.prepare('SELECT title FROM scope_groups WHERE id = ?').get(known) as any)?.title as string | undefined);
  if (isRejected('scope', row.id, 'group', title.trim()) || (knownTitle && isRejected('scope', row.id, 'group', knownTitle)) || (known !== null && isRejected('scope', row.id, 'group', known))) {
    report.push(`${label}: did not put it in group "${title.trim()}": a person changed this group back before.`);
    return;
  }
  const byPerson = !ai.has('group') && (row.group_id !== null || row.group_by_person);
  const gid = known ?? scopeGroupId(fid, title, true)!;
  const before = name(row.group_id);
  report.push(
    byPerson
      ? `${label}: moved from ${before ? `group "${before}"` : 'no group'}, which a person chose or checked, to "${name(gid)}". The review shows the old group, with "Change back".`
      : before
        ? `${label}: moved from the AI draft group "${before}" to "${name(gid)}".`
        : `${label}: put in group "${name(gid)}". It shows as AI draft until a person checks it.`,
  );
  keepBefore('scope', row.id, 'group', row.group_id, !ai.has('group'));
  db.prepare('UPDATE scopes SET group_id = ? WHERE id = ? OR parent_id = ?').run(gid, row.id, row.id);
  ai.add('group');
  const dropped = dropEmptyAiGroup(row.group_id);
  if (dropped) report.push(`F-${fid}: deleted the AI draft group "${dropped}". It has no scopes now.`);
}

/**
 * Adds the variations that the AI skill sends for scope sid. A variation that the scope has (the same values)
 * stays as it is. A variation that a person deleted is not added again. A new key adds a column. When the
 * scope gets its first variations, its test links, screenshots and code go to the first variation: a scope
 * with variations has none. A new variation shows as AI draft until a person checks it.
 */
function writeVariations(fid: number, sid: number, s: ScopeIn, label: string, report: string[]) {
  const given = list<Record<string, unknown>>(s.variations, `variations of ${label}`);
  if (!given.length) {
    if (s.columns !== undefined) report.push(`${label}: "columns" without "variations". Nothing changed.`);
    return;
  }
  // All or nothing: a failed variation undoes the columns and variations that this call made before it.
  const lines: string[] = [];
  db.exec('SAVEPOINT write_variations');
  try {
    for (const v of given) if (!v || typeof v !== 'object' || Array.isArray(v)) throw new EditError('each variation is an object { "<column>": "<value>" }');
    const keys: string[] = [];
    for (const v of given) for (const k of Object.keys(v)) {
      const name = columnWord(k, 'Column name');
      if (!keys.some((x) => x.toLowerCase() === name.toLowerCase())) keys.push(name);
    }
    let cur = scopeRow(sid);
    let first = false;
    if (cur.columns === null) {
      const cols = columnList(s.columns ?? keys);
      db.prepare('UPDATE scopes SET columns = ? WHERE id = ?').run(JSON.stringify(cols), sid);
      cur = { ...cur, columns: cols };
      first = true;
      lines.push(`${label}: has variations now, with the columns ${cols.map((c) => `"${c}"`).join(', ')}.`);
    }
    const extra = keys.filter((k) => !cur.columns!.some((c) => c.toLowerCase() === k.toLowerCase()));
    if (extra.length) {
      if (cur.columns!.length + extra.length > MAX_COLUMNS) throw new EditError(`the scope would have more than ${MAX_COLUMNS} columns`);
      resetVariations(cur, cur.title, (vals) => [...vals, ...extra.map(() => '')]);
      cur = { ...cur, columns: [...cur.columns!, ...extra] };
      db.prepare('UPDATE scopes SET columns = ? WHERE id = ?').run(JSON.stringify(cur.columns), sid);
      lines.push(`${label}: new column(s) ${extra.map((c) => `"${c}"`).join(', ')}. The other variations have no value there.`);
    }
    for (const v of given) {
      const values = variationValues(cur.columns!, v);
      const shown = values.filter(Boolean).join(', ');
      if (variationsOf(sid).some((x) => valuesKey(x.values) === valuesKey(values))) continue;
      const gone = goneScope(fid, { title: variationTitle(cur.title, values) });
      if (gone && 'skip' in gone) {
        lines.push(`${label} variation (${shown}): ${gone.skip.replace('scope S-', 'variation SV-')}. Not added again.`);
        continue;
      }
      if (gone) continue; // an old title of a variation that is still here, with other values now
      const vid = newVariation(cur, values, ['title']);
      lines.push(`${label}: new variation SV-${vid} (${shown}). It shows as AI draft until a person checks it.`);
      if (first) {
        moveEvidence(sid, vid);
        first = false;
      }
    }
    db.exec('RELEASE write_variations');
    report.push(...lines);
  } catch (e) {
    db.exec('ROLLBACK TO write_variations');
    db.exec('RELEASE write_variations');
    if (!(e instanceof EditError)) throw e;
    report.push(`${label}: variations not saved, nothing changed: ${e.message}`);
  } finally {
    // No variation was made (a person deleted each one, or the values clash): the scope stays a normal scope.
    if (!variationsOf(sid).length && (db.prepare('SELECT columns FROM scopes WHERE id = ?').get(sid) as any)?.columns != null) {
      db.prepare('UPDATE scopes SET columns = NULL WHERE id = ?').run(sid);
      report.push(`${label}: no variation was added, so the scope has no variations.`);
    }
  }
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

const names = (ids: number[]) => ids.map((s) => scopeLabel({ id: s, parentId: (db.prepare('SELECT parent_id FROM scopes WHERE id = ?').get(s) as any)?.parent_id ?? null })).join(', ');
/** Adds scope tags to a link or a screenshot. Tags that are there stay. */
function addScopeTags(table: 'link_scopes' | 'screenshot_scopes' | 'code_scopes', id: number, scopeIds: number[]) {
  const col = table === 'link_scopes' ? 'link_id' : table === 'code_scopes' ? 'code_id' : 'screenshot_id';
  const add = db.prepare(`INSERT OR IGNORE INTO ${table} (${col}, scope_id) VALUES (?, ?)`);
  for (const s of scopeIds) add.run(id, s);
}

/**
 * Scope IDs of feature fid from titles (of this payload or the feature) or S-ids.
 * A scope that a person deleted or moved away is left out, with a line in the report.
 */
/** A scope with its columns, and the "To remove" mark of its scope when it is a variation. */
const PICK = 'SELECT s.id, s.remove_reason, s.columns, p.remove_reason AS parent_mark FROM scopes s LEFT JOIN scopes p ON p.id = s.parent_id';
function resolveScopes(fid: number, keys: (string | number)[], scopeIds: Map<string, number | null>, what: string, report: string[], marked?: { n: number }): number[] {
  const ids = keys
    .map((k) => String(k).trim())
    .filter(Boolean)
    .map((key) => {
      if (scopeIds.has(key.toLowerCase())) {
        const id = scopeIds.get(key.toLowerCase())!;
        if (id === null) return null;
        const r = db.prepare(`${PICK} WHERE s.id = ?`).get(id) as any;
        // A scope of this payload can have variations: then it takes no test, screenshot or code itself.
        if (r?.columns != null) throw new EditError(`${what}: S-${id} has variations. Name a variation: ${variationsOf(id).map((v) => `SV-${v.id}`).join(', ')}`);
        if (r?.remove_reason || r?.parent_mark) return marked && marked.n++, report.push(`${what}: scope "${key}" left out: it is marked "To remove".`), null;
        return id;
      }
      const byId = SCOPE_RE.exec(key);
      const row = byId
        ? (db.prepare(`${PICK} WHERE s.id = ? AND s.feature_id = ?`).get(Number(byId[1]), fid) as any)
        : (db.prepare(`${PICK} WHERE s.feature_id = ? AND lower(s.title) = lower(?)`).get(fid, key) as any);
      const leaveMarked = () => (marked && marked.n++, report.push(`${what}: scope "${key}" left out: it is marked "To remove".`), null);
      // A test, screenshot or code entry goes on a variation, not on a scope with variations.
      if (row?.columns != null) throw new EditError(`${what}: S-${row.id} has variations. Name a variation: ${variationsOf(row.id).map((v) => `SV-${v.id}`).join(', ')}`);
      if (row?.remove_reason || row?.parent_mark) return leaveMarked();
      if (row) return row.id as number;
      const gone = goneScope(fid, byId ? { id: Number(byId[1]) } : { title: key });
      if (gone && 'id' in gone) {
        // An old title of a scope that a person renamed: the mark counts too.
        const g = db.prepare(`${PICK} WHERE s.id = ?`).get(gone.id) as any;
        if (g?.columns != null) throw new EditError(`${what}: S-${g.id} has variations. Name a variation: ${variationsOf(g.id).map((v) => `SV-${v.id}`).join(', ')}`);
        if (g?.remove_reason || g?.parent_mark) return leaveMarked();
        return gone.id;
      }
      if (gone) return void report.push(`${what}: scope "${key}" left out: ${gone.skip}.`), null;
      throw new EditError(`${what}: scope "${key}" is not in F-${fid}`);
    });
  return [...new Set(ids.filter((id): id is number => id !== null))];
}

/** Reads a local image file for a screenshot: its bytes and type. */
function readImage(file: string, caption: string): { data: Buffer; mime: string } {
  if (!path.isAbsolute(file)) throw new EditError(`Screenshot "${caption}": give the full path of the image file, not "${file}"`);
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  if (!stat?.isFile()) throw new EditError(`Screenshot "${caption}": no image file "${file}"`);
  if (stat.size > SCREENSHOT_MAX_BYTES) throw new EditError(`Screenshot "${caption}": the image is too large (10 MB or less)`);
  try {
    const data = fs.readFileSync(file);
    return { data, mime: imageType(data) };
  } catch (e) {
    throw new EditError(`Screenshot "${caption}" (${file}): ${(e as Error).message}`);
  }
}

/**
 * Adds a screenshot from a local image file, or changes one that is there.
 *  - A screenshot that is there: found by its ID (IMG-12 or 12), or by the first caption it got (captionKey),
 *    also after a person changed the caption. A person's own upload has no first caption: use its ID.
 *  - The AI can change any screenshot, also one that a person checked or uploaded: add tags (scopes),
 *    take tags off (removeScopes), give a new caption (newCaption), replace the image (replace: true with
 *    file), delete it (remove: true), or mark the image as old (stale: why). The screenshot from before the
 *    first change is kept (screenshot_before), and the review shows the change with "Change back".
 *  - Not changed: a screenshot that a person deleted, and a value that a person changed back before.
 */
function writeScreenshot(p: ProjectConfig, fid: number, x: ShotIn, scopeIds: Map<string, number | null>, report: string[]) {
  const byId = x?.id !== undefined && x?.id !== null && String(x.id).trim() !== '';
  let cur: any;
  if (byId) {
    const n = Number(String(x.id).trim().replace(/^.*?IMG-/i, ''));
    cur = db.prepare('SELECT * FROM screenshots WHERE id = ? AND feature_id = ?').get(n, fid);
    if (!cur) throw new EditError(`F-${fid} has no screenshot IMG-${n}`);
  }
  const caption = str(x?.caption, 500) || (cur?.caption as string) || '';
  if (!caption) throw new EditError(`A screenshot of F-${fid} has no caption. Say what it shows`);
  const key = captionKey(caption);
  cur ??= db.prepare('SELECT * FROM screenshots WHERE feature_id = ? AND match_key = ? ORDER BY removed, id LIMIT 1').get(fid, key);
  const keys = list<string | number>(x.scopes, `scopes of screenshot "${caption}"`);
  const want = resolveScopes(fid, keys, scopeIds, `Screenshot "${caption}"`, report);
  const label = cur ? `F-${fid} screenshot IMG-${cur.id} "${cur.caption}"` : `F-${fid} screenshot "${caption}"`;
  if (!cur && keys.length && !want.length) return void report.push(`${label}: not added, because a person deleted, moved or marked "To remove" all its scopes.`);

  if (!cur) {
    if (x.remove || x.stale || list(x.removeScopes, 'removeScopes').length || x.newCaption) throw new EditError(`${label}: no such screenshot to change. Give its ID (IMG-…) or its first caption`);
    const { data, mime } = readImage(str(x.file, 4000), caption);
    const id = Number(
      db
        .prepare("INSERT INTO screenshots (project_id, feature_id, caption, mime, sort, source, match_key) VALUES (?, ?, ?, ?, ?, 'ai', ?)")
        .run(p.id, fid, caption, mime, nextSort('screenshots', 'feature_id = ?', fid), key).lastInsertRowid,
    );
    db.prepare('INSERT INTO screenshot_images (screenshot_id, data) VALUES (?, ?)').run(id, data);
    addScopeTags('screenshot_scopes', id, want);
    return void report.push(`${label}: added as IMG-${id}${want.length ? ` with ${names(want)}` : ' (no scope)'}.`);
  }
  // A person deleted it: the row stays only as a marker.
  if (cur.removed && cur.ai_change === null) return void report.push(`${label}: a person deleted it before. Not added again or changed.`);
  // The AI deleted it, and a person did not review the delete yet.
  if (cur.removed) return void report.push(`${label}: the AI deleted it, and the delete waits for a person's review. Not changed.`);
  // An AI screenshot that no person checked is still a draft: a change keeps it a draft, with no "Change back".
  const draft = cur.source === 'ai' && !cur.checked && cur.ai_change === null;

  const done: string[] = [];
  const firstReport = report.length;
  const changes = new Set<string>(cur.ai_change === null ? [] : json(cur.ai_change));
  const changesBefore = changes.size;
  // The screenshot from before the first AI change, for "Change back".
  const keepState = () => {
    if (draft) return;
    if (db.prepare('SELECT 1 FROM screenshot_before WHERE screenshot_id = ?').get(cur.id)) return;
    const tags = (db.prepare('SELECT scope_id FROM screenshot_scopes WHERE screenshot_id = ? ORDER BY scope_id').all(cur.id) as any[]).map((r) => r.scope_id);
    db.prepare('INSERT INTO screenshot_before (screenshot_id, caption, scope_ids) VALUES (?, ?, ?)').run(cur.id, cur.caption, JSON.stringify(tags));
  };
  const have = new Set((db.prepare('SELECT scope_id FROM screenshot_scopes WHERE screenshot_id = ?').all(cur.id) as any[]).map((r) => r.scope_id as number));

  // Tags to add.
  const add = want.filter((s) => !have.has(s));
  const refused = add.filter((s) => isRejected('screenshot', cur.id, 'tag', s));
  if (refused.length) report.push(`${label}: did not add ${names(refused)}: a person took this tag off before.`);
  const toAdd = add.filter((s) => !refused.includes(s));
  if (toAdd.length) {
    keepState();
    addScopeTags('screenshot_scopes', cur.id, toAdd);
    changes.add('tags');
    done.push(`added ${names(toAdd)}`);
  }
  // Tags to take off.
  const offKeys = list<string | number>(x.removeScopes, `removeScopes of screenshot "${caption}"`);
  const offAll = resolveScopes(fid, offKeys, scopeIds, `Screenshot "${caption}"`, report).filter((s) => have.has(s));
  const keepOn = offAll.filter((s) => isRejected('screenshot', cur.id, 'tag-off', s));
  if (keepOn.length) report.push(`${label}: did not take off ${names(keepOn)}: a person put this tag back before.`);
  const off = offAll.filter((s) => !keepOn.includes(s));
  if (off.length) {
    keepState();
    const del = db.prepare('DELETE FROM screenshot_scopes WHERE screenshot_id = ? AND scope_id = ?');
    for (const s of off) del.run(cur.id, s);
    changes.add('tags');
    done.push(`took off ${names(off)}`);
  }
  // A new caption. The first caption stays the match key.
  const newCaption = str(x.newCaption, 500);
  if (newCaption && newCaption !== cur.caption) {
    if (isRejected('screenshot', cur.id, 'caption', newCaption)) report.push(`${label}: did not change the caption to "${newCaption}": a person changed it back before.`);
    else {
      keepState();
      db.prepare('UPDATE screenshots SET caption = ? WHERE id = ?').run(newCaption, cur.id);
      changes.add('caption');
      done.push(`new caption "${newCaption}"`);
    }
  }
  // A new image.
  if (x.replace && !cur.stale && isRejected('screenshot', cur.id, 'image', 'replace')) {
    report.push(`${label}: did not replace the image: a person changed the image back before. Send "stale" with the reason when the image is old now.`);
  } else if (x.replace) {
    const { data, mime } = readImage(str(x.file, 4000), caption);
    keepState();
    // Keep the first image only: a second replace before a review keeps the image of the person.
    db.prepare('UPDATE screenshot_before SET data = (SELECT data FROM screenshot_images WHERE screenshot_id = ?), mime = ? WHERE screenshot_id = ? AND data IS NULL').run(cur.id, cur.mime, cur.id);
    db.prepare('UPDATE screenshot_images SET data = ? WHERE screenshot_id = ?').run(data, cur.id);
    db.prepare('UPDATE screenshots SET mime = ?, image_at = ?, stale = NULL WHERE id = ?').run(mime, new Date().toISOString(), cur.id);
    changes.add('image');
    done.push('replaced the image');
  }
  // Old image: the AI review after a sync marks it, a new image clears it.
  const stale = str(x.stale, 1000);
  if (stale && !done.includes('replaced the image') && stale !== cur.stale) {
    db.prepare('UPDATE screenshots SET stale = ? WHERE id = ?').run(stale, cur.id);
    done.push(`marked as old: ${stale}`);
  }
  // Delete. The image stays until a person checks the delete, so "Change back" can bring it back.
  if (x.remove && !cur.removed) {
    if (isRejected('screenshot', cur.id, 'removed', 1)) report.push(`${label}: not deleted: a person brought it back before.`);
    else {
      keepState();
      db.prepare('UPDATE screenshots SET removed = 1 WHERE id = ?').run(cur.id);
      // A draft that the AI deletes is gone for good (a marker row, as for a person's delete).
      if (draft) {
        db.prepare('DELETE FROM screenshot_images WHERE screenshot_id = ?').run(cur.id);
        db.prepare('DELETE FROM screenshot_scopes WHERE screenshot_id = ?').run(cur.id);
      }
      else changes.add('removed');
      done.push('deleted it');
    }
  }
  if (!done.length) {
    if (report.length === firstReport) report.push(`${label}: already there. Not changed.`);
    return;
  }
  if (changes.size && !draft) db.prepare('UPDATE screenshots SET ai_change = ? WHERE id = ?').run(JSON.stringify([...changes].sort()), cur.id);
  const changedNow = changes.size > changesBefore || done.some((d) => d.startsWith('replaced') || d.startsWith('new caption') || d.startsWith('added') || d.startsWith('took off'));
  const person = changedNow && (cur.source !== 'ai' || cur.checked) ? ' A person checked or uploaded it: the review shows the change, with "Change back".' : '';
  report.push(`${label}: ${done.join(', ')}.${person}`);
}

function writeLink(p: ProjectConfig, fid: number, l: LinkIn, scopeIds: Map<string, number | null>, report: string[]) {
  const testId = str(l.testId, 100);
  const cur = db.prepare('SELECT * FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p.id, testId, fid) as any;
  const tagsOf = (id: number) => (db.prepare('SELECT scope_id FROM link_scopes WHERE link_id = ?').all(id) as any[]).map((r) => r.scope_id as number);
  // An AI change on a link that a person made or checked gets the "Changed" mark, with the old values.
  if (l.remove) {
    if (!cur || cur.removed) return;
    if (isRejected('link', cur.id, 'removed', 1)) return void report.push(`${testId} -> F-${fid}: not removed: a person brought this link back before.`);
    // An AI link that no person checked: the row goes, so the AI can link the test again later.
    if (cur.source === 'ai' && !cur.checked && cur.ai_change === null) {
      db.prepare('DELETE FROM links WHERE id = ?').run(cur.id);
      report.push(`${testId} -> F-${fid}: link removed (an AI link that no person checked).`);
      return;
    }
    markAiChange('links', cur.id, { scopes: tagsOf(cur.id), removed: true });
    db.prepare('UPDATE links SET removed = 1 WHERE id = ?').run(cur.id);
    db.prepare('DELETE FROM link_scopes WHERE link_id = ?').run(cur.id);
    report.push(`${testId} -> F-${fid}: link removed.`);
    return;
  }
  if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL').get(p.id, testId))
    throw new EditError(`Unknown test ${testId}. Use the test IDs that "next" or "code" gave`);
  const keys = [...list<string | number>(l.scopes, `scopes of ${testId}`), ...(l.scope !== undefined && l.scope !== null ? [l.scope] : [])];
  const want = resolveScopes(fid, keys, scopeIds, `Link ${testId}`, report);
  const offKeys = list<string | number>(l.removeScopes, `removeScopes of ${testId}`);
  // Scopes to take off: any scope of the feature, also one marked "To remove" (taking a tag off only cleans up).
  const off = offKeys.flatMap((k) => {
    const key = String(k).trim();
    const m = SCOPE_RE.exec(key);
    const row = (m
      ? db.prepare('SELECT id FROM scopes WHERE id = ? AND feature_id = ?').get(Number(m[1]), fid)
      : db.prepare('SELECT id FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, key)) as { id: number } | undefined;
    if (!row) report.push(`Link ${testId}: removeScopes "${key}" is not a scope of F-${fid}.`);
    return row ? [row.id] : [];
  });
  if (keys.length && !want.length && !off.length) {
    report.push(`${testId} -> F-${fid}: link not added or changed, because none of its scopes is in F-${fid} now.`);
    return;
  }
  const addScopes = (linkId: number, ids: number[]) => addScopeTags('link_scopes', linkId, ids);

  if (!cur) {
    const id = Number(db.prepare("INSERT INTO links (project_id, test_id, feature_id, source) VALUES (?, ?, ?, 'ai')").run(p.id, testId, fid).lastInsertRowid);
    addScopes(id, want);
    report.push(`${testId} -> F-${fid}${want.length ? ` / ${names(want)}` : ' (no scope)'}: new link.`);
    return;
  }
  if (cur.removed && cur.ai_change === null) {
    report.push(`${testId} -> F-${fid}: a person removed this link before. Not added again.`);
    return;
  }
  const have = tagsOf(cur.id);
  const next = [...new Set([...have.filter((s) => !off.includes(s)), ...want])];
  // Every scope comes off: the test checks nothing of this feature now. A link with no scope would count for
  // the whole feature, so the link is removed.
  if (!cur.removed && have.length && !next.length) return writeLink(p, fid, { testId, remove: true }, scopeIds, report);
  // The AI removed this link before, and no person checked it yet: the AI brings it back.
  const back = !!cur.removed;
  if (!back && scopeSetKey(next) === scopeSetKey(have)) return;
  if (!back && isRejected('link', cur.id, 'scopes', scopeSetKey(next))) {
    report.push(`${testId} -> F-${fid}: did not set the scopes to ${names(next)}: a person changed them back before.`);
    return;
  }
  markAiChange('links', cur.id, { scopes: have });
  if (back) {
    db.prepare('UPDATE links SET removed = 0 WHERE id = ?').run(cur.id);
    // Only the old values stay: "removed" is not a change now.
    const ch = JSON.parse((db.prepare('SELECT ai_change FROM links WHERE id = ?').get(cur.id) as any).ai_change ?? '{}');
    delete ch.removed;
    db.prepare('UPDATE links SET ai_change = ? WHERE id = ?').run(Object.keys(ch).length ? JSON.stringify(ch) : null, cur.id);
  }
  db.prepare('DELETE FROM link_scopes WHERE link_id = ?').run(cur.id);
  addScopes(cur.id, next);
  const added = next.filter((s) => !have.includes(s));
  const taken = have.filter((s) => !next.includes(s));
  report.push(`${testId} -> F-${fid}:${back ? ' link back,' : ''}${added.length ? ` added ${names(added)}` : ''}${added.length && taken.length ? ',' : ''}${taken.length ? ` took off ${names(taken)}` : ''}.`);
}

/**
 * Moves the link of a renamed test (old ID gone from the repo) to its new ID, for one feature.
 * A wrong pair is skipped with a note: it must not lose the rest of the AI answer.
 */
function moveRenamedLink(p: ProjectConfig, fid: number, r: { from: string; to: string }, report: string[]) {
  const from = str(r?.from, 100);
  const to = str(r?.to, 100);
  const label = `Rename ${from || '?'} -> ${to || '?'} on F-${fid}`;
  if (db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL').get(p.id, from)) {
    report.push(`${label}: not moved, because ${from} is still in the repo.`);
    return;
  }
  const old = db.prepare('SELECT id FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ? AND removed = 0').get(p.id, from, fid) as any;
  if (!old) return void report.push(`${label}: not moved: F-${fid} has no active link to ${from}.`);
  if (isRejected('link', old.id, 'test', to) || isRejected('link', old.id, 'removed', 1)) {
    report.push(`${label}: not moved: a person changed this move back before.`);
    return;
  }
  const target = db.prepare('SELECT id, removed, ai_change FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p.id, to, fid) as any;
  // A person removed the new test's link: the AI does not add it again.
  if (target?.removed && target.ai_change === null) {
    report.push(`${label}: not moved, because a person removed the link of ${to} to F-${fid}. Move or link it by hand if it belongs here.`);
    return;
  }
  if (target) {
    // The new test has a link already (also one that the AI removed): its link gets the scopes of the old link,
    // and the old link is removed. Each change has its own "Changed" mark, so "Change back" undoes each one.
    const tags = (db.prepare('SELECT scope_id FROM link_scopes WHERE link_id = ?').all(old.id) as any[]).map((x) => `S-${x.scope_id}`);
    writeLink(p, fid, { testId: to, scopes: tags }, new Map(), report);
    if (target.removed && !tags.length) {
      // writeLink brings back a removed link only with scopes: an old link for the whole feature brings it back here.
      const back = db.prepare('SELECT ai_change FROM links WHERE id = ?').get(target.id) as any;
      const ch = JSON.parse(back.ai_change ?? '{}');
      delete ch.removed;
      db.prepare('UPDATE links SET removed = 0, ai_change = ? WHERE id = ?').run(Object.keys(ch).length ? JSON.stringify(ch) : null, target.id);
    }
    writeLink(p, fid, { testId: from, remove: true }, new Map(), report);
    report.push(`${label}: the link of ${to} got the scopes of the old link, and the old link is removed.`);
    return;
  }
  try {
    edits.moveTestLinks(p.id, { from, to, featureId: fid });
    // The review shows the move as "Changed", with the old test ID and "Change back".
    const moved = db.prepare('SELECT id FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p.id, to, fid) as any;
    if (moved) markAiChange('links', moved.id, { test: from });
    report.push(`${label}: link moved, with its scopes.`);
  } catch (e) {
    if (!(e instanceof EditError)) throw e;
    report.push(`${label}: not moved. ${e.message}.`);
  }
}

function skip(p: ProjectConfig, kind: Kind, ref: string | undefined, reason: string | undefined, codeFiles: string[]) {
  if (!ref || !reason) fail('Usage: skip <project> <kind> <ref> <reason> [--files a.php,b.php]');
  let files: string[];
  // A skip does not sort code, so the code would come back in "next" again and again.
  if (kind === 'code') fail('A code unit cannot be skipped. Put each item in "library" (start-up, helpers, glue) or "unused" (nothing loads or calls it), with a reason, and use apply.');
  {
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

/**
 * Parks a unit that failed 2 times in one mapping loop (server/map-loop.ts). "next" skips it while
 * the hash of its files stays the same. A person can remove the park in the app.
 */
function park(p: ProjectConfig, kind: Kind, ref: string | undefined, reason: string) {
  if (!ref) fail('Usage: park <project> <kind> <ref> <reason>');
  let files: string[];
  if (kind === 'code') files = [ref];
  else {
    const unit = units(p.id, kind).find((u) => u.ref === ref);
    files = unit?.files.length ? unit.files : [testRepoPath(p, kind, ref)];
  }
  db.prepare(
    `INSERT INTO parked_units (project_id, kind, ref, hash, reason, parked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, kind, ref) DO UPDATE SET hash = excluded.hash, reason = excluded.reason, parked_at = excluded.parked_at`,
  ).run(p.id, kind, ref, hashFiles(p, files), reason || 'Failed 2 times', now());
  out({ parked: true, kind, ref });
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
  park: () => park(projectOf(projectId), kindOf(args[0]), args[1], args.slice(2).join(' ')),
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
  console.log('Commands: status, next, features, feature, code, test-code, apply, skip, reset, park, move-scope, screenshots. See server/map.ts.');
  process.exit(cmd ? 1 : 0);
}
// A fresh scan first for the commands that use test IDs and files, so they match the repo now.
// The read-only feature commands skip it: the scan reads every test file.
if (['status', 'next', 'apply', 'skip'].includes(cmd) && projectId && getProject(projectId)) syncProject(getProject(projectId)!, true);
commands[cmd]();
