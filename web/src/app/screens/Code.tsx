import { useApi, type FileEntry, type View } from '../../api';
import { fmt, type Tracker } from '../data';
import { link, setQuery, useSticky, type Route } from '../route';
import { Bar, Card, IFile, IFolder, INext, Loading, Seg, SortTh } from '../ui';
import { codeNums, type LC } from './Overview';
import { Warnings } from './Warnings';
import { LibraryReview, useReviewData } from './LibraryReview';

type Sort = 'path' | 'unc' | 'pct' | 'lib' | 'marked';
const NAT: Record<Sort, 'ascending' | 'descending'> = { path: 'ascending', unc: 'descending', pct: 'ascending', lib: 'descending', marked: 'descending' };
export const VIEW_LABEL: Record<View, string> = { playwright: 'Playwright', cypress: 'Cypress', both: 'Both' };

interface Stats { run: number; mcov: number; setup: number; miss: number; lib: number; mlib: number; feat: number; unc: number; marked: number; pct: number; nfiles: number }
const stats = (l: LC): Stats => {
  const c = codeNums(l);
  return { ...c, unc: c.setup + c.miss, marked: c.mlib + c.mcov, pct: c.feat ? c.pct : 100, nfiles: 1 };
};
interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: { e: FileEntry; s: Stats; name: string }[]; s?: Stats }

/** File order of the tree as it shows now: the file page uses it for "Previous" and "Next". */
export let fileOrder: string[] = [];

/** The coverage view of the page: the asked one when the project has it, else the project's default. */
export function useView(t: Tracker, route: Route): View | null {
  const asked = route.q.get('view') as View | null;
  return asked && t.summary.views.includes(asked) ? asked : t.summary.view;
}

export function ViewSeg({ t, view }: { t: Tracker; view: View | null }) {
  if (t.summary.views.length < 2 || !view) return null;
  return <Seg label="Coverage from" value={view} onChange={(v) => setQuery({ view: v })} items={t.summary.views.map((v) => ({ key: v, label: VIEW_LABEL[v] }))} />;
}

