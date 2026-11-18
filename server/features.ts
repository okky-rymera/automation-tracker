/**
 * Feature list: groups > features > scopes, and links from tests to them.
 * People type this data in the app, or the AI skill writes a draft of it.
 * The database holds the only copy.
 *
 * A feature has:
 *  - title, description, priority, group
 *  - labels: short values that repeat across features (roles, needs).
 *    A label exists while at least one feature uses it.
 *  - lists of sentences: rules, out of scope, where, open questions
 *  - scopes: the separate things the feature does, like the scenarios of a test
 *  - links: test -> feature, and the scopes of the feature that the test checks
 *
 * Every link is made by a person (source manual) or by the AI skill (source ai).
 * When a person removes a link, the row stays with removed = 1, so the AI skill
 * does not add it again. checked = 1: a person checked an AI link.
 *
 * AI marks: features.ai_fields and scopes.ai_fields list the fields that the AI
 * skill wrote and no person checked yet. A person who changes a field removes it
 * from the list. "Mark as checked" clears the lists, the item marks and the links.
 */
import { db, json, tx } from './db.ts';

export const PRIORITIES = ['', 'high', 'medium', 'low'];

/** List fields of a feature: API name -> feature_items.kind. */
export const ITEM_KINDS = { rules: 'rule', outOfScope: 'out_of_scope', where: 'where', questions: 'question' } as const;
/** Label fields of a feature: API name -> feature_labels.kind. */
export const LABEL_KINDS = { roles: 'role', needs: 'needs' } as const;
const ITEM_KIND_VALUES: string[] = Object.values(ITEM_KINDS);
/** Feature fields that can carry an AI mark. */
export const FEATURE_AI_FIELDS = ['title', 'description', 'priority', 'group'] as const;
export const SCOPE_AI_FIELDS = ['title', 'description'] as const;

/** Removes fields from a row's AI list: a person changed or checked them. */
function clearAi(table: 'features' | 'scopes', id: number, fields: string[]) {
  if (!fields.length) return;
  const row = db.prepare(`SELECT ai_fields FROM ${table} WHERE id = ?`).get(id) as any;
  const left = (json(row.ai_fields) as string[]).filter((f) => !fields.includes(f));
  db.prepare(`UPDATE ${table} SET ai_fields = ? WHERE id = ?`).run(JSON.stringify(left), id);
}

/** Groups rows by a key, in one pass. */
function byKey<T>(rows: T[], key: (r: T) => number) {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}
const LABEL_KIND_VALUES: string[] = Object.values(LABEL_KINDS);

