import { featurePct, featureTotal, useApi, type ProjectSummary } from '../../api';
import { fmt } from '../data';
import { link } from '../route';
import { Bar, Loading } from '../ui';

/** All projects. Each project is one plugin. */
export function Projects() {
  const { data, error } = useApi<ProjectSummary[]>('/api/projects');
  return (
    <>
      <header className="top" style={{ paddingBottom: 8 }}>
        <span className="brand">Automation Tracker</span>
      </header>
      {!data ? (
        <Loading error={error} />
      ) : (
        <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1 className="h1">Projects</h1>
            <p className="muted" style={{ margin: 0 }}>Each project is one plugin. The list comes from the database (data/tracker.db).</p>
          </div>
          <div className="grid3">
            {data.map((p) => {
              const l = p.lines;
              const ft = featureTotal(l);
              return (
                <a key={p.id} href={link(p.id, 'overview')} className="card proj-card">
                  <div className="h2">{p.name}</div>
                  <div className="mono faint" style={{ overflowWrap: 'anywhere' }}>{p.path}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span className="q-big">{featurePct(l)}%</span>
                    <span className="q-sub">{fmt(l.tested)} of {fmt(ft)} feature lines run by tests</span>
                  </div>
                  <Bar total={ft} parts={[[l.tested, 'c-good'], [l.setup + l.background, 'c-skip'], [l.never, 'c-fail']]} />
                  <div className="kv">
                    <span>{p.features.features} features</span>
                    <span>{p.playwright.tests} Playwright tests</span>
                    <span>{p.cypress.scenarios} Cypress scenarios</span>
                  </div>
                </a>
              );
            })}
          </div>
        </main>
      )}
    </>
  );
}
