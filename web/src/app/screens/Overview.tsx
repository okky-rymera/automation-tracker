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
  // mlib: a person's library marks only. markedLibrary also has the decision lines and the automatic lines.
  const mlib = l.personLibrary ?? 0;
  return { feat, run: l.tested - mcov, mcov, setup: l.setup + l.background, miss: l.never, lib: l.library, mlib, pct: pct(l.tested, feat) };
}

const FW_NAME = { playwright: 'Playwright', cypress: 'Cypress' } as const;

/**
 * How the plugin code splits: in a feature, in no feature, unused (nothing loads or calls it), and library
 * (start-up, helpers, guard lines). The four parts add up to all runnable lines. The big number is the share of
 * the code that is not library or unused. Both coverage runs together (server: mappedCodeTotals and lines).
 * A line in two features counts one time.
 */
function CodeInFeatures({ t }: { t: Tracker }) {
  const p = t.project;
  const m = t.summary.mappedCode;
  const l = t.summary.lines;
  if (!t.summary.view) {
    return (
      <Card className="q-card">
        <div className="q-q">Plugin code in a feature</div>
        <div className="q-sub">There is no coverage run yet, so the plugin lines are not counted. Sync with the tests on to make one.</div>
      </Card>
    );
  }
  const inF = m.lines ? featureTotal(m.lines) : 0;
  const noF = featureTotal(m.unmapped);
  const unused = l.unused ?? 0;
  const lib = l.library - unused;
  const noFiles = t.codeMap ? t.codeMap.unmapped.length : null;
  return (
    <Card className="q-card">
      <div className="q-q">Plugin code in a feature</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="q-big">{pct(inF, inF + noF)}%</span>
        <span className="q-sub">{fmt(inF)} of {fmt(inF + noF)} plugin lines (library and unused code left out)</span>
      </div>
      <Bar
        total={l.runnable}
        label={`${fmt(inF)} lines in a feature, ${fmt(noF)} in no feature, ${fmt(unused)} unused, ${fmt(lib)} library, of ${fmt(l.runnable)} lines`}
        parts={[[inF, 'c-good'], [noF, 'c-fail'], [unused, 'c-skip'], [lib, 'c-decided']]}
      />
      <div className="legend">
        <span><i className="sw c-good" />{fmt(inF)} In a feature</span>
        <span><i className="sw c-fail" />{fmt(noF)} In no feature</span>
        <span><i className="sw c-skip" />{fmt(unused)} Unused</span>
        <span><i className="sw c-decided" />{fmt(lib)} Library</span>
      </div>
      <div className="q-sub">
        {noF
          ? `${fmt(noF)} lines${noFiles !== null ? ` in ${noFiles} ${noFiles === 1 ? 'file' : 'files'}` : ''} are in no feature, so the feature list does not tell what they do. The AI mapping sorts them.`
          : 'Each plugin line is in a feature, or is library or unused code.'}
        {unused > 0 && ` ${fmt(unused)} lines are unused: no plugin code loads or calls them, so the team can delete them.`}
      </div>
      {noF > 0 && <div><a className="linkbtn" href={link(p, 'code', null, { sort: 'nof' })}>Show the files with the most code in no feature</a></div>}
      {unused > 0 && <div><a className="linkbtn" href={link(p, 'code', null, { tab: 'decisions' })}>Show the unused code</a></div>}
    </Card>
  );
}

