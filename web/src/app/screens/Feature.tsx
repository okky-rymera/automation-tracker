import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { featureTotal, mutate, pct, screenshotSmallUrl, screenshotUrl, type CodeEntry, type FeatureItem, type FeatureLink, type ItemField, type Screenshot, type TrackedIssue } from '../../api';
import { KIND_LABEL, LISTS, PRI_LABEL, ST_LABEL, ST_TAG, countedScopes, featureIssues, issueOpen, scopeIdLabel, scopeIssues, anyScopeLabel, scopeCountText, scopeLinks, scopesForIssue, scopeStatus, scopeToRemove, variationsOf, type FeatureInfo, type FeatureX, type ScopeX, type Tracker } from '../data';
import { go, link, setQuery, withBack, type Route } from '../route';
import { AddRow, Dialog, IdBtn, Lightbox, InlineText, INext, IPlus, IPrev, IRefresh, ITrash, IX, Menu, Picker, Seg, useAct, useEscapeClose, useSay, type PickRow } from '../ui';
import { listOrder } from './FeatureList';

const ITEM_KIND: Record<ItemField, string> = { requirements: 'requirement', notes: 'note', outOfScope: 'out_of_scope', where: 'where', settings: 'setting', questions: 'question' };
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
  const issues = featureIssues(t, f);
  const forIssue = scopesForIssue(t, f);
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
    (m.none ? ` ${m.none} have no test.` : '') +
    (m.remove ? ` ${m.remove} ${m.remove === 1 ? 'is' : 'are'} marked "To remove" and ${m.remove === 1 ? 'does' : 'do'} not count.` : '');
  const reviewTxt = i.nChanges
    ? `${i.nChanges} ${i.nChanges === 1 ? 'change waits' : 'changes wait'} for your review. They are marked below.`
    : f.reviewWanted
      ? 'A person marked this feature as not reviewed.'
      : f.reviewedAt
        ? `Reviewed on ${new Date(f.reviewedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. No change since.`
        : 'No change waits for a review.';
  const tabs: [Tab, string][] = [['scopes', `Scopes ${countedScopes(f).length}`], ['details', 'Details'], ['code', 'Code'], ['shots', `Screenshots ${f.screenshots.length}`]];
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
            {f.toRemove && <span className="tag tag-remove">To remove</span>}
            {f.aiFields.length > 0 && <span className="tag tag-changed" title="These fields changed since the last review.">Changed: {f.aiFields.join(', ')}</span>}
            <span className="muted" style={{ fontSize: 13 }}>{reviewTxt}</span>
            <span style={{ flex: 1 }} />
            {i.changes.length > 0 && <a className="btn btn-sm" style={{ color: 'var(--ink)', textDecoration: 'none' }} href={link(p, 'changes', null, { f: f.id })}>List the changes</a>}
            {i.toReview && <button className="btn btn-sm btn-primary" onClick={() => act(() => mutate('POST', `${url}/check`, {}), `F-${f.id} marked as reviewed`)}>Mark as reviewed</button>}
            <Menu
              label="More actions"
              items={[
                { label: 'Mark as not reviewed', hidden: i.toReview, run: () => act(() => mutate('POST', `${url}/uncheck`, {}), `F-${f.id} marked as not reviewed`) },
                {
                  label: 'Mark as “To remove”…', hidden: !!f.toRemove,
                  run: () => {
                    const reason = askRemoveReason(`F-${f.id} “${f.title}”`);
                    if (reason) patch({ toRemove: reason }, `F-${f.id} marked “To remove”`, { toRemove: null });
                  },
                },
                { label: 'Clear the “To remove” mark', hidden: !f.toRemove, run: () => patch({ toRemove: null }, `F-${f.id}: “To remove” mark cleared`, f.toRemove ? { toRemove: f.toRemove } : undefined) },
                { label: 'Merge another feature into this one…', run: () => (setMq(''), setMerge(true)) },
                {
                  label: 'Delete feature', danger: true,
                  run: () => confirm(`Delete F-${f.id} “${f.title}” with its scopes, lists and links? This cannot be undone.`) &&
                    act(async () => (await mutate('DELETE', url), go(link(p, 'flist'))), `F-${f.id} deleted`),
                },
              ]}
            />
          </div>
          {f.toRemove && (
            <div className="remove-box">
              <strong>To remove:</strong> <span>{f.toRemove.reason}</span>
              <span className="faint">{removeWho(f.toRemove)}. Its scopes do not count in the coverage, and the AI does not add to it. Delete the feature or move its scopes when its tests are gone.</span>
            </div>
          )}
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
          <IssueList
            t={t} f={f} issues={issues}
            actions={<>
              {!f.toRemove && (
                <button
                  className="btn btn-ghost btn-sm add-btn" disabled={!forIssue.length}
                  title={forIssue.length ? `One GitHub issue to write tests for the ${scopeCountText(forIssue)} with no test` : 'Each scope has a test or an open issue'}
                  onClick={() =>
                    confirm(`Create one GitHub issue to write tests for the ${scopeCountText(forIssue)} of F-${f.id} with no test?\n\n${forIssue.map((x) => `${scopeIdLabel(f, x.id)} ${x.title}`).join('\n')}\n\nThe AI writes it with the create-issue skill, with no test plan, and posts it to the plugin repo on GitHub. This takes 1 to 2 minutes.`) &&
                    act(() => mutate('POST', `${url}/issues`, {}), 'The AI creates the issue now. This takes 1 to 2 minutes.')
                  }
                ><IPlus />Create test issue</button>
              )}
              <button className="btn btn-ghost btn-sm add-btn" onClick={() => addIssue(act, `${url}/issues/link`, {}, `F-${f.id}`)} title="Add an issue that is on GitHub to this feature" aria-label="Add an issue"><IPlus />Add</button>
              <CheckIssuesButton project={p} />
            </>}
          />
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
              key: String(x.f.id), idLabel: `F-${x.f.id}`, title: x.f.title, sub: `${x.group} · ${countedScopes(x.f).length} scopes`,
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
/** The scope, or one of its variations, has a change to review. */
const cardChanged = (f: FeatureX, s: ScopeX) => scopeChanged(f, s) || variationsOf(f, s.id).some((v) => scopeChanged(f, v as ScopeX));

