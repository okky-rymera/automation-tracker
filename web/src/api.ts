import { useEffect, useState } from 'react';

export type LineState = 'library' | 'tested' | 'setup' | 'background' | 'never';
export type FunctionState = LineState | 'unknown';

/** Runnable PHP lines by state. runByTests counts library lines too. */
export type LineCounts = Record<LineState | 'runnable' | 'runByTests', number>;
export type FunctionCounts = Record<FunctionState | 'total', number>;

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  coverageLabel: string | null;
  coverageFreshness: { runCommit: string | null; currentCommit: string | null; stale: boolean | null; reasons: string[] } | null;
  files: { total: number; php: number; js: number };
  lines: LineCounts;
  functions: FunctionCounts;
  neverLoadedFiles: number;
  uncountedFiles: number;
  playwright: { tests: number; files: number; skipped: number; runTests: number; parseErrors: { file: string; error: string }[] };
  cypress: { scenarios: number; files: number };
  features: {
    features: number;
    withPlaywright: number;
    withCypress: number;
    scopes: number;
    scopesBoth: number;
    unlinkedTests: { playwright: number; cypress: number };
  };
}

export type Framework = 'playwright' | 'cypress';

export interface FeatureLink {
  id: number;
  testId: string;
  /** Scopes of the feature that this test checks (none = the feature in general). */
  scopeIds: number[];
  /** manual = a person, ai = the feature-mapping skill. */
  source: 'manual' | 'ai';
  /** A person checked this AI link ("Mark as checked"). */
  checked: boolean;
  framework: Framework;
  title: string | null;
  file: string | null;
  /** True when the test is not in the repo now (deleted or renamed). */
  missing: boolean;
}

export interface Scope {
  id: number;
  title: string;
  description: string;
  sort: number;
  /** Fields the skill wrote that no person checked yet. */
  aiFields: string[];
  aiDraft: boolean;
}

/** One sentence in a feature list (rules, out of scope, where, open questions). */
export interface FeatureItem {
  id: number;
  text: string;
  aiDraft: boolean;
}

export type ItemField = 'rules' | 'outOfScope' | 'where' | 'questions';
export type LabelField = 'roles' | 'needs';
/** API kind names of the list and label fields. */
export const ITEM_KIND: Record<ItemField, string> = { rules: 'rule', outOfScope: 'out_of_scope', where: 'where', questions: 'question' };
export const LABEL_KIND: Record<LabelField, string> = { roles: 'role', needs: 'needs' };

export interface Feature extends Record<ItemField, FeatureItem[]>, Record<LabelField, string[]> {
  id: number;
  groupId: number | null;
  title: string;
  description: string;
  priority: '' | 'high' | 'medium' | 'low';
  sort: number;
  /** Fields (title, description, priority, group) the skill wrote that no person checked yet. */
  aiFields: string[];
  aiDraft: boolean;
  scopes: Scope[];
  links: FeatureLink[];
}

export interface FeatureGroup {
  id: number;
  title: string;
  description: string;
  sort: number;
}

export interface FeatureData {
  groups: FeatureGroup[];
  features: Feature[];
  /** Label values in use in the project, most used first. */
  labels: Record<LabelField, { value: string; count: number }[]>;
  unlinked: Record<Framework, number>;
  tests: Record<Framework, number>;
  /** Units the feature-mapping skill processed. */
  processed: { kind: string; status: string; count: number }[];
}

export interface FeatureCode {
  linkedRunTests: number;
  functions: { file: string; name: string; start: number; end: number; state: FunctionState; lines: Record<LineState, number>; tests: string[] }[];
}

export interface FileEntry {
  path: string;
  lang: 'php' | 'js';
  measured: boolean;
  loaded: boolean;
  uncounted: boolean;
  lines: LineCounts;
  functions: FunctionCounts;
}

export interface FileDetail {
  path: string;
  source: string;
  measured: boolean;
  loaded: boolean;
  functions: {
    name: string;
    start: number;
    end: number;
    state: FunctionState;
    lines: Record<LineState, number>;
    tests: { id: string; title: string; file: string }[];
  }[];
  lines: Record<LineState | 'runByTests', number[]>;
}

export interface PlaywrightTest {
  id: string;
  file: string;
  describes: string[];
  title: string;
  line: number;
  tags: string[];
  skipped: boolean;
  parametrized: boolean;
  steps: { title: string; depth: number }[];
  run: { runId: string; title: string; status: string; functions: number }[];
}

export interface CypressScenario {
  id: string;
  file: string;
  feature: string;
  featureDescription: string;
  keyword: string;
  title: string;
  line: number;
  rule: string | null;
  tags: string[];
  steps: { keyword: string; text: string; background: boolean }[];
  examples: number;
  parseError?: string;
}

const inflight = new Map<string, { at: number; promise: Promise<unknown> }>();

/** One request per URL: parts of a page that ask within 2 seconds share it. */
function getJson(url: string): Promise<unknown> {
  const hit = inflight.get(url);
  if (hit && Date.now() - hit.at < 2000) return hit.promise;
  const promise = fetch(url).then((r) =>
    r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error ?? r.statusText))),
  );
  inflight.set(url, { at: Date.now(), promise });
  promise.catch(() => inflight.delete(url));
  return promise;
}

// Each change bumps this number; every open view then loads its data again.
let version = 0;
const listeners = new Set<() => void>();

/**
 * Sends a change to the API (POST, PATCH or DELETE with a JSON body).
 * On success, all views load their data again. Throws the API error text.
 */
export async function mutate<T = unknown>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  inflight.clear();
  version++;
  listeners.forEach((f) => f());
  if (!r.ok) throw new Error(out.error ?? r.statusText);
  return out as T;
}

/** Fetches JSON from the local API. Returns null while loading. After a change it keeps the old data until the new data comes. */
export function useApi<T>(url: string | null): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null; url: string | null }>({ data: null, error: null, url: null });
  const [v, setV] = useState(version);
  useEffect(() => {
    const on = () => setV(version);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState((s) => (s.url === url ? s : { data: null, error: null, url }));
    getJson(url)
      .then((data) => live && setState({ data: data as T, error: null, url }))
      .catch((e) => live && setState({ data: null, error: String(e.message ?? e), url }));
    return () => {
      live = false;
    };
  }, [url, v]);
  return state.url === url ? state : { data: null, error: null };
}

export const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** Feature lines = runnable lines that are not library code. */
export const featureTotal = (c: LineCounts) => c.runnable - c.library;
/** Share of feature lines run by tests (library removed). */
export const featurePct = (c: LineCounts) => pct(c.tested, featureTotal(c));
/** Share of all runnable lines run by tests (library included). */
export const allPct = (c: LineCounts) => pct(c.runByTests, c.runnable);
