import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { FRAMEWORKS, ROOT, getProject, importProjectsJson, loadProjects, safeRepoPath, writeCoverageConfig, type ProjectConfig } from './projects.ts';
import { syncProject } from './scan.ts';
import { EditError, edits, featureData, screenshotData, screenshotInfo, sweepBefore, sweepReviewed } from './features.ts';
import { listMarks, markEdits } from './line-marks.ts';
import { listDecisions, removeDecision } from './code-decisions.ts';
import { listLeftOut, removeLeftOut } from './left-out.ts';
import { untestedChanges } from './selection.ts';
import { dailySyncState, startDailySync } from './daily-sync.ts';
import { listSettings, saveSettings, SettingError } from './settings.ts';
import { testSource } from './test-source.ts';
import { fileDetail, listFiles, type FileEntry } from './files.ts';
import { listPlaywright, playwrightErrors } from './playwright.ts';
import { listCypress } from './cypress.ts';
import { availableViews, loadCoverage, resolveView, runFreshness } from './coverage.ts';
import { runTestOwners } from './run-tests.ts';
import { featureCodeCoverage, mappedCodeTotals } from './feature-code.ts';
import { cancelSync, startSync, syncState, SyncError, type TestMode } from './sync.ts';
import { aiUpdateState, AiUpdateError, retryReview, startAiUpdate } from './ai-update.ts';
import { listParked, mapLoopState, MapLoopError, mapOlderRuns, mapRunReport, startMapLoop, stopMapLoop, unpark } from './map-loop.ts';

const app = express();
const PORT = Number(process.env.PORT ?? 5174);

// Accept only requests addressed to this computer. A web page can point its own
// domain at 127.0.0.1 (DNS rebinding); its requests then carry that domain as Host.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use((req, res, next) => (LOCAL_HOST.test(req.headers.host ?? '') ? next() : res.status(403).send('Forbidden')));

// Changes: any web page can send a POST to localhost, so accept a change only
// from this app (Origin on localhost) and only as JSON (a plain form cannot send JSON).
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
  next();
});
// A screenshot upload is one image as base64 text (10 MB image = about 13.4 MB text). Other changes are small.
// The upload route reads its body first; the general parser then skips a body that is already read.
const SCREENSHOT_UPLOAD = '/api/projects/:id/features/:fid/screenshots';
app.post(SCREENSHOT_UPLOAD, express.json({ limit: '14mb' }));
app.use(express.json({ limit: '200kb' }));

importProjectsJson();
writeCoverageConfig(); // coverage/prepend.php reads it; it is not in git

/** The run of each test tool: label, plugin commit check, and number of test runs. */
function runInfo(p: ProjectConfig) {
  return Object.fromEntries(
    FRAMEWORKS.map((fw) => {
      const cov = loadCoverage(p, fw);
      return [fw, cov ? { label: cov.label, freshness: runFreshness(p, fw), tests: cov.tests.length } : null];
    }),
  );
}

const lineKeys = ['runnable', 'library', 'tested', 'setup', 'background', 'never', 'runByTests', 'cypressOnly', 'markedLibrary', 'markedCovered'] as const;
const lineTotals = (php: FileEntry[]) => Object.fromEntries(lineKeys.map((k) => [k, php.reduce((n, f) => n + f.lines[k], 0)]));

/**
 * The project page. The top numbers always use the two runs together (or the one run that exists).
 * linesBy gives the numbers of each run alone, for the Playwright and Cypress cards.
 */
