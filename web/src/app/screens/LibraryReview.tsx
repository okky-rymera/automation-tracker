import { mutate, useApi } from '../../api';
import { day, short, type Tracker } from '../data';
import { link } from '../route';
import { Card, useAct } from '../ui';

export interface Decision { file: string; function: string; kind: 'library' | 'unused'; reason: string; by: 'ai' | 'person'; commit: string | null; createdAt: string }
interface Untested { file: string; function: string; commit: string }
export interface LeftOut { testId: string; title: string | null; file: string | null; framework: string | null; reason: string; by: 'ai' | 'person'; createdAt: string }
export type UntestedByTool = Record<'playwright' | 'cypress', { untested: Untested[]; fullRunAt: string | null; run: string } | null> & { fullRunDays: number };

const TOOL = { playwright: 'Playwright', cypress: 'Cypress' } as const;

/** The data of the "AI decisions" tab. The Code page loads it, so the tab can show the count. */
export function useReviewData(project: string) {
  const { data: decisions } = useApi<Decision[]>(`/api/projects/${project}/code-decisions`);
  const { data: untested } = useApi<UntestedByTool>(`/api/projects/${project}/untested`);
  const { data: leftOut } = useApi<LeftOut[]>(`/api/projects/${project}/left-out-tests`);
  const tools = untested ? (Object.keys(TOOL) as (keyof typeof TOOL)[]).filter((k) => untested[k]?.untested.length) : [];
  const count = decisions && untested && leftOut ? decisions.length + leftOut.length + tools.reduce((n, k) => n + untested[k]!.untested.length, 0) : undefined;
  return { decisions, untested, leftOut, tools, count };
}

/**
 * Library code that the AI decided (code_decisions), and library changes that partial runs did not
 * test again. Both change the coverage numbers without a test, so a person can check them here.
 */
export function LibraryReview({ t, d, view }: { t: Tracker; d: ReturnType<typeof useReviewData>; view: string | null }) {
  const act = useAct();
  const { decisions, untested, leftOut, tools } = d;
  const file = (path: string) => <a className="mono" style={{ fontSize: 12 }} href={link(t.project, 'codefile', null, { path, view })}>{path}</a>;
  const byFile = new Map<string, Decision[]>();
  for (const x of decisions ?? []) byFile.set(x.file, [...(byFile.get(x.file) ?? []), x]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 16, alignItems: 'start' }}>
      <Card className="q-card" style={{ gridColumn: '1 / -1' }}>
        <div className="q-q">Library and unused code decided by the AI</div>
        <div className="q-sub">
          The AI mapping sorts the code that no feature holds. Library code (start-up, small shared helpers, glue) and unused code (nothing loads or calls it) do not count as uncovered code.
          The overview shows unused code apart, so the team can delete it. Remove a decision that is wrong: the code then counts as uncovered again, and the AI looks at it again.
        </div>
        {!decisions ? (
          <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
        ) : !decisions.length ? (
          <div className="muted" style={{ fontSize: 13 }}>None yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="faint" style={{ fontSize: 12 }}>
              {decisions.filter((x) => x.kind === 'library').length} library and {decisions.filter((x) => x.kind === 'unused').length} unused items in {byFile.size} files. Open a file group, then click an item to see its code.
            </div>
            {[...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([path, list]) => (
              <details key={path} style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  <span className="mono" style={{ overflowWrap: 'anywhere' }}>{path}</span> <span className="faint">({list.length})</span>
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0 2px 16px' }}>
                  {list.map((x) => (
                    <div key={x.function} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}
                      title={`${x.by === 'ai' ? 'AI' : 'A person'}, ${day(x.createdAt)}${x.commit ? `, at ${short(x.commit)}` : ''}`}>
                      <a className="mono" style={{ flex: '0 1 auto', minWidth: 0, overflowWrap: 'anywhere' }} href={link(t.project, 'codefile', null, x.function ? { path, fn: x.function, view } : { path, view })}
                        title={x.function ? 'Open the file at this function' : 'Open the file'}>{x.function || '(code outside functions)'}</a>
                      <span className={`tag ${x.kind === 'unused' ? 'tag-changed' : ''}`} style={{ flex: 'none' }}>{x.kind === 'unused' ? 'Unused' : 'Library'}</span>
                      <span className="muted" style={{ flex: 1, minWidth: 0 }}>{x.reason}</span>
                      <button className="btn btn-sm" aria-label={`Remove the ${x.kind} decision for ${x.function || 'the code outside functions'}`}
                        onClick={() => act(() => mutate('DELETE', `/api/projects/${t.project}/code-decisions`, { file: x.file, function: x.function }), `${x.function || 'The code outside functions'} counts as uncovered again`)}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
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