function ScopesTab({ t, i, openScope }: { t: Tracker; i: FeatureInfo; openScope: number | null }) {
  const f = i.f;
  const p = t.project;
  const base = `/api/projects/${p}`;
  const act = useAct();
  const [flt, setFlt] = useState<'all' | 'gaps' | 'review' | 'remove'>('all');
  const [adding, setAdding] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const shotsBy = useMemo(() => shotsByScope(f.screenshots), [f.screenshots]);
  const status = (id: number) => scopeStatus(f, id, t.testById);
  const marked = (s: ScopeX) => scopeToRemove(f, s);
  // A scope with variations counts as its variations.
  const leaves = (s: ScopeX) => (s.columns ? (variationsOf(f, s.id) as ScopeX[]) : [s]);
  // The "To remove" button goes when the last mark goes: show all scopes again.
  useEffect(() => {
    if (flt === 'remove' && !i.m.remove) setFlt('all');
  }, [flt, i.m.remove]);
  const shown = (s: ScopeX) =>
    flt === 'all' ||
    (flt === 'gaps' && leaves(s).some((x) => !marked(x) && status(x.id) !== 'ok')) ||
    (flt === 'review' && cardChanged(f, s)) ||
    (flt === 'remove' && (marked(s) || leaves(s).some(marked)));
  const top = f.scopes.filter((s) => s.parentId === null) as ScopeX[];
  const groups: { id: number | null; title: string }[] = [...f.scopeGroups.map((g) => ({ id: g.id as number | null, title: g.title })), { id: null, title: f.scopeGroups.length ? 'No group' : 'Scopes' }];
  const featureLinks = f.links.filter((l) => !l.scopeIds.length);
  // ?scope= names a scope or a variation. A variation opens in the table of its scope.
  const openRow = openScope === null ? null : f.scopes.find((s) => s.id === openScope) ?? null;
  const openCard = openRow ? (openRow.parentId ?? openRow.id) : null;
  const popScope = openCard === null ? null : top.find((s) => s.id === openCard) ?? null;

  // Open the scope from the link (?scope=), and show it.
  useEffect(() => {
    if (openCard) setTimeout(() => document.getElementById(`scope-${openCard}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  }, [openCard]);
  const openTo = (id: number | null) => setQuery({ scope: id });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Seg
          label="Show scopes" value={flt} onChange={setFlt}
          items={[
            { key: 'all', label: 'All', n: top.length },
            { key: 'gaps', label: 'Not covered', n: i.m.total - i.m.ok },
            { key: 'review', label: 'To review', n: top.filter((s) => cardChanged(f, s)).length },
            ...(i.m.remove ? [{ key: 'remove' as const, label: 'To remove', n: i.m.remove }] : []),
          ]}
        />
        <span style={{ flex: 1 }} />
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
        const all = top.filter((s) => s.groupId === g.id);
        if (g.id === null && !all.length) return null;
        // Scopes marked "To remove" go to the end of their group, in their own order.
        const list = [...all.filter((s) => shown(s) && !marked(s)), ...all.filter((s) => shown(s) && marked(s))];
        if (!list.length && (flt !== 'all' || g.id === null)) return null;
        const counted = all.flatMap(leaves).filter((s) => !marked(s));
        const ok = counted.filter((s) => status(s.id) === 'ok').length;
        return (
          <div key={g.id ?? 'none'} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="grp-title">
              {g.id === null ? (
                <h3 className="h3">{g.title}</h3>
              ) : (
                <InlineText label="Scope group name" className="h3" value={g.title} required="A group needs a name. The old name is back." onSave={(title) => act(() => mutate('PATCH', `${base}/scope-groups/${g.id}`, { title }), 'Group renamed')} />
              )}
              <span className="faint" style={{ fontSize: 12 }}>{counted.length ? `${ok} of ${counted.length} covered` : all.length ? 'All marked “To remove”' : 'No scope yet'}</span>
              {g.id !== null && (
                <button
                  className="icon-btn icon-danger" aria-label={`Delete group ${g.title}`} title="Delete group (its scopes stay, with no group)"
                  onClick={() => confirm(`Delete the group “${g.title}”? Its scopes stay, with no group.`) && act(() => mutate('DELETE', `${base}/scope-groups/${g.id}`), 'Group deleted')}
                ><ITrash s={14} /></button>
              )}
            </div>
            {list.map((s) => <ScopeRow key={s.id} t={t} f={f} s={s} shotsBy={shotsBy} open={openCard === s.id} onOpen={() => openTo(s.id)} />)}
          </div>
        );
      })}
      {/* The popup is outside the group lists: a filter or a new group does not close it or build it again. */}
      {popScope && (
        <ScopePopup
          key={popScope.id} t={t} f={f} s={popScope} openRow={openRow?.parentId === popScope.id ? openRow.id : null}
          setOpen={(on) => openTo(on ? popScope.id : null)} setRow={(id) => openTo(id ?? popScope.id)}
        />
      )}
      {!top.some(shown) && <div className="faint" style={{ fontSize: 13 }}>{top.length ? 'No scope matches this filter.' : 'No scope yet. A scope is one thing the feature does, like a test scenario.'}</div>}
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

/**
 * One scope. A scope with no variations has its own tests and screenshots. A scope with variations (one check
 * in several places) has a table instead: one line for each variation, with its SV- ID, its values, its
 * coverage and its tests. A line opens in place for the tests and screenshots of that variation. The scope
 * keeps the title, description, requirements, group and move: a variation has none of them.
 */
function ScopeRow({ t, f, s, shotsBy, open, onOpen }: { t: Tracker; f: FeatureX; s: ScopeX; shotsBy: Map<number, Screenshot[]>; open: boolean; onOpen: () => void }) {
  return (
    <div className={`scope${scopeToRemove(f, s) ? ' scope-marked' : ''}`} id={`scope-${s.id}`}>
      <div className="scope-head-wrap">
        <IdBtn label={`S-${s.id}`} text={`F-${f.id}/S-${s.id}`} />
        <button className="scope-head" onClick={onOpen} aria-haspopup="dialog" aria-expanded={open}>
          <span style={{ flex: 1, fontWeight: 500 }}>{s.title}</span>
          <ScopeStatusTags t={t} f={f} s={s} />
          <INext s={14} />
        </button>
      </div>
      {!scopeToRemove(f, s) && <RowShots p={t.project} shots={rowShots(f, s, shotsBy)} hasVars={!!s.columns} onMore={onOpen} />}
    </div>
  );
}

/** The screenshots of each scope or variation ID. The scopes tab makes it one time for all its rows. */
function shotsByScope(shots: Screenshot[]): Map<number, Screenshot[]> {
  const by = new Map<number, Screenshot[]>();
  for (const sh of shots) for (const id of sh.scopeIds) {
    const list = by.get(id);
    if (list) list.push(sh); else by.set(id, [sh]);
  }
  return by;
}

/** The screenshots of a scope and of its variations that are not marked "To remove", each one time. */
function rowShots(f: FeatureX, s: ScopeX, shotsBy: Map<number, Screenshot[]>): Screenshot[] {
  if (!s.columns) return shotsBy.get(s.id) ?? [];
  const vars = (variationsOf(f, s.id) as ScopeX[]).filter((v) => !scopeToRemove(f, v));
  const seen = new Map<number, Screenshot>();
  for (const id of [s.id, ...vars.map((v) => v.id)]) for (const sh of shotsBy.get(id) ?? []) seen.set(sh.id, sh);
  return [...seen.values()];
}

const ROW_SHOTS = 6;

/**
 * Small screenshots on a scope row, so a person sees them without opening the scope. A click shows one
 * at full size. After 6, a "+N" button opens the scope. Nothing when the scope has no screenshots.
 * The popup of a scope with variations shows the screenshots of a variation only when its line is open.
 */
function RowShots({ p, shots, hasVars, onMore }: { p: string; shots: Screenshot[]; hasVars: boolean; onMore: () => void }) {
  const [big, setBig] = useState<number | null>(null);
  const closeBig = useCallback(() => setBig(null), []);
  if (!shots.length) return null;
  const more = shots.length - ROW_SHOTS;
  return (
    <div className="row-shots">
      {shots.slice(0, ROW_SHOTS).map((sh) => (
        <button key={sh.id} className="row-shot" onClick={() => setBig(sh.id)} title={sh.caption || `IMG-${sh.id}: show full size`}>
          <img src={screenshotSmallUrl(p, sh.id)} alt={sh.caption || `Screenshot IMG-${sh.id}`} loading="lazy" />
        </button>
      ))}
      {more > 0 && <button className="row-shot row-shot-more" onClick={onMore} title={hasVars ? 'Open the scope. The screenshots are on each variation.' : 'Open the scope to see all screenshots'}>+{more}</button>}
      {big !== null && (
        <Lightbox src={screenshotUrl(p, big)} onClose={closeBig} />
      )}
    </div>
  );
}

/** The tags of a scope: changed, covered or not, "To remove", and the coverage of its variations. */
function ScopeStatusTags({ t, f, s }: { t: Tracker; f: FeatureX; s: ScopeX }) {
  const vars = s.columns ? (variationsOf(f, s.id) as ScopeX[]) : [];
  const st = scopeStatus(f, s.id, t.testById);
  const marked = scopeToRemove(f, s);
  const changed = cardChanged(f, s);
  const chgLabel = s.aiFields.length ? (s.aiFields.includes('title') && !(s.before && 'title' in s.before) ? 'New' : 'Changed') : 'Has changes';
  const links = f.links.filter((l) => l.scopeIds.includes(s.id));
  // Code of this scope that no linked test checks: a test to write.
  const codeNoTest = !s.columns && !links.length && !!t.codeMap?.features.find((x) => x.featureId === f.id)?.entries.some((e) => e.scopeIds.includes(s.id));
  const counted = vars.filter((v) => !scopeToRemove(f, v));
  const ok = counted.filter((v) => scopeStatus(f, v.id, t.testById) === 'ok').length;
  const covered = counted.length ? `${ok} of ${counted.length} covered` : vars.length ? 'All marked “To remove”' : 'No variation yet';
  return (
    <>
      {changed && <span className="tag tag-changed">{chgLabel}</span>}
      {s.columns ? (
        <>
          {marked && <span className="tag tag-remove" title={(s.toRemove ?? f.toRemove)?.reason}>To remove</span>}
          <span className="set-dots" aria-label={covered}>
            {vars.map((v) => <span key={v.id} className={`set-dot ${scopeToRemove(f, v) ? 'dot-remove' : `dot-${scopeStatus(f, v.id, t.testById)}`}`} title={`SV-${v.id} ${(v.values ?? []).filter(Boolean).join(', ')}`} />)}
          </span>
          <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{covered}</span>
        </>
      ) : marked ? (
        <span className="tag tag-remove" title={(s.toRemove ?? f.toRemove)?.reason}>To remove</span>
      ) : (
        <span className={`tag ${ST_TAG[st]}`}>{ST_LABEL[st]}</span>
      )}
      {codeNoTest && !marked && <span className="tag tag-skip" title="The AI put plugin code on this scope, but no test is linked to it. Write a test for it.">Code, no test</span>}
    </>
  );
}

/**
 * The popup of one scope. The scopes tab shows it outside the group lists, so it stays open when the
 * scope leaves the filter or goes to another group. Focus goes into it, Tab stays in it, and focus goes
 * back to the scope row when it closes.
 */
function ScopePopup({ t, f, s, openRow, setOpen, setRow }: {
  t: Tracker; f: FeatureX; s: ScopeX; openRow: number | null; setOpen: (on: boolean) => void; setRow: (id: number | null) => void;
}) {
  const p = t.project;
  const base = `/api/projects/${p}`;
  const url = `${base}/scopes/${s.id}`;
  const act = useAct();
  const vars = s.columns ? (variationsOf(f, s.id) as ScopeX[]) : [];
  const links = f.links.filter((l) => l.scopeIds.includes(s.id));
  const [addReq, setAddReq] = useState(false);
  const [modal, setModal] = useState<null | 'link' | 'move'>(null);
  const [starting, setStarting] = useState(false);
  const [mq, setMq] = useState('');
  const shots = f.screenshots.filter((x) => x.scopeIds.includes(s.id));
  const [big, setBig] = useState<number | null>(null);
  const closeBig = useCallback(() => setBig(null), []);
  const tags = <ScopeStatusTags t={t} f={f} s={s} />;
  const q = mq.trim().toLowerCase();
  const have = new Set(links.map((l) => l.testId));
  const close = useCallback(() => setOpen(false), [setOpen]);
  // A variation from the link (?scope=SV) shows in the popup in place of its scope. "Back" shows the scope again.
  const openVar = openRow === null ? null : vars.find((v) => v.id === openRow) ?? null;
  const popRef = useEscapeClose(close);
  // A switch between the scope and a variation starts at the top of the popup.
  useEffect(() => {
    popRef.current?.querySelector('.scope-pop-panel')?.scrollTo(0, 0);
  }, [openVar?.id, popRef]);
  // Focus goes into the popup when it opens, and back to the scope row when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    popRef.current?.querySelector<HTMLElement>('.scope-pop-panel')?.focus({ preventScroll: true });
    return () => {
      const row = document.querySelector<HTMLElement>(`#scope-${s.id} .scope-head`);
      (row ?? (before?.isConnected ? before : null))?.focus({ preventScroll: true });
    };
  }, [popRef, s.id]);
  // Tab and Shift+Tab stay in the popup.
  const keepTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1];
    const cur = document.activeElement;
    if (e.shiftKey && (cur === first || cur === e.currentTarget)) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && cur === last) (e.preventDefault(), first.focus());
  };
  const issues = scopeIssues(t, f, s.id);
  const openIssues = issues.filter(issueOpen);
  const createIssue = () =>
    (!openIssues.length || confirm(`S-${s.id} has an open issue already (${openIssues.map((x) => (x.number ? `#${x.number}` : 'being created')).join(', ')}). Create one more?`)) &&
    confirm(`Create a GitHub issue to write tests for S-${s.id} “${s.title}”?\n\nThe AI writes it with the create-issue skill, with no test plan, and posts it to the plugin repo on GitHub. This takes 1 to 2 minutes.`) &&
    act(() => mutate('POST', `${base}/features/${f.id}/issues`, { scopeId: s.id }), 'The AI creates the issue now. This takes 1 to 2 minutes.');
  const what = s.columns ? `scope S-${s.id} “${s.title}”, its ${vars.length} variation${vars.length === 1 ? '' : 's'}` : `scope S-${s.id} “${s.title}”`;
  return (
    <>
        <div className="overlay scope-pop" ref={popRef}>
          <button className="backdrop" onClick={close} aria-label="Close scope" tabIndex={-1} />
          <div className="panel scope-pop-panel" role="dialog" aria-modal="true" aria-label={`S-${s.id} ${s.title}`} tabIndex={-1} onKeyDown={keepTab}>
            {openVar ? (
            <div className="sp-head">
              <button className="icon-btn" onClick={() => setRow(null)} aria-label={`Back to S-${s.id}`} title={`Back to S-${s.id}`}><IPrev s={16} /></button>
              <IdBtn label={`SV-${openVar.id}`} text={`F-${f.id}/SV-${openVar.id}`} />
              <span className="sp-head-title">{(openVar.values ?? []).filter(Boolean).join(' · ') || 'No value'}</span>
              <button className="icon-btn" onClick={close} aria-label="Close scope" title="Close (Esc)"><IX s={16} /></button>
            </div>
            ) : (
            <div className="sp-head">
              <IdBtn label={`S-${s.id}`} text={`F-${f.id}/S-${s.id}`} />
              <select className="input sel-sm sp-group" aria-label="Scope group" title="Scope group" value={s.groupId == null ? 'none' : String(s.groupId)} onChange={(e) => act(() => mutate('PATCH', url, { groupId: e.target.value === 'none' ? null : Number(e.target.value) }), 'Scope moved to the group')}>
                <option value="none">No group</option>
                {f.scopeGroups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" onClick={close} aria-label="Close scope" title="Close (Esc)"><IX s={16} /></button>
            </div>
            )}
            {openVar ? (
              <VariationDetail key={openVar.id} t={t} f={f} s={s} v={openVar} />
            ) : (
            <div className="sp-main">
                <div className="sp-intro">
                <InlineText
                  id={`in-s${s.id}`} label="Scope title" className="ie-scope sp-title" value={s.title} required="A scope needs a title. The old title is back."
                  onSave={(title) => act(() => mutate('PATCH', url, { title }), s.columns ? 'Scope renamed. Its variations have new titles. The AI still knows the old titles.' : 'Scope renamed. The AI still knows it by its old title.', () => mutate('PATCH', url, { title: s.title }, { quiet: true }))}
                />
                <div className="sp-tags">{tags}</div>
                {s.toRemove ? (
                  <div className="remove-box">
                    <strong>To remove:</strong> <span>{s.toRemove.reason}</span>
                    <span className="faint">{removeWho(s.toRemove)}. Remove or move its tests, then delete or move the scope.</span>
                    <button className="btn btn-sm" onClick={() => act(() => mutate('PATCH', url, { toRemove: null }), `S-${s.id}: “To remove” mark cleared`, () => mutate('PATCH', url, { toRemove: s.toRemove }, { quiet: true }))}>Clear mark</button>
                  </div>
                ) : f.toRemove ? (
                  <div className="remove-box"><strong>To remove:</strong> <span>the whole feature has the mark.</span></div>
                ) : null}
                {s.before && 'title' in s.before && s.before.title && (
                  <div className="was-box"><strong>Title before the change:</strong> <span className="was-old">{s.before.title}</span></div>
                )}
                <InlineText
                  label="Scope description" className="ie-sdesc sp-desc" multi value={s.description} placeholder={s.columns ? 'Add a description for all variations: the steps, or what the user sees.' : 'Add a description: the steps, or what the user sees.'}
                  onSave={(description) => act(() => mutate('PATCH', url, { description }), 'Description saved', () => mutate('PATCH', url, { description: s.description }, { quiet: true }))}
                />
                </div>
                <section className="lc" aria-label="Requirements of this scope">
                  <div className="lc-head lc-head-row">
                    <div className="lc-titlerow">
                      <span className="lc-title">Requirements</span><span className="lc-count">{s.requirements.length}</span>
                    </div>
                    <button className="btn btn-ghost btn-sm add-btn" onClick={() => setAddReq(true)} aria-label="Add a requirement"><IPlus />Add</button>
                  </div>
                  {!s.requirements.length && !addReq && <div className="lc-empty">None yet.</div>}
                  {s.requirements.map((r) => <ItemRow key={r.id} t={t} item={r} bullet />)}
                  {addReq && (
                    <AddRow
                      placeholder="New requirement. Enter adds it." onClose={() => setAddReq(false)}
                      onAdd={async (text) => void (await act(() => mutate('POST', `${base}/features/${f.id}/items`, { kind: 'requirement', text, scopeId: s.id }), 'Requirement added'))}
                    />
                  )}
                </section>
                {s.columns ? (
                  <Variations t={t} f={f} s={s} vars={vars} setRow={setRow} />
                ) : (
                  <>
                    <ScopeShots p={p} shots={shots} onBig={setBig} />
                    <section className="lc" aria-label="Tests of this scope">
                      <div className="lc-head lc-head-row">
                        <div className="lc-titlerow"><span className="lc-title">Tests</span><span className="lc-count">{links.length}</span></div>
                        <button className="btn btn-ghost btn-sm add-btn" onClick={() => (setMq(''), setModal('link'))} aria-label="Link a test"><IPlus />Link</button>
                      </div>
                      {links.map((l) => <TestRow key={l.id} t={t} f={f} l={l} scopeId={s.id} />)}
                      {!links.length && <div className="lc-empty">None yet.</div>}
                    </section>
                    {starting && <StartVariations nTests={links.length} nShots={shots.length} onClose={() => setStarting(false)} onAdd={(columns, values) => act(() => mutate('POST', `${url}/variations`, { columns, values }), 'Variations added. Add one more for each place.')} />}
                  </>
                )}
                <section className="lc" aria-label="Issues of this scope">
                  <div className="lc-head lc-head-row">
                    <div className="lc-titlerow"><span className="lc-title">Issues</span><span className="lc-count">{issues.length}</span></div>
                    <span style={{ display: 'inline-flex', gap: 4 }}>
                      {!scopeToRemove(f, s) && <button className="btn btn-ghost btn-sm add-btn" onClick={createIssue} title="A GitHub issue to write tests for this scope, made by the AI with no test plan"><IPlus />Create test issue</button>}
                      <button className="btn btn-ghost btn-sm add-btn" onClick={() => addIssue(act, `${base}/features/${f.id}/issues/link`, { scopeId: s.id }, `S-${s.id}`)} title="Add an issue that is on GitHub to this scope" aria-label="Add an issue"><IPlus />Add</button>
                      <CheckIssuesButton project={p} />
                    </span>
                  </div>
                  <IssueList t={t} f={f} issues={issues} bare />
                  {!issues.length && !t.issuesError && <div className="lc-empty">None yet.</div>}
                </section>
                <div className="scope-foot">
                  {!s.columns && !starting && (
                    <button className="btn btn-sm" onClick={() => setStarting(true)} title="One check in several places, for example on 4 pages: a list with a line for each place">Add variations…</button>
                  )}
                  {!s.toRemove && (
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        const reason = askRemoveReason(`S-${s.id} “${s.title}”`);
                        if (reason) act(() => mutate('PATCH', url, { toRemove: reason }), `S-${s.id} marked “To remove”`, () => mutate('PATCH', url, { toRemove: null }, { quiet: true }));
                      }}
                    >Mark “To remove”…</button>
                  )}
                  <button className="btn btn-sm" onClick={() => (setMq(''), setModal('move'))}>Move to feature…</button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => confirm(`Delete ${what} and its requirements? Its tests stay linked to the feature. The AI will not add it again.`) &&
                      act(() => mutate('DELETE', url), `Scope S-${s.id} deleted. The AI will not add it again.`)}
                  >Delete</button>
                </div>
              </div>
            )}
          </div>
        </div>
      {big !== null && (
        <Lightbox src={screenshotUrl(p, big)} onClose={closeBig} />
      )}
      {modal === 'link' && (
        <LinkPicker t={t} have={have} title={`Link a test to S-${s.id}`} sub={`${s.title}. Tests in no feature come first.`} onClose={() => setModal(null)}
          onPick={(testId) => act(async () => (await mutate('POST', `${base}/links`, { testId, scopeId: s.id }), setModal(null)), `${testId} linked to S-${s.id}`)} />
      )}
      {modal === 'move' && (
        <Picker
          title={`Move S-${s.id} to another feature`}
          sub={s.columns ? 'Its variations, requirements, test links and screenshots go with it. The IDs stay.' : 'Its requirements, test links and screenshots go with it. It keeps its ID.'}
          q={mq} setQ={setMq} onClose={() => setModal(null)}
          rows={t.info
            .filter((x) => x.f.id !== f.id && (!q || x.f.title.toLowerCase().includes(q)))
            .map<PickRow>((x) => ({
              key: String(x.f.id), idLabel: `F-${x.f.id}`, title: x.f.title, sub: x.group,
              pick: () => act(async () => (await mutate('POST', `${url}/move`, { featureId: x.f.id }), setModal(null), setQuery({ scope: null })), `S-${s.id} moved to F-${x.f.id}`),
            }))}
        />
      )}
    </>
  );
}