function summary(id: string) {
  const p = getProject(id)!;
  const view = resolveView(p, 'both');
  const files = listFiles(p, view);
  const php = files.filter((f) => f.measured);
  const sumFns = (k: keyof FileEntry['functions']) => php.reduce((n, f) => n + f.functions[k], 0);
  const fnKeys = ['total', 'library', 'tested', 'setup', 'background', 'never', 'unknown'] as const;
  const pw = listPlaywright(p);
  const cy = listCypress(p);
  const runs = runInfo(p);
  const pwCommit = runs.playwright?.freshness?.runCommit;
  const cyCommit = runs.cypress?.freshness?.runCommit;
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    view,
    views: availableViews(p),
    runs,
    /** Selected runs whose folder could not be read (no report.json, or bad JSON). */
    unreadRuns: FRAMEWORKS.filter((fw) => p.runs[fw] && !runs[fw]).map((fw) => ({ framework: fw, dir: p.runs[fw]!.dir })),
    /**
     * Both runs exist: "same" or "different" plugin commit, or "unknown" when a run has no commit.
     * With different code, line numbers may not match. Null: not both runs.
     */
    runsCommit: !runs.playwright || !runs.cypress ? null : !pwCommit || !cyCommit ? 'unknown' : pwCommit === cyCommit ? 'same' : 'different',
    files: { total: files.length, php: files.filter((f) => f.lang === 'php').length, js: files.filter((f) => f.lang === 'js').length },
    lines: lineTotals(php),
    linesBy: Object.fromEntries(
      FRAMEWORKS.map((fw) => [fw, view === fw ? lineTotals(php) : runs[fw] ? lineTotals(listFiles(p, fw).filter((f) => f.measured)) : null]),
    ),
    mappedCode: mappedCodeTotals(p, view),
    functions: Object.fromEntries(fnKeys.map((k) => [k, sumFns(k)])),
    neverLoadedFiles: php.filter((f) => !f.loaded).length,
    uncountedFiles: php.filter((f) => f.uncounted).length,
    playwright: {
      tests: pw.length,
      files: new Set(pw.map((t) => t.file)).size,
      skipped: pw.filter((t) => t.skipped).length,
      runTests: runs.playwright?.tests ?? 0,
      parseErrors: playwrightErrors.get(p.id) ?? [],
    },
    cypress: { scenarios: cy.length, files: new Set(cy.map((s) => s.file)).size, runTests: runs.cypress?.tests ?? 0 },
    features: featureSummary(p.id),
  };
}

/** Features and how many scopes have a Playwright test, a Cypress scenario, both or none. */
function featureSummary(id: string) {
  const d = featureData(id);
  const scopes = d.features.flatMap((f: any) => f.scopes.map((s: any) => f.links.filter((l: any) => l.scopeIds.includes(s.id) && !l.missing)));
  const has = (ls: any[], fw: string) => ls.some((l) => l.framework === fw);
  return {
    features: d.features.length,
    withPlaywright: d.features.filter((f: any) => has(f.links.filter((l: any) => !l.missing), 'playwright')).length,
    withCypress: d.features.filter((f: any) => has(f.links.filter((l: any) => !l.missing), 'cypress')).length,
    scopes: scopes.length,
    scopesBoth: scopes.filter((ls: any[]) => has(ls, 'playwright') && has(ls, 'cypress')).length,
    unlinkedTests: d.unlinked,
  };
}

app.get('/api/projects', (_req, res) => {
  res.json(loadProjects().map((p) => summary(p.id)));
});

/** The coverage view asked in ?view= (playwright, cypress or both). resolveView picks a default. */
const viewOf = (req: express.Request) => resolveView((req as any).project, req.query.view);

app.use('/api/projects/:id', (req, res, next) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Unknown project' });
  (req as any).project = p;
  next();
});

app.get('/api/projects/:id', (req, res) => res.json(summary(req.params.id)));
app.get('/api/projects/:id/files', (req, res) => res.json(listFiles((req as any).project, viewOf(req))));
app.get('/api/projects/:id/file', (req, res) => {
  const p = (req as any).project;
  const rel = String(req.query.path ?? '');
  const full = safeRepoPath(p, rel);
  if (!full) return res.status(404).json({ error: 'File not found' });
  res.json(fileDetail(p, rel, full, viewOf(req)));
});
app.get('/api/projects/:id/playwright', (req, res) => res.json(listPlaywright((req as any).project)));
/** The file of one test (?id=PW-… or CY-…), with the first and last line of the test. */
app.get('/api/projects/:id/test-source', (req, res) => {
  const out = testSource((req as any).project, String(req.query.id ?? ''));
  if (!out) return res.status(404).json({ error: 'Unknown test, or its file is not in the repo' });
  res.json(out);
});
app.get('/api/projects/:id/cypress', (req, res) => res.json(listCypress((req as any).project)));

// ---- Features ----
const proj = (req: express.Request) => (req as any).project as ProjectConfig;

app.get('/api/projects/:id/features', (req, res) => {
  syncProject(proj(req));
  res.json(featureData(proj(req).id));
});

/**
 * PHP functions that the feature's linked tests ran, in the coverage of the asked view.
 * Each function lists the linked tests (PW-… and CY-…) that ran it. A function that only
 * linked Cypress tests ran is code that the Playwright tests of this feature do not reach yet.
 */
