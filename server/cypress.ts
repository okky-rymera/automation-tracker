/**
 * Reads Cypress Gherkin .feature files with the official Gherkin parser.
 * One entry per Scenario or Scenario Outline (not per Examples row).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';
import type { ProjectConfig } from './projects.ts';
import { db, json } from './db.ts';
import { syncProject } from './scan.ts';
import { loadCoverage, runTestPath } from './coverage.ts';

export interface CypressStep {
  keyword: string;
  text: string;
  background: boolean;
}

export interface CypressScenario {
  id: string;
  file: string; // relative to the Cypress tests folder
  feature: string;
  featureDescription: string;
  keyword: string; // "Scenario" or "Scenario Outline"
  title: string;
  line: number;
  rule: string | null;
  tags: string[]; // feature + rule + scenario tags
  steps: CypressStep[];
  examples: number; // number of example rows (0 for a plain scenario)
  parseError?: string;
  /** From the Cypress coverage run: one entry per run of the scenario (one per example row). runId = test ID in the run. */
  run: { runId: string; title: string; status: string; functions: number }[];
}

function walkFeatures(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFeatures(full, out);
    else if (e.name.endsWith('.feature')) out.push(full);
  }
}

/**
 * Turns a run file path (from the Cypress project folder, "cypress/tests/Admin/x.feature")
 * into a scan path (from cypressDir, "Admin/x.feature"). cypressDir is longer
 * ("tests/Cypress/cypress/tests"), so remove its longest end part that starts the run path.
 */
function scanPath(project: ProjectConfig, runFile: string): string {
  const parts = (project.cypressDir ?? '').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(i).join('/') + '/';
    if (runFile.startsWith(prefix)) return runFile.slice(prefix.length);
  }
  return runFile;
}

/**
 * Cypress scenarios of the project from the database, matched to the Cypress coverage run.
 * A run test matches by feature file and scenario line, not by title: an outline runs
 * once per example row, with the example values in the title.
 * The run's file path starts at the Cypress project folder; scanPath makes it a scan path.
 */
export function listCypress(project: ProjectConfig): CypressScenario[] {
  syncProject(project);
  const rows = db
    .prepare("SELECT * FROM tests WHERE project_id = ? AND framework = 'cypress' AND removed_at IS NULL ORDER BY file, line")
    .all(project.id) as any[];
  const cov = loadCoverage(project, 'cypress');
  const byPlace = new Map<string, NonNullable<typeof cov>['tests']>();
  for (const t of cov?.tests ?? []) {
    const key = `${scanPath(project, t.file)}:${t.line}`;
    byPlace.set(key, [...(byPlace.get(key) ?? []), t]);
  }
  return rows.map((r) => {
    const matched = byPlace.get(`${r.file}:${r.line}`) ?? [];
    return {
      id: r.id, file: r.file, title: r.title, line: r.line, tags: json(r.tags), ...json(r.data),
      run: matched.map((t) => ({
        runId: t.id,
        title: runTestPath(t).slice(-1)[0],
        status: t.status,
        functions: cov!.functionsPerTest.get(t.id) ?? 0,
      })),
    };
  });
}

/** Reads all .feature files of the project. Used by the scan (scan.ts). */
export function parseCypressRepo(project: ProjectConfig): Omit<CypressScenario, 'run'>[] | null {
  if (!project.cypressDir) return [];
  const root = path.join(project.path, project.cypressDir);
  if (!fs.existsSync(root)) return null; // folder missing: do not mark tests removed
  const files: string[] = [];
  walkFeatures(root, files);

  const seen = new Set<string>();
  const out: Omit<CypressScenario, 'run'>[] = [];
  const makeId = (key: string) => {
    let id = 'CY-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    if (seen.has(id)) {
      const base = id;
      for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
    }
    seen.add(id);
    return id;
  };

  for (const full of files.sort()) {
    const rel = path.relative(root, full);
    const parser = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
    let doc;
    try {
      doc = parser.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      out.push({
        id: makeId(rel + ' > (parse error)'), file: rel, feature: path.basename(rel), featureDescription: '',
        keyword: '', title: '(file could not be read)', line: 1, rule: null, tags: [], steps: [], examples: 0,
        parseError: String((e as Error).message).split('\n')[0],
      });
      continue;
    }
    const feature = doc.feature;
    if (!feature) continue;
    const featureTags = feature.tags.map((t) => t.name);

    const addFrom = (children: readonly any[], rule: string | null, ruleTags: string[], inheritedBg: CypressStep[]) => {
      let background = inheritedBg;
      for (const child of children) {
        if (child.background) {
          background = [
            ...inheritedBg,
            ...child.background.steps.map((s: any) => ({ keyword: s.keyword.trim(), text: s.text, background: true })),
          ];
        } else if (child.rule) {
          addFrom(child.rule.children, child.rule.name, child.rule.tags.map((t: any) => t.name), background);
        } else if (child.scenario) {
          const s = child.scenario;
          out.push({
            id: makeId([rel, rule ?? '', s.name].join(' > ')),
            file: rel,
            feature: feature.name,
            featureDescription: feature.description.trim(),
            keyword: s.keyword,
            title: s.name,
            line: s.location.line,
            rule,
            tags: [...new Set([...featureTags, ...ruleTags, ...s.tags.map((t: any) => t.name)])],
            steps: [
              ...background,
              ...s.steps.map((st: any) => ({ keyword: st.keyword.trim(), text: st.text, background: false })),
            ],
            examples: s.examples.reduce((n: number, ex: any) => n + ex.tableBody.length, 0),
          });
        }
      }
    };
    addFrom(feature.children, null, [], []);
  }
  return out;
}
