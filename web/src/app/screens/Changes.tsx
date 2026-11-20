import { useEffect, useRef, useState } from 'react';
import { mutate } from '../../api';
import { KIND_LABEL, KIND_TAG, runAll, type Change, type Tracker } from '../data';
import { go, link, setQuery, withBack, type Route } from '../route';
import { useAct, useSay } from '../ui';

/** The features with changes to review, and the changes of one feature. Only the changed parts show, not the whole feature. */
export function Changes({ t, route }: { t: Tracker; route: Route }) {
  const p = t.project;
  const act = useAct();
  const say = useSay();
  const queue = t.info.filter((i) => i.toReview);
  const asked = Number(route.q.get('f'));
  const cur = queue.find((i) => i.f.id === asked) ?? queue[0];
  const [focus, setFocus] = useState(Number(route.q.get('i')) || 0);
  const list = useRef<HTMLDivElement>(null);
  const dl = cur?.changes ?? [];
  const fx = Math.max(0, Math.min(focus, dl.length - 1));

  useEffect(() => {
    setTimeout(() => list.current?.focus({ preventScroll: true }), 30);
  }, [cur?.f.id]);
  useEffect(() => {
    document.getElementById(`draft-${fx}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [fx]);

  const openIn = (x: Change, idx: number) =>
    go(withBack(link(p, 'feature', cur!.f.id, { tab: x.tab === 'scopes' ? null : x.tab, scope: x.scopeId ?? null }), 'Back to Changes', link(p, 'changes', null, { f: cur!.f.id, i: idx })));
  const nextId = () => {
    const k = queue.findIndex((i) => i.f.id === cur!.f.id);
    return (queue[k + 1] ?? queue[k - 1])?.f.id ?? null;
  };
  const markNext = () =>
    act(async () => {
      const n = nextId();
      await mutate('POST', `/api/projects/${p}/features/${cur!.f.id}/check`, {});
      setFocus(0);
      setQuery({ f: n, i: null });
    }, `F-${cur!.f.id} marked as reviewed`);
  const run = (fn: (() => Promise<unknown>) | undefined, msg: string, ask?: string) => fn && (!ask || confirm(ask)) && act(() => runAll([fn]), msg);

  const keys = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !cur) return;
    const k = e.key.toLowerCase();
    const x = dl[fx];
    if (k === 'j' || e.key === 'ArrowDown') (e.preventDefault(), setFocus(Math.min(fx + 1, dl.length - 1)));
    else if (k === 'k' || e.key === 'ArrowUp') (e.preventDefault(), setFocus(Math.max(fx - 1, 0)));
    else if (e.key === 'Enter' && x) (e.preventDefault(), openIn(x, fx));
    else if (k === 'a' && x) {
      e.preventDefault();
      if (x.keep) run(x.keep, `${x.keepLbl}: done`);
      else say('This change has no Keep. Open it, or mark the feature as reviewed.');
    } else if (k === 'x' && x?.remove) (e.preventDefault(), run(x.remove, `${x.removeLbl}: done`, x.confirm));
    else if (k === 'r') (e.preventDefault(), markNext());
  };

  const secs: string[] = [];
  for (const x of dl) if (!secs.includes(x.sec)) secs.push(x.sec);

  return (
    <main className="page split">
      <aside className="card side" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }} aria-label="Review queue">
        <div className="h3" style={{ padding: '4px 10px 8px' }}>Features to review</div>
        {queue.map((i) => {
          const on = cur && i.f.id === cur.f.id;
          return (
            <button key={i.f.id} className={`li ${on ? 'li-on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => (setFocus(0), setQuery({ f: i.f.id, i: null }))}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' }}>
                <span className="mono faint">F-{i.f.id}</span>
                <span style={{ flex: 1, fontWeight: 500 }} className="clamp">{i.f.title}</span>
              </span>
              <span><span className="tag tag-changed">{i.changes.length || 1} to review</span></span>
            </button>
          );
        })}
        {!queue.length && <div className="muted" style={{ padding: 10, fontSize: 13 }}>You saw every change. Nothing waits for a review.</div>}
      </aside>
      {cur && (
        <section className="main" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="Review">
          <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="mono faint">F-{cur.f.id}</span>
              <h1 className="h1" style={{ flex: 1 }}>{cur.f.title}</h1>
              <a className="btn btn-sm" style={{ color: 'var(--ink)', textDecoration: 'none' }} href={withBack(link(p, 'feature', cur.f.id), 'Back to Changes')}>Open feature</a>
              <button className="btn btn-primary" onClick={markNext}>Mark as reviewed</button>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {dl.length} {dl.length === 1 ? 'change' : 'changes'} to review. Only the changed items show here, not the whole feature. “Mark as reviewed” keeps all of them.
            </div>
            <div className="kbdrow">
              <span>Keys:</span><span><kbd>J</kbd> <kbd>K</kbd> next and back</span><span><kbd>A</kbd> keep</span><span><kbd>X</kbd> undo the change</span>
              <span><kbd>Enter</kbd> open in the feature</span><span><kbd>R</kbd> mark the feature as reviewed</span>
            </div>
          </div>
          <div ref={list} className="rv-list" tabIndex={0} onKeyDown={keys} aria-label="Changes. J and K move, A keeps, X undoes, Enter opens, R marks the feature as reviewed." style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {secs.map((sec) => {
              const items = dl.map((x, idx) => ({ x, idx })).filter((y) => y.x.sec === sec);
              const keeps = items.map((y) => y.x.keep).filter(Boolean) as (() => Promise<unknown>)[];
              return (
                <div className="card" key={sec}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                    <h2 className="h2" style={{ flex: 1 }}>{sec} <span className="faint" style={{ fontWeight: 400 }}>{items.length}</span></h2>
                    {keeps.length > 1 && items.every((y) => y.x.keepLbl === 'Keep' || !y.x.keep) && (
                      <button className="btn btn-sm btn-ghost" onClick={() => act(() => runAll(keeps), `${sec}: all kept`)}>Keep all</button>
                    )}
                  </div>
                  <div>
                    {items.map(({ x, idx }) => (
                      <div key={x.key} id={`draft-${idx}`} className={`draft ${idx === fx ? 'dr-focus' : ''}`} onClick={() => setFocus(idx)}>
                        <span className={`tag ${KIND_TAG[x.kind]}`} style={{ marginTop: 2 }}>{KIND_LABEL[x.kind]}</span>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span>{x.text}</span>
                          {x.before !== null && <span className="faint" style={{ fontSize: 12 }}>Before: {x.before ? <span className="was-old">{x.before}</span> : <em>empty</em>}</span>}
                          {x.ctx && <span className="faint" style={{ fontSize: 12 }}>{x.ctx}</span>}
                        </div>
                        <span className="acts" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {x.keep && <button className="btn btn-sm btn-ok" onClick={(e) => (e.stopPropagation(), run(x.keep, `${x.keepLbl}: done`))}>{x.keepLbl}</button>}
                          {x.remove && <button className="btn btn-sm btn-danger" onClick={(e) => (e.stopPropagation(), run(x.remove, `${x.removeLbl}: done`, x.confirm))}>{x.removeLbl}</button>}
                          <button className="btn btn-sm btn-ghost" onClick={(e) => (e.stopPropagation(), openIn(x, idx))}>Open</button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {!dl.length && <div className="card" style={{ padding: 16 }}>No single change is left. Mark the feature as reviewed to finish.</div>}
          </div>
        </section>
      )}
    </main>
  );
}