export function CodeList({ t, route }: { t: Tracker; route: Route }) {
  const view = useView(t, route);
  const { data, error } = useApi<FileEntry[]>(view ? `/api/projects/${t.project}/files?view=${view}` : null);
  const [cq, setCq] = useSticky('code.q', '');
  const [hide, setHide] = useSticky('code.hide', false);
  const [sort, setSort] = useSticky<Sort>('code.sort', 'unc');
  const [rev, setRev] = useSticky('code.rev', false);
  const [exp, setExp] = useSticky<Record<string, boolean>>('code.exp', {});
  const review = useReviewData(t.project);
  const tab = route.q.get('tab') === 'decisions' ? 'decisions' : 'files';
  const tabs = (
    <div className="tabs" role="tablist">
      {([['files', 'Files'], ['decisions', 'AI decisions']] as const).map(([k, l]) => (
        <button key={k} className={`tab ${tab === k ? 'tab-on' : ''}`} role="tab" aria-selected={tab === k} onClick={() => setQuery({ tab: k === 'files' ? null : k })}>
          {l}{k === 'decisions' && review.count !== undefined && <span className="badge" style={{ marginLeft: 6 }}>{review.count}</span>}
        </button>
      ))}
    </div>
  );
  const head = view && (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 260 }}>
        <h1 className="h1">Code coverage</h1>
        <p className="muted" style={{ margin: 0 }}>
          Find the plugin code no test runs yet. From {view === 'both' ? 'the Playwright and the Cypress run together' : `the run “${t.summary.runs[view]?.label}”`}.
        </p>
      </div>
      <ViewSeg t={t} view={view} />
    </div>
  );
  if (view && tab === 'decisions') {
    return (
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {head}
        {tabs}
        <LibraryReview t={t} d={review} view={route.q.get('view')} />
      </main>
    );
  }
  if (!view) {
    return (
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 className="h1">Code coverage</h1>
        <div className="muted">There is no coverage run yet. Sync with the tests on to make one.</div>
      </main>
    );
  }
  if (!data) return <Loading error={error} />;
  const files = data.filter((e) => e.lang === 'php' && e.measured).map((e) => ({ e, s: stats(e.lines as LC), name: e.path.split('/').pop()! }));
  const tot = files.reduce<Stats>((a, { s }) => {
    for (const k of Object.keys(a) as (keyof Stats)[]) a[k] += s[k];
    return a;
  }, { run: 0, mcov: 0, setup: 0, miss: 0, lib: 0, mlib: 0, feat: 0, unc: 0, marked: 0, pct: 0, nfiles: 0 });
  const totPct = tot.feat ? Math.round(((tot.run + tot.mcov) / tot.feat) * 100) : 0;
  const ql = cq.trim().toLowerCase();
  const list = files.filter((x) => (!ql || x.e.path.toLowerCase().includes(ql)) && (!hide || x.s.unc > 0));

  // Folder tree: folders first, then files. Each level is sorted by the chosen column. Folder numbers add up their files.
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const x of list) {
    const parts = x.e.path.split('/');
    let n = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const path = parts.slice(0, k + 1).join('/');
      if (!n.dirs.has(parts[k])) n.dirs.set(parts[k], { name: parts[k], path, dirs: new Map(), files: [] });
      n = n.dirs.get(parts[k])!;
    }
    n.files.push(x);
  }
  const agg = (d: Dir): Stats => {
    const a: Stats = { run: 0, mcov: 0, setup: 0, miss: 0, lib: 0, mlib: 0, feat: 0, unc: 0, marked: 0, pct: 0, nfiles: 0 };
    for (const s of [...[...d.dirs.values()].map(agg), ...d.files.map((f) => f.s)]) for (const k of Object.keys(a) as (keyof Stats)[]) if (k !== 'pct') a[k] += s[k];
    a.pct = a.feat ? Math.round(((a.run + a.mcov) / a.feat) * 100) : 100;
    d.s = a;
    return a;
  };
  agg(root);
  const cmp0 = (a: { name: string; s?: Stats }, b: { name: string; s?: Stats }) => {
    const A = a.s!, B = b.s!;
    return sort === 'path' ? a.name.localeCompare(b.name)
      : sort === 'pct' ? A.pct - B.pct || B.unc - A.unc || a.name.localeCompare(b.name)
      : sort === 'lib' ? B.lib - A.lib || a.name.localeCompare(b.name)
      : sort === 'marked' ? B.marked - A.marked || a.name.localeCompare(b.name)
      : B.unc - A.unc || a.name.localeCompare(b.name);
  };
  const cmp = (a: { name: string; s?: Stats }, b: { name: string; s?: Stats }) => (rev ? -cmp0(a, b) : cmp0(a, b));
  const isOpen = (d: Dir, depth: number) => (ql ? true : exp[d.path] ?? depth === 0);
  const rows: React.ReactNode[] = [];
  const allDirs: string[] = [];
  const order: string[] = [];
  const cells = (s: Stats) => {
    const w = (n: number) => `${s.feat ? (n / s.feat) * 100 : 0}%`;
    return (
      <>
        <div role="cell" className={`num ${s.unc ? '' : 'faint'}`} style={{ fontWeight: 600 }}>{fmt(s.unc)}</div>
        <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="bar bar-sm stack" style={{ flex: 1 }} role="img" aria-label={`${s.run} run, ${s.mcov} marked covered, ${s.setup} only in setup, ${s.miss} never run`}>
            <div className="fill c-good" style={{ width: w(s.run) }} /><div className="fill c-mcov" style={{ width: w(s.mcov) }} />
            <div className="fill c-skip" style={{ width: w(s.setup) }} /><div className="fill c-fail" style={{ width: w(s.miss) }} />
          </div>
          <span className="num" style={{ fontSize: 13, width: 40 }}>{s.feat ? `${s.pct}%` : '–'}</span>
        </div>
        <div role="cell" className="num" style={{ fontSize: 13 }}>{fmt(s.lib)}</div>
        <div role="cell" className="num" style={{ fontSize: 13 }}>{s.marked ? fmt(s.marked) : '–'}</div>
      </>
    );
  };
  const walk = (n: Dir, depth: number, visible: boolean) => {
    for (const d of [...n.dirs.values()].sort(cmp)) {
      allDirs.push(d.path);
      const open = isOpen(d, depth);
      if (visible) {
        rows.push(
          <div key={`d:${d.path}`} className="gr cols-cf fl-row tr-dir" role="row" aria-level={depth + 1}>
            <div role="cell" style={{ minWidth: 0, paddingLeft: depth * 20 }}>
              <button
                className="rowbtn tree-item tree-dir" aria-expanded={open} onClick={() => setExp({ ...exp, [d.path]: !open })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' && !open) (e.preventDefault(), setExp({ ...exp, [d.path]: true }));
                  else if (e.key === 'ArrowLeft' && open) (e.preventDefault(), setExp({ ...exp, [d.path]: false }));
                }}
              >
                <span className="tree-chev" style={{ transform: open ? 'rotate(90deg)' : 'none', display: 'inline-flex' }}><INext s={12} /></span>
                <span className="tree-ic"><IFolder s={16} /></span>
                <span className="mono">{d.name}</span>
                <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>{d.s!.nfiles} {d.s!.nfiles === 1 ? 'file' : 'files'}</span>
              </button>
            </div>
            {cells(d.s!)}
          </div>,
        );
      }
      walk(d, depth + 1, visible && open);
    }
    for (const f of [...n.files].sort((a, b) => cmp(a, b))) {
      order.push(f.e.path);
      if (!visible) continue;
      rows.push(
        <div key={f.e.path} className="gr cols-cf fl-row" role="row" aria-level={depth + 1}>
          <div role="cell" style={{ minWidth: 0, paddingLeft: depth * 20 + 20 }}>
            <a className="rowbtn tree-item mono" style={{ fontSize: 13, textDecoration: 'none' }} href={link(t.project, 'codefile', null, { path: f.e.path, view: route.q.get('view') })}>
              <span className="tree-ic"><IFile s={15} /></span><span style={{ overflowWrap: 'anywhere' }}>{f.name}</span>
            </a>
          </div>
          {cells(f.s)}
        </div>,
      );
    }
  };
  walk(root, 0, true);
  fileOrder = order;
  const onSort = (k: Sort) => (setRev(sort === k ? !rev : false), setSort(k));
  const tw = (n: number) => [n, ''] as [number, string];
  void tw;
  const js = data.filter((e) => e.lang === 'js').length;

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {head}
      {tabs}
      <Warnings p={t.summary} parse={false} />
      <div className="grid3">
        <Card className="q-card">
          <div className="q-q">Feature code run by tests</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{totPct}%</span><span className="q-sub">{fmt(tot.run + tot.mcov)} of {fmt(tot.feat)} feature lines</span></div>
          <Bar total={tot.feat} label={`${fmt(tot.run)} run by tests, ${fmt(tot.mcov)} marked covered, ${fmt(tot.setup)} only in setup, ${fmt(tot.miss)} never run`} parts={[[tot.run, 'c-good'], [tot.mcov, 'c-mcov'], [tot.setup, 'c-skip'], [tot.miss, 'c-fail']]} />
          <div className="legend">
            <span><i className="sw c-good" />{fmt(tot.run)} Run by tests</span><span><i className="sw c-mcov" />{fmt(tot.mcov)} Marked covered</span>
            <span><i className="sw c-skip" />{fmt(tot.setup)} Only in setup</span><span><i className="sw c-fail" />{fmt(tot.miss)} Never run</span>
          </div>
        </Card>
        <Card className="q-card">
          <div className="q-q">Uncovered feature lines</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{fmt(tot.unc)}</span><span className="q-sub">in {files.filter((x) => x.s.unc > 0).length} files</span></div>
          <div className="q-sub">Never run, or run only while a test sets up. Library code is left out.</div>
          <div><button className="linkbtn" onClick={() => (setSort('unc'), setRev(false), setHide(true))}>Show the files with the most first</button></div>
        </Card>
        <Card className="q-card">
          <div className="q-q">Marked by hand</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{fmt(tot.marked)}</span><span className="q-sub">lines</span></div>
          <div className="q-sub">{fmt(tot.mlib)} as library, {fmt(tot.mcov)} as covered. Marks count in these totals. Open a file to add or remove them.</div>
        </Card>
      </div>
      <div className="toolbar" style={{ gap: 10 }}>
        <label className="sr" htmlFor="cq">Search files</label>
        <input id="cq" className="input" style={{ flex: '1 1 240px', maxWidth: 360 }} placeholder="Search file paths" value={cq} onChange={(e) => setCq(e.target.value)} />
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13, minHeight: 38 }}><input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Hide fully covered files</label>
        {(cq.trim() || hide) && <button className="btn btn-ghost btn-sm" onClick={() => (setCq(''), setHide(false))}>Clear filters</button>}
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => setExp(Object.fromEntries(allDirs.map((d) => [d, true])))}>Expand all</button>
        <button className="btn btn-sm" onClick={() => setExp(Object.fromEntries(allDirs.map((d) => [d, false])))}>Collapse all</button>
      </div>
      <div className="card">
        <div className="table-box">
          <div className="gt gt-cf" role="treegrid" aria-label="PHP files by folder">
            <div className="gr gh cols-cf" role="row">
              <SortTh k="path" label="Name" sort={sort} rev={rev} natural={NAT.path} onSort={onSort} />
              <SortTh k="unc" label="Uncovered lines" sort={sort} rev={rev} natural={NAT.unc} onSort={onSort} className="num" />
              <SortTh k="pct" label="Feature lines run" sort={sort} rev={rev} natural={NAT.pct} onSort={onSort} />
              <SortTh k="lib" label="Library lines" sort={sort} rev={rev} natural={NAT.lib} onSort={onSort} className="num" />
              <SortTh k="marked" label="Marked" sort={sort} rev={rev} natural={NAT.marked} onSort={onSort} className="num" />
            </div>
            {rows}
            {!list.length && (
              <div style={{ padding: '24px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 13 }}>No file matches these filters.</span>
                <button className="btn btn-sm" onClick={() => (setCq(''), setHide(false))}>Clear filters</button>
              </div>
            )}
          </div>
        </div>
        <div className="pager">
          <span className="muted" style={{ fontSize: 13 }} role="status">
            {list.length} {list.length === 1 ? 'file' : 'files'} in {allDirs.length} {allDirs.length === 1 ? 'folder' : 'folders'}{ql ? ', all folders opened to show matches' : ''}
          </span>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        {js ? `${js} JavaScript files are not measured yet, so they are not listed. ` : ''}
        {t.summary.neverLoadedFiles > 0 && `${t.summary.neverLoadedFiles} PHP files were never loaded by any request: their lines count as never run. `}
        Library code = lines that run on plain page loads that test nothing (home page, REST index, admin dashboard).
      </p>
    </main>
  );
}