app.get('/api/projects/:id/features/:fid/code', (req, res) => {
  const p = proj(req);
  const f = featureData(p.id).features.find((x: any) => x.id === Number(req.params.fid));
  if (!f) return res.status(404).json({ error: 'Unknown feature' });
  const view = viewOf(req);
  const cov = view && loadCoverage(p, view);
  const linked = new Set(f.links.map((l: any) => l.testId));
  const runToTest = new Map([...runTestOwners(p)].filter(([, testId]) => linked.has(testId)));
  const runTestIds = new Set(cov?.tests.map((t) => t.id) ?? []);
  const functions = [];
  for (const [file, list] of cov?.functionsByFile ?? []) {
    for (const fn of list) {
      if (fn.state === 'library') continue; // runs on every request: says nothing about one feature
      const tests = [...new Set(fn.tests.map((t) => runToTest.get(t)).filter(Boolean))] as string[];
      if (tests.length) functions.push({ file, name: fn.function, start: fn.start, end: fn.end, state: fn.state, lines: fn.lines, tests });
    }
  }
  const inRun = new Set([...runToTest].filter(([runId]) => runTestIds.has(runId)).map(([, testId]) => testId));
  res.json({
    view,
    linkedRunTests: { playwright: [...inRun].filter((t) => t.startsWith('PW-')).length, cypress: [...inRun].filter((t) => t.startsWith('CY-')).length },
    functions,
  });
});

/** Mapped code of every feature, with coverage from both runs together, and the code in no feature. */
app.get('/api/projects/:id/feature-code', (req, res) => res.json(featureCodeCoverage(proj(req), resolveView(proj(req), 'both'))));

