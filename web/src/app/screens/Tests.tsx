import { useState } from 'react';
import { mutate, pct } from '../../api';
import { scopeToRemove, scopesToTest, testToRemove, type TestInfo, type Tracker } from '../data';
import { link, setQuery, useSticky, withBack, type Route } from '../route';
import { ILock, Picker, Seg, useAct, type PickRow } from '../ui';

type Show = 'none' | 'all' | 'skipped' | 'failed' | 'new' | 'remove';

export function testTag(x: TestInfo | undefined): [string, string] {
  if (!x) return ['Gone', 'tag-fail'];
  if (x.skipped) return ['Skipped', 'tag-skip'];
  if (x.result === 'failed') return ['Failing', 'tag-fail'];
  return ['Active', 'tag-ok'];
}

/**
 * How many tests ran plugin code in the last coverage run.
 * ran: tests with at least one run entry that ran a plugin function. inRun: tests that were in the run.
 */
function codeShare(tests: TestInfo[]) {
  const runs = (x: TestInfo) => x.pw?.run ?? x.cy?.run ?? [];
  return {
    total: tests.length,
    inRun: tests.filter((x) => runs(x).length).length,
    ran: tests.filter((x) => runs(x).some((r) => r.functions > 0)).length,
  };
}

/** Test order of the list as it shows now: the test page uses it for "Previous" and "Next". */
export let testOrder: string[] = [];

/** "To remove" badge of a test that is linked only to marked items. A Cypress test must not be converted. */
export function RemoveTag({ t, x }: { t: Tracker; x: TestInfo }) {
  if (!testToRemove(t, x.id)) return null;
  return (
    <span className="tag tag-remove" title="All its links are to scopes or features marked “To remove”. Delete the test, or link it to a scope that stays.">
      {x.fw === 'cypress' ? 'To remove, do not convert' : 'To remove'}
    </span>
  );
}

/** Links of a test, as "F-3/S-16 title" lines. */
export function TestLinks({ t, x, backLabel }: { t: Tracker; x: TestInfo; backLabel: string }) {
  const ls = t.linkedTo.get(x.id) ?? [];
  if (!ls.length) return <span className="tag tag-none">In no feature</span>;
  return (
    <>
      {ls.flatMap(({ fid, ftitle, link: l }) => {
        const f = t.infoById.get(fid)?.f;
        if (!l.scopeIds.length) {
          return [
            <div key={`${fid}`}>
              <a className="linkbtn mono" href={withBack(link(t.project, 'feature', fid), backLabel)}>F-{fid}</a>{' '}
              <span className="faint" style={{ fontSize: 12 }}>{ftitle} (the whole feature)</span>
              {f?.toRemove && <span className="tag tag-remove" style={{ marginLeft: 6 }}>To remove</span>}
            </div>,
          ];
        }
        return l.scopeIds.map((sid) => (
          <div key={`${fid}/${sid}`}>
            <a className="linkbtn mono" href={withBack(link(t.project, 'feature', fid, { scope: sid }), backLabel)}>F-{fid}/S-{sid}</a>{' '}
            <span className="faint" style={{ fontSize: 12 }}>{f?.scopes.find((s) => s.id === sid)?.title}</span>
            {(f?.toRemove || f?.scopes.find((s) => s.id === sid)?.toRemove) && <span className="tag tag-remove" style={{ marginLeft: 6 }}>To remove</span>}
            {l.source === 'ai' && !l.checked && <span className="tag tag-new" style={{ marginLeft: 6 }}>New</span>}
          </div>
        ));
      })}
    </>
  );
}

/** Picker: link a test to a scope of any feature. Scopes with no test come first. */
export function LinkToScope({ t, x, onClose }: { t: Tracker; x: TestInfo; onClose: () => void }) {
  const act = useAct();
  const [mq, setMq] = useState('');
  const q = mq.trim().toLowerCase();
  const rows: (PickRow & { empty: boolean })[] = [];
  for (const i of t.info) {
    for (const s of i.f.scopes) {
      const links = i.f.links.filter((l) => !l.missing && l.scopeIds.includes(s.id));
      if (links.some((l) => l.testId === x.id)) continue;
      if (scopeToRemove(i.f, s)) continue; // a scope that must go takes no new test
      if (q && !(s.title.toLowerCase().includes(q) || i.f.title.toLowerCase().includes(q) || `s-${s.id}` === q || `f-${i.f.id}/s-${s.id}` === q)) continue;
      rows.push({
        key: `${i.f.id}/${s.id}`, idLabel: `F-${i.f.id}/S-${s.id}`, title: s.title, sub: i.f.title, empty: !links.length,
        tag: links.length ? undefined : 'No test yet', tagCls: 'tag-none',
        pick: () => act(async () => (await mutate('POST', `/api/projects/${t.project}/links`, { testId: x.id, scopeId: s.id }), onClose()), `${x.id} linked to F-${i.f.id}/S-${s.id}`),
      });
    }
  }
  rows.sort((a, b) => Number(b.empty) - Number(a.empty));
  return <Picker title={`Link ${x.id} to a scope`} sub={`${x.title}. This changes the feature. The test stays as it is.`} q={mq} setQ={setMq} onClose={onClose} rows={rows.slice(0, 60)} />;
}

