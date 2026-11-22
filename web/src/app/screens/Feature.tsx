import { useEffect, useRef, useState } from 'react';
import { featureTotal, mutate, pct, screenshotUrl, type CodeEntry, type FeatureItem, type FeatureLink, type ItemField, type Screenshot } from '../../api';
import { KIND_LABEL, LISTS, PRI_LABEL, ST_LABEL, ST_TAG, scopeLinks, scopeStatus, type FeatureInfo, type FeatureX, type ScopeX, type Tracker } from '../data';
import { go, link, setQuery, withBack, type Route } from '../route';
import { AddRow, Dialog, IdBtn, InlineText, INext, IPlus, IPrev, ITrash, IX, Menu, Picker, Seg, useAct, type PickRow } from '../ui';
import { listOrder } from './FeatureList';

const ITEM_KIND: Record<ItemField, string> = { requirements: 'requirement', notes: 'note', outOfScope: 'out_of_scope', where: 'where', questions: 'question' };
type Tab = 'scopes' | 'details' | 'code' | 'shots';

export function FeaturePage({ t, route }: { t: Tracker; route: Route }) {
  const fid = Number(route.id);
  const i = t.infoById.get(fid);
  if (!i) {
    return (
      <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="muted">There is no feature F-{route.id}. It was deleted or merged.</div>
        <div><a className="btn" href={link(t.project, 'flist')}>Open the feature list</a></div>
      </main>
    );
  }
  return <Feature key={fid} t={t} i={i} route={route} />;
}