/** Everything the feature editor needs, in one response. */
export function featureData(projectId: string) {
  const groups = db.prepare('SELECT id, title, description, sort FROM feature_groups WHERE project_id = ? ORDER BY sort, id').all(projectId);
  const features = db
    .prepare('SELECT id, group_id AS groupId, title, description, priority, sort, ai_fields FROM features WHERE project_id = ? ORDER BY sort, id')
    .all(projectId) as any[];
  const scopes = db
    .prepare(
      'SELECT s.id, s.feature_id, s.title, s.description, s.sort, s.ai_fields FROM scopes s JOIN features f ON f.id = s.feature_id WHERE f.project_id = ? ORDER BY s.sort, s.id',
    )
    .all(projectId) as any[];
  const items = db
    .prepare(
      'SELECT i.id, i.feature_id, i.kind, i.text, i.sort, i.ai_draft AS aiDraft FROM feature_items i JOIN features f ON f.id = i.feature_id WHERE f.project_id = ? ORDER BY i.sort, i.id',
    )
    .all(projectId) as any[];
  const labels = db
    .prepare('SELECT l.feature_id, l.kind, l.value FROM feature_labels l JOIN features f ON f.id = l.feature_id WHERE f.project_id = ? ORDER BY l.value COLLATE NOCASE')
    .all(projectId) as any[];
  const links = db
    .prepare(
      `SELECT l.id, l.test_id AS testId, l.feature_id, l.source, l.checked,
              t.framework, t.title, t.file, t.removed_at AS testRemovedAt
       FROM links l LEFT JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id
       WHERE l.project_id = ? AND l.removed = 0 ORDER BY t.framework, t.file, t.line`,
    )
    .all(projectId) as any[];

  const linkScopes = new Map<number, number[]>();
  for (const r of db
    .prepare('SELECT ls.link_id, ls.scope_id FROM link_scopes ls JOIN links l ON l.id = ls.link_id WHERE l.project_id = ? ORDER BY ls.scope_id')
    .all(projectId) as any[])
    linkScopes.set(r.link_id, [...(linkScopes.get(r.link_id) ?? []), r.scope_id]);

  const scopesBy = byKey(scopes, (s) => s.feature_id);
  const itemsBy = byKey(items, (i) => i.feature_id);
  const labelsBy = byKey(labels, (l) => l.feature_id);
  const linksBy = byKey(links, (l) => l.feature_id);
  for (const f of features) {
    f.aiFields = json(f.ai_fields);
    f.aiDraft = f.aiFields.length > 0;
    delete f.ai_fields;
    const myLabels = labelsBy.get(f.id) ?? [];
    for (const [key, kind] of Object.entries(LABEL_KINDS)) f[key] = myLabels.filter((l) => l.kind === kind).map((l) => l.value);
    const myItems = itemsBy.get(f.id) ?? [];
    for (const [key, kind] of Object.entries(ITEM_KINDS))
      f[key] = myItems.filter((i) => i.kind === kind).map((i) => ({ id: i.id, text: i.text, aiDraft: !!i.aiDraft }));
    f.scopes = (scopesBy.get(f.id) ?? []).map(({ feature_id, ai_fields, ...s }) => {
      const aiFields = json(ai_fields) as string[];
      return { ...s, aiFields, aiDraft: aiFields.length > 0 };
    });
    f.links = (linksBy.get(f.id) ?? []).map(({ feature_id, checked, ...l }) => ({
      ...l,
      checked: !!checked,
      scopeIds: linkScopes.get(l.id) ?? [],
      framework: l.framework ?? (l.testId.startsWith('CY-') ? 'cypress' : 'playwright'),
      missing: !l.framework || !!l.testRemovedAt,
    }));
  }

  const linked = new Set(links.map((l) => l.testId));
  const all = db.prepare('SELECT id, framework FROM tests WHERE project_id = ? AND removed_at IS NULL').all(projectId) as any[];
  const unlinked = { playwright: 0, cypress: 0 };
  for (const t of all) if (!linked.has(t.id)) unlinked[t.framework as 'playwright' | 'cypress']++;

  const units = db.prepare('SELECT kind, status, COUNT(*) AS n FROM processed_units WHERE project_id = ? GROUP BY kind, status').all(projectId) as any[];

  return {
    groups,
    features,
    /** Labels in use in the project, most used first: for autocomplete. */
    labels: Object.fromEntries(Object.entries(LABEL_KINDS).map(([key, kind]) => [key, countLabels(labels.filter((l) => l.kind === kind))])),
    processed: units.map((u) => ({ kind: u.kind as string, status: u.status as string, count: u.n as number })),
    unlinked,
    tests: { playwright: all.filter((t) => t.framework === 'playwright').length, cypress: all.filter((t) => t.framework === 'cypress').length },
  };
}

