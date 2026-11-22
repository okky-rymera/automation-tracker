import { mutate, useApi } from '../../api';
import { day, short, type Tracker } from '../data';
import { link } from '../route';
import { Card, useAct } from '../ui';

interface Decision { file: string; function: string; kind: 'library'; reason: string; by: 'ai' | 'person'; commit: string | null; createdAt: string }
interface Untested { file: string; function: string; commit: string }
interface LeftOut { testId: string; title: string | null; file: string | null; framework: string | null; reason: string; by: 'ai' | 'person'; createdAt: string }
type UntestedByTool = Record<'playwright' | 'cypress', { untested: Untested[]; fullRunAt: string | null; run: string } | null> & { fullRunDays: number };

const TOOL = { playwright: 'Playwright', cypress: 'Cypress' } as const;

/**
 * Library code that the AI decided (code_decisions), and library changes that partial runs did not
 * test again. Both change the coverage numbers without a test, so a person can check them here.
 */
export function LibraryReview({ t }: { t: Tracker }) {
  const act = useAct();
  const { data: decisions } = useApi<Decision[]>(`/api/projects/${t.project}/code-decisions`);
  const { data: untested } = useApi<UntestedByTool>(`/api/projects/${t.project}/untested`);
  const { data: leftOut } = useApi<LeftOut[]>(`/api/projects/${t.project}/left-out-tests`);
  const file = (path: string) => <a className="mono" style={{ fontSize: 12 }} href={link(t.project, 'codefile', null, { path })}>{path}</a>;
  const tools = untested ? (Object.keys(TOOL) as (keyof typeof TOOL)[]).filter((k) => untested[k]?.untested.length) : [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 16, alignItems: 'start' }}>
      <Card className="q-card">
        <div className="q-q">Library code decided by the AI</div>
        <div className="q-sub">
          The AI mapping sorts the code that no test runs. A function it calls library code (start-up, small shared helpers, glue) counts as library lines, not as uncovered code.
          Remove a decision that is wrong: the function then counts as uncovered again, and the AI looks at it again.
        </div>
        {!decisions ? (
          <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
        ) : !decisions.length ? (
          <div className="muted" style={{ fontSize: 13 }}>None yet.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {decisions.map((d) => (
              <li key={`${d.file}\0${d.function}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="mono" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{d.function}</span>
                  {file(d.file)}
                  <span style={{ fontSize: 13 }}>{d.reason}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{d.by === 'ai' ? 'AI' : 'A person'}, {day(d.createdAt)}{d.commit ? `, at ${short(d.commit)}` : ''}</span>
                </div>
                <button className="btn btn-sm" aria-label={`Remove the library decision for ${d.function}`}
                  onClick={() => act(() => mutate('DELETE', `/api/projects/${t.project}/code-decisions`, { file: d.file, function: d.function }), `${d.function} counts as uncovered again`)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="q-card">
        <div className="q-q">Library changes not tested again</div>
        <div className="q-sub">
          A sync runs only the tests that the changed code touches. A changed function that 90% or more of the tests run is library code: no test runs it again
          until the next full run{untested ? ` (one each ${untested.fullRunDays} days)` : ''}.
        </div>
        {!untested ? (
          <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
        ) : !tools.length ? (
          <div className="muted" style={{ fontSize: 13 }}>None. Every change since the last full run was tested again.</div>
        ) : (
          tools.map((k) => {
            const u = untested[k]!;
            const next = u.fullRunAt ? new Date(new Date(u.fullRunAt).getTime() + untested.fullRunDays * 86_400_000).toISOString() : null;
            return (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{TOOL[k]}: {u.untested.length} {u.untested.length === 1 ? 'change' : 'changes'}{next ? `, full run from ${day(next)}` : ''}</div>
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {u.untested.map((x) => (
                    <li key={`${x.file}\0${x.function}`} style={{ fontSize: 13 }}>
                      <span className="mono" style={{ overflowWrap: 'anywhere' }}>{x.function}</span> in {file(x.file)} <span className="faint">(changed at {short(x.commit)})</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </Card>
      <Card className="q-card">
        <div className="q-q">Tests the AI left out</div>
        <div className="q-sub">
          The AI links each test to the scopes it checks. A test that fits no feature (a setup step, a helper, a test of something that is gone) is left out with a reason.
          When a person deletes a feature, its tests are left out too, so the AI does not make the feature again. Remove a row that is wrong: the AI then looks at the test again.
        </div>
        {!leftOut ? (
          <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
        ) : !leftOut.length ? (
          <div className="muted" style={{ fontSize: 13 }}>None.</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {leftOut.map((x) => (
              <li key={x.testId} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <a className="linkbtn" style={{ fontSize: 13, overflowWrap: 'anywhere', textAlign: 'left' }} href={link(t.project, 'test', x.testId)}>{x.title ?? x.testId}</a>
                  {x.file && <span className="mono faint" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{x.file}</span>}
                  <span style={{ fontSize: 13 }}>{x.reason}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{x.by === 'ai' ? 'AI' : 'A person'}, {day(x.createdAt)}{x.title ? '' : ' · the test is not in the last scan'}</span>
                </div>
                <button className="btn btn-sm" aria-label={`Remove the left-out row for ${x.title ?? x.testId}`}
                  onClick={() => act(() => mutate('DELETE', `/api/projects/${t.project}/left-out-tests`, { testId: x.testId }), 'The AI looks at this test again in the next mapping loop')}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
