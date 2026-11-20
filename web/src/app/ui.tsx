import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { reloadAll } from '../api';

/* ---------------- Icons ---------------- */
type IP = { s?: number };
const svg = (d: ReactNode, sw = 2) => ({ s = 14 }: IP) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} aria-hidden="true">{d}</svg>
);
export const IPlus = svg(<path d="M12 5v14M5 12h14" />, 2.2);
export const IX = svg(<path d="M6 6l12 12M18 6L6 18" />);
export const ICopy = svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>);
export const IPrev = svg(<path d="M15 6l-6 6 6 6" />);
export const INext = svg(<path d="M9 6l6 6-6 6" />);
export const ISearch = svg(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>);
export const ILock = svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
export const ITrash = svg(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />);
export const IFolder = svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, 1.8);
export const IFile = svg(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />, 1.8);
export const IMore = svg(<><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>);
export const IWarn = svg(<><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18h.01" /></>);
export const IPencil = svg(<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />);

/* ---------------- Toast with Undo ---------------- */
interface ToastState { msg: string; undo?: () => Promise<unknown> }
const ToastCtx = createContext<(msg: string, undo?: () => Promise<unknown>) => void>(() => {});
export const useSay = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = (msg: string, undo?: () => Promise<unknown>) => {
    clearTimeout(timer.current);
    setT({ msg, undo });
    timer.current = setTimeout(() => setT(null), undo ? 8000 : 5000);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastCtx.Provider value={say}>
      {children}
      {t && (
        <div className="toast" role="status">
          <span style={{ fontSize: 13 }}>{t.msg}</span>
          {t.undo && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                const u = t.undo!;
                setT(null);
                try {
                  await u();
                  reloadAll();
                  say('Undone');
                } catch (e) {
                  say(`Could not undo: ${(e as Error).message}`);
                }
              }}
            >
              Undo
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setT(null)} aria-label="Close message">×</button>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/**
 * Runs a change and shows the result. msg: the message on success. undo: a call that puts it back.
 * An error from the API shows as the message.
 */
export function useAct() {
  const say = useSay();
  return async (fn: () => Promise<unknown>, msg?: string, undo?: () => Promise<unknown>) => {
    try {
      await fn();
      if (msg) say(msg, undo);
      return true;
    } catch (e) {
      say((e as Error).message);
      return false;
    }
  };
}

/* ---------------- Clipboard ---------------- */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API needs https or localhost. This fallback works on a plain-http address too.
    const before = document.activeElement as HTMLElement | null;
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    before?.focus();
    return ok;
  }
}

/** An ID with a copy button. text: what goes on the clipboard (it can say more, like "F-1/S-3"). */
export function IdBtn({ label, text = label, className = 'idbtn mono' }: { label: string; text?: string; className?: string }) {
  const say = useSay();
  return (
    <button
      type="button"
      className={className}
      title={`Copy ${text}`}
      aria-label={`Copy ${text}`}
      onClick={async (e) => {
        e.stopPropagation();
        say((await copyText(text)) ? `Copied ${text}` : 'Could not copy');
      }}
    >
      {label}
      <ICopy s={12} />
    </button>
  );
}

/* ---------------- Inline edit ---------------- */
/**
 * The text is the field: click to edit. Blur or Enter saves, Esc puts the old text back.
 * multi: Shift+Enter makes a new line. required: an empty value is refused with this message.
 * An empty value of an item that is not required calls onSave('') (the caller removes the item).
 */