/** Screenshots tagged with one scope or variation. Nothing when it has none. */
function ScopeShots({ p, shots, onBig }: { p: string; shots: Screenshot[]; onBig: (id: number) => void }) {
  if (!shots.length) return null;
  return (
    <section className="lc" aria-label="Screenshots">
      <div className="lc-head lc-head-row">
        <div className="lc-titlerow"><span className="lc-title">Screenshots</span><span className="lc-count">{shots.length}</span></div>
        <button className="btn btn-ghost btn-sm add-btn" onClick={() => setQuery({ tab: 'shots', scope: null })} title="Tag more screenshots on the Screenshots tab"><IPlus />Tag more</button>
      </div>
      <div className="scope-shots">
        {shots.map((sh) => (
          <button key={sh.id} className="scope-shot" onClick={() => onBig(sh.id)} title={sh.caption || `IMG-${sh.id}: show full size`}>
            <img src={screenshotUrl(p, sh.id)} alt={sh.caption || `Screenshot IMG-${sh.id}`} loading="lazy" />
          </button>
        ))}
      </div>
    </section>
  );
}

/** Pick a test to link. Tests in no feature come first. */
function LinkPicker({ t, have, title, sub, onPick, onClose }: { t: Tracker; have: Set<string>; title: string; sub: string; onPick: (testId: string) => void; onClose: () => void }) {
  const [mq, setMq] = useState('');
  const q = mq.trim().toLowerCase();
  return (
    <Picker
      title={title} sub={sub} q={mq} setQ={setMq} onClose={onClose}
      rows={t.tests
        .filter((x) => !have.has(x.id) && (!q || x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q) || x.file.toLowerCase().includes(q)))
        .sort((a, b) => (t.linkedTo.has(a.id) ? 1 : 0) - (t.linkedTo.has(b.id) ? 1 : 0))
        .slice(0, 40)
        .map<PickRow>((x) => {
          const l = t.linkedTo.get(x.id);
          return { key: x.id, idLabel: x.id, title: x.title, sub: x.file, tag: l ? `Also in F-${l[0].fid}` : 'In no feature', tagCls: l ? 'tag-ro' : 'tag-none', pick: () => onPick(x.id) };
        })}
    />
  );
}

