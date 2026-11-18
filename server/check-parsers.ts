/**
 * Checks the parsers and totals against known data. Run: npm run check-parsers
 *  - Playwright parser finds the same tests (title + tags) as the Playwright coverage run.
 *  - Each test in the Cypress coverage run matches one scenario.
 *  - All IDs are unique.
 *  - Function totals equal the analysis summary.
 */
import { importProjectsJson, loadProjects } from './projects.ts';
importProjectsJson();
import { listPlaywright } from './playwright.ts';
import { listCypress } from './cypress.ts';
import { listFiles } from './files.ts';
import { availableViews, loadCoverage, runTestPath } from './coverage.ts';

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

for (const p of loadProjects()) {
  console.log(`\n== ${p.name}`);
  const pw = listPlaywright(p);
  const cy = listCypress(p);
  const cov = loadCoverage(p, 'playwright');

  check(new Set(pw.map((t) => t.id)).size === pw.length, `Playwright IDs unique (${pw.length} tests)`);
  console.log(`      ${pw.filter((t) => t.parametrized).length} tests are built in a loop; ${pw.filter((t) => t.skipped).length} are skipped in code`);
  check(new Set(cy.map((s) => s.id)).size === cy.length, `Cypress IDs unique (${cy.length} scenarios)`);
  const errors = cy.filter((s) => s.parseError);
  check(errors.length === 0, `Cypress files parse (${errors.length} errors)`);
  errors.forEach((e) => console.log(`      ${e.file}: ${e.parseError}`));

  if (cov) {
    const runKeys = new Map(cov.tests.map((t) => [runTestPath(t).join(' > '), t]));
    const matchedTitles = new Set(pw.flatMap((t) => t.run.map((r) => r.title + '|' + t.file)));
    const missing = [...runKeys.entries()]
      .filter(([, r]) => !matchedTitles.has(runTestPath(r).slice(-1)[0] + '|' + runTestPath(r)[0]))
      .map(([k]) => k);
    check(missing.length === 0, `Every test in the coverage run is found by the parser (${runKeys.size} run tests)`);
    missing.forEach((k) => console.log(`      not parsed: ${k}`));

    const runEntries = pw.reduce((n, t) => n + t.run.length, 0);
    check(runEntries === cov.tests.length, `Each run test matches exactly one parsed test (${runEntries} matches for ${cov.tests.length} run tests)`);

    let tagDiff = 0;
    for (const t of pw) {
      const r = t.parametrized ? undefined : runKeys.get([t.file, ...t.describes, t.title].join(' > '));
      if (!r) continue;
      const a = [...t.tags].sort().join(' ');
      const b = [...r.tags].sort().join(' ');
      if (a !== b) {
        tagDiff++;
        console.log(`      tags differ: ${t.title}\n        parser: ${a}\n        run:    ${b}`);
      }
    }
    check(tagDiff === 0, 'Parser tags equal run tags');

    const files = listFiles(p, 'playwright').filter((f) => f.measured);
    const total = files.reduce((n, f) => n + f.functions.total, 0);
    const all = [...cov.functionsByFile.values()].reduce((n, l) => n + l.length, 0);
    check(total === all, `File list holds all analysed functions (${total} of ${all})`);
    const sum = (k: keyof (typeof files)[0]['lines']) => files.reduce((n, f) => n + f.lines[k], 0);
    const covFiles = Object.keys(cov.lines).length;
    const withData = files.filter((f) => f.loaded || cov.neverLoaded.has(f.path)).length;
    check(withData === covFiles, `File list holds every file with line data (${withData} of ${covFiles}, ${cov.neverLoaded.size} counted without running)`);
    console.log(
      `      lines: runnable ${sum('runnable')}, library ${sum('library')}, tested ${sum('tested')}, setup ${sum('setup')}, never ${sum('never')}, run by tests incl. library ${sum('runByTests')}`,
    );
  }
}
for (const p of loadProjects()) {
  const cyCov = loadCoverage(p, 'cypress');
  if (cyCov) {
    console.log(`\n== ${p.name} (Cypress run)`);
    const cy = listCypress(p);
    const matched = cy.reduce((n, s) => n + s.run.length, 0);
    check(matched === cyCov.tests.length, `Each Cypress run test matches one scenario (${matched} matches for ${cyCov.tests.length} run tests)`);
    const owned = new Set(cy.flatMap((s) => s.run.map((r) => r.runId)));
    cyCov.tests.filter((t) => !owned.has(t.id)).forEach((t) => console.log(`      not matched: ${t.file}:${t.line} ${t.title}`));
  }
  if (availableViews(p).includes('both')) {
    const both = listFiles(p, 'both').filter((f) => f.measured);
    const sum = (k: keyof (typeof both)[0]['lines']) => both.reduce((n, f) => n + f.lines[k], 0);
    check(sum('cypressOnly') <= sum('tested'), `Cypress-only lines are part of the tested lines (${sum('cypressOnly')} of ${sum('tested')})`);
    console.log(`      both runs: runnable ${sum('runnable')}, library ${sum('library')}, tested ${sum('tested')} (Cypress only ${sum('cypressOnly')}), never ${sum('never')}`);
  }
}
process.exit(failed ? 1 : 0);
