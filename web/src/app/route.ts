import { useEffect, useState } from 'react';

/**
 * Hash routes of the app:
 *   #/                               projects
 *   #/p/<project>                    overview
 *   #/p/<project>/features           feature list
 *   #/p/<project>/features/<id>      one feature (?tab=scopes|details|code|shots&scope=<id>)
 *   #/p/<project>/changes            changes to review (?f=<feature id>)
 *   #/p/<project>/tests              tests (?show=none|all|skipped|failed|new)
 *   #/p/<project>/tests/<test id>    one test
 *   #/p/<project>/code               code coverage (?view=playwright|cypress|both)
 *   #/p/<project>/code/file          one file (?path=<repo path>&view=…)
 *   #/p/<project>/sync               sync report and AI updates
 *   #/p/<project>/map                map features with AI
 * Any route can carry ?back=<hash>&bl=<label>: the "Back to …" button.
 */
export type Screen = 'projects' | 'overview' | 'flist' | 'feature' | 'changes' | 'tests' | 'test' | 'code' | 'codefile' | 'sync' | 'map' | 'settings';

export interface Route {
  project: string | null;
  screen: Screen;
  /** Feature ID or test ID. */
  id: string | null;
  q: URLSearchParams;
}

const SCREENS: Record<string, Screen> = { features: 'flist', changes: 'changes', tests: 'tests', code: 'code', sync: 'sync', map: 'map', settings: 'settings' };

export function readRoute(hash = location.hash): Route {
  const [pathPart, query = ''] = hash.replace(/^#/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  if (parts[0] !== 'p' || !parts[1]) return { project: null, screen: 'projects', id: null, q };
  const project = parts[1];
  const sel = q.get('sel');
  // Links of the old screens: #/p/x/features?sel=f:3, #/p/x/playwright?sel=PW-…, #/p/x/cypress?sel=CY-…
  if (parts[2] === 'playwright' || parts[2] === 'cypress') {
    if (sel && /^(PW|CY)-/.test(sel)) return { project, screen: 'test', id: sel, q: new URLSearchParams() };
    if (q.get('pane') === 'code') return { project, screen: 'code', id: null, q: new URLSearchParams({ view: parts[2] }) };
    return { project, screen: 'tests', id: null, q: new URLSearchParams() };
  }
  if (parts[2] === 'features' && !parts[3] && sel?.startsWith('f:')) return { project, screen: 'feature', id: sel.slice(2), q: new URLSearchParams() };
  if (parts[2] === 'features' && parts[3]) return { project, screen: 'feature', id: parts[3], q };
  if (parts[2] === 'tests' && parts[3]) return { project, screen: 'test', id: parts[3], q };
  if (parts[2] === 'code' && parts[3] === 'file') return { project, screen: 'codefile', id: null, q };
  return { project, screen: SCREENS[parts[2]] ?? 'overview', id: null, q };
}

const PATHS: Record<Screen, string> = {
  projects: '', overview: '', flist: 'features', feature: 'features', changes: 'changes', tests: 'tests', test: 'tests', code: 'code', codefile: 'code/file', sync: 'sync', map: 'map', settings: 'settings',
};

/** Link to a screen. q: query values (empty values are left out). */
export function link(project: string | null, screen: Screen, id?: string | number | null, q: Record<string, string | number | null | undefined> = {}): string {
  if (!project || screen === 'projects') return '#/';
  const path = [PATHS[screen], id != null && id !== '' ? encodeURIComponent(String(id)) : ''].filter(Boolean).join('/');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `#/p/${encodeURIComponent(project)}${path ? '/' + path : ''}${s ? '?' + s : ''}`;
}

/** The same link, with a "Back to …" button that comes back to the page that is open now. */
export function withBack(href: string, label: string, back = location.hash || '#/'): string {
  return `${href}${href.includes('?') ? '&' : '?'}${new URLSearchParams({ back, bl: label }).toString()}`;
}

export const go = (href: string) => {
  location.hash = href.replace(/^#/, '');
};

/** Replaces the query of the current route (filters, open tab). No new history entry. */
export function setQuery(values: Record<string, string | number | null | undefined>) {
  const [pathPart, query = ''] = location.hash.split('?');
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, String(v));
  }
  const s = q.toString();
  history.replaceState(null, '', `${pathPart || '#/'}${s ? '?' + s : ''}`);
  dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => readRoute());
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** UI state that stays while the app is open (filters, sort, open folders), also when a person leaves the page and comes back. */
const sticky = new Map<string, unknown>();
export function useSticky<T>(key: string, initial: T): [T, (v: T | ((old: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (sticky.has(key) ? (sticky.get(key) as T) : initial));
  const set = (x: T | ((old: T) => T)) =>
    setV((old) => {
      const next = typeof x === 'function' ? (x as (o: T) => T)(old) : x;
      sticky.set(key, next);
      return next;
    });
  return [v, set];
}
/** Forget the saved value of one key, so the next screen that uses it starts from its initial value. */
export function clearSticky(key: string) {
  sticky.delete(key);
}
