/**
 * Reads Playwright spec files without running them.
 * Finds test.describe blocks, tests, their tags and their test.step titles.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '@babel/parser';
import type { ProjectConfig } from './projects.ts';
import { loadCoverage, runTestPath } from './coverage.ts';
import { db, json } from './db.ts';
import { syncProject } from './scan.ts';

export interface PlaywrightStep {
  title: string;
  depth: number;
}

export interface PlaywrightTest {
  id: string;
  file: string; // relative to the specs folder
  describes: string[];
  title: string;
  line: number;
  tags: string[];
  skipped: boolean;
  steps: PlaywrightStep[];
  /** True when the title is built in a loop (for example one test per user role). */
  parametrized: boolean;
  /** From the last coverage run: one entry per runtime test that matched. runId = test ID in the run. */
  run: { runId: string; title: string; status: string; functions: number }[];
}

type Node = { type: string; [k: string]: any };

const TEST_NAMES = new Set(['test', 'it']);
const MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow', 'serial', 'parallel']);

/** Returns the call chain of a callee: test.describe.serial → ['test', 'describe', 'serial']. */
function chain(callee: Node): string[] | null {
  if (callee.type === 'Identifier') return [callee.name];
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const left = chain(callee.object);
    return left ? [...left, callee.property.name] : null;
  }
  return null;
}

function stringOf(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral') {
    return n.quasis.map((q: Node, i: number) => q.value.cooked + (i < n.expressions.length ? '${…}' : '')).join('');
  }
  return null;
}

function tagsOf(details: Node | undefined): string[] {
  if (!details || details.type !== 'ObjectExpression') return [];
  const prop = details.properties.find(
    (p: Node) => p.type === 'ObjectProperty' && (p.key.name === 'tag' || p.key.value === 'tag'),
  );
  if (!prop) return [];
  const v = prop.value;
  if (v.type === 'ArrayExpression') return v.elements.map(stringOf).filter(Boolean) as string[];
  const s = stringOf(v);
  return s ? [s] : [];
}

const titleTags = (title: string) => title.match(/@[\w:.-]+/g) ?? [];
const isFn = (n: Node | undefined) => !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'comments' || key.endsWith('Comments')) continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && out.push(c));
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

function collectSteps(node: Node, depth: number, out: PlaywrightStep[]) {
  if (node.type === 'CallExpression') {
    const c = chain(node.callee);
    if (c && TEST_NAMES.has(c[0]) && c[1] === 'step') {
      const title = stringOf(node.arguments[0]);
      if (title !== null) {
        out.push({ title, depth });
        const fn = node.arguments.find(isFn);
        if (fn) collectSteps(fn.body, depth + 1, out);
        return;
      }
    }
  }
  for (const ch of children(node)) collectSteps(ch, depth, out);
}

interface Describe {
  title: string;
  tags: string[];
  skipped: boolean;
}

type Parsed = Omit<PlaywrightTest, 'id' | 'run' | 'parametrized'>;

function parseFile(source: string, rel: string, isTs: boolean): Parsed[] {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    plugins: isTs ? ['typescript', 'jsx'] : ['jsx'],
    errorRecovery: true,
  }) as unknown as Node;
  const tests: Parsed[] = [];

  const visit = (node: Node, describes: Describe[]) => {
    if (node.type === 'CallExpression') {
      const c = chain(node.callee);
      if (c && TEST_NAMES.has(c[0])) {
        const rest = c.slice(1);
        const title = stringOf(node.arguments[0]);
        const fn = node.arguments.find(isFn);
        const details = node.arguments.length === 3 ? node.arguments[1] : undefined;
        const skipped = rest.includes('skip') || rest.includes('fixme');

        if (rest[0] === 'describe' && rest.slice(1).every((m) => MODIFIERS.has(m)) && title !== null && fn) {
          const d = { title, tags: [...tagsOf(details), ...titleTags(title)], skipped };
          visit(fn.body, [...describes, d]);
          return;
        }
        if (rest.every((m) => MODIFIERS.has(m)) && title !== null && fn) {
          const steps: PlaywrightStep[] = [];
          collectSteps(fn.body, 0, steps);
          const tags = new Set([...describes.flatMap((d) => d.tags), ...tagsOf(details), ...titleTags(title)]);
          tests.push({
            file: rel,
            describes: describes.map((d) => d.title),
            title,
            line: node.loc.start.line,
            tags: [...tags],
            skipped: skipped || describes.some((d) => d.skipped),
            steps,
          });
          return;
        }
      }
    }
    for (const ch of children(node)) visit(ch, describes);
  };
  visit(ast, []);
  return tests;
}

