import { useEffect, useState } from 'react';
import { mutate, useApi } from '../../api';
import { useAct } from '../ui';

interface Setting {
  key: string;
  env: string;
  group: string;
  label: string;
  help: string;
  kind: 'bool' | 'number' | 'choice';
  default: boolean | number | string;
  min?: number;
  max?: number;
  int?: boolean;
  unit?: string;
  choices?: { value: string; label: string }[];
  value: boolean | number | string;
  /** An environment variable of the server sets it: the screen cannot change it. */
  locked: boolean;
  /** A person changed it from the default. */
  changed: boolean;
  /** The environment variable is set, but its value cannot be read, so it is ignored. */
  envIgnored: string | null;
}

/**
 * Settings of the whole tracker (server/settings.ts): the daily sync, the AI step after it, and the
 * test runs. A change works at the next check of the server, with no restart.
 */
export function SettingsPage() {
  const { data, error } = useApi<Setting[]>('/api/settings');
  const [list, setList] = useState<Setting[] | null>(null);
  useEffect(() => {
    if (data) setList(data);
  }, [data]);
  const act = useAct();
  const save = (key: string, value: unknown, label: string) =>
    act(async () => setList(await mutate<Setting[]>('PATCH', '/api/settings', { [key]: value }, { quiet: true })), `${label}: saved`);
  if (error) return <main className="page"><div className="err">{error}</div></main>;
  if (!list) return <main className="page"><div className="muted">Loading…</div></main>;
  const groups = [...new Set(list.map((s) => s.group))];
  return (
    <main className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h1 className="h1">Settings</h1>
        <p className="muted" style={{ margin: 0 }}>These settings are for all projects. A change works at the next check of the server (within 1 minute), with no restart.</p>
      </div>
      {groups.map((g) => (
        <section key={g} className="card">
          <div className="sec-head"><h2 className="h2">{g}</h2></div>
          <div>
            {list.filter((s) => s.group === g).map((s) => (
              <Row key={s.key} s={s} save={save} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function Row({ s, save }: { s: Setting; save: (key: string, value: unknown, label: string) => Promise<unknown> }) {
  const [text, setText] = useState(String(s.value));
  useEffect(() => setText(String(s.value)), [s.value]);
  const id = `set-${s.key}`;
  const saveNumber = () => {
    const n = Number(text);
    if (text.trim() === '' || n === s.value) return setText(String(s.value));
    // The server refuses a value outside the limits. Then the box shows the saved value again.
    if (!Number.isFinite(n) || n < s.min! || n > s.max! || (s.int && !Number.isInteger(n))) setText(String(s.value));
    void save(s.key, n, s.label);
  };
  let control;
  if (s.kind === 'bool') {
    control = <input id={id} type="checkbox" checked={s.value === true} disabled={s.locked} onChange={(e) => save(s.key, e.target.checked, s.label)} style={{ width: 18, height: 18 }} />;
  } else if (s.kind === 'choice') {
    control = (
      <select id={id} className="input sel-sm" value={String(s.value)} disabled={s.locked} onChange={(e) => save(s.key, e.target.value, s.label)}>
        {s.choices!.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    );
  } else {
    control = (
      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input
          id={id} className="input sel-sm" style={{ width: 90 }} type="number" min={s.min} max={s.max} step={s.int ? 1 : 'any'} value={text} disabled={s.locked}
          onChange={(e) => setText(e.target.value)} onBlur={saveNumber} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
        {s.unit && <span className="faint" style={{ fontSize: 13 }}>{s.unit}</span>}
      </span>
    );
  }
  return (
    <div className="draft" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label htmlFor={id} style={{ fontWeight: 600, fontSize: 14 }}>{s.label}</label>
        <span className="muted" style={{ fontSize: 13 }}>{s.help}</span>
        {s.envIgnored !== null && (
          <span style={{ fontSize: 12, color: 'var(--warn)' }}>
            <span className="mono">{s.env}={s.envIgnored}</span> is set on the server, but the value cannot be read, so it is ignored.
          </span>
        )}
        {s.locked ? (
          <span className="faint" style={{ fontSize: 12 }}>Set by <span className="mono">{s.env}</span> in the environment of the server. Remove the variable to change it here.</span>
        ) : (
          s.changed && (
            <span className="faint" style={{ fontSize: 12 }}>
              Default: {fmt(s, s.default)}.{' '}
              <button className="linkbtn" style={{ fontSize: 12 }} onClick={() => save(s.key, null, s.label)}>Use the default</button>
            </span>
          )
        )}
      </div>
      <div style={{ flex: '0 0 auto' }}>{control}</div>
    </div>
  );
}

const fmt = (s: Setting, v: Setting['value']) =>
  s.kind === 'bool' ? (v ? 'on' : 'off') : s.kind === 'choice' ? s.choices!.find((c) => c.value === v)?.label ?? String(v) : `${v}${s.unit ? ` ${s.unit}` : ''}`;
