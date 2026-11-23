import { useEffect, useMemo, useState } from 'react';
import {
  featureTotal, mutate, pct, reloadAll, useApi,
  type CypressScenario, type Feature, type FeatureCodeMap, type FeatureData, type FeatureItem, type FeatureLink, type ItemField,
  type LineCounts, type PlaywrightTest, type ProjectSummary, type Scope,
} from '../api';

/* ------------------------------------------------------------------ */
/* Types the old screens did not need                                  */
/* ------------------------------------------------------------------ */

/** The value a field had before the AI changed it (server: ai_before). Only fields that still have the AI mark. */
export type Before = Record<string, string | null>;
export type FeatureX = Feature & { before?: Before };
export type ScopeX = Scope & { before?: Before };

export interface TestRef { id: string; framework: 'playwright' | 'cypress'; file: string; title: string; links: number }
export interface ChangeReport {
  from: string;
  to: string;
  commits: number;
  files: { status: string; path: string; oldPath?: string; kind: string }[];
  functions: { file: string; name: string; change: 'added' | 'changed' | 'removed' }[];
  tests: { added: TestRef[]; changed: TestRef[]; removed: TestRef[] };
  renames: { from: TestRef; to: TestRef; reason: 'same-code' | 'similar-title' }[];
  codeGone: { entryId: number; featureId: number; featureTitle: string; file: string; function: string; reason: string; movedTo?: string }[];
  review: { featureId: number; title: string; reasons: string[] }[];
  parseErrors: string[];
}
export interface TestResult {
  ran: boolean; reason?: string; selected?: boolean; runDir?: string; total?: number; passed?: number; failed?: number; skipped?: number; minutes?: number;
  /** A partial run: the spec files that ran, and the tests kept from the last run. */
  partial?: { files: number; keptTests: number };
  /** Library changes since the last full run that no test ran again. */
  untested?: number;
}

/** "Partial run: 3 spec files, 46 tests kept from the last run. 2 library changes not tested again." Empty for a full run. */
export function partialText(r: TestResult): string {
  const parts: string[] = [];
  if (r.partial) parts.push(`Partial run: ${r.partial.files} spec file${r.partial.files === 1 ? '' : 's'}, ${r.partial.keptTests} tests kept from the last run.`);
  if (r.untested) parts.push(`${r.untested} library change${r.untested === 1 ? '' : 's'} not tested again until the next full run.`);
  return parts.join(' ');
}
export interface SyncState {
  enabled: boolean;
  branch: string | null;
  syncedCommit: string | null;
  syncedAt: string | null;
  last: null | {
    id: number;
    status: 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
    step: string;
    startedAt: string;
    finishedAt: string | null;
    fromCommit: string | null;
    toCommit: string | null;
    report: ChangeReport | null;
    tests: TestResult | null;
    /** The Cypress run of the sync. Older syncs have no value. */
    cypressTests?: TestResult | null;
    error: string | null;
    log: string;
  };
  progress: { total: number; done: number; failed: number; current: string } | null;
}

/** One test or Cypress scenario, in the form all screens use. */
export interface TestInfo {
  id: string;
  fw: 'playwright' | 'cypress';
  title: string;
  /** describe blocks (Playwright) or the feature name (Cypress). */
  path: string[];
  file: string;
  line: number;
  tags: string[];
  skipped: boolean;
  /** Result in the coverage run: passed, failed, or none (not in the run). */
  result: 'passed' | 'failed' | 'none';
  pw?: PlaywrightTest;
  cy?: CypressScenario;
}

export type ScopeStatus = 'ok' | 'fail' | 'cy' | 'skipped' | 'none';
export const ST_LABEL: Record<ScopeStatus, string> = { ok: 'Covered', fail: 'Failing', skipped: 'Skipped', cy: 'Cypress only', none: 'No test' };
export const ST_TAG: Record<ScopeStatus, string> = { ok: 'tag-ok', fail: 'tag-fail', skipped: 'tag-skip', cy: 'tag-cy', none: 'tag-none' };

