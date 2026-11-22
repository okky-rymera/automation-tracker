import { mutate, useApi } from '../../api';
import { when } from '../data';
import { useAct } from '../ui';

interface Parked { kind: 'playwright' | 'cypress' | 'code'; ref: string; reason: string; parkedAt: string }
const KIND: Record<Parked['kind'], string> = { playwright: 'Playwright file', cypress: 'Cypress file', code: 'Code file' };

/**
 * Units that failed 2 times in one mapping loop (server/map-loop.ts). The loop skips them until
 * their files change, so a daily loop does not spend the plan on the same failure each day.
 */
export function ParkedUnits({ project, tick }: { project: string; tick: number }) {
  const act = useAct();
  const { data } = useApi<Parked[]>(`/api/projects/${project}/parked-units?t=${tick}`);
  if (!data?.length) return null;
  return (
    <section className="card">
      <div className="sec-head"><h2 className="h2">Parked units <span className="faint" style={{ fontWeight: 400 }}>{data.length}</span></h2></div>
      <p className="faint" style={{ margin: '0 16px 8px', fontSize: 13 }}>
        These units failed 2 times in one loop. The loop skips them until their files change. Look at the reason, then click "Try again" to give a unit to the next loop.
      </p>
      <div>
        {data.map((u) => (
          <div key={`${u.kind}\0${u.ref}`} className="draft" style={{ gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13 }}>
              <span><span className="faint">{KIND[u.kind]}</span> <span className="mono" style={{ overflowWrap: 'anywhere' }}>{u.ref}</span> <span className="faint">· {when(u.parkedAt)}</span></span>
              <span className="muted" style={{ overflowWrap: 'anywhere' }}>{u.reason}</span>
            </div>
            <button className="btn btn-sm" onClick={() => act(() => mutate('DELETE', `/api/projects/${project}/parked-units`, { kind: u.kind, ref: u.ref }), `${u.ref} goes to the next loop`)}>
              Try again
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
