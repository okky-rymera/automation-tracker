/**
 * Change report: what changed in a plugin repo between two commits, and which features to review.
 *
 * It reads only the two commits (git), never the working folder or the database state before
 * the sync. So it gives the same answer each time, also for the first sync.
 *  - files: git diff -M (finds renamed files)
 *  - PHP functions: coverage/fingerprints.php on the files of each commit (comments and white space do not count)
 *  - tests: the test folders of each commit, read by the same parsers as the scan
 *  - likely renamed tests: a new title or file gives a new test ID, so its links stay on the old ID
 *  - feature code that is not in the code now (file or function gone)
 *  - features to review: their linked tests or their code changed
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.ts';
import { DEFAULT_EXCLUDE } from './files.ts';
import { parsePlaywrightRepo, playwrightErrors } from './playwright.ts';
import { parseCypressRepo } from './cypress.ts';
import { ROOT, type ProjectConfig } from './projects.ts';

export type FileKind = 'php' | 'js' | 'playwright' | 'playwright-support' | 'cypress' | 'other-test' | 'other';

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  path: string;
  oldPath?: string;
  kind: FileKind;
}

export interface ChangedFunction {
  file: string;
  /** Name as in the coverage report ("Class::name", "name"), or "(code outside functions)". */
  name: string;
  change: 'added' | 'changed' | 'removed';
}

export interface TestRef {
  id: string;
  framework: 'playwright' | 'cypress';
  file: string;
  title: string;
  /** Active links of this test (removed links do not count). */
  links: number;
}

export interface LikelyRename {
  from: TestRef;
  to: TestRef;
  /** same-code: the test code is the same; similar-title: same file, the titles share most words. */
  reason: 'same-code' | 'similar-title';
}

export interface CodeGone {
  entryId: number;
  featureId: number;
  featureTitle: string;
  file: string;
  function: string;
  reason: 'file-gone' | 'file-moved' | 'function-gone';
  /** file-moved: the new path. */
  movedTo?: string;
}

export interface FeatureToReview {
  featureId: number;
  title: string;
  reasons: string[];
}

export interface ChangeReport {
  from: string;
  to: string;
  commits: number;
  files: ChangedFile[];
  functions: ChangedFunction[];
  tests: { added: TestRef[]; changed: TestRef[]; removed: TestRef[] };
  renames: LikelyRename[];
  codeGone: CodeGone[];
  review: FeatureToReview[];
  /** Spec files that could not be read at the new commit. */
  parseErrors: string[];
}

const OUTSIDE = '(code outside functions)';

function git(repo: string, args: string[], input?: Buffer): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], input });
}
const gitOk = (repo: string, args: string[]) => {
  try {
    git(repo, args);
    return true;
  } catch {
    return false;
  }
};

/** The Playwright folder (holds the config): the parent of the specs folder. '' when the specs folder is at the top. */
export const playwrightRoot = (p: ProjectConfig) => (p.playwrightDir ? path.posix.dirname(p.playwrightDir.replace(/\/+$/, '')).replace(/^\.$/, '') : '');

const inDir = (file: string, dir: string | undefined) => !!dir && (dir === '' || file.startsWith(dir.replace(/\/+$/, '') + '/'));

function kindOf(p: ProjectConfig, file: string): FileKind {
  const spec = p.playwrightDir?.replace(/\/+$/, '');
  if (spec !== undefined && inDir(file, spec)) return 'playwright';
  const pwRoot = playwrightRoot(p);
  if (p.playwrightDir && (pwRoot ? inDir(file, pwRoot) : /^playwright\.config\./.test(path.basename(file)))) return 'playwright-support';
  if (p.cypressDir && inDir(file, p.cypressDir.replace(/\/+$/, ''))) return 'cypress';
  const parts = file.split('/');
  const exclude = new Set(p.excludeDirs ?? DEFAULT_EXCLUDE);
  if (parts[0] === 'tests') return 'other-test';
  const hidden = parts.slice(0, -1).some((d) => d.startsWith('.') || exclude.has(d));
  if (hidden) return 'other';
  if (file.endsWith('.php')) return 'php';
  if (/\.(m|c)?[jt]sx?$/.test(file) && !file.endsWith('.min.js')) return 'js';
  return 'other';
}