/** Scope counts of a feature. total and the states leave out the scopes marked "To remove"; remove counts them. */
export interface Metrics { total: number; ok: number; fail: number; skip: number; cy: number; none: number; remove: number }

/** One change to review: an AI draft mark, a link to a test that is gone, or a linked test that the last sync changed. */
export interface Change {
  key: string;
  sec: string;
  kind: 'new' | 'changed' | 'test' | 'gone' | 'wanted';
  text: string;
  before: string | null;
  ctx: string;
  /** Where "Open" goes in the feature. */
  tab: 'scopes' | 'details' | 'code' | 'shots';
  scopeId?: number;
  keepLbl: string;
  keep?: () => Promise<unknown>;
  removeLbl?: string;
  remove?: () => Promise<unknown>;
  /** Ask this before remove (a delete that cannot be undone). */
  confirm?: string;
}

export interface FeatureInfo {
  f: FeatureX;
  group: string;
  m: Metrics;
  /** Feature lines of the mapped code run by tests. Null: no code or no coverage run. */
  code: { t: number; n: number } | null;
  changes: Change[];
  /** Number of real changes: the "marked as not reviewed" entry is not a change. */
  nChanges: number;
  /** A person or the AI change waits for a review. */
  toReview: boolean;
}

export interface Tracker {
  project: string;
  summary: ProjectSummary;
  fd: FeatureData;
  tests: TestInfo[];
  testById: Map<string, TestInfo>;
  sync: SyncState | null;
  codeMap: FeatureCodeMap | null;
  info: FeatureInfo[];
  infoById: Map<number, FeatureInfo>;
  /** Active links of each test: feature, and its scopes (empty: the whole feature). */
  linkedTo: Map<string, { fid: number; ftitle: string; link: FeatureLink }[]>;
  groupTitle: (id: number | null) => string;
  /** Test IDs that the last sync added. */
  newTests: Set<string>;
}

/**
 * Scopes that have plugin code (the AI put code on them) but no linked test: the tests to write next.
 * Most code first.
 */
export function scopesToTest(t: Tracker): { fid: number; feature: string; sid: number; scope: string; code: number }[] {
  const code = new Map<number, number>();
  for (const f of t.codeMap?.features ?? []) for (const e of f.entries) for (const sid of e.scopeIds) code.set(sid, (code.get(sid) ?? 0) + 1);
  const out: { fid: number; feature: string; sid: number; scope: string; code: number }[] = [];
  for (const f of t.fd.features) {
    const tested = new Set(f.links.flatMap((l) => l.scopeIds));
    for (const s of f.scopes) if (code.has(s.id) && !tested.has(s.id) && !scopeToRemove(f, s)) out.push({ fid: f.id, feature: f.title, sid: s.id, scope: s.title, code: code.get(s.id)! });
  }
  return out.sort((a, b) => b.code - a.code || a.fid - b.fid);
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Reads the sync state, and reads it again every 2 s while a sync runs. When it ends, every screen loads again. */
export function useSync(project: string): SyncState | null {
  const [tick, setTick] = useState(0);
  const { data } = useApi<SyncState>(`/api/projects/${project}/sync?t=${tick}`);
  const [s, setS] = useState<SyncState | null>(null);
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  const running = s?.last?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => {
      clearInterval(t);
      reloadAll();
    };
  }, [running]);
  return s;
}