/**
 * The variations of a scope, as a table: ID with copy button, the values and the coverage. The column
 * names are edited in the table header. A click on a line opens the variation in the popup (VariationDetail).
 */
function Variations({ t, f, s, vars, setRow }: {
  t: Tracker; f: FeatureX; s: ScopeX; vars: ScopeX[]; setRow: (id: number | null) => void;
}) {
  const url = `/api/projects/${t.project}/scopes/${s.id}`;
  const act = useAct();
  const [adding, setAdding] = useState(false);
  const columns = s.columns ?? [];
  const rename = (i: number, name: string) => act(() => mutate('PATCH', url, { columns: columns.map((c, k) => (k === i ? name : c)) }), 'Column renamed');
  return (
    <section className="lc" aria-label="Variations of this scope">
      <div className="lc-head lc-head-row">
        <div className="lc-titlerow"><span className="lc-title">Variations</span><span className="lc-count">{vars.length}</span></div>
        <Menu
          label="Variation actions"
          items={[
            {
              label: 'Add column…', hidden: columns.length >= 6,
              run: () => {
                const name = prompt('Name of the new column, for example “Product type”. The variations have no value in it until you set one.');
                if (name?.trim()) act(() => mutate('POST', `${url}/columns`, { name: name.trim() }), 'Column added');
              },
            },
            {
              label: 'Remove variations', hidden: vars.length > 1,
              run: () => confirm(`Remove the variations of S-${s.id}? ${vars.length ? `The tests and screenshots of SV-${vars[0].id} go back to the scope.` : ''}`) &&
                act(() => mutate('DELETE', `${url}/variations`), 'The scope has no variations now'),
            },
          ]}
        />
      </div>
      <div className="set-table-wrap">
        <table className="set-table">
          <thead>
            <tr>
              <th scope="col" className="set-th-id">ID</th>
              {columns.map((c, i) => (
                <th key={`${i}-${c}`} scope="col">
                  <span className="set-hcell">
                    <InlineText label={`Column name ${i + 1}`} className="ie-setcol" value={c} required="A column needs a name. The old name is back." onSave={(name) => rename(i, name)} />
                    {columns.length > 1 && (
                      <button
                        className="icon-btn" aria-label={`Delete column ${c}`} title="Delete this column. Each variation loses its value here."
                        onClick={() => confirm(`Delete the column “${c}”? Each variation loses its value in it, and the variation titles change.`) && act(() => mutate('DELETE', `${url}/columns/${i}`), 'Column deleted')}
                      ><IX s={12} /></button>
                    )}
                  </span>
                </th>
              ))}
              <th scope="col" className="set-th-cov">Coverage</th>
              <th scope="col" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => {
              const marked = scopeToRemove(f, v);
              const st = scopeStatus(f, v.id, t.testById);
              return (
                <tr key={v.id} className={`set-tr${marked ? ' scope-marked' : ''}`} id={`scope-${v.id}`} onClick={() => setRow(v.id)}>
                  <td className="set-td-id" onClick={(e) => e.stopPropagation()}><IdBtn label={`SV-${v.id}`} text={`F-${f.id}/SV-${v.id}`} /></td>
                  {columns.map((_, i) => <td key={i} className={v.values?.[i] ? '' : 'faint'}>{v.values?.[i] || '–'}</td>)}
                  <td className="set-th-cov">
                    <span className="set-tags">
                      {marked ? <span className="tag tag-remove" title={(v.toRemove ?? s.toRemove ?? f.toRemove)?.reason}>To remove</span> : <span className={`tag ${ST_TAG[st]}`}>{ST_LABEL[st]}</span>}
                      {scopeChanged(f, v) && <span className="tag tag-changed">{v.aiFields.includes('title') ? 'New' : 'Changed'}</span>}
                    </span>
                  </td>
                  <td className="set-chev">
                    <button className="icon-btn" aria-label={`Open SV-${v.id}`} onClick={(e) => (e.stopPropagation(), setRow(v.id))}><INext s={14} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {adding ? (
        <VariationForm columns={columns} onAdd={(values) => act(() => mutate('POST', `${url}/variations`, { values }), 'Variation added')} onClose={() => setAdding(false)} />
      ) : (
        <div><button className="btn btn-ghost btn-sm add-btn" onClick={() => setAdding(true)}><IPlus />Add variation</button></div>
      )}
    </section>
  );
}

/**
 * One variation, shown in the scope popup in place of its scope: its values, screenshots and tests.
 * Its scope has the text, requirements, group and move.
 */
function VariationDetail({ t, f, s, v }: { t: Tracker; f: FeatureX; s: ScopeX; v: ScopeX }) {
  const p = t.project;
  const base = `/api/projects/${p}`;
  const url = `${base}/scopes/${v.id}`;
  const act = useAct();
  const links = f.links.filter((l) => l.scopeIds.includes(v.id));
  const shots = f.screenshots.filter((x) => x.scopeIds.includes(v.id));
  const [linking, setLinking] = useState(false);
  const [big, setBig] = useState<number | null>(null);
  const closeBig = useCallback(() => setBig(null), []);
  const columns = s.columns ?? [];
  const shown = (v.values ?? []).filter(Boolean).join(', ');
  const setValue = (i: number, x: string) => act(() => mutate('PATCH', url, { values: columns.map((_, k) => (k === i ? x : (v.values?.[k] ?? ''))) }), 'Value changed');
  return (
    <div className="sp-main">
      {v.toRemove ? (
        <div className="remove-box">
          <strong>To remove:</strong> <span>{v.toRemove.reason}</span>
          <span className="faint">{removeWho(v.toRemove)}. Remove or move its tests, then delete the variation.</span>
          <button className="btn btn-sm" onClick={() => act(() => mutate('PATCH', url, { toRemove: null }), `SV-${v.id}: “To remove” mark cleared`)}>Clear mark</button>
        </div>
      ) : s.toRemove || f.toRemove ? (
        <div className="remove-box"><strong>To remove:</strong> <span>{s.toRemove ? `its scope S-${s.id} has the mark.` : 'the whole feature has the mark.'}</span></div>
      ) : null}
      <section className="lc" aria-label="Values of this variation">
        <div className="lc-head lc-head-row">
          <div className="lc-titlerow"><span className="lc-title">Values</span></div>
        </div>
        <div className="set-fields">
          {columns.map((c, i) => (
            <label key={`${i}-${c}`} className="set-field">
              <span className="set-field-name">{c}</span>
              <InlineText label={c} className="ie-setval" value={v.values?.[i] ?? ''} placeholder="Does not apply" onSave={(x) => setValue(i, x)} />
            </label>
          ))}
        </div>
      </section>
      <ScopeShots p={p} shots={shots} onBig={setBig} />
      <section className="lc" aria-label="Tests of this variation">
        <div className="lc-head lc-head-row">
          <div className="lc-titlerow"><span className="lc-title">Tests</span><span className="lc-count">{links.length}</span></div>
          <button className="btn btn-ghost btn-sm add-btn" onClick={() => setLinking(true)} aria-label="Link a test"><IPlus />Link</button>
        </div>
        {links.map((l) => <TestRow key={l.id} t={t} f={f} l={l} scopeId={v.id} />)}
        {!links.length && <div className="lc-empty">None yet.</div>}
      </section>
      <div className="scope-foot">
        <span style={{ marginRight: 'auto' }} />
        {!v.toRemove && (
          <button
            className="btn btn-sm"
            onClick={() => {
              const reason = askRemoveReason(`SV-${v.id} (${shown})`);
              if (reason) act(() => mutate('PATCH', url, { toRemove: reason }), `SV-${v.id} marked “To remove”`);
            }}
          >Mark “To remove”…</button>
        )}
        <button
          className="btn btn-sm btn-danger"
          onClick={() => confirm(`Delete variation SV-${v.id} (${shown})? Its tests stay linked to the feature. The AI will not add it again.`) &&
            act(async () => (await mutate('DELETE', url), setQuery({ scope: s.id })), `Variation SV-${v.id} deleted. The AI will not add it again.`)}
        >Delete variation</button>
      </div>
      {big !== null && (
        <Lightbox src={screenshotUrl(p, big)} onClose={closeBig} />
      )}
      {linking && (
        <LinkPicker t={t} have={new Set(links.map((l) => l.testId))} title={`Link a test to SV-${v.id}`} sub={`${v.title}. Tests in no feature come first.`} onClose={() => setLinking(false)}
          onPick={(testId) => act(async () => (await mutate('POST', `${base}/links`, { testId, scopeId: v.id }), setLinking(false)), `${testId} linked to SV-${v.id}`)} />
      )}
    </div>
  );
}

/** One field for each column. Enter or "Add" adds the variation, and the form stays for the next one. */
function VariationForm({ columns, onAdd, onClose }: { columns: string[]; onAdd: (values: string[]) => Promise<unknown>; onClose: () => void }) {
  const [typed, setVals] = useState<string[]>([]);
  // One value for each column now: a column added while the form is open gets an empty field.
  const vals = columns.map((_, i) => typed[i] ?? '');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const add = async () => {
    if (!vals.some((v) => v.trim())) return;
    await onAdd(vals.map((v) => v.trim()));
    setVals(columns.map(() => ''));
    first.current?.focus();
  };
  return (
    <form className="set-form" onSubmit={(e) => (e.preventDefault(), void add())} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      {columns.map((c, i) => (
        <input
          key={i} ref={i === 0 ? first : undefined} className="input set-cell" aria-label={c} placeholder={c} value={vals[i]}
          onChange={(e) => setVals(vals.map((v, k) => (k === i ? e.target.value : v)))}
        />
      ))}
      <button className="btn btn-sm btn-ok" type="submit" disabled={!vals.some((v) => v.trim())}>Add</button>
      <button className="btn btn-sm" type="button" onClick={onClose}>Close</button>
    </form>
  );
}

/**
 * Turns a scope into a scope with variations: the name of the first column and the value of the first
 * variation. The scope's tests and screenshots go to that first variation.
 */
function StartVariations({ nTests, nShots, onAdd, onClose }: { nTests: number; nShots: number; onAdd: (columns: string[], values: string[]) => Promise<unknown>; onClose: () => void }) {
  const [col, setCol] = useState('Page');
  const [val, setVal] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const moves = [nTests ? `${nTests} test${nTests === 1 ? '' : 's'}` : '', nShots ? `${nShots} screenshot${nShots === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  return (
    <form
      className="lc start-vars" onKeyDown={(e) => e.key === 'Escape' && onClose()}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!col.trim() || !val.trim()) return;
        await onAdd([col.trim()], [val.trim()]);
        onClose();
      }}
    >
      <div className="lc-head">
        <div className="lc-titlerow"><span className="lc-title">Add variations</span></div>
        <span className="lc-sub">
          One check in several places, for example on 4 pages. Name the column, then the first place. {moves ? `The ${moves} of this scope go to this first variation.` : ''} You can add more columns later.
        </span>
      </div>
      <div className="set-form">
        <label className="set-value"><span className="faint">Column</span><input ref={first} className="input set-cell" aria-label="Column name" value={col} onChange={(e) => setCol(e.target.value)} /></label>
        <label className="set-value"><span className="faint">First variation</span><input className="input set-cell" aria-label="Value of the first variation" placeholder="For example “Shop page”" value={val} onChange={(e) => setVal(e.target.value)} /></label>
        <button className="btn btn-sm btn-ok" type="submit" disabled={!col.trim() || !val.trim()}>Add</button>
        <button className="btn btn-sm" type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/** One linked test. scopeId: the scope or variation it shows under (null: a link to the whole feature). */
function TestRow({ t, f, l, scopeId }: { t: Tracker; f: FeatureX; l: FeatureLink; scopeId: number | null }) {
  const p = t.project;
  const base = `/api/projects/${p}`;
  const act = useAct();
  const [pick, setPick] = useState(false);
  const [mq, setMq] = useState('');
  const x = t.testById.get(l.testId);
  const fw = l.framework === 'cypress';
  const [stLabel, stCls] = l.missing ? ['Gone', 'tag-fail'] : fw ? ['Cypress', 'tag-cy'] : x?.skipped ? ['Skipped', 'tag-skip'] : x?.result === 'failed' ? ['Failing', 'tag-fail'] : ['Playwright', 'tag-ok'];
  const code = (id: number) => scopeIdLabel(f, id);
  const unlink = () => {
    const rest = l.scopeIds.filter((id) => id !== scopeId);
    if (scopeId !== null && rest.length) {
      return act(() => mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: rest }), `${l.testId} unlinked from ${code(scopeId)}`, () => mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: l.scopeIds }, { quiet: true }));
    }
    return act(() => mutate('DELETE', `${base}/links/${l.id}`), `${l.testId} unlinked. The AI will not link it again.`);
  };
  const backLabel = scopeId ? `Back to F-${f.id} / ${code(scopeId)}` : `Back to F-${f.id}`;
  const q = mq.trim().toLowerCase();
  // A scope with variations takes no test itself: its row puts the test on all its variations.
  const pickRows: PickRow[] = [];
  for (const s of f.scopes.filter((y) => y.parentId === null)) {
    const vars = s.columns ? variationsOf(f, s.id) : [];
    const hit = (y: { id: number; title: string }) => !q || y.title.toLowerCase().includes(q) || code(y.id).toLowerCase() === q;
    if (s.columns) {
      if (vars.length && (hit(s) || vars.some(hit)))
        pickRows.push({
          key: String(s.id), idLabel: `S-${s.id}`, title: `${s.title} · all ${vars.length} variations`,
          pick: () => act(async () => (await mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: vars.map((v) => v.id) }), setPick(false)), `${l.testId} put on ${vars.map((v) => `SV-${v.id}`).join(', ')}`),
        });
      for (const v of vars.filter((y) => hit(s) || hit(y)))
        pickRows.push({
          key: String(v.id), idLabel: `SV-${v.id}`, title: v.title, tag: scopeLinks(f, v.id).length ? undefined : 'No test yet', tagCls: 'tag-none',
          pick: () => act(async () => (await mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: [v.id] }), setPick(false)), `${l.testId} put on SV-${v.id}`),
        });
    } else if (hit(s))
      pickRows.push({
        key: String(s.id), idLabel: `S-${s.id}`, title: s.title, tag: scopeLinks(f, s.id).length ? undefined : 'No test yet', tagCls: 'tag-none',
        pick: () => act(async () => (await mutate('PATCH', `${base}/links/${l.id}`, { scopeIds: [s.id] }), setPick(false)), `${l.testId} put on S-${s.id}`),
      });
  }
  return (
    <div className="lc-row">
      <span className={`tag ${stCls}`} style={{ marginTop: 1 }}>{stLabel}</span>
      <span className="lc-text">
        {l.missing ? <span>{l.title ?? l.testId}</span> : <a className="linkbtn" href={withBack(link(p, 'test', l.testId), backLabel)}>{x?.title ?? l.title ?? l.testId}</a>}
        <span className="mono faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.testId}{l.scopeIds.length > 1 ? ` · also in ${l.scopeIds.filter((id) => id !== scopeId).map(code).join(', ')}` : ''}</span>
      </span>
      {l.missing ? (
        <span className="tag tag-fail" title="The test is not in the repo now. It was deleted or renamed.">{KIND_LABEL.gone}</span>
      ) : l.source === 'ai' && !l.checked ? (
        <span className="tag tag-new" title="Linked since the last review.">New</span>
      ) : null}
      <span className="row-acts">
        {scopeId === null && <button className="btn btn-ghost btn-sm" onClick={() => (setMq(''), setPick(true))}>Put on a scope</button>}
        <button className="btn btn-ghost btn-sm" onClick={unlink}>Unlink</button>
      </span>
      {pick && <Picker title={`Put ${l.testId} on a scope of F-${f.id}`} sub={x?.title} q={mq} setQ={setMq} onClose={() => setPick(false)} rows={pickRows} />}
    </div>
  );
}

/** A list item or scope requirement: edit in place, remove. "New" shows until the feature is reviewed. */
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
      {item.aiDraft && <span className="tag tag-new" title="Added by the AI since the last review.">New</span>}
      <span className="row-acts">
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
                  {e.scopeIds.map((id) => <span key={id} className="tag tag-ro" title={f.scopes.find((s) => s.id === id)?.title}>{scopeIdLabel(f, id)}</span>)}
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
  const closeBig = useCallback(() => setBig(null), []);
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
              {sh.aiDraft && (sh.aiChange.length ? <span className="tag tag-changed">Changed by AI</span> : <span className="tag tag-new">New</span>)}
              {sh.stale && <span className="tag tag-fail" title={sh.stale}>Needs a new image</span>}
            </div>
            <InlineText label="Caption" className="ie-item" multi value={sh.caption} placeholder="Add a caption: what the image shows." onSave={(caption) => act(() => mutate('PATCH', `${base}/screenshots/${sh.id}`, { caption }), 'Caption saved')} />
          </figcaption>
          <div className="shot-tags">
            {sh.scopeIds.map((id) => <span key={id} className="tag tag-ro mono" title={f.scopes.find((s) => s.id === id)?.title}>{scopeIdLabel(f, id)}</span>)}
            <button className="btn btn-ghost btn-sm add-btn" onClick={() => setTagging(sh)}>{sh.scopeIds.length ? 'Change scopes' : 'Tag scopes'}</button>
          </div>
        </figure>
      ))}
      <button className="shot-add" onClick={() => file.current?.click()}><IPlus s={16} />Add a screenshot (or paste one)</button>
      <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => (void upload(e.target.files), (e.target.value = ''))} />
      {big !== null && (
        <Lightbox src={screenshotUrl(p, big)} onClose={closeBig} />
      )}
      {tagging && (
        <ScopeTags f={f} title={`Scopes that IMG-${tagging.id} shows`} sub="No scope: the image shows the feature in general." ids={tagging.scopeIds}
          url={`/api/projects/${t.project}/screenshots/${tagging.id}`} onClose={() => setTagging(null)} />
      )}
    </div>
  );
}

/**
 * A dialog to choose the scopes of a screenshot or a code entry. A scope with variations takes no tag itself:
 * its box "All variations" ticks each of its variations.
 */
function ScopeTags({ f, title, sub, ids, url, onClose }: { f: FeatureX; title: string; sub: string; ids: number[]; url: string; onClose: () => void }) {
  const act = useAct();
  const [sel, setSel] = useState(new Set(ids.filter((id) => !f.scopes.find((s) => s.id === id)?.columns)));
  const flip = (list: number[], on: boolean) => setSel((s) => {
    const n = new Set(s);
    for (const id of list) on ? n.add(id) : n.delete(id);
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
      {f.scopes.filter((s) => s.parentId === null).map((s) => {
        if (!s.columns) {
          return (
            <label key={s.id} className="check-row">
              <input type="checkbox" checked={sel.has(s.id)} onChange={() => flip([s.id], !sel.has(s.id))} />
              <span className="mono faint">S-{s.id}</span>
              <span>{s.title}</span>
            </label>
          );
        }
        const vars = variationsOf(f, s.id);
        const all = vars.length > 0 && vars.every((v) => sel.has(v.id));
        return (
          <Fragment key={s.id}>
            <label className="check-row">
              <input type="checkbox" checked={all} disabled={!vars.length} onChange={() => flip(vars.map((v) => v.id), !all)} />
              <span className="mono faint">S-{s.id}</span>
              <span>{s.title} <span className="faint">· all variations</span></span>
            </label>
            {vars.map((v) => (
              <label key={v.id} className="check-row check-sub">
                <input type="checkbox" checked={sel.has(v.id)} onChange={() => flip([v.id], !sel.has(v.id))} />
                <span className="mono faint">SV-{v.id}</span>
                <span>{(v.values ?? []).filter(Boolean).join(', ')}</span>
              </label>
            ))}
          </Fragment>
        );
      })}
    </Dialog>
  );
}

/** Asks for the reason of a "To remove" mark. Null: the person cancelled or typed nothing. */
function askRemoveReason(what: string): string | null {
  const r = prompt(`Why must ${what} go? Its tests stay linked until you remove them. It leaves the coverage counts, and the AI does not add to it.`);
  return r?.trim() || null;
}

/** Who set the mark, and when. */
function removeWho(m: { at: string; by: 'person' | 'ai' }) {
  const day = new Date(m.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${m.by === 'ai' ? 'Set by the AI for a person' : 'Set by a person'} on ${day}`;
}

/* ================= GitHub issues ================= */

/** Asks for an issue that is on GitHub, and adds it to the feature or scope. The server checks it on GitHub first. */
function addIssue(act: ReturnType<typeof useAct>, url: string, body: object, what: string) {
  const issue = prompt(`GitHub issue to add to ${what}.\nType an issue number of the plugin repo (1162), owner/repo#12, or paste an issue link.`);
  if (!issue?.trim()) return;
  act(() => mutate('POST', url, { ...body, issue: issue.trim() }), `Issue added to ${what}`);
}

const PR_TAG: Record<string, [string, string]> = { OPEN: ['tag-new', 'Open'], MERGED: ['tag-ai', 'Merged'], CLOSED: ['tag-ro', 'Closed'] };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Checks all open issues of the project on GitHub now: one call for each repo, so it costs the same as one issue. */
function CheckIssuesButton({ project }: { project: string }) {
  const say = useSay();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const { checked: n, notFound } = await mutate<{ checked: number; notFound: number }>('POST', `/api/projects/${project}/issues/sync`);
      say(!n ? 'No open issues to check' : `Checked ${n} open issue${n === 1 ? '' : 's'} on GitHub${notFound ? `, ${notFound} not found on GitHub` : ''}`);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-ghost btn-sm add-btn" onClick={run} disabled={busy} title="Check the state and linked PRs of all open issues of the project on GitHub now, not only the issues here. The app also does this at the daily sync interval (24 hours by default)." aria-label="Check the issues on GitHub">
      <IRefresh />{busy ? 'Checking…' : 'Check GitHub'}
    </button>
  );
}

/**
 * GitHub issues that the app made for scopes with no test: the issue, its state, and its linked pull
 * requests. The daily sync checks the open issues again. A failed run can be taken off the list.
 */
function IssueList({ t, f, issues, bare, actions }: { t: Tracker; f: FeatureX; issues: TrackedIssue[]; bare?: boolean; actions?: React.ReactNode }) {
  const act = useAct();
  const forget = (x: TrackedIssue, msg: string) => act(() => mutate('DELETE', `/api/projects/${t.project}/issues/${x.id}`), msg);
  return (
    <div className={bare ? '' : 'issue-box'} aria-label={bare ? undefined : 'Issues of this feature'}>
      {!bare && (
        <div className="issue-box-head">
          <span className="faint issue-box-title">Issues{issues.length ? ` ${issues.length}` : ''}</span>
          <span style={{ flex: 1 }} />
          {actions}
        </div>
      )}
      {t.issuesError && <div className="err" style={{ fontSize: 13 }}>{t.issuesError}</div>}
      {!bare && !issues.length && !t.issuesError && <div className="faint" style={{ fontSize: 13 }}>None yet.</div>}
      {issues.map((x) => (
        <div key={x.id} className="issue-row">
          {x.status === 'creating' ? (
            <><span className="tag tag-changed">Creating…</span><span className="muted">The AI writes the issue on GitHub.</span></>
          ) : x.status === 'failed' ? (
            <>
              <span className="tag tag-fail">Not created</span>
              <span className="muted issue-err">{x.error}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => forget(x, 'Removed from the list')}>Remove</button>
            </>
          ) : (
            <>
              <a href={x.url ?? undefined} target="_blank" rel="noreferrer" className="issue-link" title={`Open ${x.repo}#${x.number} on GitHub (new tab)`}>
                <span className="mono">#{x.number}</span> <span className="issue-title">{x.title}</span>
              </a>
              <span className={`tag ${x.state === 'CLOSED' ? 'tag-ok' : 'tag-new'}`}>{x.state === 'CLOSED' ? 'Closed' : 'Open'}</span>
              {x.prs.map((pr) => (
                <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer" className={`tag ${PR_TAG[pr.state]?.[0] ?? 'tag-ro'}`} style={{ textDecoration: 'none' }} title={pr.title}>
                  PR #{pr.number} {PR_TAG[pr.state]?.[1] ?? pr.state}
                </a>
              ))}
              {!x.prs.length && <span className="faint">No PR yet</span>}
              {x.error && <span className="muted issue-err">{x.error}</span>}
              {x.kind === 'automation-plan' && (
                x.planStatus === 'writing' ? <span className="tag tag-changed" title="The AI writes the test plan and puts it into the issue. This takes some minutes.">Writing the plan…</span>
                : x.planStatus === 'added' ? <span className="tag tag-ok">Plan added</span>
                : (
                  <>
                    {x.planStatus === 'failed' && <span className="tag tag-fail" title={x.planError ?? undefined}>Plan failed</span>}
                    {x.planStatus === 'failed' && x.planError && <span className="muted issue-err">{x.planError}</span>}
                    <button className="btn btn-ghost btn-sm" title="The AI writes the test plan from the tracker facts and screenshots, and puts it into the issue"
                      onClick={() => act(() => mutate('POST', `/api/projects/${t.project}/issues/${x.id}/plan`, {}), 'The AI writes the plan')}>
                      {x.planStatus === 'failed' ? 'Try the plan again' : 'Add plan'}
                    </button>
                  </>
                )
              )}
            </>
          )}
          <span style={{ flex: 1 }} />
          <span className="faint issue-meta" title={x.syncedAt ? `Last check on GitHub: ${day(x.syncedAt)}` : undefined}>
            {x.scopeIds.map((id) => anyScopeLabel(t, id)).join(', ')}
            {x.status === 'created' && x.syncedAt ? ` · checked ${day(x.syncedAt)}` : ''}
          </span>
          {x.status === 'created' && (
            <button
              className="icon-btn" aria-label={`Take #${x.number} off the tracker`} title="Take off the tracker (the issue on GitHub stays)"
              onClick={() => confirm(`Take issue #${x.number} off the tracker? The issue on GitHub stays.`) && forget(x, `#${x.number} taken off the tracker`)}
            ><IX s={14} /></button>
          )}
        </div>
      ))}
    </div>
  );
}