/** Files changed between two commits. -z keeps special characters in paths as they are. */
export function changedFiles(p: ProjectConfig, from: string, to: string): ChangedFile[] {
  const fields = git(p.path, ['diff', '--name-status', '-z', '-M', from, to]).split('\0');
  const out: ChangedFile[] = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const status = fields[i][0] as ChangedFile['status'];
    const two = status === 'R' || status === 'C';
    const oldPath = fields[i + 1];
    const newPath = two ? fields[i + 2] : oldPath;
    i += two ? 3 : 2;
    out.push({ status, path: newPath, ...(two ? { oldPath } : {}), kind: kindOf(p, newPath) });
  }
  return out;
}

/** Writes some files of one commit into a new temporary folder. Missing files are left out. */
function extractFiles(repo: string, commit: string, files: string[], dir: string) {
  for (const f of files) {
    try {
      const data = execFileSync('git', ['-C', repo, 'show', `${commit}:${f}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), data);
    } catch {
      /* not in this commit */
    }
  }
}

/**
 * Writes some folders of one commit into dir. Not git archive: plugins often mark "tests" as
 * export-ignore in .gitattributes, and then git archive leaves the tests out.
 * One git cat-file --batch call reads all files.
 */
function extractDirs(repo: string, commit: string, dirs: string[], dir: string) {
  const list = git(repo, ['ls-tree', '-r', '-z', commit, '--', ...dirs.filter(Boolean)]).split('\0').filter(Boolean);
  const blobs = list
    .map((row) => {
      const tab = row.indexOf('\t');
      const [mode, type, sha] = row.slice(0, tab).split(' ');
      return { mode, type, sha, file: row.slice(tab + 1) };
    })
    .filter((b) => b.type === 'blob' && b.mode !== '120000'); // no symlinks
  if (!blobs.length) return;
  const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: blobs.map((b) => b.sha).join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  // Each object: "<sha> blob <size>\n<data>\n".
  let pos = 0;
  for (const b of blobs) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString().split(' ')[2]);
    const data = out.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    const dest = path.join(dir, b.file);
    if (!dest.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
}

type Fingerprints = Record<string, { top: string; functions: { key: string; name: string; hash: string }[] } | null>;

/** Runs coverage/fingerprints.php on files in a folder. In groups, so the command line stays short. */
export function fingerprints(dir: string, files: string[]): Fingerprints {
  const out: Fingerprints = {};
  for (let i = 0; i < files.length; i += 200) {
    const part = files.slice(i, i + 200);
    const text = execFileSync('php', [path.join(ROOT, 'coverage', 'fingerprints.php'), dir, ...part], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    Object.assign(out, JSON.parse(text));
  }
  return out;
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-changes-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Changed PHP functions: compares the fingerprint of each function in the two commits. */
function changedFunctions(p: ProjectConfig, from: string, to: string, files: ChangedFile[]): ChangedFunction[] {
  const php = files.filter((f) => f.kind === 'php');
  if (!php.length) return [];
  return withTemp((tmp) => {
    const oldDir = path.join(tmp, 'old');
    const newDir = path.join(tmp, 'new');
    const olds = php.filter((f) => f.status !== 'A').map((f) => f.oldPath ?? f.path);
    const news = php.filter((f) => f.status !== 'D').map((f) => f.path);
    extractFiles(p.path, from, olds, oldDir);
    extractFiles(p.path, to, news, newDir);
    const before = fs.existsSync(oldDir) ? fingerprints(oldDir, olds) : {};
    const after = fs.existsSync(newDir) ? fingerprints(newDir, news) : {};
    const out: ChangedFunction[] = [];
    for (const f of php) {
      const b = f.status === 'A' ? null : before[f.oldPath ?? f.path];
      const a = f.status === 'D' ? null : after[f.path];
      const bf = new Map((b?.functions ?? []).map((x) => [x.key, x]));
      const af = new Map((a?.functions ?? []).map((x) => [x.key, x]));
      for (const key of [...new Set([...bf.keys(), ...af.keys()])].sort()) {
        const x = bf.get(key);
        const y = af.get(key);
        if (x && y && x.hash === y.hash) continue;
        out.push({ file: f.path, name: (y ?? x)!.name, change: !x ? 'added' : !y ? 'removed' : 'changed' });
      }
      if ((b?.top ?? null) !== (a?.top ?? null)) out.push({ file: f.path, name: OUTSIDE, change: !b ? 'added' : !a ? 'removed' : 'changed' });
    }
    return out;
  });
}

interface ParsedTest {
  id: string;
  framework: 'playwright' | 'cypress';
  file: string;
  title: string;
  /** Changes when the test code changes. */
  body: string;
  /** Changes when the title, the describes or the skip state change (they do not all change the ID). */
  head: string;
}

/** The tests of one commit, read by the scan's parsers from a copy of the test folders. */
function testsAt(p: ProjectConfig, commit: string): { tests: ParsedTest[]; errors: string[] } {
  return withTemp((dir) => {
    extractDirs(p.path, commit, [p.playwrightDir, p.cypressDir].filter((d): d is string => !!d), dir);
    // Another ID, so the parser's error list of the real project stays as it is.
    const copy: ProjectConfig = { ...p, id: `${p.id}@${commit.slice(0, 8)}`, path: dir };
    const pw = parsePlaywrightRepo(copy);
    playwrightErrors.delete(copy.id); // the error list is for the real project only
    const cy = parseCypressRepo(copy);
    const tests: ParsedTest[] = [];
    for (const t of pw?.tests ?? []) {
      tests.push({
        id: t.id, framework: 'playwright', file: t.file, title: [...t.describes, t.title].join(' > '),
        body: t.bodyHash ?? '', head: JSON.stringify([t.describes, t.title, t.skipped, [...t.tags].sort()]),
      });
    }
    for (const s of cy ?? []) {
      if (s.parseError) continue;
      tests.push({
        id: s.id, framework: 'cypress', file: s.file, title: [s.feature, s.rule, s.title].filter(Boolean).join(' > '),
        body: JSON.stringify([s.steps.map((x) => [x.keyword, x.text, x.background]), s.examples]),
        head: JSON.stringify([s.title, [...s.tags].sort()]),
      });
    }
    return { tests, errors: (pw?.errors ?? []).map((e) => e.file) };
  });
}

/** bodyHash of an empty test body "{}" (server/playwright.ts). */
const EMPTY_BODY = crypto.createHash('sha1').update('{}').digest('hex').slice(0, 12);

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const both = [...x].filter((w) => y.has(w)).length;
  return x.size + y.size ? both / (x.size + y.size - both) : 0;
}

/** Builds the full change report for one project between two commits. */
export function changeReport(p: ProjectConfig, fromRef: string, toRef: string): ChangeReport {
  const full = (ref: string) => git(p.path, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const from = full(fromRef);
  const to = full(toRef);
  const commits = Number(git(p.path, ['rev-list', '--count', `${from}..${to}`]).trim());
  const files = from === to ? [] : changedFiles(p, from, to);
  const functions = changedFunctions(p, from, to, files);

  // Tests: read both commits only when a test folder changed.
  const testsChanged = files.some((f) => f.kind === 'playwright' || f.kind === 'cypress');
  const oldT = testsChanged ? testsAt(p, from) : { tests: [], errors: [] };
  const newT = testsChanged ? testsAt(p, to) : { tests: [], errors: [] };
  const linkCount = new Map(
    (db.prepare('SELECT test_id, COUNT(*) AS n FROM links WHERE project_id = ? AND removed = 0 GROUP BY test_id').all(p.id) as any[]).map((r) => [r.test_id, r.n]),
  );
  const ref = (t: ParsedTest): TestRef => ({ id: t.id, framework: t.framework, file: t.file, title: t.title, links: linkCount.get(t.id) ?? 0 });
  const oldById = new Map(oldT.tests.map((t) => [t.id, t]));
  const newById = new Map(newT.tests.map((t) => [t.id, t]));
  const added = newT.tests.filter((t) => !oldById.has(t.id));
  const removed = oldT.tests.filter((t) => !newById.has(t.id));
  const changed = newT.tests.filter((t) => {
    const o = oldById.get(t.id);
    return o && (o.body !== t.body || o.head !== t.head);
  });

  // Likely renames. A renamed file keeps its tests' code; git -M gives the new path.
  const movedTo = new Map(files.filter((f) => f.oldPath).map((f) => [f.oldPath!, f.path]));
  const relFile = (t: ParsedTest) => {
    const dir = t.framework === 'playwright' ? p.playwrightDir : p.cypressDir;
    return dir ? `${dir.replace(/\/+$/, '')}/${t.file}` : t.file;
  };
  const renames: LikelyRename[] = [];
  const taken = new Set<string>();
  for (const pass of ['same-code', 'similar-title'] as const) {
    for (const r of removed) {
      if (renames.some((x) => x.from.id === r.id)) continue;
      const rFile = movedTo.get(relFile(r)) ?? relFile(r);
      const candidates = added.filter((a) => !taken.has(a.id) && a.framework === r.framework);
      let best: ParsedTest | undefined;
      if (pass === 'same-code') {
        // An empty or very short body ("{}") says nothing. Tests made in a loop share one body:
        // then the title must decide, and a tie gives no match, so links never go to the wrong test.
        if (r.framework === 'playwright' && r.body === EMPTY_BODY) continue;
        const same = candidates.filter((a) => a.body && a.body === r.body);
        const sameFile = same.filter((a) => relFile(a) === rFile);
        const pool = sameFile.length ? sameFile : same;
        if (pool.length === 1) best = pool[0];
        else if (pool.length > 1) {
          const scored = pool.map((a) => ({ a, s: similarity(r.title, a.title) })).sort((x, y) => y.s - x.s);
          if (scored[0].s > scored[1].s) best = scored[0].a;
        }
      } else {
        let score = 0.5;
        for (const a of candidates.filter((a) => relFile(a) === rFile)) {
          const s = similarity(r.title, a.title);
          if (s >= score) [best, score] = [a, s];
        }
      }
      if (best) {
        taken.add(best.id);
        renames.push({ from: ref(r), to: ref(best), reason: pass });
      }
    }
  }

  // Feature code that is not in the code now.
  const entries = db
    .prepare('SELECT c.id, c.feature_id, c.file, c.function, f.title FROM feature_code c JOIN features f ON f.id = c.feature_id WHERE c.project_id = ? AND c.removed = 0')
    .all(p.id) as any[];
  const codeGone: CodeGone[] = [];
  const codeFiles = [...new Set(entries.map((e) => e.file as string))];
  const present = new Set(codeFiles.filter((f) => gitOk(p.path, ['cat-file', '-e', `${to}:${f}`])));
  const names = withTemp((dir) => {
    const withFns = [...new Set(entries.filter((e) => e.function && present.has(e.file)).map((e) => e.file as string))];
    extractFiles(p.path, to, withFns, dir);
    const fp = withFns.length ? fingerprints(dir, withFns) : {};
    return new Map(withFns.map((f) => [f, new Set((fp[f]?.functions ?? []).map((x) => x.name))]));
  });
  for (const e of entries) {
    const base = { entryId: e.id, featureId: e.feature_id, featureTitle: e.title, file: e.file, function: e.function };
    if (!present.has(e.file)) {
      const to2 = movedTo.get(e.file);
      codeGone.push(to2 ? { ...base, reason: 'file-moved', movedTo: to2 } : { ...base, reason: 'file-gone' });
    } else if (e.function && !names.get(e.file)?.has(e.function)) {
      codeGone.push({ ...base, reason: 'function-gone' });
    }
  }

  // Features to review.
  const reasons = new Map<number, Set<string>>();
  const addReason = (id: number, why: string) => (reasons.get(id) ?? reasons.set(id, new Set()).get(id)!).add(why);
  const linksOf = db.prepare('SELECT feature_id FROM links WHERE project_id = ? AND test_id = ? AND removed = 0');
  for (const [list, why] of [
    [changed, 'linked test changed'],
    [removed, 'linked test removed or renamed'],
  ] as const) {
    for (const t of list) for (const l of linksOf.all(p.id, t.id) as any[]) addReason(l.feature_id, `${why}: ${t.title}`);
  }
  const changedFiles2 = new Map<string, ChangedFile>();
  for (const f of files) {
    changedFiles2.set(f.path, f);
    if (f.oldPath) changedFiles2.set(f.oldPath, f);
  }
  const fnChanged = new Set(functions.map((f) => `${f.file}\0${f.name}`));
  for (const e of entries) {
    const f = changedFiles2.get(e.file);
    if (!f || (f.kind !== 'php' && f.kind !== 'js')) continue;
    if (!e.function) addReason(e.feature_id, `code file changed: ${e.file}`);
    else if (fnChanged.has(`${f.path}\0${e.function}`)) addReason(e.feature_id, `function changed: ${e.file} ${e.function}`);
  }
  for (const g of codeGone) addReason(g.featureId, `code not in the code now: ${g.file}${g.function ? ' ' + g.function : ''}`);
  const titles = new Map((db.prepare('SELECT id, title FROM features WHERE project_id = ?').all(p.id) as any[]).map((r) => [r.id, r.title]));
  const review = [...reasons]
    .filter(([id]) => titles.has(id))
    .map(([featureId, why]) => ({ featureId, title: titles.get(featureId) as string, reasons: [...why].sort() }))
    .sort((a, b) => a.featureId - b.featureId);

  return {
    from, to, commits, files, functions,
    tests: { added: added.map(ref), changed: changed.map(ref), removed: removed.map(ref) },
    renames, codeGone, review, parseErrors: newT.errors,
  };
}

/** One line for each part of the report, for the command line. */
export function reportText(r: ChangeReport): string {
  const kinds = r.files.reduce<Record<string, number>>((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  const lines = [
    `${r.from.slice(0, 8)}..${r.to.slice(0, 8)}: ${r.commits} commits, ${r.files.length} files (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`,
    `PHP functions: ${r.functions.length} changed (${['added', 'changed', 'removed'].map((c) => `${c} ${r.functions.filter((f) => f.change === c).length}`).join(', ')})`,
    `Tests: ${r.tests.added.length} added, ${r.tests.changed.length} changed, ${r.tests.removed.length} removed`,
  ];
  for (const x of r.renames) lines.push(`  likely rename (${x.reason}, ${x.from.links} links): ${x.from.id} "${x.from.title}" -> ${x.to.id} "${x.to.title}"`);
  lines.push(`Feature code not in the code now: ${r.codeGone.length}`);
  for (const g of r.codeGone) lines.push(`  F-${g.featureId} ${g.file} ${g.function || '(whole file)'}: ${g.reason}${g.movedTo ? ' -> ' + g.movedTo : ''}`);
  lines.push(`Features to review: ${r.review.length}`);
  for (const f of r.review) lines.push(`  F-${f.featureId} ${f.title}: ${f.reasons.length} reasons (${f.reasons[0]})`);
  if (r.parseErrors.length) lines.push(`Spec files that could not be read: ${r.parseErrors.join(', ')}`);
  return lines.join('\n');
}