function testResult(run: { status: string }[]): TestInfo['result'] {
  if (!run.length) return 'none';
  if (run.some((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted')) return 'failed';
  return 'passed';
}

export function useTracker(project: string): { t: Tracker | null; error: string | null } {
  const summary = useApi<ProjectSummary>(`/api/projects/${project}`);
  const fd = useApi<FeatureData>(`/api/projects/${project}/features`);
  const pw = useApi<PlaywrightTest[]>(`/api/projects/${project}/playwright`);
  const cy = useApi<CypressScenario[]>(`/api/projects/${project}/cypress`);
  const code = useApi<FeatureCodeMap>(`/api/projects/${project}/feature-code`);
  const sync = useSync(project);
  const error = summary.error ?? fd.error ?? pw.error ?? cy.error;
  const t = useMemo(
    () => (summary.data && fd.data && pw.data && cy.data ? build(project, summary.data, fd.data, pw.data, cy.data, code.data, sync) : null),
    [project, summary.data, fd.data, pw.data, cy.data, code.data, sync],
  );
  return { t, error };
}

/* ------------------------------------------------------------------ */
/* Derived numbers                                                     */
/* ------------------------------------------------------------------ */

const activeLinks = (f: Feature) => f.links.filter((l) => !l.missing);
export const scopeLinks = (f: Feature, scopeId: number) => activeLinks(f).filter((l) => l.scopeIds.includes(scopeId));

/**
 * Coverage state of a scope, from its linked tests:
 * ok: a Playwright test that is not skipped and did not fail · fail: its Playwright tests failed in the run
 * cy: only Cypress tests (to convert) · skipped: only skipped Playwright tests · none: no test.
 */
export function scopeStatus(f: Feature, scopeId: number, byId: Map<string, TestInfo>): ScopeStatus {
  const ls = scopeLinks(f, scopeId);
  const pw = ls.filter((l) => l.framework === 'playwright').map((l) => byId.get(l.testId)).filter(Boolean) as TestInfo[];
  const active = pw.filter((t) => !t.skipped);
  if (active.some((t) => t.result !== 'failed')) return 'ok';
  if (active.length) return 'fail';
  if (ls.some((l) => l.framework === 'cypress')) return 'cy';
  if (pw.length) return 'skipped';
  return 'none';
}

/** The scope has the "To remove" mark, or its feature has it. */
export const scopeToRemove = (f: Feature, s: Scope) => !!(f.toRemove || s.toRemove);

/**
 * The test is linked only to items marked "To remove": each active link is to a marked feature, or only to
 * marked scopes. Then the test must go too (a Cypress test: do not convert it). False for a test with no link.
 */
export function testToRemove(t: Pick<Tracker, 'linkedTo' | 'infoById'>, testId: string): boolean {
  const ls = t.linkedTo.get(testId) ?? [];
  return ls.length > 0 && ls.every(({ fid, link: l }) => {
    const f = t.infoById.get(fid)?.f;
    if (!f) return false;
    if (f.toRemove) return true;
    return l.scopeIds.length > 0 && l.scopeIds.every((sid) => !!f.scopes.find((s) => s.id === sid)?.toRemove);
  });
}

export function metrics(f: Feature, byId: Map<string, TestInfo>): Metrics {
  const m: Metrics = { total: 0, ok: 0, fail: 0, skip: 0, cy: 0, none: 0, remove: 0 };
  for (const s of f.scopes) {
    if (scopeToRemove(f, s)) {
      m.remove++;
      continue;
    }
    m.total++;
    const st = scopeStatus(f, s.id, byId);
    if (st === 'ok') m.ok++;
    else if (st === 'fail') m.fail++;
    else if (st === 'skipped') m.skip++;
    else if (st === 'cy') m.cy++;
    else m.none++;
  }
  return m;
}

export const LISTS: { key: ItemField; label: string; hint: string; noun: string }[] = [
  { key: 'requirements', label: 'Requirements', hint: 'What must be true before you check any scope: a setting, data, the user.', noun: 'requirement' },
  { key: 'where', label: 'Where', hint: 'The screens and settings that show this feature.', noun: 'screen or setting' },
  { key: 'notes', label: 'Notes', hint: 'Only what no test can check: a reason, a code fact, a limit.', noun: 'note' },
  { key: 'outOfScope', label: 'Out of scope', hint: 'What this feature does not do.', noun: 'out-of-scope item' },
  { key: 'questions', label: 'Open questions', hint: 'What nobody knows yet. The answer-questions skill can answer them.', noun: 'question' },
];

export const PRI_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low', '': 'None' };
const FIELD_LABEL: Record<string, string> = { title: 'Title', description: 'Description', priority: 'Priority', group: 'Group', roles: 'User roles' };

function build(
  project: string, summary: ProjectSummary, fd: FeatureData, pw: PlaywrightTest[], cy: CypressScenario[], codeMap: FeatureCodeMap | null, sync: SyncState | null,
): Tracker {
  const tests: TestInfo[] = [
    ...pw.map<TestInfo>((t) => ({ id: t.id, fw: 'playwright', title: t.title, path: t.describes, file: t.file, line: t.line, tags: t.tags, skipped: t.skipped, result: testResult(t.run), pw: t })),
    ...cy.map<TestInfo>((t) => ({ id: t.id, fw: 'cypress', title: t.title, path: [t.feature], file: t.file, line: t.line, tags: t.tags, skipped: false, result: testResult(t.run), cy: t })),
  ];
  const testById = new Map(tests.map((t) => [t.id, t]));
  const groups = new Map(fd.groups.map((g) => [g.id, g.title]));
  const groupTitle = (id: number | null) => (id == null ? 'No group' : (groups.get(id) ?? 'No group'));
  const linkedTo: Tracker['linkedTo'] = new Map();
  for (const f of fd.features) for (const l of activeLinks(f)) linkedTo.set(l.testId, [...(linkedTo.get(l.testId) ?? []), { fid: f.id, ftitle: f.title, link: l }]);
  const codeBy = new Map((codeMap?.features ?? []).map((x) => [x.featureId, x]));
  const report = sync?.last?.status === 'done' ? sync.last.report : null;
  const syncAt = sync?.last?.status === 'done' ? sync.last.finishedAt : null;
  const newTests = new Set(report?.tests.added.map((t) => t.id) ?? []);

  const info = fd.features.map<FeatureInfo>((f0) => {
    const f = f0 as FeatureX;
    const lc: LineCounts | null = codeBy.get(f.id)?.lines ?? null;
    const n = lc ? featureTotal(lc) : 0;
    const changes = changesOf(project, f, fd, testById, groupTitle, codeMap, report, syncAt);
    return {
      f,
      group: groupTitle(f.groupId),
      m: metrics(f, testById),
      code: lc && n ? { t: lc.tested, n } : null,
      changes,
      nChanges: changes.filter((c) => c.kind !== 'wanted').length,
      // A link to a gone test stays until a person unlinks or moves it: "Mark as reviewed" cannot clear it, so alone it does not keep the feature in the queue.
      toReview: changes.some((c) => c.kind !== 'gone') || f.reviewWanted,
    };
  });
  return {
    project, summary, fd, tests, testById, sync, codeMap, info, infoById: new Map(info.map((i) => [i.f.id, i])), linkedTo, groupTitle, newTests,
  };
}

export const codeTxt = (c: FeatureInfo['code']) => (c ? `${pct(c.t, c.n)}% of ${c.n.toLocaleString('en-US')} lines` : '–');

/* ------------------------------------------------------------------ */
/* Changes to review                                                   */
/* ------------------------------------------------------------------ */

const api = (project: string) => `/api/projects/${project}`;
const quiet = { quiet: true };
/** For "Keep all": the calls run one after the other, then every screen loads again. */
export async function runAll(fns: (() => Promise<unknown>)[]) {
  try {
    for (const fn of fns) await fn();
  } finally {
    reloadAll();
  }
}

function changesOf(
  project: string, f: FeatureX, fd: FeatureData, byId: Map<string, TestInfo>, groupTitle: (id: number | null) => string,
  codeMap: FeatureCodeMap | null, report: ChangeReport | null, syncAt: string | null,
): Change[] {
  const out: Change[] = [];
  const base = api(project);
  const revert = (kind: 'feature' | 'scope', id: number, ...fields: string[]) => () => mutate('POST', `${base}/revert`, { kind, id, fields }, quiet);
  const fieldText = (field: string, v: string | null) =>
    field === 'group' ? (v ? groupTitle(Number(v)) : 'No group') : field === 'priority' ? PRI_LABEL[v ?? ''] ?? v ?? '' : (v ?? '');

  // Fields of the feature.
  for (const field of f.aiFields) {
    const cur = field === 'roles' ? f.roles.join(', ') : field === 'group' ? groupTitle(f.groupId) : field === 'priority' ? PRI_LABEL[f.priority] : String((f as any)[field] ?? '');
    const has = !!f.before && field in f.before;
    const before = has ? fieldText(field, f.before![field]) : null;
    const canBack = has && !(field === 'title' && !before);
    out.push({
      key: `f:${field}`, sec: 'Feature', kind: before ? 'changed' : 'new', text: cur || '(empty)', before: before || null,
      ctx: `${FIELD_LABEL[field] ?? field} · ${before ? 'The AI changed this field.' : 'The AI filled this field.'}`,
      tab: field === 'roles' ? 'scopes' : 'scopes', keepLbl: 'Keep',
      keep: () => mutate('PATCH', `${base}/features/${f.id}`, { check: [field] }, quiet),
      ...(canBack ? { removeLbl: before ? 'Change back' : 'Clear', remove: revert('feature', f.id, field) } : {}),
    });
  }

  // Scopes.
  for (const s0 of f.scopes) {
    const s = s0 as ScopeX;
    if (!s.aiFields.length) continue;
    const b = s.before ?? {};
    const isNew = s.aiFields.includes('title') && !('title' in b);
    const backFields = s.aiFields.filter((k) => k in b && !(k === 'title' && !b[k]));
    out.push({
      key: `s:${s.id}`, sec: 'Scopes', kind: isNew ? 'new' : 'changed', text: s.title, before: 'title' in b ? (b.title ?? '') : null,
      ctx: `S-${s.id} · ${isNew ? 'The AI added this scope.' : `The AI changed: ${s.aiFields.map((k) => (FIELD_LABEL[k] ?? k).toLowerCase()).join(', ')}.`}`,
      tab: 'scopes', scopeId: s.id, keepLbl: 'Keep',
      keep: () => mutate('PATCH', `${base}/scopes/${s.id}`, { check: true }, quiet),
      ...(isNew
        ? { removeLbl: 'Remove scope', confirm: `Delete scope S-${s.id} “${s.title}” and its requirements? The AI will not add it again.`, remove: () => mutate('DELETE', `${base}/scopes/${s.id}`, {}, quiet) }
        : backFields.length
          ? { removeLbl: 'Change back', remove: revert('scope', s.id, ...backFields) }
          : {}),
    });
  }
  for (const s of f.scopes) {
    for (const i of s.requirements) {
      if (!i.aiDraft) continue;
      out.push(itemChange(base, i, 'Scope requirements', `S-${s.id}`, 'scopes', s.id));
    }
  }

  // Lists of the feature.
  for (const l of LISTS) for (const i of f[l.key] as FeatureItem[]) if (i.aiDraft) out.push(itemChange(base, i, l.label, '', 'details'));

  // Test links.
  const renames = new Map((report?.renames ?? []).map((r) => [r.from.id, r.to]));
  const changedTests = new Set((report?.tests.changed ?? []).map((t) => t.id));
  const syncNewer = !!syncAt && (!f.reviewedAt || syncAt > f.reviewedAt);
  for (const l of f.links) {
    const t = byId.get(l.testId);
    const where = l.scopeIds.length ? l.scopeIds.map((x) => `S-${x}`).join(', ') : 'the whole feature';
    const sid = l.scopeIds[0];
    if (l.missing) {
      const to = renames.get(l.testId);
      out.push({
        key: `l:${l.id}`, sec: 'Tests', kind: 'gone', text: l.title ?? l.testId, before: null,
        ctx: `${l.testId} → ${where} · The test is not in the repo now. It was deleted or renamed.${to ? ` It is likely ${to.id} now.` : ''}`,
        tab: 'scopes', scopeId: sid, keepLbl: to ? `Move to ${to.id}` : '',
        keep: to ? () => mutate('POST', `${base}/links/move-test`, { from: l.testId, to: to.id }, quiet) : undefined,
        removeLbl: 'Unlink', remove: () => mutate('DELETE', `${base}/links/${l.id}`, {}, quiet),
      });
    } else if (l.source === 'ai' && !l.checked) {
      out.push({
        key: `l:${l.id}`, sec: 'Tests', kind: 'new', text: t?.title ?? l.title ?? l.testId, before: null,
        ctx: `${l.testId} → ${where} · The AI linked this test.`, tab: 'scopes', scopeId: sid, keepLbl: 'Keep',
        keep: () => mutate('PATCH', `${base}/links/${l.id}`, { check: true }, quiet),
        removeLbl: 'Unlink', remove: () => mutate('DELETE', `${base}/links/${l.id}`, {}, quiet),
      });
    } else if (syncNewer && changedTests.has(l.testId)) {
      out.push({
        key: `t:${l.id}`, sec: 'Tests', kind: 'test', text: t?.title ?? l.title ?? l.testId, before: null,
        ctx: `${l.testId} → ${where} · The test code changed in the last sync. Check that it still checks the scope.`, tab: 'scopes', scopeId: sid, keepLbl: '',
      });
    }
  }

  // Screenshots and code.
  for (const sh of f.screenshots) {
    if (!sh.aiDraft) continue;
    out.push({
      key: `x:${sh.id}`, sec: 'Screenshots', kind: 'new', text: sh.caption || `Screenshot IMG-${sh.id}`, before: null, ctx: `IMG-${sh.id} · The AI added this screenshot.`,
      tab: 'shots', keepLbl: 'Keep', keep: () => mutate('PATCH', `${base}/screenshots/${sh.id}`, { check: true }, quiet),
      removeLbl: 'Remove', remove: () => mutate('DELETE', `${base}/screenshots/${sh.id}`, {}, quiet),
    });
  }
  for (const e of codeMap?.features.find((x) => x.featureId === f.id)?.entries ?? []) {
    if (e.source !== 'ai' || e.checked) continue;
    out.push({
      key: `c:${e.id}`, sec: 'Code', kind: 'new', text: e.function ? `${e.function}` : `${e.file} (whole file)`, before: null, ctx: `${e.file} · The AI put this code in the feature.`,
      tab: 'code', keepLbl: 'Keep', keep: () => mutate('PATCH', `${base}/feature-code/${e.id}`, { check: true }, quiet),
      removeLbl: 'Remove', remove: () => mutate('DELETE', `${base}/feature-code/${e.id}`, {}, quiet),
    });
  }
  if (!out.length && f.reviewWanted) {
    out.push({
      key: 'wanted', sec: 'Feature', kind: 'wanted', text: f.title, before: null, ctx: 'A person marked this feature as not reviewed. No AI change waits.',
      tab: 'scopes', keepLbl: '',
    });
  }
  void fd;
  return out;
}

function itemChange(base: string, i: FeatureItem, sec: string, prefix: string, tab: Change['tab'], scopeId?: number): Change {
  // The AI changes only its own draft items, so an item has no text of a person to change back to.
  return {
    key: `i:${i.id}`, sec, kind: 'new', text: i.text, before: null,
    ctx: `${prefix ? prefix + ' · ' : ''}The AI added this item.`,
    tab, scopeId, keepLbl: 'Keep',
    keep: () => mutate('PATCH', `${base}/items/${i.id}`, { check: true }, quiet),
    removeLbl: 'Remove', remove: () => mutate('DELETE', `${base}/items/${i.id}`, {}, quiet),
  };
}

export const KIND_LABEL: Record<Change['kind'], string> = { new: 'New', changed: 'Changed', test: 'Test changed', gone: 'Test gone', wanted: 'Review' };
export const KIND_TAG: Record<Change['kind'], string> = { new: 'tag-new', changed: 'tag-changed', test: 'tag-changed', gone: 'tag-fail', wanted: 'tag-ro' };

export const fmt = (n: number) => n.toLocaleString('en-US');
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
export const short = (c: string | null | undefined) => c?.slice(0, 7) ?? '';