export function InlineText({
  value, onSave, className, placeholder, multi = false, required, id, label,
}: {
  value: string; onSave: (v: string) => Promise<unknown> | void; className: string; placeholder?: string; multi?: boolean; required?: string; id?: string; label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const skip = useRef(false);
  const say = useSay();
  const ref = useRef<HTMLTextAreaElement>(null);
  // Browsers without field-sizing: grow the box to its text.
  useEffect(() => {
    const el = ref.current;
    if (el && !(window.CSS && CSS.supports?.('field-sizing', 'content'))) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  });
  const save = async () => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    if (draft === null) return;
    const t = draft.trim();
    if (t === value.trim()) return setDraft(null);
    if (!t && required) {
      setDraft(null);
      return say(required);
    }
    try {
      await onSave(t);
    } catch (e) {
      say((e as Error).message);
    }
    setDraft(null);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      skip.current = true;
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && !(multi && e.shiftKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  return (
    <>
      {id && <label className="sr" htmlFor={id}>{label}</label>}
      <textarea
        ref={ref}
        id={id}
        aria-label={id ? undefined : label}
        className={`ie ${className}`}
        rows={1}
        value={draft ?? value}
        placeholder={placeholder}
        title="Click to edit"
        onChange={(e) => setDraft(multi ? e.target.value : e.target.value.replace(/\n/g, ' '))}
        onBlur={save}
        onKeyDown={keys}
      />
    </>
  );
}

/** "Add" row: one focused input. Enter adds (and keeps a new row open unless once), blur adds and closes, Esc closes. */
export function AddRow({ placeholder, onAdd, onClose, className = 'lc-row bul dl-new', once = false, inputClass = 'lc-input' }: {
  placeholder: string; onAdd: (v: string) => Promise<boolean | void>; onClose: () => void; className?: string; once?: boolean; inputClass?: string;
}) {
  const [v, setV] = useState('');
  const skip = useRef(false);
  const add = async (close: boolean) => {
    const t = v.trim();
    if (!t) return onClose();
    setV('');
    await onAdd(t);
    if (close) onClose();
  };
  return (
    <div className={className}>
      <span className="lc-text" style={{ width: '100%' }}>
        <input
          className={inputClass}
          placeholder={placeholder}
          aria-label={placeholder}
          value={v}
          autoFocus
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (once) skip.current = true;
              void add(once);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              skip.current = true;
              onClose();
            }
          }}
          onBlur={() => {
            if (skip.current) {
              skip.current = false;
              return;
            }
            void add(true);
          }}
        />
      </span>
    </div>
  );
}

/* ---------------- Small parts ---------------- */
export function Seg<K extends string>({ items, value, onChange, label }: { items: { key: K; label: string; n?: number; disabled?: boolean; title?: string }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((b) => (
        <button key={b.key} className={value === b.key ? 'on' : ''} aria-pressed={value === b.key} onClick={() => onChange(b.key)} disabled={b.disabled} title={b.title}>
          {b.label}
          {b.n !== undefined && <span className="n">{b.n}</span>}
        </button>
      ))}
    </div>
  );
}

const w = (n: number, d: number) => `${d ? (n / d) * 100 : 0}%`;
/** Stacked bar. parts: [count, class]. */
export function Bar({ parts, total, small, label, style }: { parts: [number, string][]; total: number; small?: boolean; label?: string; style?: React.CSSProperties }) {
  return (
    <div className={`bar stack ${small ? 'bar-sm' : ''}`} role="img" aria-label={label} title={label} style={style}>
      {parts.map(([n, cls], i) => (
        <div key={i} className={`fill ${cls}`} style={{ width: w(n, total) }} />
      ))}
    </div>
  );
}

export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`card ${className}`} style={style}>{children}</div>;
}

export function Loading({ error }: { error?: string | null }) {
  return <main className="page"><div className="muted">{error ? `Could not load: ${error}` : 'Loading…'}</div></main>;
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div className={`banner ${tone === 'warn' ? 'banner-warn' : tone === 'bad' ? 'banner-bad' : ''}`}>
      {tone !== 'info' && <IWarn s={16} />}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/* ---------------- Dialogs ---------------- */
export function Dialog({ title, sub, onClose, children, foot, filter, onFilter, wide }: {
  title: string; sub?: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; filter?: string; onFilter?: (v: string) => void; wide?: boolean;
}) {
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay">
      <button className="backdrop" onClick={onClose} aria-label="Close" />
      <div className="panel" role="dialog" aria-label={title} style={wide ? { maxWidth: 880 } : undefined}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 className="h2">{title}</h2>
          {sub && <div className="muted" style={{ fontSize: 13 }}>{sub}</div>}
          {onFilter && (
            <>
              <label className="sr" htmlFor="mq">Filter</label>
              <input id="mq" className="input" placeholder="Filter" value={filter} onChange={(e) => onFilter(e.target.value)} autoFocus />
            </>
          )}
        </div>
        <div className="panel-body">{children}</div>
        <div className="panel-foot">{foot ?? <button className="btn" onClick={onClose}>Cancel</button>}</div>
      </div>
    </div>
  );
}