/** Label values with how many features use each, most used first. Letter case does not count. */
function countLabels(rows: { value: string }[]) {
  const m = new Map<string, { value: string; count: number }>();
  for (const r of rows) {
    const k = r.value.toLowerCase();
    const c = m.get(k);
    if (c) c.count++;
    else m.set(k, { value: r.value, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { sensitivity: 'base' }));
}

/** Values of one label kind in the project, with how many features use each. */
export function labelsInUse(projectId: string, kind: string) {
  return db
    .prepare(
      `SELECT l.value, COUNT(*) AS count FROM feature_labels l JOIN features f ON f.id = l.feature_id
       WHERE f.project_id = ? AND l.kind = ? GROUP BY l.value COLLATE NOCASE ORDER BY count DESC, l.value COLLATE NOCASE`,
    )
    .all(projectId, kind) as { value: string; count: number }[];
}

// ---- Edits. Each function throws EditError for bad input. ----

export class EditError extends Error {}

const need = (v: unknown, what: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new EditError(`${what} is empty`);
  if (s.length > 2000) throw new EditError(`${what} is too long`);
  return s;
};
const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 20000) : '');
const nextSort = (table: string, where: string, arg: string | number) =>
  ((db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM ${table} WHERE ${where}`).get(arg) as any).n as number);

function own(table: 'feature_groups' | 'features', projectId: string, id: unknown): number {
  const n = Number(id);
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(n, projectId)) throw new EditError('Not found in this project');
  return n;
}
function ownScope(projectId: string, id: unknown): { id: number; featureId: number } {
  const r = db
    .prepare('SELECT s.id, s.feature_id FROM scopes s JOIN features f ON f.id = s.feature_id WHERE s.id = ? AND f.project_id = ?')
    .get(Number(id), projectId) as any;
  if (!r) throw new EditError('Scope not found in this project');
  return { id: r.id, featureId: r.feature_id };
}
/** Scope ID in feature featureId, or an EditError. */
export function scopeOf(projectId: string, featureId: number, id: unknown): number {
  const s = ownScope(projectId, id);
  if (s.featureId !== featureId) throw new EditError('The scope is not in this feature');
  return s.id;
}
function ownItem(projectId: string, id: unknown): any {
  const r = db
    .prepare('SELECT i.* FROM feature_items i JOIN features f ON f.id = i.feature_id WHERE i.id = ? AND f.project_id = ?')
    .get(Number(id), projectId);
  if (!r) throw new EditError('Item not found in this project');
  return r;
}
function ownLink(projectId: string, id: unknown): any {
  const r = db.prepare('SELECT * FROM links WHERE id = ? AND project_id = ?').get(Number(id), projectId);
  if (!r) throw new EditError('Link not found in this project');
  return r;
}
export function itemKind(v: unknown): string {
  if (typeof v !== 'string' || !ITEM_KIND_VALUES.includes(v)) throw new EditError(`Item kind must be one of: ${ITEM_KIND_VALUES.join(', ')}`);
  return v;
}
export function labelKind(v: unknown): string {
  if (typeof v !== 'string' || !LABEL_KIND_VALUES.includes(v)) throw new EditError(`Label kind must be one of: ${LABEL_KIND_VALUES.join(', ')}`);
  return v;
}
/**
 * Cleans a label value. If the project already uses the same value with other
 * letter case, it returns that spelling, so one role does not show two times.
 */
export function labelValue(projectId: string, kind: string, v: unknown): string {
  const s = need(v, 'Label').replace(/\s+/g, ' ');
  if (s.length > 100) throw new EditError('Label is too long (100 characters or less)');
  const same = labelsInUse(projectId, kind).find((l) => l.value.toLowerCase() === s.toLowerCase());
  return same ? same.value : s;
}

export const edits = {
  addGroup(p: string, b: any) {
    const r = db.prepare('INSERT INTO feature_groups (project_id, title, description, sort) VALUES (?, ?, ?, ?)').run(
      p, need(b.title, 'Title'), text(b.description), nextSort('feature_groups', 'project_id = ?', p),
    );
    return { id: Number(r.lastInsertRowid) };
  },
  updateGroup(p: string, id: string, b: any) {
    const g = own('feature_groups', p, id);
    if ('title' in b) db.prepare('UPDATE feature_groups SET title = ? WHERE id = ?').run(need(b.title, 'Title'), g);
    if ('description' in b) db.prepare('UPDATE feature_groups SET description = ? WHERE id = ?').run(text(b.description), g);
    if ('sort' in b) db.prepare('UPDATE feature_groups SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, g);
  },
  deleteGroup(p: string, id: string) {
    db.prepare('DELETE FROM feature_groups WHERE id = ?').run(own('feature_groups', p, id)); // features become ungrouped
  },

  addFeature(p: string, b: any) {
    const groupId = b.groupId ? own('feature_groups', p, b.groupId) : null;
    const r = db.prepare('INSERT INTO features (project_id, group_id, title, description, sort) VALUES (?, ?, ?, ?, ?)').run(
      p, groupId, need(b.title, 'Title'), text(b.description), nextSort('features', 'project_id = ?', p),
    );
    return { id: Number(r.lastInsertRowid) };
  },
  updateFeature(p: string, id: string, b: any) {
    const f = own('features', p, id);
    // Check all values first, so a refused change saves nothing.
    if ('title' in b) need(b.title, 'Title');
    if ('priority' in b && !PRIORITIES.includes(text(b.priority))) throw new EditError('Priority must be high, medium, low or empty');
    const groupId = 'groupId' in b ? (b.groupId ? own('feature_groups', p, b.groupId) : null) : undefined;
    tx(() => {
      if ('title' in b) db.prepare('UPDATE features SET title = ? WHERE id = ?').run(String(b.title).trim(), f);
      if ('description' in b) db.prepare('UPDATE features SET description = ? WHERE id = ?').run(text(b.description), f);
      if ('priority' in b) db.prepare('UPDATE features SET priority = ? WHERE id = ?').run(text(b.priority), f);
      if (groupId !== undefined) db.prepare('UPDATE features SET group_id = ? WHERE id = ?').run(groupId, f);
      if ('sort' in b) db.prepare('UPDATE features SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, f);
      // A person set these fields: they are not AI draft now. Other AI fields keep their mark.
      clearAi('features', f, [...(['title', 'description', 'priority'] as const).filter((k) => k in b), ...(groupId !== undefined ? ['group'] : [])]);
    });
  },
  /** "Mark as checked": a person read the AI draft. Clears the marks on the feature, its lists, its scopes and its AI links. */
  checkFeature(p: string, id: string) {
    const f = own('features', p, id);
    tx(() => {
      db.prepare("UPDATE features SET ai_fields = '[]' WHERE id = ?").run(f);
      db.prepare('UPDATE feature_items SET ai_draft = 0 WHERE feature_id = ?').run(f);
      db.prepare("UPDATE scopes SET ai_fields = '[]' WHERE feature_id = ?").run(f);
      db.prepare("UPDATE links SET checked = 1 WHERE feature_id = ? AND source = 'ai'").run(f);
    });
  },
  deleteFeature(p: string, id: string) {
    db.prepare('DELETE FROM features WHERE id = ?').run(own('features', p, id)); // labels, lists, scopes and links go too
  },
  /** Moves labels, lists, scopes and links of feature "from" into feature id, then deletes "from". */
  mergeFeature(p: string, id: string, b: any) {
    const into = own('features', p, id);
    const from = own('features', p, b.from);
    if (into === from) throw new EditError('A feature cannot merge with itself');
    tx(() => {
      db.prepare('INSERT OR IGNORE INTO feature_labels (feature_id, kind, value) SELECT ?, kind, value FROM feature_labels WHERE feature_id = ?').run(into, from);
      const itemBase = nextSort('feature_items', 'feature_id = ?', into);
      db.prepare('UPDATE feature_items SET feature_id = ?, sort = sort + ? WHERE feature_id = ?').run(into, itemBase, from);
      const scopeBase = nextSort('scopes', 'feature_id = ?', into);
      db.prepare('UPDATE scopes SET feature_id = ?, sort = sort + ? WHERE feature_id = ?').run(into, scopeBase, from);
      // A test linked to both: an active link wins over a link that a person removed.
      // Then keep the link of the target feature.
      db.prepare(
        'DELETE FROM links WHERE feature_id = ? AND removed = 1 AND test_id IN (SELECT test_id FROM links WHERE feature_id = ? AND removed = 0)',
      ).run(into, from);
      // Before a duplicate link goes, move its scopes to the link that stays.
      db.prepare(
        `INSERT OR IGNORE INTO link_scopes (link_id, scope_id)
         SELECT keep.id, ls.scope_id FROM links old
         JOIN links keep ON keep.project_id = old.project_id AND keep.test_id = old.test_id AND keep.feature_id = ?
         JOIN link_scopes ls ON ls.link_id = old.id
         WHERE old.feature_id = ?`,
      ).run(into, from);
      db.prepare('DELETE FROM links WHERE feature_id = ? AND test_id IN (SELECT test_id FROM links WHERE feature_id = ?)').run(from, into);
      db.prepare('UPDATE links SET feature_id = ? WHERE feature_id = ?').run(into, from);
      db.prepare('DELETE FROM features WHERE id = ?').run(from);
    });
  },

  // Labels (roles, needs). Removing a label from every feature removes it from the project.
  addLabel(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = labelKind(b.kind);
    db.prepare('INSERT OR IGNORE INTO feature_labels (feature_id, kind, value) VALUES (?, ?, ?)').run(f, kind, labelValue(p, kind, b.value));
  },
  deleteLabel(p: string, id: string, b: any) {
    const f = own('features', p, id);
    db.prepare('DELETE FROM feature_labels WHERE feature_id = ? AND kind = ? AND value = ?').run(f, labelKind(b.kind), need(b.value, 'Label'));
  },

  // List items (rules, out of scope, where, open questions).
  addItem(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = itemKind(b.kind);
    const t = need(b.text, 'Text');
    // The same text two times (a double click, Enter then blur) keeps one item.
    const same = db.prepare('SELECT id FROM feature_items WHERE feature_id = ? AND kind = ? AND lower(text) = lower(?)').get(f, kind, t) as any;
    if (same) return { id: same.id as number };
    const r = db.prepare('INSERT INTO feature_items (feature_id, kind, text, sort) VALUES (?, ?, ?, ?)').run(f, kind, t, nextSort('feature_items', 'feature_id = ?', f));
    return { id: Number(r.lastInsertRowid) };
  },
  updateItem(p: string, id: string, b: any) {
    const i = ownItem(p, id);
    const t = 'text' in b ? need(b.text, 'Text') : null;
    tx(() => {
      // A person changed the text: it is not an AI draft now. A move only (sort) keeps the mark.
      if (t !== null) db.prepare('UPDATE feature_items SET text = ?, ai_draft = 0 WHERE id = ?').run(t, i.id);
      if (b.check) db.prepare('UPDATE feature_items SET ai_draft = 0 WHERE id = ?').run(i.id); // checked without a change
      if ('sort' in b) db.prepare('UPDATE feature_items SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, i.id);
    });
  },
  deleteItem(p: string, id: string) {
    db.prepare('DELETE FROM feature_items WHERE id = ?').run(ownItem(p, id).id);
  },

  // Scopes.
  addScope(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const r = db.prepare('INSERT INTO scopes (feature_id, title, description, sort) VALUES (?, ?, ?, ?)').run(
      f, need(b.title, 'Title'), text(b.description), nextSort('scopes', 'feature_id = ?', f),
    );
    return { id: Number(r.lastInsertRowid) };
  },
  updateScope(p: string, id: string, b: any) {
    const s = ownScope(p, id).id;
    const title = 'title' in b ? need(b.title, 'Title') : null;
    tx(() => {
      if (title !== null) db.prepare('UPDATE scopes SET title = ? WHERE id = ?').run(title, s);
      if ('description' in b) db.prepare('UPDATE scopes SET description = ? WHERE id = ?').run(text(b.description), s);
      if ('sort' in b) db.prepare('UPDATE scopes SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, s);
      // b.check = true: the person checked the scope without a change.
      clearAi('scopes', s, b.check ? [...SCOPE_AI_FIELDS] : (['title', 'description'] as const).filter((k) => k in b));
    });
  },
  deleteScope(p: string, id: string) {
    db.prepare('DELETE FROM scopes WHERE id = ?').run(ownScope(p, id).id); // its tests stay linked to the feature
  },

  /**
   * Links a test to a feature, and to one of its scopes if scopeId is given.
   * With only scopeId, the feature is the scope's feature.
   * A link that exists gets the scope added. A link that a person removed comes back.
   */
  addLink(p: string, b: any) {
    const testId = need(b.testId, 'Test ID');
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ?').get(p, testId)) throw new EditError(`Unknown test ${testId}`);
    const f = b.featureId ? own('features', p, b.featureId) : b.scopeId ? ownScope(p, b.scopeId).featureId : own('features', p, null);
    const scopeId = b.scopeId ? scopeOf(p, f, b.scopeId) : null;
    tx(() => {
      db.prepare(`INSERT INTO links (project_id, test_id, feature_id, source) VALUES (?, ?, ?, 'manual')
        ON CONFLICT (project_id, test_id, feature_id) DO UPDATE SET removed = 0, source = 'manual'`).run(p, testId, f);
      const link = (db.prepare('SELECT id FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p, testId, f) as any).id;
      if (scopeId) db.prepare('INSERT OR IGNORE INTO link_scopes (link_id, scope_id) VALUES (?, ?)').run(link, scopeId);
    });
  },
  /** Sets the scopes of a link: body { scopeIds: number[] }. */
  updateLink(p: string, id: string, b: any) {
    const l = ownLink(p, id);
    if (!Array.isArray(b.scopeIds)) throw new EditError('scopeIds must be a list');
    const ids: number[] = [...new Set<number>(b.scopeIds.map((s: unknown) => scopeOf(p, l.feature_id, s)))];
    tx(() => {
      db.prepare('DELETE FROM link_scopes WHERE link_id = ?').run(l.id);
      const add = db.prepare('INSERT INTO link_scopes (link_id, scope_id) VALUES (?, ?)');
      for (const s of ids) add.run(l.id, s);
      db.prepare("UPDATE links SET source = 'manual' WHERE id = ?").run(l.id);
    });
  },
  deleteLink(p: string, id: string) {
    const l = ownLink(p, id);
    // Keep the row as a marker, so the AI skill does not add the link again.
    tx(() => {
      db.prepare('UPDATE links SET removed = 1 WHERE id = ?').run(l.id);
      db.prepare('DELETE FROM link_scopes WHERE link_id = ?').run(l.id);
    });
  },
};