function Feature({ t, i, route }: { t: Tracker; i: FeatureInfo; route: Route }) {
  const f = i.f;
  const p = t.project;
  const base = `/api/projects/${p}`;
  const url = `${base}/features/${f.id}`;
  const act = useAct();
  const tab = (route.q.get('tab') as Tab) || 'scopes';
  const order = listOrder.includes(f.id) ? listOrder : t.info.map((x) => x.f.id);
  const pos = order.indexOf(f.id);
  const prev = pos > 0 ? order[pos - 1] : null;
  const next = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;
  const m = i.m;
  const [merge, setMerge] = useState(false);
  const [mq, setMq] = useState('');
  const [addingRole, setAddingRole] = useState(false);
  const titleBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (route.q.get('focus') === 'title') {
      const el = titleBox.current?.querySelector('textarea');
      el?.focus();
      el?.select();
      setQuery({ focus: null });
    }
  }, [route.q]);

  const patch = (body: object, msg: string, undo?: object) => act(() => mutate('PATCH', url, body), msg, undo ? () => mutate('PATCH', url, undo, { quiet: true }) : undefined);
  const summary =
    `${m.ok} of ${m.total} scopes are covered by Playwright.` +
    (m.fail ? ` ${m.fail} have only failing tests.` : '') +
    (m.cy ? ` ${m.cy} have only Cypress tests.` : '') +
    (m.skip ? ` ${m.skip} have only skipped tests.` : '') +
    (m.none ? ` ${m.none} have no test.` : '');
  const reviewTxt = i.nChanges
    ? `${i.nChanges} ${i.nChanges === 1 ? 'change waits' : 'changes wait'} for your review. They are marked below.`
    : f.reviewWanted
      ? 'A person marked this feature as not reviewed.'
      : f.reviewedAt
        ? `Reviewed on ${new Date(f.reviewedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. No change since.`
        : 'No change waits for a review.';
  const tabs: [Tab, string][] = [['scopes', `Scopes ${m.total}`], ['details', 'Details'], ['code', 'Code'], ['shots', `Screenshots ${f.screenshots.length}`]];
  const groupSel = async (v: string) => {
    if (v === '__new') {
      const title = prompt('Name of the new group');
      if (!title?.trim()) return;
      await act(async () => {
        const r = await mutate<{ id: number }>('POST', `${base}/groups`, { title }, { quiet: true });
        await mutate('PATCH', url, { groupId: r.id });
      }, `Moved to the new group ${title}`);
      return;
    }
    const groupId = v === 'none' ? null : Number(v);
    patch({ groupId }, groupId ? `Moved to the group ${t.groupTitle(groupId)}` : 'Removed from its group', { groupId: f.groupId });
  };

  return (
    <main className="page">
      <section className="main" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-label="Feature">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a className="linkbtn" href={link(p, 'flist')}>Features</a>
          <span className="faint" aria-hidden="true">/</span>
          <span className="faint">{i.group}</span>
          <span style={{ flex: 1 }} />
          <span className="faint" style={{ fontSize: 12 }}>{pos >= 0 ? `${pos + 1} of ${order.length}` : ''}</span>
          <button className="icon-btn" onClick={() => prev != null && go(link(p, 'feature', prev))} disabled={prev == null} aria-label="Previous feature" title="Previous feature"><IPrev s={16} /></button>
          <button className="icon-btn" onClick={() => next != null && go(link(p, 'feature', next))} disabled={next == null} aria-label="Next feature" title="Next feature"><INext s={16} /></button>
        </nav>

        <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <IdBtn label={`F-${f.id}`} className="btn btn-ghost btn-sm mono" />
            {i.toReview && <span className="tag tag-changed">To review</span>}
            {f.aiFields.length > 0 && <span className="tag tag-ai" title="The AI wrote these fields and no person checked them yet.">AI draft: {f.aiFields.join(', ')}</span>}
            <span className="muted" style={{ fontSize: 13 }}>{reviewTxt}</span>
            <span style={{ flex: 1 }} />
            {i.changes.length > 0 && <a className="btn btn-sm" style={{ color: 'var(--ink)', textDecoration: 'none' }} href={link(p, 'changes', null, { f: f.id })}>List the changes</a>}
            {i.toReview && <button className="btn btn-sm btn-primary" onClick={() => act(() => mutate('POST', `${url}/check`, {}), `F-${f.id} marked as reviewed`)}>Mark as reviewed</button>}
            <Menu
              label="More actions"
              items={[
                { label: 'Mark as not reviewed', hidden: i.toReview, run: () => act(() => mutate('POST', `${url}/uncheck`, {}), `F-${f.id} marked as not reviewed`) },
                { label: 'Merge another feature into this one…', run: () => (setMq(''), setMerge(true)) },
                {
                  label: 'Delete feature', danger: true,
                  run: () => confirm(`Delete F-${f.id} “${f.title}” with its scopes, lists and links? This cannot be undone.`) &&
                    act(async () => (await mutate('DELETE', url), go(link(p, 'flist'))), `F-${f.id} deleted`),
                },
              ]}
            />
          </div>
          <div ref={titleBox}>
            <InlineText id="ftitle" label="Feature title" className="ie-title" value={f.title} placeholder="Feature title" required="A feature needs a title. The old title is back." onSave={(title) => patch({ title }, 'Title saved', { title: f.title })} />
          </div>
          <InlineText id="fdesc" label="Description" className="ie-desc" multi value={f.description} placeholder="Add a description: what the feature does, and for whom." onSave={(description) => patch({ description }, 'Description saved', { description: f.description })} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center', fontSize: 13 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span className="faint">Group</span>
              <select className="input" style={{ width: 'auto', minHeight: 32, padding: '3px 8px' }} value={f.groupId == null ? 'none' : String(f.groupId)} onChange={(e) => groupSel(e.target.value)}>
                <option value="none">No group</option>
                {t.fd.groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                <option value="__new">New group…</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span className="faint">Priority</span>
              <select className="input" style={{ width: 'auto', minHeight: 32, padding: '3px 8px' }} value={f.priority} onChange={(e) => patch({ priority: e.target.value }, `Priority set to ${PRI_LABEL[e.target.value].toLowerCase()}`, { priority: f.priority })}>
                <option value="">None</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </select>
            </label>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="faint">Roles</span>
              {f.roles.map((r) => (
                <span key={r} className="tag tag-ro" style={{ paddingRight: 6 }}>
                  {r}
                  <button
                    className="chip-x" aria-label={`Remove role ${r}`} title={`Remove role ${r}`}
                    onClick={() => act(() => mutate('DELETE', `${url}/labels/role/${encodeURIComponent(r)}`), 'Role removed', () => mutate('POST', `${url}/labels`, { kind: 'role', value: r }, { quiet: true }))}
                  ><IX s={12} /></button>
                </span>
              ))}
              {addingRole ? (
                <AddRow
                  className="" inputClass="input role-input" placeholder="Role name, then Enter" once
                  onAdd={async (value) => void (await act(() => mutate('POST', `${url}/labels`, { kind: 'role', value }), 'Role added', () => mutate('DELETE', `${url}/labels/role/${encodeURIComponent(value)}`, {}, { quiet: true })))}
                  onClose={() => setAddingRole(false)}
                />
              ) : (
                <button className="btn btn-ghost btn-sm add-btn" onClick={() => setAddingRole(true)}><IPlus />Add role</button>
              )}
              {t.fd.labels.roles.length > 0 && addingRole && <span className="faint" style={{ fontSize: 12 }}>In use: {t.fd.labels.roles.slice(0, 6).map((r) => r.value).join(', ')}</span>}
            </span>
          </div>
          <div style={{ fontSize: 13, borderTop: '1px solid var(--line)', paddingTop: 10 }}>{summary}</div>
        </div>

        <div className="card" style={{ padding: '0 18px 18px' }}>
          <div className="tabs" role="tablist">
            {tabs.map(([k, l]) => (
              <button key={k} className={`tab ${tab === k ? 'tab-on' : ''}`} role="tab" aria-selected={tab === k} onClick={() => setQuery({ tab: k === 'scopes' ? null : k, scope: null })}>{l}</button>
            ))}
          </div>
          {tab === 'scopes' && <ScopesTab t={t} i={i} openScope={Number(route.q.get('scope')) || null} />}
          {tab === 'details' && <DetailsTab t={t} f={f} />}
          {tab === 'code' && <CodeTab t={t} f={f} />}
          {tab === 'shots' && <ShotsTab t={t} f={f} />}
        </div>
      </section>
      {merge && (
        <Picker
          title={`Merge a feature into F-${f.id}`}
          sub="Its scopes, lists, links, code and screenshots move to this feature. Then the other feature is deleted. This cannot be undone."
          q={mq} setQ={setMq} onClose={() => setMerge(false)}
          rows={t.info
            .filter((x) => x.f.id !== f.id && (!mq.trim() || x.f.title.toLowerCase().includes(mq.trim().toLowerCase()) || `f-${x.f.id}` === mq.trim().toLowerCase()))
            .map<PickRow>((x) => ({
              key: String(x.f.id), idLabel: `F-${x.f.id}`, title: x.f.title, sub: `${x.group} · ${x.f.scopes.length} scopes`,
              pick: () => confirm(`Merge F-${x.f.id} “${x.f.title}” into F-${f.id}? F-${x.f.id} is deleted after the merge.`) &&
                act(async () => (await mutate('POST', `${url}/merge`, { from: x.f.id }), setMerge(false)), `F-${x.f.id} merged into F-${f.id}`),
            }))}
        />
      )}
    </main>
  );
}

