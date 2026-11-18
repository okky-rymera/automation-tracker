import { useEffect, useState } from 'react';

/** Hash routes: #/  and  #/p/<project>/<tab>?sel=<item> */
export interface Route {
  project: string | null;
  tab: 'code' | 'features' | 'playwright' | 'cypress';
  sel: string | null;
}

function read(): Route {
  const [pathPart, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'p' && parts[1]) {
    const tab = (['code', 'features', 'playwright', 'cypress'].includes(parts[2]) ? parts[2] : 'code') as Route['tab'];
    return { project: decodeURIComponent(parts[1]), tab, sel: params.get('sel') };
  }
  return { project: null, tab: 'code', sel: null };
}

export function href(r: Partial<Route>): string {
  if (!r.project) return '#/';
  const q = r.sel ? '?sel=' + encodeURIComponent(r.sel) : '';
  return `#/p/${encodeURIComponent(r.project)}/${r.tab ?? 'code'}${q}`;
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