/** Plugin lines that the tests run: both runs together, then each run alone. Hand marks count as run. */
function CodeRun({ t }: { t: Tracker }) {
  const p = t.project;
  const s = t.summary;
  const c = s.view ? codeNums(s.lines as LC) : null;
  const rows = (['playwright', 'cypress'] as const).map((fw) => {
    const l = s.linesBy[fw] as LC | null;
    return { fw, name: FW_NAME[fw], c: l ? codeNums(l) : null, run: s.runs[fw] };
  });
  const both = rows.every((r) => r.c);
  return (
    <Card className="q-card">
      <div className="q-q">Plugin code run by tests</div>
      {!c ? (
        <div className="q-sub">There is no coverage run yet. Sync with the tests on to make one.</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="q-big">{c.pct}%</span>
            <span className="q-sub">{fmt(c.run + c.mcov)} of {fmt(c.feat)} plugin lines{both ? ', Playwright and Cypress together' : ''}</span>
          </div>
          <Bar
            total={c.feat}
            label={`${fmt(c.run)} run by tests, ${fmt(c.mcov)} marked covered, ${fmt(c.setup)} only in setup, ${fmt(c.miss)} never run`}
            parts={[[c.run, 'c-good'], [c.mcov, 'c-mcov'], [c.setup, 'c-skip'], [c.miss, 'c-fail']]}
          />
          <div className="legend">
            <span><i className="sw c-good" />{fmt(c.run)} Run by tests</span>
            {c.mcov > 0 && <span><i className="sw c-mcov" />{fmt(c.mcov)} Marked covered</span>}
            <span><i className="sw c-skip" />{fmt(c.setup)} Only in setup</span>
            <span><i className="sw c-fail" />{fmt(c.miss)} Never run</span>
          </div>
          <div className="q-sub">
            <strong>{fmt(c.setup + c.miss)} uncovered lines:</strong> never run, or run only while a test sets up. Library code is left out.
          </div>
          {both && rows.map((r) => (
            <div key={r.fw} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name} alone</span>
                <span className="q-sub">{r.c!.pct}%, {fmt(r.c!.run + r.c!.mcov)} of {fmt(r.c!.feat)} lines</span>
              </div>
              <Bar small total={r.c!.feat} label={`${r.name} tests run ${fmt(r.c!.run)} plugin lines. ${fmt(r.c!.mcov)} more are marked covered by hand`} parts={[[r.c!.run, 'c-good'], [r.c!.mcov, 'c-mcov']]} />
            </div>
          ))}
          <div className="q-sub">From {rows.filter((r) => r.run?.label).map((r) => `“${r.run!.label}”`).join(' and ')}.</div>
          <div><a className="linkbtn" href={link(p, 'code', null, { sort: 'unc' })}>Show the files with the most uncovered lines</a></div>
        </>
      )}
    </Card>
  );
}

/**
 * Lines that count as library or covered with no test, by source: a person's line marks, decisions (library or
 * unused, mostly from the AI mapping), and the automatic guard and blank lines. They count in the totals above.
 */
function MarkedByHand({ t }: { t: Tracker }) {
  const p = t.project;
  const l = t.summary.lines;
  const dec = l.decisionLibrary ?? 0;
  const auto = l.autoLibrary ?? 0;
  const person = l.personLibrary ?? 0;
  // Unused lines that the decision moved to library. Unused lines that the run counted as library already
  // are not "counted with no test": the run counts them.
  const unused = Math.max(0, (l.markedLibrary ?? 0) - dec - auto - person);
  const covered = l.markedCovered ?? 0;
  return (
    <Card className="q-card">
      <div className="q-q">Counted with no test</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{fmt(person + covered + dec + unused + auto)}</span><span className="q-sub">lines</span></div>
      <ul className="q-sub" style={{ margin: 0, paddingLeft: 18 }}>
        <li>{fmt(person + covered)} marked by a person: {fmt(person)} as library, {fmt(covered)} as covered.</li>
        <li>{fmt(dec)} library by a decision, and {fmt(unused)} unused. The AI mapping makes most decisions.</li>
        <li>{fmt(auto)} library found by the app: the check that stops a direct call of a file, and blank lines.</li>
      </ul>
      <div className="q-sub">They count in the totals of this section.</div>
      <div><a className="linkbtn" href={link(p, 'code', null, { tab: 'decisions' })}>Check the decisions</a></div>
      {person + covered > 0 && <div><a className="linkbtn" href={link(p, 'code', null, { sort: 'marked' })}>Show the files with marks</a></div>}
    </Card>
  );
}

export function Overview({ t }: { t: Tracker }) {
  const p = t.project;
  const sum = (k: keyof Tracker['info'][number]['m']) => t.info.reduce((n, i) => n + i.m[k], 0);
  const total = sum('total');
  const ok = sum('ok');
  const gaps = total - ok;
  const chg = t.info.reduce((n, i) => n + i.nChanges, 0);
  const chgF = t.info.filter((i) => i.toReview).length;
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

      <section className="ov-sec" aria-labelledby="ov-ft">
        <h2 className="h2" id="ov-ft">Features and tests</h2>
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
      </section>

      <section className="ov-sec" aria-labelledby="ov-code">
        <h2 className="h2" id="ov-code">Plugin code</h2>
        <div className="grid3">
          <CodeInFeatures t={t} />
          <CodeRun t={t} />
          <MarkedByHand t={t} />
        </div>
      </section>

      <section className="ov-sec" aria-labelledby="ov-rev">
        <h2 className="h2" id="ov-rev">To review</h2>
        <div className="grid3">
          <Card className="q-card">
            <div className="q-q">Changes to review</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}><span className="q-big">{chg}</span><span className="q-sub">changes in {chgF} features</span></div>
            <div className="q-sub">
              AI drafts, tests that are gone{last?.status === 'done' && last.finishedAt ? `, and tests the sync of ${new Date(last.finishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} changed` : ''}.
            </div>
            <div><a className="linkbtn" href={link(p, 'changes')}>Review the changes</a></div>
          </Card>
        </div>
      </section>
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