/* ================= Scopes ================= */

const scopeChanged = (f: FeatureX, s: ScopeX) =>
  s.aiFields.length > 0 || s.requirements.some((r) => r.aiDraft) || f.links.some((l) => l.scopeIds.includes(s.id) && (l.missing || (l.source === 'ai' && !l.checked)));

function ScopesTab({ t, i, openScope }: { t: Tracker; i: FeatureInfo; openScope: number | null }) {
  const f = i.f;
  const p = t.project;
  const base = `/api/projects/${p}`;
  const act = useAct();
  const [flt, setFlt] = useState<'all' | 'gaps' | 'review'>('all');
  const [openAll, setOpenAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const status = (id: number) => scopeStatus(f, id, t.testById);
  const shown = (s: ScopeX) => flt === 'all' || (flt === 'gaps' && status(s.id) !== 'ok') || (flt === 'review' && scopeChanged(f, s));
  const groups: { id: number | null; title: string }[] = [...f.scopeGroups.map((g) => ({ id: g.id as number | null, title: g.title })), { id: null, title: f.scopeGroups.length ? 'No group' : 'Scopes' }];
  const featureLinks = f.links.filter((l) => !l.scopeIds.length);

  // Open the scope from the link (?scope=), and show it.
  useEffect(() => {
    if (openScope) setTimeout(() => document.getElementById(`scope-${openScope}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  }, [openScope]);
  const toggle = (id: number) => (setOpenAll(false), setQuery({ scope: openScope === id ? null : id }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Seg
          label="Show scopes" value={flt} onChange={setFlt}
          items={[
            { key: 'all', label: 'All', n: i.m.total },
            { key: 'gaps', label: 'Not covered', n: i.m.total - i.m.ok },
            { key: 'review', label: 'To review', n: f.scopes.filter((s) => scopeChanged(f, s)).length },
          ]}
        />
        <span style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={() => (setOpenAll(!openAll), setQuery({ scope: null }))}>{openAll ? 'Close all' : 'Open all'}</button>
        <button className="btn btn-sm" onClick={() => setAddingGroup(true)}><IPlus />Add group</button>
        <button className="btn btn-sm add-btn" onClick={() => setAdding(true)}><IPlus />Add scope</button>
      </div>
      {addingGroup && (
        <AddRow
          className="scope dl-new-scope" placeholder="New scope group, like a describe block. Enter adds it." once
          onAdd={async (title) => void (await act(() => mutate('POST', `${base}/features/${f.id}/scope-groups`, { title }), 'Group added'))}
          onClose={() => setAddingGroup(false)}
        />
      )}
      {groups.map((g) => {
        const all = f.scopes.filter((s) => s.groupId === g.id) as ScopeX[];
        if (g.id === null && !all.length) return null;
        const list = all.filter(shown);
        if (!list.length && (flt !== 'all' || g.id === null)) return null;
        const ok = all.filter((s) => status(s.id) === 'ok').length;
        return (
          <div key={g.id ?? 'none'} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="grp-title">
              {g.id === null ? (
                <h3 className="h3">{g.title}</h3>
              ) : (
                <InlineText label="Scope group name" className="h3" value={g.title} required="A group needs a name. The old name is back." onSave={(title) => act(() => mutate('PATCH', `${base}/scope-groups/${g.id}`, { title }), 'Group renamed')} />
              )}
              <span className="faint" style={{ fontSize: 12 }}>{all.length ? `${ok} of ${all.length} covered` : 'No scope yet'}</span>
              {g.id !== null && (
                <button
                  className="icon-btn icon-danger" aria-label={`Delete group ${g.title}`} title="Delete group (its scopes stay, with no group)"
                  onClick={() => confirm(`Delete the group “${g.title}”? Its scopes stay, with no group.`) && act(() => mutate('DELETE', `${base}/scope-groups/${g.id}`), 'Group deleted')}
                ><ITrash s={14} /></button>
              )}
            </div>
            {list.map((s) => (
              <ScopeCard key={s.id} t={t} f={f} s={s} open={openAll || openScope === s.id} toggle={() => toggle(s.id)} />
            ))}
          </div>
        );
      })}
      {!f.scopes.some(shown) && <div className="faint" style={{ fontSize: 13 }}>{f.scopes.length ? 'No scope matches this filter.' : 'No scope yet. A scope is one thing the feature does, like a test scenario.'}</div>}
      {adding && (
        <AddRow
          className="scope dl-new-scope" once placeholder="New scope: one thing the feature does, like a test scenario. Enter adds it."
          onAdd={async (title) => {
            await act(async () => {
              const r = await mutate<{ id: number }>('POST', `${base}/features/${f.id}/scopes`, { title });
              setQuery({ scope: r.id });
            }, 'Scope added');
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {featureLinks.length > 0 && (
        <section className="lc" aria-label="Tests of the whole feature">
          <div className="lc-head">
            <div className="lc-titlerow"><span className="lc-title">Tests of the whole feature</span><span className="lc-count">{featureLinks.length}</span></div>
            <span className="lc-sub">These tests link to the feature, not to a scope. Put each one on the scope it checks.</span>
          </div>
          {featureLinks.map((l) => <TestRow key={l.id} t={t} f={f} l={l} scopeId={null} />)}
        </section>
      )}
    </div>
  );
}

function ScopeCard({ t, f, s, open, toggle }: { t: Tracker; f: FeatureX; s: ScopeX; open: boolean; toggle: () => void }) {
  const p = t.project;
  const base = `/api/projects/${p}`;
  const url = `${base}/scopes/${s.id}`;
  const act = useAct();
  const st = scopeStatus(f, s.id, t.testById);
  const changed = scopeChanged(f, s);
  const chgLabel = s.aiFields.length ? (s.aiFields.includes('title') && !(s.before && 'title' in s.before) ? 'New' : 'Changed') : 'Has changes';
  const links = f.links.filter((l) => l.scopeIds.includes(s.id));
  // Code of this scope that no linked test checks: a test to write.
  const codeNoTest = !links.length && !!t.codeMap?.features.find((x) => x.featureId === f.id)?.entries.some((e) => e.scopeIds.includes(s.id));
  const [addReq, setAddReq] = useState(false);
  const [modal, setModal] = useState<null | 'link' | 'move'>(null);
  const [mq, setMq] = useState('');
  const tags = (
    <>
      {changed && <span className="tag tag-changed">{chgLabel}</span>}
      <span className={`tag ${ST_TAG[st]}`}>{ST_LABEL[st]}</span>
      {codeNoTest && <span className="tag tag-skip" title="The AI put plugin code on this scope, but no test is linked to it. Write a test for it.">Code, no test</span>}
    </>
  );
  const q = mq.trim().toLowerCase();
  const have = new Set(links.map((l) => l.testId));
  return (
    <div className="scope" id={`scope-${s.id}`}>
      {!open ? (
        <div className="scope-head-wrap">
          <IdBtn label={`S-${s.id}`} text={`F-${f.id}/S-${s.id}`} />
          <button className="scope-head" onClick={toggle} aria-expanded={false}>
            <span style={{ flex: 1, fontWeight: 500 }}>{s.title}</span>
            {tags}
            <INext s={14} />
          </button>
        </div>
      ) : (
        <>
          <div className="scope-head scope-head-open">
            <IdBtn label={`S-${s.id}`} text={`F-${f.id}/S-${s.id}`} />
            <InlineText
              id={`in-s${s.id}`} label="Scope title" className="ie-scope" value={s.title} required="A scope needs a title. The old title is back."
              onSave={(title) => act(() => mutate('PATCH', url, { title }), 'Scope renamed. The AI still knows it by its old title.', () => mutate('PATCH', url, { title: s.title }, { quiet: true }))}
            />
            {tags}
            <button className="icon-btn" onClick={toggle} aria-expanded aria-label="Close scope" title="Close"><span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}><INext s={14} /></span></button>
          </div>
          <div className="scope-body">
            {s.before && 'title' in s.before && s.before.title && (
              <div className="was-box"><strong>Title before the AI change:</strong> <span className="was-old">{s.before.title}</span></div>
            )}
            {s.aiFields.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
                <span className="tag tag-ai">AI draft: {s.aiFields.join(', ')}</span>
                <button className="btn btn-sm btn-ok" onClick={() => act(() => mutate('PATCH', url, { check: true }), `S-${s.id} checked`)}>Keep</button>
              </div>
            )}
            <InlineText
              label="Scope description" className="ie-sdesc" multi value={s.description} placeholder="Add a description: the steps, or what the user sees."
              onSave={(description) => act(() => mutate('PATCH', url, { description }), 'Description saved', () => mutate('PATCH', url, { description: s.description }, { quiet: true }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <section className="lc" aria-label="Requirements of this scope">
                <div className="lc-head lc-head-row">
                  <div className="lc-titlerow"><span className="lc-title">Requirements</span><span className="lc-count">{s.requirements.length}</span></div>
                  <button className="btn btn-ghost btn-sm add-btn" onClick={() => setAddReq(true)} aria-label="Add a requirement"><IPlus />Add</button>
                </div>
                {!s.requirements.length && !addReq && <div className="lc-empty">None yet.</div>}
                {s.requirements.map((r) => <ItemRow key={r.id} t={t} item={r} bullet />)}
                {addReq && (
                  <AddRow
                    placeholder="New requirement. Enter adds it." onClose={() => setAddReq(false)}
                    onAdd={async (text) => void (await act(async () => {
                      const r = await mutate<{ id: number }>('POST', `${base}/features/${f.id}/items`, { kind: 'requirement', text, scopeId: s.id });
                      return r;
                    }, 'Requirement added'))}
                  />
                )}
              </section>
              <section className="lc" aria-label="Tests of this scope">
                <div className="lc-head lc-head-row">
                  <div className="lc-titlerow"><span className="lc-title">Tests</span><span className="lc-count">{links.length}</span></div>
                  <button className="btn btn-ghost btn-sm add-btn" onClick={() => (setMq(''), setModal('link'))} aria-label="Link a test"><IPlus />Link</button>
                </div>
                {links.map((l) => <TestRow key={l.id} t={t} f={f} l={l} scopeId={s.id} />)}
                {!links.length && <div className="lc-empty">None yet.</div>}
              </section>
            </div>
            <div className="scope-foot">
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, marginRight: 'auto' }}>
                <span className="faint">Group</span>
                <select className="input sel-sm" value={s.groupId == null ? 'none' : String(s.groupId)} onChange={(e) => act(() => mutate('PATCH', url, { groupId: e.target.value === 'none' ? null : Number(e.target.value) }), 'Scope moved to the group')}>
                  <option value="none">No group</option>
                  {f.scopeGroups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                </select>
              </label>
              <button className="btn btn-sm" onClick={() => (setMq(''), setModal('move'))}>Move to feature…</button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => confirm(`Delete scope S-${s.id} “${s.title}” and its requirements? Its tests stay linked to the feature. The AI will not add it again.`) &&
                  act(() => mutate('DELETE', url), `Scope S-${s.id} deleted. The AI will not add it again.`)}
              >Delete</button>
            </div>
          </div>
        </>
      )}
      {modal === 'link' && (
        <Picker
          title={`Link a test to S-${s.id}`} sub={`${s.title}. Tests in no feature come first.`} q={mq} setQ={setMq} onClose={() => setModal(null)}
          rows={t.tests
            .filter((x) => !have.has(x.id) && (!q || x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q) || x.file.toLowerCase().includes(q)))
            .sort((a, b) => (t.linkedTo.has(a.id) ? 1 : 0) - (t.linkedTo.has(b.id) ? 1 : 0))
            .slice(0, 40)
            .map<PickRow>((x) => {
              const l = t.linkedTo.get(x.id);
              return {
                key: x.id, idLabel: x.id, title: x.title, sub: x.file, tag: l ? `Also in F-${l[0].fid}` : 'In no feature', tagCls: l ? 'tag-ro' : 'tag-none',
                pick: () => act(async () => (await mutate('POST', `${base}/links`, { testId: x.id, scopeId: s.id }), setModal(null)), `${x.id} linked to S-${s.id}`),
              };
            })}
        />
      )}
      {modal === 'move' && (
        <Picker
          title={`Move S-${s.id} to another feature`} sub="Its requirements, test links and screenshots go with it. It keeps its ID." q={mq} setQ={setMq} onClose={() => setModal(null)}
          rows={t.info
            .filter((x) => x.f.id !== f.id && (!q || x.f.title.toLowerCase().includes(q)))
            .map<PickRow>((x) => ({
              key: String(x.f.id), idLabel: `F-${x.f.id}`, title: x.f.title, sub: x.group,
              pick: () => act(async () => (await mutate('POST', `${url}/move`, { featureId: x.f.id }), setModal(null), setQuery({ scope: null })), `S-${s.id} moved to F-${x.f.id}`),
            }))}
        />
      )}
    </div>
  );
}

/** One linked test. scopeId: the scope it shows under (null: a link to the whole feature). */
function TestRow({ t, f, l, scopeId }: { t: Tracker; f: FeatureX; l: FeatureLink; scopeId: number | null }) {
  const p = t.project;
  const base = `/api/projects/${p}`;
  const act = useAct();
  const [pick, setPick] = useState(false);
  const [mq, setMq] = useState('');
  const x = t.testById.get(l.testId);
  const fw = l.framework === 'cypress';
  const [stLabel, stCls] = l.missing ? ['Gone', 'tag-fail'] : fw ? ['Cypress', 'tag-cy'] : x?.skipped ? ['Skipped', 'tag-skip'] : x?.result === 'failed' ? ['Failing', 'tag-fail'] : ['Playwright', 'tag-ok'];
  const unlink = () => {
    const rest = l.scopeIds.filter((id) => id !== scopeId);
    if (scopeId !== null && rest.length) {
      return act(() => mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: rest }), `${l.testId} unlinked from S-${scopeId}`, () => mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: l.scopeIds }, { quiet: true }));
    }
    return act(() => mutate('DELETE', `${base}/links/${l.id}`), `${l.testId} unlinked. The AI will not link it again.`);
  };
  const backLabel = scopeId ? `Back to F-${f.id} / S-${scopeId}` : `Back to F-${f.id}`;
  const q = mq.trim().toLowerCase();
  return (
    <div className="lc-row">
      <span className={`tag ${stCls}`} style={{ marginTop: 1 }}>{stLabel}</span>
      <span className="lc-text">
        {l.missing ? <span>{l.title ?? l.testId}</span> : <a className="linkbtn" href={withBack(link(p, 'test', l.testId), backLabel)}>{x?.title ?? l.title ?? l.testId}</a>}
        <span className="mono faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.testId}{l.scopeIds.length > 1 ? ` · also in ${l.scopeIds.filter((id) => id !== scopeId).map((id) => `S-${id}`).join(', ')}` : ''}</span>
      </span>
      {l.missing ? (
        <span className="tag tag-fail" title="The test is not in the repo now. It was deleted or renamed.">{KIND_LABEL.gone}</span>
      ) : l.source === 'ai' && !l.checked ? (
        <span className="tag tag-new" title="The AI linked this test. No person checked it yet.">New</span>
      ) : null}
      <span className="row-acts">
        {l.source === 'ai' && !l.checked && !l.missing && <button className="btn btn-ghost btn-sm btn-ok" onClick={() => act(() => mutate('PATCH', `${base}/links/${l.id}`, { check: true }), 'Link kept')}>Keep</button>}
        {scopeId === null && <button className="btn btn-ghost btn-sm" onClick={() => (setMq(''), setPick(true))}>Put on a scope</button>}
        <button className="btn btn-ghost btn-sm" onClick={unlink}>Unlink</button>
      </span>
      {pick && (
        <Picker
          title={`Put ${l.testId} on a scope of F-${f.id}`} sub={x?.title} q={mq} setQ={setMq} onClose={() => setPick(false)}
          rows={f.scopes
            .filter((s) => !q || s.title.toLowerCase().includes(q) || `s-${s.id}` === q)
            .map<PickRow>((s) => ({
              key: String(s.id), idLabel: `S-${s.id}`, title: s.title, tag: scopeLinks(f, s.id).length ? undefined : 'No test yet', tagCls: 'tag-none',
              pick: () => act(async () => (await mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: [s.id] }), setPick(false)), `${l.testId} put on S-${s.id}`),
            }))}
        />
      )}
    </div>
  );
}

/** A list item or scope requirement: edit in place, keep an AI draft, remove. */
function ItemRow({ t, item, bullet }: { t: Tracker; item: FeatureItem; bullet?: boolean }) {
  const base = `/api/projects/${t.project}`;
  const act = useAct();
  return (
    <div className={`lc-row ${bullet ? 'bul' : 'dl-row'}`}>
      <div className="lc-text">
        <InlineText
          label="Item" className="ie-item" multi value={item.text}
          onSave={(text) =>
            text
              ? act(() => mutate('PATCH', `${base}/items/${item.id}`, { text }), 'Saved', () => mutate('PATCH', `${base}/items/${item.id}`, { text: item.text }, { quiet: true }))
              : act(() => mutate('DELETE', `${base}/items/${item.id}`), 'Removed')
          }
        />
      </div>
      {item.aiDraft && <span className="tag tag-ai" title="The AI wrote this. No person checked it yet.">AI draft</span>}
      <span className="row-acts">
        {item.aiDraft && <button className="btn btn-ghost btn-sm btn-ok" onClick={() => act(() => mutate('PATCH', `${base}/items/${item.id}`, { check: true }), 'Kept')}>Keep</button>}
        <button className="icon-btn icon-danger" onClick={() => act(() => mutate('DELETE', `${base}/items/${item.id}`), 'Removed')} aria-label="Remove" title="Remove"><IX s={16} /></button>
      </span>
    </div>
  );
}

/* ================= Details ================= */

function DetailsTab({ t, f }: { t: Tracker; f: FeatureX }) {
  const act = useAct();
  const [adding, setAdding] = useState<ItemField | null>(null);
  const url = `/api/projects/${t.project}/features/${f.id}`;
  return (
    <div className="dl">
      {LISTS.map((l) => {
        const items = f[l.key] as FeatureItem[];
        return (
          <section className="dl-sec" aria-label={l.label} key={l.key}>
            <div className="dl-head">
              <h3 className="dl-title">{l.label}<span className="faint">{items.length}</span></h3>
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)' }} onClick={() => setAdding(l.key)} aria-label={`Add a ${l.noun}`}><IPlus />Add</button>
            </div>
            <p className="dl-hint">{l.hint}</p>
            <div className="dl-body">
              {!items.length && adding !== l.key && <div className="faint" style={{ fontSize: 13, padding: '4px 0' }}>None yet.</div>}
              {items.map((it) => <ItemRow key={it.id} t={t} item={it} />)}
              {adding === l.key && (
                <AddRow
                  className="lc-row dl-row dl-new" placeholder={`New ${l.noun}. Enter adds it.`} onClose={() => setAdding(null)}
                  onAdd={async (text) => void (await act(() => mutate('POST', `${url}/items`, { kind: ITEM_KIND[l.key], text }), `${l.label}: item added`))}
                />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ================= Code ================= */

function CodeTab({ t, f }: { t: Tracker; f: FeatureX }) {
  const act = useAct();
  const p = t.project;
  const [tagging, setTagging] = useState<CodeEntry | null>(null);
  const entry = t.codeMap?.features.find((x) => x.featureId === f.id);
  const lc = entry?.lines;
  const ft = lc ? featureTotal(lc) : 0;
  const rows = (entry?.entries ?? [])
    .map((e) => {
      const n = e.lines ? featureTotal(e.lines) : 0;
      const run = e.lines?.tested ?? 0;
      return { e, n, run, p: n ? pct(run, n) : -1 };
    })
    .sort((a, b) => a.p - b.p);
  const tone = (x: number) => (x >= 80 ? 'c-good' : x >= 50 ? 'c-warn' : 'c-bad');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 16 }}>
      <div className="muted" style={{ fontSize: 13 }}>
        {!t.codeMap ? 'Loading the code…' : lc && ft ? `Tests run ${lc.tested} of ${ft} PHP lines (${pct(lc.tested, ft)}%). Least covered first. From the coverage run, Playwright and Cypress together.` : 'No code of this feature has coverage data yet.'}
        {' '}The map-features skill puts code in a feature. Remove code that is not part of it.
      </div>
      {rows.length > 0 && (
        <div className="table-box">
          <div className="gt" role="table" aria-label="Functions">
            <div className="gr gh cols-fn" role="row"><span role="columnheader">Function</span><span role="columnheader">File</span><span role="columnheader">Lines run by tests</span></div>
            {rows.map(({ e, n, run, p: x }) => (
              <div className="gr cols-fn lc-row" role="row" key={e.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <div role="cell" className="mono" style={{ overflowWrap: 'anywhere', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {e.function || '(whole file)'}
                  {e.source === 'ai' && !e.checked && <span className="tag tag-new">New</span>}
                  {!e.inRepo && <span className="tag tag-fail">Not in the repo</span>}
                  {e.inRepo && !e.measured && <span className="tag tag-none" title="The coverage run has no such file or function. The code changed, or the file is new.">Not measured</span>}
                  {e.scopeIds.map((id) => <span key={id} className="tag tag-ro" title={f.scopes.find((s) => s.id === id)?.title}>S-{id}</span>)}
                  <button className="btn btn-ghost btn-sm add-btn" onClick={() => setTagging(e)}>{e.scopeIds.length ? 'Change scopes' : 'Tag scopes'}</button>
                </div>
                <div role="cell" style={{ overflowWrap: 'anywhere' }}><a className="linkbtn mono" style={{ fontSize: 12 }} href={withBack(link(p, 'codefile', null, { path: e.file }), `Back to F-${f.id}`)}>{e.file}</a></div>
                <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {x >= 0 ? (
                    <>
                      <div className="bar bar-sm" style={{ flex: 1 }}><div className={`fill ${tone(x)}`} style={{ width: `${x}%` }} /></div>
                      <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{run} of {n} ({x}%)</span>
                    </>
                  ) : (
                    <span className="faint" style={{ fontSize: 13 }}>–</span>
                  )}
                  <span className="row-acts">
                    {e.source === 'ai' && !e.checked && <button className="btn btn-ghost btn-sm btn-ok" onClick={() => act(() => mutate('PATCH', `/api/projects/${p}/feature-code/${e.id}`, { check: true }), 'Code kept')}>Keep</button>}
                    <button className="icon-btn icon-danger" aria-label="Remove from the feature" title="Remove from the feature" onClick={() => act(() => mutate('DELETE', `/api/projects/${p}/feature-code/${e.id}`), 'Code removed. The AI will not add it again.')}><IX s={16} /></button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {tagging && (
        <ScopeTags f={f} title={`Scopes that ${tagging.function || tagging.file} does`} sub="No scope: the code does the feature in general." ids={tagging.scopeIds}
          url={`/api/projects/${p}/feature-code/${tagging.id}`} onClose={() => setTagging(null)} />
      )}
    </div>
  );
}

/* ================= Screenshots ================= */

function ShotsTab({ t, f }: { t: Tracker; f: FeatureX }) {
  const act = useAct();
  const p = t.project;
  const base = `/api/projects/${p}`;
  const file = useRef<HTMLInputElement>(null);
  const [big, setBig] = useState<number | null>(null);
  const [tagging, setTagging] = useState<Screenshot | null>(null);
  const upload = async (files: FileList | File[] | null) => {
    for (const fl of Array.from(files ?? [])) {
      if (!fl.type.startsWith('image/')) continue;
      const image = await new Promise<string>((ok, bad) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result));
        r.onerror = () => bad(new Error('Could not read the image'));
        r.readAsDataURL(fl);
      });
      await act(() => mutate('POST', `${base}/features/${f.id}/screenshots`, { image, caption: '' }), 'Screenshot added');
    }
  };
  // Paste an image (Ctrl+V) while this tab is open.
  useEffect(() => {
    const on = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.files ?? []).filter((x) => x.type.startsWith('image/'));
      if (imgs.length && !/^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName)) (e.preventDefault(), void upload(imgs));
    };
    addEventListener('paste', on);
    return () => removeEventListener('paste', on);
  });
  return (
    <div className="shots" style={{ paddingTop: 16 }}>
      {f.screenshots.map((sh) => (
        <figure className="shot" key={sh.id}>
          <img src={screenshotUrl(p, sh.id)} alt={sh.caption || `Screenshot IMG-${sh.id}`} loading="lazy" onClick={() => setBig(sh.id)} />
          <div className="shot-acts">
            <button className="shot-del" onClick={() => confirm('Remove this screenshot?') && act(() => mutate('DELETE', `${base}/screenshots/${sh.id}`), 'Screenshot removed')} aria-label="Remove screenshot" title="Remove screenshot"><ITrash s={16} /></button>
          </div>
          <figcaption className="shot-cap">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
              <IdBtn label={`IMG-${sh.id}`} text={`F-${f.id}/IMG-${sh.id}`} />
              {sh.aiDraft && (
                <>
                  <span className="tag tag-new">New</span>
                  <button className="btn btn-ghost btn-sm btn-ok" onClick={() => act(() => mutate('PATCH', `${base}/screenshots/${sh.id}`, { check: true }), 'Screenshot kept')}>Keep</button>
                </>
              )}
            </div>
            <InlineText label="Caption" className="ie-item" multi value={sh.caption} placeholder="Add a caption: what the image shows." onSave={(caption) => act(() => mutate('PATCH', `${base}/screenshots/${sh.id}`, { caption }), 'Caption saved')} />
          </figcaption>
          <div className="shot-tags">
            {sh.scopeIds.map((id) => <span key={id} className="tag tag-ro mono">S-{id}</span>)}
            <button className="btn btn-ghost btn-sm add-btn" onClick={() => setTagging(sh)}>{sh.scopeIds.length ? 'Change scopes' : 'Tag scopes'}</button>
          </div>
        </figure>
      ))}
      <button className="shot-add" onClick={() => file.current?.click()}><IPlus s={16} />Add a screenshot (or paste one)</button>
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => (void upload(e.target.files), (e.target.value = ''))} />
      {big !== null && (
        <button className="lightbox" onClick={() => setBig(null)} aria-label="Close the image"><img src={screenshotUrl(p, big)} alt="" /></button>
      )}
      {tagging && (
        <ScopeTags f={f} title={`Scopes that IMG-${tagging.id} shows`} sub="No scope: the image shows the feature in general." ids={tagging.scopeIds}
          url={`/api/projects/${t.project}/screenshots/${tagging.id}`} onClose={() => setTagging(null)} />
      )}
    </div>
  );
}

/** A dialog to choose the scopes of a screenshot or a code entry. */
function ScopeTags({ f, title, sub, ids, url, onClose }: { f: FeatureX; title: string; sub: string; ids: number[]; url: string; onClose: () => void }) {
  const act = useAct();
  const [sel, setSel] = useState(new Set(ids));
  const flip = (id: number) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <Dialog
      title={title} sub={sub} onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => act(async () => (await mutate('PATCH', url, { scopeIds: [...sel] }), onClose()), 'Scopes saved')}>Save</button>
      </>}
    >
      {f.scopes.map((s) => (
        <label key={s.id} className="check-row">
          <input type="checkbox" checked={sel.has(s.id)} onChange={() => flip(s.id)} />
          <span className="mono faint">S-{s.id}</span>
          <span>{s.title}</span>
        </label>
      ))}
    </Dialog>
  );
}