function walkSpecs(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSpecs(full, out);
    else if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(e.name)) out.push(full);
  }
}

/** A test as the scan finds it in the repo (no coverage data). */
export type ScannedPlaywrightTest = Omit<PlaywrightTest, 'run'>;

export interface PlaywrightScan {
  tests: ScannedPlaywrightTest[];
  /** Spec files that could not be read (for example a syntax error while someone edits). */
  errors: { file: string; error: string }[];
}

/** Spec files that could not be read in the last scan, per project. */
export const playwrightErrors = new Map<string, PlaywrightScan['errors']>();

/** Reads all spec files of the project. Used by the scan (scan.ts). */
export function parsePlaywrightRepo(project: ProjectConfig): PlaywrightScan | null {
  if (!project.playwrightDir) return { tests: [], errors: [] };
  const root = path.join(project.path, project.playwrightDir);
  if (!fs.existsSync(root)) return null; // folder missing: do not mark tests removed
  const files: string[] = [];
  walkSpecs(root, files);
  const seen = new Set<string>();
  const out: ScannedPlaywrightTest[] = [];
  const errors: PlaywrightScan['errors'] = [];
  for (const full of files.sort()) {
    const rel = path.relative(root, full);
    let parsed: Parsed[];
    try {
      parsed = parseFile(fs.readFileSync(full, 'utf8'), rel, /\.tsx?$/.test(full));
    } catch (e) {
      errors.push({ file: rel, error: String((e as Error).message).split('\n')[0] });
      continue;
    }
    for (const t of parsed) {
      const key = [t.file, ...t.describes, t.title].join(' > ');
      let id = 'PW-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
      // Same title twice in one file: keep IDs unique.
      if (seen.has(id)) {
        const base = id;
        for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
      }
      seen.add(id);
      out.push({ ...t, id, parametrized: key.includes('${…}') });
    }
  }
  playwrightErrors.set(project.id, errors);
  return { tests: out, errors };
}

/** Playwright tests of the project from the database, matched to the coverage run. */
export function listPlaywright(project: ProjectConfig): PlaywrightTest[] {
  syncProject(project);
  const rows = db
    .prepare("SELECT * FROM tests WHERE project_id = ? AND framework = 'playwright' AND removed_at IS NULL ORDER BY file, line")
    .all(project.id) as any[];

  // Match tests to tests in the coverage run by "file > describe > title".
  // A title built in a loop holds "${…}"; it matches each runtime title by pattern.
  const cov = loadCoverage(project);
  const runTests = (cov?.tests ?? []).map((t) => ({ key: runTestPath(t).join(' > '), t }));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return rows.map((r) => {
    const t: ScannedPlaywrightTest = { id: r.id, file: r.file, title: r.title, line: r.line, tags: json(r.tags), ...json(r.data) };
    const key = [t.file, ...t.describes, t.title].join(' > ');
    const re = t.parametrized ? new RegExp('^' + key.split('${…}').map(escape).join('.+') + '$') : null;
    const matched = runTests.filter((x) => (re ? re.test(x.key) : x.key === key)).map((x) => x.t);
    // Loop-built tests often set tags from a variable, so take those from the run.
    const tags = new Set([...t.tags, ...(t.parametrized ? matched.flatMap((x) => x.tags) : [])]);
    return {
      ...t,
      tags: [...tags],
      run: matched.map((x) => ({
        runId: x.id,
        title: runTestPath(x).slice(-1)[0],
        status: x.status,
        functions: cov!.functionsPerTest.get(x.id) ?? 0,
      })),
    };
  });
}
