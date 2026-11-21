/**
 * Test selection for a sync (phase 6, step 3 of docs/sync-plan.md): a full run, or a partial run of
 * only the spec files that the changed code touches.
 *
 * coverage/select-tests.py finds the tests that ran each changed function in the selected run. A
 * changed function that 90% or more of the tests ran is library code (startup, hooks, glue): it
 * selects no test. It is saved as "untested" in run-info.json, with the commit, until the next full run.
 *
 * A full run when:
 *  - the sync asks for "always"
 *  - there is no selected run, or it has no raw requests, windows or plugin commit
 *  - the last full run is older than FULL_RUN_DAYS (7; TRACKER_FULL_RUN_DAYS changes it). This is the
 *    safety net: it tests the skipped library changes again, and makes a new full map.
 *  - a test support file changed (page objects, fixtures, step definitions, config): the script
 *    cannot see which specs use it
 *  - select-tests.py fails, or every spec file is selected
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type ProjectConfig } from './projects.ts';
import { cypressRoot } from './cypress-run.ts';
import type { Ctx, RunPlan } from './test-run.ts';

export type Framework = 'playwright' | 'cypress';

const FULL_RUN_DAYS = (() => {
  const v = Number.parseFloat(process.env.TRACKER_FULL_RUN_DAYS ?? '');
  return v > 0 ? v : 7;
})();
/** A changed function that this share of tests (or more) ran is library code. TRACKER_LIBRARY_SHARE changes it. */
export const LIBRARY_SHARE = (() => {
  const v = Number.parseFloat(process.env.TRACKER_LIBRARY_SHARE ?? '');
  return v > 0 && v <= 1 ? v : 0.9;
})();

export interface Untested {
  file: string;
  function: string;
  /** The commit that brought the change. */
  commit: string;
}

export interface Selection {
  /** Undefined: a full run. */
  plan?: RunPlan;
  /** Why a full run, or what the partial run runs. */
  why: string;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The date of the last full run behind a run: its own fullRunAt, or the record date of an older full run. */
function fullRunDate(info: any): Date | null {
  const d = info?.fullRunAt ?? (info?.partial ? null : info?.recordedAt);
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

export async function selectRun(p: ProjectConfig, fw: Framework, to: string, mode: string, ctx: Ctx): Promise<Selection> {
  if (mode === 'always') return { why: 'full run (asked)' };
  const run = p.runs[fw];
  if (!run) return { why: 'full run (no selected run yet)' };
  const dir = path.join(ROOT, run.dir);
  const info = readJson(path.join(dir, 'run-info.json'));
  const from: string | undefined = info?.pluginCommit;
  if (!from || !fs.existsSync(path.join(dir, 'raw')) || !fs.existsSync(path.join(dir, 'test-windows.json'))) {
    return { why: 'full run (the selected run has no requests, windows or plugin commit)' };
  }
  const full = fullRunDate(info);
  const days = full ? (Date.now() - full.getTime()) / 86_400_000 : Infinity;
  if (days >= FULL_RUN_DAYS) return { why: full ? `full run (the last full run is ${Math.floor(days)} days old; one full run each ${FULL_RUN_DAYS} days)` : 'full run (no full run date)' };

  // The spec folder, and the folder that the test paths are relative to.
  let specDir: string;
  let testsRoot: string;
  if (fw === 'playwright') {
    if (!p.playwrightDir) return { why: 'full run (no Playwright folder)' };
    specDir = p.playwrightDir;
    testsRoot = path.dirname(specDir);
  } else {
    const root = cypressRoot(p);
    if (!p.cypressDir || !root) return { why: 'full run (no Cypress folder)' };
    specDir = p.cypressDir;
    testsRoot = path.relative(p.path, root).split(path.sep).join('/');
    // With cypress.config.* at the top of the repo, select-tests.py cannot tell Cypress support files
    // (step definitions, cypress/support) from other files, so a changed step would select no test.
    if (!testsRoot) return { why: 'full run (cypress.config.* is at the top of the repo: support file changes cannot be found)' };
  }
  const args = [path.join(ROOT, 'coverage', 'select-tests.py'), p.path, dir, from, to, '--playwright-dir', specDir, '--tests-root', testsRoot, '--library-share', String(LIBRARY_SHARE), '--json'];
  if (p.excludeDirs) args.push('--exclude', p.excludeDirs.join(','));
  const r = await ctx.run('python3', args, { cwd: ROOT, env: ctx.env(), quiet: true });
  if (r.code !== 0) return { why: `full run (select-tests.py failed: ${r.out.trim().split('\n').slice(-1)[0] ?? ''})` };
  let sel: any;
  try {
    sel = JSON.parse(r.out);
  } catch {
    return { why: 'full run (select-tests.py gave no JSON)' };
  }
  if (sel.supportChanges?.length) return { why: `full run (${sel.supportChanges.length} test support files changed, for example ${sel.supportChanges[0]})` };
  const allFiles = new Set<string>((readJson(path.join(dir, 'test-windows.json')) ?? []).filter((w: any) => w.project !== 'setup').map((w: any) => w.file));
  // Changed spec files are selected through their tests. A new spec file has no tests in the old run: add it.
  const files = new Set<string>(sel.selectedFiles ?? []);
  for (const c of sel.specChanges ?? []) {
    if (c.status === 'D') continue;
    const rel = path.relative(testsRoot, c.new).split(path.sep).join('/');
    if (!rel.startsWith('..')) files.add(rel);
  }
  if (allFiles.size && [...allFiles].every((f) => files.has(f))) return { why: 'full run (the changes touch every spec file)' };

  const old: Untested[] = Array.isArray(info.untested) ? info.untested : [];
  const seen = new Set(old.map((u) => `${u.file}\0${u.function}`));
  const added: Untested[] = [];
  for (const c of sel.libraryChanges ?? []) {
    const key = `${c.file}\0${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ file: c.file, function: c.name, commit: to });
  }
  const untested = [...old, ...added];
  const plan: RunPlan = {
    files: [...files].sort(),
    baseDir: run.dir,
    info: {
      fullRunAt: info.fullRunAt ?? full?.toISOString() ?? null,
      untested,
      partial: { fromRun: run.dir, fromCommit: from, selectedTests: sel.selected, libraryShare: LIBRARY_SHARE, libraryChanges: added.length },
    },
  };
  const why = `partial run: ${plan.files.length} of ${allFiles.size} spec files (${sel.selected} tests touch the changed code); ${added.length} new library change${added.length === 1 ? '' : 's'} not tested again (${untested.length} since the last full run)`;
  return { plan, why };
}