const edit = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
  try {
    const out = fn(req);
    // A person changed something: a feature with no open AI mark left is reviewed now.
    if (req.method !== 'GET') {
      sweepReviewed(proj(req).id);
      sweepBefore(); // "before" values of AI marks that went
    }
    res.json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof EditError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Could not save the change' });
  }
};
const P = (req: express.Request) => proj(req).id;
// ---- Sync with the remote branch (server/sync.ts) ----
app.get('/api/projects/:id/sync', (req, res) => res.json(syncState(P(req))));
const syncEdit = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    if (e instanceof SyncError) return res.status(409).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
};
app.post('/api/projects/:id/sync', syncEdit((req) => {
  const mode: TestMode = ['auto', 'always', 'never'].includes(req.body?.tests) ? req.body.tests : 'auto';
  return { syncId: startSync(P(req), mode).syncId };
}));
app.post('/api/projects/:id/sync/cancel', syncEdit((req) => cancelSync(P(req))));
// ---- AI update after a sync (server/ai-update.ts) ----
app.get('/api/projects/:id/ai-updates', (req, res) => res.json(aiUpdateState(P(req))));
// "Try again" for a feature that the AI update parked after it failed on 2 days.
app.post('/api/projects/:id/ai-review-pending/:fid/retry', edit((req) => {
  if (!retryReview(proj(req).id, Number(req.params.fid))) throw new EditError(`F-${req.params.fid} is not in the AI review list`);
  return { ok: true };
}));
app.post('/api/projects/:id/ai-update', (req, res) => {
  try {
    const model = ['sonnet', 'opus', 'haiku'].includes(req.body?.model) ? req.body.model : undefined;
    const budget = Number(req.body?.budgetUsd);
    res.json(startAiUpdate(proj(req), { model, budgetUsd: budget > 0 && budget <= 10 ? budget : undefined }));
  } catch (e) {
    if (e instanceof AiUpdateError) return res.status(409).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
});
// ---- Mapping loop: headless map-features (server/map-loop.ts) ----
app.get('/api/projects/:id/map-loop', (req, res) => res.json(mapLoopState(P(req))));
// ?before=<unit id>: one page of the units that are older than this unit.
app.get('/api/projects/:id/map-loop/runs', (req, res) => {
  const before = Number(req.query.before);
  if (!Number.isInteger(before) || before <= 0) return res.status(400).json({ error: 'Send ?before=<unit id>, a whole number above 0.' });
  res.json({ runs: mapOlderRuns(P(req), before) });
});
app.get('/api/projects/:id/map-loop/runs/:rid/report', (req, res) => {
  const rid = Number(req.params.rid);
  if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'The unit ID must be a whole number above 0.' });
  const report = mapRunReport(P(req), rid);
  if (report === null) return res.status(404).json({ error: 'No such unit in this project.' });
  res.json({ report });
});
const loopEdit = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    if (e instanceof MapLoopError) return res.status(409).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
};
app.post('/api/projects/:id/map-loop', loopEdit((req) => {
  const b = req.body ?? {};
  // No value: the default. A bad value or a value above the limit: startMapLoop refuses it with a message.
  const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const model = ['sonnet', 'opus'].includes(b.model) ? b.model : undefined;
  return { loopId: startMapLoop(proj(req), { model, maxUnits: n(b.maxUnits), startedBy: 'app' }).loopId };
}));
app.post('/api/projects/:id/map-loop/stop', loopEdit((req) => stopMapLoop(P(req))));
app.post('/api/projects/:id/rescan', edit((req) => syncProject(proj(req), true)));
app.post('/api/projects/:id/groups', edit((req) => edits.addGroup(P(req), req.body)));
app.patch('/api/projects/:id/groups/:gid', edit((req) => edits.updateGroup(P(req), req.params.gid, req.body)));
app.delete('/api/projects/:id/groups/:gid', edit((req) => edits.deleteGroup(P(req), req.params.gid)));
app.post('/api/projects/:id/features', edit((req) => edits.addFeature(P(req), req.body)));
app.patch('/api/projects/:id/features/:fid', edit((req) => edits.updateFeature(P(req), req.params.fid, req.body)));
app.delete('/api/projects/:id/features/:fid', edit((req) => edits.deleteFeature(P(req), req.params.fid)));
app.post('/api/projects/:id/features/:fid/merge', edit((req) => edits.mergeFeature(P(req), req.params.fid, req.body)));
app.post('/api/projects/:id/features/:fid/check', edit((req) => edits.checkFeature(P(req), req.params.fid)));
app.post('/api/projects/:id/features/:fid/uncheck', edit((req) => edits.uncheckFeature(P(req), req.params.fid)));
app.post('/api/projects/:id/features/:fid/labels', edit((req) => edits.addLabel(P(req), req.params.fid, req.body)));
app.delete('/api/projects/:id/features/:fid/labels/:kind/:value', edit((req) => edits.deleteLabel(P(req), req.params.fid, req.params)));
app.post('/api/projects/:id/features/:fid/items', edit((req) => edits.addItem(P(req), req.params.fid, req.body)));
app.patch('/api/projects/:id/items/:iid', edit((req) => edits.updateItem(P(req), req.params.iid, req.body)));
app.delete('/api/projects/:id/items/:iid', edit((req) => edits.deleteItem(P(req), req.params.iid)));
app.post('/api/projects/:id/features/:fid/scopes', edit((req) => edits.addScope(P(req), req.params.fid, req.body)));
app.post('/api/projects/:id/features/:fid/scope-groups', edit((req) => edits.addScopeGroup(P(req), req.params.fid, req.body)));
app.patch('/api/projects/:id/scope-groups/:gid', edit((req) => edits.updateScopeGroup(P(req), req.params.gid, req.body)));
app.delete('/api/projects/:id/scope-groups/:gid', edit((req) => edits.deleteScopeGroup(P(req), req.params.gid)));
app.patch('/api/projects/:id/scopes/:sid', edit((req) => edits.updateScope(P(req), req.params.sid, req.body)));
app.post('/api/projects/:id/scopes/:sid/move', edit((req) => edits.moveScope(P(req), req.params.sid, req.body)));
app.delete('/api/projects/:id/scopes/:sid', edit((req) => edits.deleteScope(P(req), req.params.sid)));
app.post('/api/projects/:id/links', edit((req) => edits.addLink(P(req), req.body)));
app.post('/api/projects/:id/links/move-test', edit((req) => edits.moveTestLinks(P(req), req.body)));
app.patch('/api/projects/:id/links/:lid', edit((req) => edits.updateLink(P(req), req.params.lid, req.body)));
app.patch('/api/projects/:id/feature-code/:cid', edit((req) => edits.updateFeatureCode(P(req), req.params.cid, req.body)));
app.delete('/api/projects/:id/feature-code/:cid', edit((req) => edits.deleteFeatureCode(P(req), req.params.cid)));
app.post('/api/projects/:id/revert', edit((req) => edits.revert(P(req), req.body)));
// Hand marks on code lines (server/line-marks.ts). The coverage data reads them on the next request.
app.get('/api/projects/:id/line-marks', (req, res) => res.json(listMarks(proj(req))));
app.post('/api/projects/:id/line-marks', edit((req) => markEdits.mark(proj(req), req.body)));
app.delete('/api/projects/:id/line-marks', edit((req) => markEdits.unmark(proj(req), req.body)));
// Library decisions on functions that no test runs (server/code-decisions.ts). The AI skill adds them; a person can remove one.
app.get('/api/projects/:id/code-decisions', (req, res) => res.json(listDecisions(proj(req).id)));
// Settings of the whole tracker (server/settings.ts). PATCH body: { key: value }; null puts a setting back to its default.
app.get('/api/settings', (_req, res) => res.json(listSettings()));
app.patch('/api/settings', (req, res) => {
  try {
    res.json(saveSettings(req.body ?? {}));
  } catch (e) {
    if (e instanceof SettingError) return res.status(400).json({ error: e.message });
    throw e;
  }
});
// The daily sync (server/daily-sync.ts): on or off, and when each project is due.
app.get('/api/daily-sync', (_req, res) => res.json(dailySyncState()));
// Library changes that partial runs did not test again, until the next full run (server/selection.ts).
app.get('/api/projects/:id/untested', (req, res) => res.json(untestedChanges(proj(req))));
app.delete('/api/projects/:id/code-decisions', edit((req) => {
  const { file, function: fn } = req.body ?? {};
  if (typeof file !== 'string' || typeof fn !== 'string') throw new EditError('Give "file" and "function"');
  if (!removeDecision(proj(req), file, fn)) throw new EditError(`No decision for ${file} ${fn}`);
  return { ok: true };
}));
// Tests that the AI or a feature delete left out of each feature on purpose (server/left-out.ts).
// A remove makes the test's file come back in the mapping loop.
app.get('/api/projects/:id/left-out-tests', (req, res) => res.json(listLeftOut(proj(req).id)));
app.delete('/api/projects/:id/left-out-tests', edit((req) => {
  const { testId } = req.body ?? {};
  if (typeof testId !== 'string') throw new EditError('Give "testId"');
  if (!removeLeftOut(proj(req).id, testId)) throw new EditError(`${testId} is not left out`);
  return { ok: true };
}));
// Mapping units that failed 2 times in one loop (server/map-loop.ts). A remove ("Try again") brings the unit back.
app.get('/api/projects/:id/parked-units', (req, res) => res.json(listParked(proj(req).id)));
app.delete('/api/projects/:id/parked-units', edit((req) => {
  const { kind, ref } = req.body ?? {};
  if (typeof kind !== 'string' || typeof ref !== 'string') throw new EditError('Give "kind" and "ref"');
  if (!unpark(proj(req).id, kind, ref)) throw new EditError(`${kind} "${ref}" is not parked`);
  return { ok: true };
}));
app.post(SCREENSHOT_UPLOAD, edit((req) => edits.addScreenshot(P(req), req.params.fid, req.body)));
app.patch('/api/projects/:id/screenshots/:sid', edit((req) => edits.updateScreenshot(P(req), req.params.sid, req.body)));
app.delete('/api/projects/:id/screenshots/:sid', edit((req) => edits.deleteScreenshot(P(req), req.params.sid)));
/**
 * The image of a screenshot. The browser keeps a copy, but asks each time if the copy is still good
 * (a restored backup can give an ID another image). The tag is the ID and upload time, so the
 * answer "still good" (304) does not read the image.
 */
app.get('/api/projects/:id/screenshots/:sid', (req, res) => {
  const info = screenshotInfo(P(req), req.params.sid);
  if (!info) return res.status(404).json({ error: 'Unknown screenshot' });
  const etag = `"${info.id}-${info.createdAt.replace(/\D/g, '')}"`;
  res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  const data = screenshotData(info.id);
  res.type(info.mime).send(Buffer.from(data.buffer, data.byteOffset, data.byteLength)); // no copy of the bytes
});
app.delete('/api/projects/:id/links/:lid', edit((req) => edits.deleteLink(P(req), req.params.lid)));

// Any other error: answer with JSON, so the app can show the message.
app.use('/api', (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Local only: the app can read the plugin repo and change the database.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`API on http://127.0.0.1:${PORT}`);
  // The daily sync of each project with sync on, when it is due (server/daily-sync.ts). Not in a
  // second server that runs on a copy of the database (TRACKER_DB), so a trial never starts real syncs.
  if (!process.env.TRACKER_DB) startDailySync();
});