export interface PickRow { key: string; idLabel: string; title: string; sub?: string; tag?: string; tagCls?: string; pick: () => void }
/** A list to pick one row from, with a filter. The caller filters the rows by the text. */
export function Picker({ title, sub, rows, onClose, q, setQ }: { title: string; sub?: ReactNode; rows: PickRow[]; onClose: () => void; q: string; setQ: (v: string) => void }) {
  return (
    <Dialog title={title} sub={sub} onClose={onClose} filter={q} onFilter={setQ}>
      {rows.map((r) => (
        <button key={r.key} className="res" onClick={r.pick}>
          <span className="mono faint" style={{ minWidth: 96 }}>{r.idLabel}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block' }}>{r.title}</span>
            {r.sub && <span className="faint" style={{ fontSize: 12 }}>{r.sub}</span>}
          </span>
          {r.tag && <span className={`tag ${r.tagCls ?? ''}`}>{r.tag}</span>}
        </button>
      ))}
      {!rows.length && <div className="faint" style={{ padding: 16 }}>Nothing matches.</div>}
    </Dialog>
  );
}

/** A "…" button with a small menu. */
export function Menu({ label, items }: { label: string; items: { label: string; danger?: boolean; run: () => void; hidden?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', on);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', on);
      removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}><IMore s={16} /></button>
      {open && (
        <div className="card menu" role="menu">
          {items.filter((i) => !i.hidden).map((i) => (
            <button key={i.label} role="menuitem" className={`res ${i.danger ? 't-bad' : ''}`} onClick={() => (setOpen(false), i.run())}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Page numbers with gaps: 1 … 4 5 6 … 12. */
export function Pager({ page, pages, onPage, text, per, onPer }: { page: number; pages: number; onPage: (n: number) => void; text: string; per?: number; onPer?: (n: number) => void }) {
  const nums: number[] = [];
  for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - page) <= 1) nums.push(n);
  return (
    <div className="pager">
      <span className="muted" style={{ fontSize: 13 }} role="status">{text}</span>
      <span style={{ flex: 1 }} />
      {onPer && (
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span className="faint">Rows per page</span>
          <select className="input sel" value={String(per)} onChange={(e) => onPer(Number(e.target.value))}>
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      <nav className="pages" aria-label="Pages">
        <button className="icon-btn" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page" title="Previous page"><IPrev s={16} /></button>
        {nums.map((n, i) => (
          <span key={n} style={{ display: 'contents' }}>
            {i > 0 && n - nums[i - 1] > 1 && <span className="faint" aria-hidden="true" style={{ padding: '0 4px' }}>…</span>}
            <button className={`pg ${n === page ? 'pg-on' : ''}`} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined} aria-label={`Page ${n}`}>{n}</button>
          </span>
        ))}
        <button className="icon-btn" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page" title="Next page"><INext s={16} /></button>
      </nav>
    </div>
  );
}

/** Sort header button: the arrow shows the order. */
export function SortTh<K extends string>({ k, label, sort, rev, natural, onSort, className }: { k: K; label: string; sort: K; rev: boolean; natural: 'ascending' | 'descending'; onSort: (k: K) => void; className?: string }) {
  const on = sort === k;
  const dir = on ? (rev ? (natural === 'ascending' ? 'descending' : 'ascending') : natural) : 'none';
  return (
    <span role="columnheader" aria-sort={dir} className={className}>
      <button className="th-btn" onClick={() => onSort(k)}>
        {label}
        <span aria-hidden="true">{dir === 'ascending' ? ' ↑' : dir === 'descending' ? ' ↓' : ''}</span>
      </button>
    </span>
  );
}
