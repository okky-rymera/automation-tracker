import { useEffect, useState } from 'react';
import { mutate } from '../../api';
import { codeTxt, PRI_LABEL, type FeatureInfo, type Tracker } from '../data';
import { go, link, readRoute, useSticky } from '../route';
import { AddRow, Bar, Dialog, InlineText, IPlus, ITrash, Pager, SortTh, useAct } from '../ui';

type Sort = 'id' | 'grp' | 'pri' | 'gaps' | 'code' | 'review';
const NAT: Record<Sort, 'ascending' | 'descending'> = { id: 'ascending', grp: 'ascending', pri: 'descending', gaps: 'descending', code: 'ascending', review: 'descending' };
const PRI: Record<string, number> = { high: 0, medium: 1, low: 2, '': 3 };

/** The order of the list as it shows now: the feature page uses it for "Previous" and "Next". */
export let listOrder: number[] = [];

export function FeatureList({ t }: { t: Tracker }) {
  const p = t.project;
  const act = useAct();
  const [fq, setFq] = useSticky('fl.q', '');
  const [grp, setGrp] = useSticky('fl.grp', 'all');
  const [pri, setPri] = useSticky('fl.pri', 'all');
  const [flt, setFlt] = useSticky('fl.status', 'all');
  const [sort, setSort] = useSticky<Sort>('fl.sort', 'id');
  const [rev, setRev] = useSticky('fl.rev', false);
  const [per, setPer] = useSticky('fl.per', 25);
  const [page, setPage] = useSticky('fl.page', 1);
  const [groups, setGroups] = useState(false);
  // Links from the overview set the filter and the sort.
  useEffect(() => {
    const q = readRoute().q;
    if (q.get('status')) (setFlt(q.get('status')!), setGrp('all'), setPri('all'), setFq(''), setPage(1));
    if (q.get('sort')) (setSort(q.get('sort') as Sort), setRev(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ql = fq.trim().toLowerCase();
  const gaps = (i: FeatureInfo) => i.m.total - i.m.ok;
  const codeOf = (i: FeatureInfo) => (i.code ? i.code.t / i.code.n : 1);
  const all = t.info.filter(
    (i) =>
      (flt === 'all' || (flt === 'review' && i.toReview) || (flt === 'gaps' && gaps(i) > 0)) &&
      (grp === 'all' || String(i.f.groupId ?? 'none') === grp) &&
      (pri === 'all' || i.f.priority === (pri === 'none' ? '' : pri)) &&
      (!ql ||
        `f-${i.f.id}` === ql ||
        i.f.title.toLowerCase().includes(ql) ||
        i.f.roles.some((r) => r.toLowerCase().includes(ql)) ||
        i.f.scopes.some((s) => s.title.toLowerCase().includes(ql) || `s-${s.id}` === ql)),
  );
  all.sort((a, b) =>
    sort === 'gaps' ? gaps(b) - gaps(a) || a.f.id - b.f.id
    : sort === 'review' ? b.changes.length - a.changes.length || a.f.id - b.f.id
    : sort === 'pri' ? PRI[a.f.priority] - PRI[b.f.priority] || a.f.id - b.f.id
    : sort === 'code' ? codeOf(a) - codeOf(b) || a.f.id - b.f.id
    : sort === 'grp' ? a.group.localeCompare(b.group) || a.f.id - b.f.id
    : a.f.id - b.f.id,
  );
  if (rev) all.reverse();
  listOrder = all.map((i) => i.f.id);
  const pages = Math.max(1, Math.ceil(all.length / per));
  const pg = Math.min(page, pages);
  const rows = all.slice((pg - 1) * per, pg * per);
  const onSort = (k: Sort) => (setRev(sort === k ? !rev : false), setSort(k), setPage(1));
  const has = !!fq.trim() || flt !== 'all' || grp !== 'all' || pri !== 'all';
  const clear = () => (setFq(''), setFlt('all'), setGrp('all'), setPri('all'), setPage(1));
  const addFeature = () =>
    act(async () => {
      const r = await mutate<{ id: number }>('POST', `/api/projects/${p}/features`, { title: 'New feature' });
      go(link(p, 'feature', r.id, { focus: 'title' }));
    }, 'Feature added. Type its title.');

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="h1" style={{ flex: 1 }}>Features</h1>
        <button className="btn" onClick={() => setGroups(true)}>Feature groups</button>
        <a className="btn" href={link(p, 'map')} style={{ color: 'var(--ink)', textDecoration: 'none' }}>Map with AI</a>
        <button className="btn btn-primary" onClick={addFeature}><IPlus />Add feature</button>
      </div>
      <div className="toolbar" style={{ gap: 10 }}>
        <label className="sr" htmlFor="fq">Search features</label>
        <input id="fq" className="input" style={{ flex: '1 1 240px', maxWidth: 360 }} placeholder="Search title, scope, role or ID" value={fq} onChange={(e) => (setFq(e.target.value), setPage(1))} />
        <label className="sr" htmlFor="fgrp">Group</label>
        <select id="fgrp" className="input sel" value={grp} onChange={(e) => (setGrp(e.target.value), setPage(1))}>
          <option value="all">All groups</option>
          {t.fd.groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          <option value="none">No group</option>
        </select>
        <label className="sr" htmlFor="fpri">Priority</label>
        <select id="fpri" className="input sel" value={pri} onChange={(e) => (setPri(e.target.value), setPage(1))}>
          <option value="all">All priorities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="none">No priority</option>
        </select>
        <label className="sr" htmlFor="fst">Status</label>
        <select id="fst" className="input sel" value={flt} onChange={(e) => (setFlt(e.target.value), setPage(1))}>
          <option value="all">Any status</option><option value="review">To review</option><option value="gaps">Has scopes to cover</option>
        </select>
        {has && <button className="btn btn-ghost btn-sm" onClick={clear}>Clear filters</button>}
      </div>
      <div className="card">
        <div className="table-box">
          <div className="gt gt-fl" role="table" aria-label="Features">
            <div className="gr gh cols-fl" role="row">
              <SortTh k="id" label="Feature" sort={sort} rev={rev} natural={NAT.id} onSort={onSort} />
              <SortTh k="grp" label="Group" sort={sort} rev={rev} natural={NAT.grp} onSort={onSort} />
              <SortTh k="pri" label="Priority" sort={sort} rev={rev} natural={NAT.pri} onSort={onSort} />
              <SortTh k="gaps" label="Scopes covered" sort={sort} rev={rev} natural={NAT.gaps} onSort={onSort} />
              <SortTh k="code" label="Code run by tests" sort={sort} rev={rev} natural={NAT.code} onSort={onSort} />
              <SortTh k="review" label="To review" sort={sort} rev={rev} natural={NAT.review} onSort={onSort} />
            </div>
            {rows.map((i) => (
              <div className="gr cols-fl fl-row" role="row" key={i.f.id}>
                <div role="cell"><a className="rowbtn" href={link(p, 'feature', i.f.id)} style={{ textDecoration: 'none' }}><span className="mono faint">F-{i.f.id}</span> {i.f.title}</a></div>
                <div role="cell" style={{ fontSize: 13 }}>{i.group}</div>
                <div role="cell" style={{ fontSize: 13 }}>{i.f.priority ? PRI_LABEL[i.f.priority] : '–'}</div>
                <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Bar small style={{ flex: 1 }} total={i.m.total} label={`${i.m.ok} of ${i.m.total} scopes covered by Playwright`} parts={[[i.m.ok, 'c-good']]} />
                  <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{i.m.ok}/{i.m.total}</span>
                </div>
                <div role="cell" style={{ fontSize: 13 }}>{codeTxt(i.code)}</div>
                <div role="cell">
                  {i.toReview ? (
                    <a className="tag tag-changed tag-btn" style={{ textDecoration: 'none' }} href={link(p, 'changes', null, { f: i.f.id })}>{i.changes.length || 1} to review</a>
                  ) : (
                    <span className="faint" style={{ fontSize: 13 }}>Nothing new</span>
                  )}
                </div>
              </div>
            ))}
            {!all.length && (
              <div style={{ padding: '24px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 13 }}>No feature matches these filters.</span>
                <button className="btn btn-sm" onClick={clear}>Clear filters</button>
              </div>
            )}
          </div>
        </div>
        <Pager
          page={pg} pages={pages} onPage={(n) => (setPage(Math.max(1, Math.min(pages, n))), window.scrollTo(0, 0))} per={per} onPer={(n) => (setPer(n), setPage(1))}
          text={all.length ? `Showing ${(pg - 1) * per + 1}–${Math.min(pg * per, all.length)} of ${all.length} ${all.length === 1 ? 'feature' : 'features'}` : 'No features'}
        />
      </div>
      {groups && <GroupsDialog t={t} onClose={() => setGroups(false)} />}
    </main>
  );
}

/** Add, rename and delete feature groups. A delete keeps the features, with no group. */
function GroupsDialog({ t, onClose }: { t: Tracker; onClose: () => void }) {
  const act = useAct();
  const [adding, setAdding] = useState(false);
  const base = `/api/projects/${t.project}/groups`;
  return (
    <Dialog title="Feature groups" sub="Groups sort the feature list. Click a name to rename it." onClose={onClose} foot={<button className="btn" onClick={onClose}>Done</button>}>
      {t.fd.groups.map((g) => {
        const n = t.info.filter((i) => i.f.groupId === g.id).length;
        return (
          <div key={g.id} className="lc-row" style={{ alignItems: 'center' }}>
            <span className="lc-text"><InlineText value={g.title} label="Group name" className="ie-item" required="A group needs a name. The old name is back." onSave={(title) => act(() => mutate('PATCH', `${base}/${g.id}`, { title }), 'Group renamed')} /></span>
            <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{n} {n === 1 ? 'feature' : 'features'}</span>
            <span className="row-acts">
              <button
                className="icon-btn icon-danger" aria-label={`Delete group ${g.title}`} title="Delete group"
                onClick={() => confirm(`Delete the group “${g.title}”? Its ${n} features stay, with no group.`) && act(() => mutate('DELETE', `${base}/${g.id}`), 'Group deleted')}
              ><ITrash s={16} /></button>
            </span>
          </div>
        );
      })}
      {!t.fd.groups.length && !adding && <div className="lc-empty">No group yet.</div>}
      {adding ? (
        <AddRow placeholder="New group name. Enter adds it." onAdd={async (title) => void (await act(() => mutate('POST', base, { title }), 'Group added'))} onClose={() => setAdding(false)} className="lc-row dl-new" />
      ) : (
        <div style={{ padding: 8 }}><button className="btn btn-ghost btn-sm add-btn" onClick={() => setAdding(true)}><IPlus />Add group</button></div>
      )}
    </Dialog>
  );
}
