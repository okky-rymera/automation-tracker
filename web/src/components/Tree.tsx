import { useMemo, useState, type ReactNode } from 'react';

export interface TreeNode<T> {
  key: string;
  label: string;
  children?: TreeNode<T>[];
  item?: T;
}

/** Builds a folder tree. pathOf gives the folder names and then the leaf label (a title may contain "/"). */
export function buildTree<T>(items: T[], pathOf: (t: T) => string[], keyOf: (t: T) => string): TreeNode<T>[] {
  const root: TreeNode<T> = { key: '', label: '', children: [] };
  for (const item of items) {
    const parts = pathOf(item);
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (last) {
        node.children!.push({ key: keyOf(item), label: part, item });
      } else {
        const key = 'dir:' + parts.slice(0, i + 1).join('/');
        let next = node.children!.find((c) => c.key === key);
        if (!next) {
          next = { key, label: part, children: [] };
          node.children!.push(next);
        }
        node = next;
      }
    });
  }
  const sort = (n: TreeNode<T>) => {
    n.children?.sort((a, b) => Number(!a.children) - Number(!b.children) || a.label.localeCompare(b.label));
    n.children?.forEach(sort);
  };
  sort(root);
  return root.children!;
}

export function leaves<T>(n: TreeNode<T>): T[] {
  return n.item ? [n.item] : (n.children ?? []).flatMap(leaves);
}

interface Props<T> {
  nodes: TreeNode<T>[];
  selected: string | null;
  onSelect: (node: TreeNode<T>) => void;
  /** Right side of each row (bar, count, badge). */
  renderMeta?: (node: TreeNode<T>) => ReactNode;
  renderLabel?: (node: TreeNode<T>) => ReactNode;
  defaultOpenDepth?: number;
  /** When set, all folders open (used while searching). */
  forceOpen?: boolean;
}

export function Tree<T>({ nodes, selected, onSelect, renderMeta, renderLabel, defaultOpenDepth = 1, forceOpen }: Props<T>) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Open the folders that hold the selected item.
  const selectedAncestors = useMemo(() => {
    const out = new Set<string>();
    const find = (list: TreeNode<T>[], trail: string[]): boolean =>
      list.some((n) => (n.key === selected ? (trail.forEach((k) => out.add(k)), true) : n.children ? find(n.children, [...trail, n.key]) : false));
    if (selected) find(nodes, []);
    return out;
  }, [nodes, selected]);

  const row = (n: TreeNode<T>, depth: number): ReactNode => {
    const isDir = !!n.children;
    const isOpen = forceOpen || (open[n.key] ?? (depth < defaultOpenDepth || selectedAncestors.has(n.key) || n.key === selected));
    const isSel = n.key === selected;
    return (
      <div key={n.key}>
        <button
          type="button"
          onClick={() => {
            if (isDir) setOpen((o) => ({ ...o, [n.key]: !isOpen }));
            onSelect(n);
          }}
          className={`group flex w-full items-center gap-2 rounded px-2 py-[3px] text-left hover:bg-surface-2 ${isSel ? 'bg-surface-2 ring-1 ring-accent/40' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <span className="w-3 shrink-0 text-[10px] text-ink-3">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
          <span className={`min-w-0 flex-1 truncate ${isDir ? 'font-medium' : ''}`}>{renderLabel ? renderLabel(n) : n.label}</span>
          {renderMeta && <span className="flex shrink-0 items-center gap-2">{renderMeta(n)}</span>}
        </button>
        {isDir && isOpen && n.children!.map((c) => row(c, depth + 1))}
      </div>
    );
  };
  return <div className="text-[13px]">{nodes.map((n) => row(n, 0))}</div>;
}