export function Tests({ t, route }: { t: Tracker; route: Route }) {
  const asked = (route.q.get('show') as Show) || 'none';
  // The "To remove" button goes when no test is left in it: show the default list again.
  const show: Show = asked === 'remove' && !t.tests.some((x) => testToRemove(t, x.id)) ? 'none' : asked;
  const [tq, setTq] = useSticky('tests.q', '');
  const [pick, setPick] = useState<TestInfo | null>(null);
  const ql = tq.trim().toLowerCase();
  const is = (k: Show, x: TestInfo) =>
    k === 'all' || (k === 'none' && !t.linkedTo.has(x.id)) || (k === 'skipped' && x.skipped) || (k === 'failed' && x.result === 'failed' && !x.skipped) || (k === 'new' && t.newTests.has(x.id)) || (k === 'remove' && testToRemove(t, x.id));
  const rows = t.tests.filter((x) => is(show, x) && (!ql || x.id.toLowerCase().includes(ql) || x.title.toLowerCase().includes(ql) || x.file.toLowerCase().includes(ql)));
  testOrder = rows.map((x) => x.id);
  const n = (k: Show) => t.tests.filter((x) => is(k, x)).length;
  const items: { key: Show; label: string; n: number }[] = [
    { key: 'none', label: 'In no feature', n: n('none') },
    { key: 'all', label: 'All', n: t.tests.length },
    { key: 'skipped', label: 'Skipped', n: n('skipped') },
    ...(n('failed') ? [{ key: 'failed' as Show, label: 'Failing', n: n('failed') }] : []),
    ...(t.newTests.size ? [{ key: 'new' as Show, label: 'New in last sync', n: n('new') }] : []),
    ...(n('remove') ? [{ key: 'remove' as Show, label: 'To remove', n: n('remove') }] : []),
  ];
  const pw = t.tests.filter((x) => x.fw === 'playwright').length;
  const cards = (['playwright', 'cypress'] as const).map((fw) => ({ fw, ...codeShare(t.tests.filter((x) => x.fw === fw)) }));
  const toTest = scopesToTest(t);
  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 className="h1">Tests</h1>
        <div className="banner">
          <ILock s={16} />
          The tests come from the plugin repo, so you can't edit them here. Linking a test to a scope changes only the feature.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {cards.map(({ fw, total, ran, inRun }) => (
          <div className="stat" key={fw}>
            <span className="stat-l">{fw === 'playwright' ? 'Playwright tests that ran plugin code' : 'Cypress scenarios that ran plugin code'}</span>
            <span className="stat-v">{inRun ? `${pct(ran, total)}%` : '–'}</span>
            <span className="faint" style={{ fontSize: 12 }}>
              {!total ? 'No tests.' : inRun ? `${ran} of ${total}. ${total - inRun ? `${total - inRun} were not in the last coverage run.` : ''}` : 'No coverage run yet.'}
            </span>
          </div>
        ))}
      </div>
      {toTest.length > 0 && (
        <details className="card" style={{ padding: '12px 16px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Scopes to write tests for <span className="faint" style={{ fontWeight: 400 }}>{toTest.length}</span></summary>
          <p className="faint" style={{ fontSize: 13, margin: '8px 0' }}>
            The AI put plugin code on these scopes, but no test is linked to them. A new test for one of them covers code that no test runs now. Most code first.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            {toTest.map((x) => (
              <li key={x.sid}>
                <a className="linkbtn" href={link(t.project, 'feature', x.fid, { scope: x.sid })}>{x.scope}</a>{' '}
                <span className="faint">in F-{x.fid} {x.feature} · {x.code} code {x.code === 1 ? 'entry' : 'entries'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Seg label="Show tests" value={show} onChange={(k) => setQuery({ show: k === 'none' ? null : k })} items={items} />
        <label className="sr" htmlFor="tq">Filter tests</label>
        <input id="tq" className="input" style={{ flex: '1 1 240px', maxWidth: 420 }} placeholder="Filter by title, file or ID" value={tq} onChange={(e) => setTq(e.target.value)} />
        <span className="faint" style={{ fontSize: 12 }}>{pw} Playwright tests and {t.tests.length - pw} Cypress scenarios.</span>
      </div>
      <div className="card table-box">
        <div className="gt" role="table" aria-label="Tests">
          <div className="gr gh cols-test" role="row"><span role="columnheader">Status</span><span role="columnheader">Test</span><span role="columnheader">Linked to scope</span></div>
          {rows.map((x) => {
            const [label, cls] = testTag(x);
            return (
              <div className="gr cols-test fl-row" role="row" key={x.id}>
                <div role="cell"><span className={`tag ${cls}`}>{label}</span></div>
                <div role="cell" style={{ minWidth: 0 }}>
                  <div>
                    <a className="rowbtn" href={link(t.project, 'test', x.id)} style={{ display: 'inline', textDecoration: 'none' }}>{x.title}</a>{' '}
                    {x.fw === 'cypress' && <span className="tag tag-cy">Cypress</span>} {t.newTests.has(x.id) && <span className="tag tag-new">New</span>}{' '}
                    <RemoveTag t={t} x={x} />
                  </div>
                  <div className="mono faint" style={{ overflowWrap: 'anywhere' }}>{x.id} · {x.file}</div>
                </div>
                <div role="cell" style={{ minWidth: 0 }}>
                  <TestLinks t={t} x={x} backLabel="Back to Tests" />
                  <div style={{ marginTop: 6 }}><button className="btn btn-sm" onClick={() => setPick(x)}>Link to a scope</button></div>
                </div>
              </div>
            );
          })}
          {!rows.length && <div className="faint" style={{ padding: 16, fontSize: 13 }}>No test matches. {show === 'none' ? 'Every test is in a feature.' : ''}</div>}
        </div>
      </div>
      {pick && <LinkToScope t={t} x={pick} onClose={() => setPick(null)} />}
    </main>
  );
}
