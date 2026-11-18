import { useEffect, useState } from 'react';

/**
 * Hash routes: #/  and  #/p/<project>/<tab>?pane=code&sel=<item>
 * Each tab has two panes: its list (tests, scenarios or features) and its code coverage.
 */
export type Tab = 'features' | 'playwright' | 'cypress';
export type Pane = 'list' | 'code';
export interface Route {
  project: string | null;
  tab: Tab;
  pane: Pane;
  sel: string | null;
}

const TABS: Tab[] = ['features', 'playwright', 'cypress'];

function read(): Route {
  const [pathPart, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'p' && parts[1]) {
    // Old links to the "Code coverage" tab: a file opens in "Code by feature"; a folder ("dir:…") opens in the Playwright code list.
    if (parts[2] === 'code') {
      const sel = params.get('sel');
      return { project: decodeURIComponent(parts[1]), tab: sel?.startsWith('dir:') ? 'playwright' : 'features', pane: 'code', sel };
    }
    const tab = (TABS.includes(parts[2] as Tab) ? parts[2] : 'features') as Tab;
    return { project: decodeURIComponent(parts[1]), tab, pane: params.get('pane') === 'code' ? 'code' : 'list', sel: params.get('sel') };
  }
  return { project: null, tab: 'features', pane: 'list', sel: null };
}

/** Link to a page. */
export function href(r: Partial<Route>): string {
  if (!r.project) return '#/';
  const q = new URLSearchParams();
  if (r.pane === 'code') q.set('pane', 'code');
  if (r.sel) q.set('sel', r.sel);
  const qs = q.toString();
  return `#/p/${encodeURIComponent(r.project)}/${r.tab ?? 'features'}${qs ? '?' + qs : ''}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}
