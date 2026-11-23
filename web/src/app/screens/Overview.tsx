import { featureTotal, pct, type LineCounts } from '../../api';
import { codeTxt, fmt, type Tracker } from '../data';
import { clearSticky, link } from '../route';
import { Bar, Card } from '../ui';
import { Warnings } from './Warnings';

/** Line counts with the hand marks (server: line_marks). Older servers send no marks. */
export type LC = LineCounts & { markedLibrary?: number; markedCovered?: number };

/** Numbers of the code cards: run by tests, marked covered, setup only, never run. */
export function codeNums(l: LC) {
  const mcov = l.markedCovered ?? 0;
  const feat = featureTotal(l);
  return { feat, run: l.tested - mcov, mcov, setup: l.setup + l.background, miss: l.never, lib: l.library, mlib: l.markedLibrary ?? 0, pct: pct(l.tested, feat) };
}

export function Overview({ t }: { t: Tracker }) {
  const p = t.project;
  const sum = (k: keyof Tracker['info'][number]['m']) => t.info.reduce((n, i) => n + i.m[k], 0);
  const total = sum('total');
  const ok = sum('ok');
  const gaps = total - ok;
  const chg = t.info.reduce((n, i) => n + i.nChanges, 0);
  const chgF = t.info.filter((i) => i.toReview).length;
  const pw = t.summary.linesBy.playwright as LC | null;
  const c = pw ? codeNums(pw) : null;
  const run = t.summary.runs.playwright;
  const rows = t.info
    .filter((i) => i.toReview || i.m.total - i.m.ok > 0)
    .sort((a, b) => b.changes.length - a.changes.length || b.m.total - b.m.ok - (a.m.total - a.m.ok) || a.f.id - b.f.id)
    .slice(0, 5);
  const last = t.sync?.last;
  // A test is linked when it has an active link to a feature or a scope. A test with no link is "decided" when the AI or a person
  // chose not to link it (left out, file skipped, or unlinked), else it waits for a decision. Same rules as the Tests page tabs.
  const linkRows = (['playwright', 'cypress'] as const).map((fw) => {
    const all = t.tests.filter((x) => x.fw === fw);
    const linked = all.filter((x) => t.linkedTo.has(x.id)).length;
    const decided = all.filter((x) => t.decided.has(x.id)).length;
    return { fw, name: fw === 'playwright' ? 'Playwright' : 'Cypress', total: all.length, linked, decided, not: all.length - linked - decided };
  }).filter((r) => r.total > 0);
  const notLinked = linkRows.reduce((s, r) => s + r.not, 0);
  const decided = linkRows.reduce((s, r) => s + r.decided, 0);

  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 className="h1">Coverage overview</h1>
        <p className="muted" style={{ margin: 0 }}>How well the tests cover each feature, and what waits for your review.</p>
      </div>
      <Warnings p={t.summary} />

      <div className="grid3">
        <Card className="q-card">
          <div className="q-q">Scopes covered by Playwright</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{ok} of {total}</span><span className="q-sub">{gaps} still to cover</span></div>
          <Bar
            total={total}
            label={`${ok} of ${total} scopes are covered by Playwright`}
            parts={[[ok, 'c-good'], [sum('fail'), 'c-fail'], [sum('skip'), 'c-skip'], [sum('cy'), 'c-cy']]}
          />
          <div className="legend">
            <span><i className="sw c-good" />{ok} Covered</span>
            {sum('fail') > 0 && <span><i className="sw c-fail" />{sum('fail')} Failing</span>}
            <span><i className="sw c-skip" />{sum('skip')} Skipped</span>
            <span><i className="sw c-cy" />{sum('cy')} Cypress only</span>
            <span><i className="sw sw-none" />{sum('none')} No test</span>
          </div>
          <div><a className="linkbtn" href={link(p, 'flist', null, { status: 'gaps', sort: 'gaps' })}>Show the features with scopes to cover</a></div>
          {sum('remove') > 0 && (
            <div className="q-sub">
              {sum('remove')} more {sum('remove') === 1 ? 'scope is' : 'scopes are'} marked “To remove” and {sum('remove') === 1 ? 'does' : 'do'} not count.{' '}
              <a className="linkbtn" href={link(p, 'flist', null, { status: 'remove' })}>Show them</a>
            </div>
          )}
        </Card>
        <Card className="q-card">
          <div className="q-q">Plugin code run by Playwright tests</div>
          {c ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{c.pct}%</span><span className="q-sub">{fmt(c.run + c.mcov)} of {fmt(c.feat)} feature lines</span></div>
              <Bar total={c.feat} parts={[[c.run, 'c-good'], [c.mcov, 'c-mcov']]} />
              <div className="q-sub">
                From the run “{run?.label}”.{' '}
                {t.summary.runs.cypress ? `The Cypress run is on the Code page.` : 'There is no Cypress coverage run.'}
              </div>
            </>
          ) : (
            <div className="q-sub">There is no Playwright coverage run yet. Sync with the tests on to make one.</div>
          )}
          <div><a className="linkbtn" href={link(p, 'code')}>Find code no test runs</a></div>
        </Card>
        <Card className="q-card">
          <div className="q-q">Changes to review</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{chg}</span><span className="q-sub">changes in {chgF} features</span></div>
          <div className="q-sub">
            AI drafts, tests that are gone{last?.status === 'done' && last.finishedAt ? `, and tests the sync of ${new Date(last.finishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} changed` : ''}.
          </div>
          <div><a className="linkbtn" href={link(p, 'changes')}>Review the changes</a></div>
        </Card>
        <Card className="q-card">
          <div className="q-q">Tests linked to features</div>
          {linkRows.map((r) => (
            <div key={r.fw} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span className="q-sub">
                  {r.linked} of {r.total} linked{r.decided > 0 ? `, ${r.decided} not linked on purpose` : ''}, {r.not} to decide
                </span>
              </div>
              <Bar
                total={r.total}
                label={`${r.linked} of ${r.total} ${r.name} tests are linked to a feature${r.decided ? `. ${r.decided} are not linked on purpose` : ''}`}
                parts={[[r.linked, 'c-good'], [r.decided, 'c-decided']]}
              />
            </div>
          ))}
          {!linkRows.length && <div className="q-sub">This project has no tests yet.</div>}
          {/* "In no feature" is the Tests page default, so the link sends no filter. The list has both frameworks, so the link gives the sum.
              The saved search is cleared only on a plain click: a new tab starts with no saved search, and the current tab keeps its search. */}
          {notLinked > 0 && (
            <div>
              <a
                className="linkbtn"
                href={link(p, 'tests')}
                onClick={(e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) clearSticky('tests.q'); }}
              >
                Show the {notLinked} {linkRows.length > 1 ? 'Playwright and Cypress ' : ''}tests to decide
              </a>
            </div>
          )}
          {linkRows.length > 0 && notLinked === 0 && (
            <div className="q-sub">{decided ? 'Every test is linked to a feature, or is not linked on purpose.' : 'All tests are linked to a feature.'}</div>
          )}
          {decided > 0 && (
            <div>
              <a
                className="linkbtn"
                href={link(p, 'tests', null, { show: 'decided' })}
                onClick={(e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) clearSticky('tests.q'); }}
              >
                Show the {decided} {decided === 1 ? 'test' : 'tests'} not linked on purpose, and why
              </a>
            </div>
          )}
        </Card>
      </div>

      <div className="split">
        <section className="card main" aria-labelledby="ft-h">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <h2 className="h2" id="ft-h">Needs attention</h2>
              <span className="faint" style={{ fontSize: 12 }}>Features with changes to review or scopes to cover, worst first.</span>
            </div>
            <a className="linkbtn" href={link(p, 'flist')}>See all {t.fd.features.length} features</a>
          </div>
          <div className="table-box">
            <div className="gt" role="table" aria-label="Scopes by feature">
              <div className="gr gh cols-ov" role="row">
                <span role="columnheader">Feature</span><span role="columnheader">Scopes covered by Playwright</span><span role="columnheader">Cypress only</span>
                <span role="columnheader">Code run by tests</span><span role="columnheader">To review</span>
              </div>
              {rows.map((i) => (
                <div className="gr cols-ov" role="row" key={i.f.id}>
                  <div role="cell">
                    <a className="rowbtn" href={link(p, 'feature', i.f.id)} style={{ textDecoration: 'none' }}><span className="mono faint">F-{i.f.id}</span> {i.f.title}</a>
                    <div className="faint" style={{ fontSize: 12 }}>{i.group}</div>
                  </div>
                  <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Bar small style={{ flex: 1 }} total={i.m.total} label={`${i.m.ok} covered, ${i.m.skip} skipped, ${i.m.cy} Cypress only, ${i.m.none} no test`} parts={[[i.m.ok, 'c-good'], [i.m.fail, 'c-fail'], [i.m.skip, 'c-skip'], [i.m.cy, 'c-cy']]} />
                    <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{i.m.ok} of {i.m.total}</span>
                  </div>
                  <div role="cell" style={{ fontSize: 13 }}>{i.m.cy ? `${i.m.cy} scopes` : '–'}</div>
                  <div role="cell" style={{ fontSize: 13 }}>{codeTxt(i.code)}</div>
                  <div role="cell">
                    {i.toReview ? (
                      <a className="tag tag-changed" style={{ minHeight: 28, textDecoration: 'none' }} href={link(p, 'changes', null, { f: i.f.id })}>{i.changes.length || 1} to review</a>
                    ) : (
                      <span className="faint" style={{ fontSize: 13 }}>Nothing new</span>
                    )}
                  </div>
                </div>
              ))}
              {!rows.length && <div className="faint" style={{ padding: 16, fontSize: 13 }}>Nothing needs attention: every scope is covered and every change is reviewed.</div>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
