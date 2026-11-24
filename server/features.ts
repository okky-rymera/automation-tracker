/**
 * Feature list: groups > features > scopes, and links from tests to them.
 * People type this data in the app, or the AI skill writes a draft of it.
 * The database holds the only copy.
 *
 * A feature has:
 *  - title, description, priority, group
 *  - labels: short values that repeat across features (roles).
 *    A label exists while at least one feature uses it.
 *  - lists of sentences: requirements, notes, out of scope, where, open questions.
 *    Notes: only what no test can check (reasons, code facts, limits). A testable rule is a scope.
 *    Requirements: what must be true before a tester checks it (settings, data, the user).
 *  - scopes: the separate things the feature does, like the scenarios of a test.
 *    A scope has its own requirements too (feature_items with scope_id). The feature's
 *    requirements apply to every scope.
 *  - links: test -> feature, and the scopes of the feature that the test checks
 *  - screenshots: images of the feature, each tagged with the scopes it shows. A person or
 *    the AI skill adds them. A deleted screenshot stays as a row with removed = 1 and no image,
 *    so the AI skill does not add it again.
 *
 * Every link is made by a person (source manual) or by the AI skill (source ai).
 * When a person removes a link, the row stays with removed = 1, so the AI skill
 * does not add it again. checked = 1: a person checked an AI link.
 *
 * "To remove" mark (remove_reason on features and scopes): the item must go, with its tests. Its links
 * stay until then. The app leaves it out of the coverage counts, and the AI skills do not write to it (map.ts).
 *
 * AI marks: features.ai_fields and scopes.ai_fields list the fields that the AI
 * skill wrote and no person checked yet. A person who changes a field removes it
 * from the list. "Mark as checked" clears the lists, the item marks and the links.
 */
import { db, json, now, tx } from './db.ts';

export const PRIORITIES = ['', 'high', 'medium', 'low'];

/** List fields of a feature: API name -> feature_items.kind. */
export const ITEM_KINDS = { requirements: 'requirement', notes: 'note', outOfScope: 'out_of_scope', where: 'where', questions: 'question' } as const;
/** The only list kind that a scope has. */
export const SCOPE_ITEM_KIND = ITEM_KINDS.requirements;
/** Label fields of a feature: API name -> feature_labels.kind. */
export const LABEL_KINDS = { roles: 'role' } as const;
const ITEM_KIND_VALUES: string[] = Object.values(ITEM_KINDS);
/** Feature fields that can carry an AI mark. */
export const FEATURE_AI_FIELDS = ['title', 'description', 'priority', 'group'] as const;
export const SCOPE_AI_FIELDS = ['title', 'description', 'group'] as const;

/** Removes fields from a row's AI list: a person changed or checked them. Their "before" values go too. */
function clearAi(table: 'features' | 'scopes', id: number, fields: string[]) {
  if (!fields.length) return;
  const row = db.prepare(`SELECT ai_fields FROM ${table} WHERE id = ?`).get(id) as any;
  const left = (json(row.ai_fields) as string[]).filter((f) => !fields.includes(f));
  db.prepare(`UPDATE ${table} SET ai_fields = ? WHERE id = ?`).run(JSON.stringify(left), id);
  dropBefore(table === 'features' ? 'feature' : 'scope', id, fields);
}

/**
 * "Before" values (table ai_before): the value of a field before the AI skill changed it.
 * The review screen shows it and offers "Change back". A row stays while the field has its AI mark.
 * kind: feature, scope or item. For an item, the field is "text". For a group, the value is the group ID as text.
 */
export type BeforeKind = 'feature' | 'scope' | 'item';

/**
 * Saves the value of a field right before the AI skill writes a new one (map.ts).
 * fresh: the field has no AI mark now, so the value is from a person (or empty). Only such a value is saved,
 * and it replaces an old row. When the field has an AI mark, the value is an earlier AI draft: a row that
 * holds the value of a person stays, and an AI value is not saved.
 */
export function keepBefore(kind: BeforeKind, rowId: number, field: string, value: unknown, fresh: boolean) {
  if (!fresh) return;
  const v = value === null || value === undefined ? null : String(value);
  db.prepare('INSERT OR REPLACE INTO ai_before (kind, row_id, field, before, at) VALUES (?, ?, ?, ?, ?)').run(kind, rowId, field, v, now());
}
/** Deletes the "before" values of a row: of the given fields, or of all fields. */
export function dropBefore(kind: BeforeKind, rowId: number, fields?: string[]) {
  if (!fields) return void db.prepare('DELETE FROM ai_before WHERE kind = ? AND row_id = ?').run(kind, rowId);
  const del = db.prepare('DELETE FROM ai_before WHERE kind = ? AND row_id = ? AND field = ?');
  for (const f of fields) del.run(kind, rowId, f);
}
/**
 * Deletes the "before" values whose row is gone or whose field has no AI mark now.
 * A safety net after deletes, merges and moves: an ID can come back for a new row.
 */
export function sweepBefore() {
  db.prepare(
    `DELETE FROM ai_before WHERE
       (kind = 'item' AND NOT EXISTS (SELECT 1 FROM feature_items i WHERE i.id = ai_before.row_id AND i.ai_draft = 1))
       OR (kind = 'feature' AND NOT EXISTS (SELECT 1 FROM features f, json_each(f.ai_fields) j WHERE f.id = ai_before.row_id AND j.value = ai_before.field))
       OR (kind = 'scope' AND NOT EXISTS (SELECT 1 FROM scopes s, json_each(s.ai_fields) j WHERE s.id = ai_before.row_id AND j.value = ai_before.field))`,
  ).run();
}

/**
 * SQL condition: feature f has no open AI mark (no AI field, list item, scope, link, code or screenshot
 * that no person checked). The same rule as needsReview in the app (FeaturesTab.tsx).
 */
const NO_OPEN_MARKS = `f.ai_fields = '[]'
  AND NOT EXISTS (SELECT 1 FROM feature_items i WHERE i.feature_id = f.id AND i.ai_draft = 1)
  AND NOT EXISTS (SELECT 1 FROM scopes s WHERE s.feature_id = f.id AND s.ai_fields <> '[]')
  AND NOT EXISTS (SELECT 1 FROM links l WHERE l.feature_id = f.id AND l.source = 'ai' AND l.checked = 0 AND l.removed = 0)
  AND NOT EXISTS (SELECT 1 FROM feature_code c WHERE c.feature_id = f.id AND c.source = 'ai' AND c.checked = 0 AND c.removed = 0)
  AND NOT EXISTS (SELECT 1 FROM screenshots x WHERE x.feature_id = f.id AND x.source = 'ai' AND x.checked = 0 AND x.removed = 0)`;

/**
 * Review state, after a person changed something in the app. A feature with no open AI mark is
 * reviewed now, when no person reviewed it yet, or when the AI changed it after the last review.
 * So a person who checks the AI marks one by one reviews the feature too, and a feature that a
 * person made counts as reviewed. A feature that was reviewed and did not change keeps its time.
 */
export function sweepReviewed(projectId: string) {
  db.prepare(
    `UPDATE features AS f SET reviewed_at = ?
     WHERE f.project_id = ? AND f.review_wanted = 0 AND (f.reviewed_at IS NULL OR (f.ai_changed_at IS NOT NULL AND f.ai_changed_at > f.reviewed_at))
       AND ${NO_OPEN_MARKS}`,
  ).run(now(), projectId);
}

/**
 * "To remove" mark of a feature or a scope (db step 33). Body value: a reason, { reason, by }, or null to clear it.
 * by: "person" (default) or "ai" (an AI that a person asked to set the mark).
 * at: optional ISO time, for an undo that puts back a mark with its first date.
 */
export interface ToRemove { reason: string; at: string; by: 'person' | 'ai' }
function toRemoveOf(v: unknown): { reason: string; by: string; at: string | null } | null {
  if (v === null) return null;
  const o = typeof v === 'string' ? { reason: v } : (v as any);
  const reason = typeof o?.reason === 'string' ? o.reason.trim() : '';
  if (!reason) throw new EditError('toRemove needs a reason, or null to clear the mark');
  if (reason.length > 1000) throw new EditError('The reason is too long (1000 characters or less)');
  const by = o.by === undefined ? 'person' : o.by;
  if (by !== 'person' && by !== 'ai') throw new EditError('toRemove.by must be "person" or "ai"');
  const at = o.at === undefined || o.at === null ? null : String(o.at);
  if (at !== null && Number.isNaN(Date.parse(at))) throw new EditError('toRemove.at must be a date and time (ISO)');
  return { reason, by, at };
}
function setToRemove(table: 'features' | 'scopes', id: number, v: unknown) {
  const m = toRemoveOf(v);
  db.prepare(`UPDATE ${table} SET remove_reason = ?, remove_at = ?, remove_by = ? WHERE id = ?`).run(m?.reason ?? null, m ? (m.at ?? now()) : null, m?.by ?? null, id);
}
const toRemoveRow = (r: any): ToRemove | null => (r.remove_reason ? { reason: r.remove_reason, at: r.remove_at, by: r.remove_by === 'ai' ? 'ai' : 'person' } : null);
/** IDs of the features of a project that have the "To remove" mark. */
export function featuresToRemove(projectId: string): Set<number> {
  return new Set((db.prepare('SELECT id FROM features WHERE project_id = ? AND remove_reason IS NOT NULL').all(projectId) as any[]).map((r) => r.id as number));
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
    .prepare('SELECT id, group_id AS groupId, title, description, priority, sort, ai_fields, reviewed_at AS reviewedAt, review_wanted AS reviewWanted, ai_changed_at AS aiChangedAt, remove_reason, remove_at, remove_by FROM features WHERE project_id = ? ORDER BY sort, id')
    .all(projectId) as any[];
  const scopes = db
    .prepare(
      'SELECT s.id, s.feature_id, s.title, s.description, s.group_id AS groupId, s.parent_id AS parentId, s.columns, s.var_values, s.sort, s.ai_fields, s.remove_reason, s.remove_at, s.remove_by FROM scopes s JOIN features f ON f.id = s.feature_id WHERE f.project_id = ? ORDER BY s.sort, s.id',
    )
    .all(projectId) as any[];
  const scopeGroups = db
    .prepare('SELECT g.id, g.feature_id, g.title, g.sort FROM scope_groups g JOIN features f ON f.id = g.feature_id WHERE f.project_id = ? ORDER BY g.sort, g.id')
    .all(projectId) as any[];
  const items = db
    .prepare(
      'SELECT i.id, i.feature_id, i.scope_id, i.kind, i.text, i.sort, i.ai_draft AS aiDraft FROM feature_items i JOIN features f ON f.id = i.feature_id WHERE f.project_id = ? ORDER BY i.sort, i.id',
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
  const scopeGroupsBy = byKey(scopeGroups, (g) => g.feature_id);
  const itemsBy = byKey(items, (i) => i.feature_id);
  const labelsBy = byKey(labels, (l) => l.feature_id);
  const linksBy = byKey(links, (l) => l.feature_id);
  const code = db
    .prepare("SELECT feature_id, COUNT(*) AS n, SUM(source = 'ai' AND checked = 0) AS ai FROM feature_code WHERE project_id = ? AND removed = 0 GROUP BY feature_id")
    .all(projectId) as any[];
  const codeBy = new Map(code.map((r) => [r.feature_id, r]));
  // Screenshots without the image bytes: the app loads each image from its own URL.
  const shots = db
    .prepare('SELECT id, feature_id, caption, sort, source, checked FROM screenshots WHERE project_id = ? AND removed = 0 ORDER BY sort, id')
    .all(projectId) as any[];
  const shotScopes = byKey(
    db
      .prepare('SELECT ss.screenshot_id, ss.scope_id FROM screenshot_scopes ss JOIN screenshots s ON s.id = ss.screenshot_id WHERE s.project_id = ? ORDER BY ss.scope_id')
      .all(projectId) as any[],
    (r) => r.screenshot_id,
  );
  const shotsBy = byKey(shots, (s) => s.feature_id);
  // "Before" values of the AI changes. Only a field that has its AI mark now shows one.
  const before = new Map<string, Record<string, string | null>>();
  for (const r of db
    .prepare(
      `SELECT b.kind, b.row_id, b.field, b.before FROM ai_before b WHERE
         (b.kind = 'feature' AND b.row_id IN (SELECT id FROM features WHERE project_id = ?))
         OR (b.kind = 'scope' AND b.row_id IN (SELECT s.id FROM scopes s JOIN features f ON f.id = s.feature_id WHERE f.project_id = ?))
         OR (b.kind = 'item' AND b.row_id IN (SELECT i.id FROM feature_items i JOIN features f ON f.id = i.feature_id WHERE f.project_id = ?))`,
    )
    .all(projectId, projectId, projectId) as any[]) {
    const k = `${r.kind}:${r.row_id}`;
    before.set(k, { ...before.get(k), [r.field]: r.before });
  }
  const beforeOf = (kind: BeforeKind, id: number, aiFields: string[]) =>
    Object.fromEntries(Object.entries(before.get(`${kind}:${id}`) ?? {}).filter(([field]) => aiFields.includes(field)));
  for (const f of features) {
    // Mapped code: number of entries, and how many the AI added that no person checked.
    f.code = { entries: codeBy.get(f.id)?.n ?? 0, aiToCheck: codeBy.get(f.id)?.ai ?? 0 };
    f.aiFields = json(f.ai_fields);
    f.aiDraft = f.aiFields.length > 0;
    f.reviewWanted = !!f.reviewWanted;
    f.before = beforeOf('feature', f.id, f.aiFields);
    f.toRemove = toRemoveRow(f);
    delete f.ai_fields;
    delete f.remove_reason;
    delete f.remove_at;
    delete f.remove_by;
    const myLabels = labelsBy.get(f.id) ?? [];
    for (const [key, kind] of Object.entries(LABEL_KINDS)) f[key] = myLabels.filter((l) => l.kind === kind).map((l) => l.value);
    const myItems = itemsBy.get(f.id) ?? [];
    const toItem = (i: any) => ({ id: i.id, text: i.text, aiDraft: !!i.aiDraft });
    for (const [key, kind] of Object.entries(ITEM_KINDS)) f[key] = myItems.filter((i) => i.kind === kind && i.scope_id === null).map(toItem);
    f.scopeGroups = (scopeGroupsBy.get(f.id) ?? []).map(({ feature_id, ...g }) => g);
    // A scope with variations has columns. A variation has parentId and values (one for each column).
    f.scopes = (scopesBy.get(f.id) ?? []).map(({ feature_id, ai_fields, remove_reason, remove_at, remove_by, columns, var_values, ...s }) => {
      const aiFields = json(ai_fields) as string[];
      const requirements = myItems.filter((i) => i.scope_id === s.id).map(toItem);
      const toRemove = toRemoveRow({ remove_reason, remove_at, remove_by });
      return { ...s, columns: columns === null ? null : jsonList(columns), values: s.parentId === null ? null : jsonList(var_values), requirements, aiFields, aiDraft: aiFields.length > 0, before: beforeOf('scope', s.id, aiFields), toRemove };
    });
    f.links = (linksBy.get(f.id) ?? []).map(({ feature_id, checked, ...l }) => ({
      ...l,
      checked: !!checked,
      scopeIds: linkScopes.get(l.id) ?? [],
      framework: l.framework ?? (l.testId.startsWith('CY-') ? 'cypress' : 'playwright'),
      missing: !l.framework || !!l.testRemovedAt,
    }));
    f.screenshots = (shotsBy.get(f.id) ?? []).map(({ feature_id, source, checked, ...s }) => ({
      ...s,
      source,
      aiDraft: source === 'ai' && !checked,
      scopeIds: (shotScopes.get(s.id) ?? []).map((r) => r.scope_id),
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
export const nextSort = (table: string, where: string, arg: string | number) =>
  ((db.prepare(`SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM ${table} WHERE ${where}`).get(arg) as any).n as number);

/**
 * The number of an ID as people copy it from the web page: "40", "S-40", "F-12/S-40" or "F-12/IMG-7".
 * The last part names the thing; its feature (before "/") is only a help for people.
 */
export function idNumber(id: unknown): number {
  if (typeof id === 'number') return id;
  const last = String(id ?? '').trim().split('/').pop() ?? '';
  const m = /^(?:[a-z]+-)?(\d+)$/i.exec(last.trim());
  return m ? Number(m[1]) : NaN;
}

function own(table: 'feature_groups' | 'features', projectId: string, id: unknown): number {
  const n = idNumber(id);
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(n, projectId)) throw new EditError('Not found in this project');
  return n;
}
function ownScope(projectId: string, id: unknown): { id: number; featureId: number } {
  const r = db
    .prepare('SELECT s.id, s.feature_id FROM scopes s JOIN features f ON f.id = s.feature_id WHERE s.id = ? AND f.project_id = ?')
    .get(idNumber(id), projectId) as any;
  if (!r) throw new EditError('Scope not found in this project');
  return { id: r.id, featureId: r.feature_id };
}
/** A scope group of the project: its ID and its feature. */
function ownScopeGroup(projectId: string, id: unknown): { id: number; featureId: number } {
  const r = db
    .prepare('SELECT g.id, g.feature_id FROM scope_groups g JOIN features f ON f.id = g.feature_id WHERE g.id = ? AND f.project_id = ?')
    .get(idNumber(id), projectId) as any;
  if (!r) throw new EditError('Scope group not found in this project');
  return { id: r.id, featureId: r.feature_id };
}
/** A group title: trimmed, one space between words, not empty, and not the title of another group of the feature. */
function scopeGroupTitle(fid: number, v: unknown, self: number | null = null): string {
  const t = need(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, 'Group title');
  if (t.length > 200) throw new EditError('Group title is too long');
  if (db.prepare('SELECT 1 FROM scope_groups WHERE feature_id = ? AND lower(title) = lower(?) AND id IS NOT ?').get(fid, t, self))
    throw new EditError(`This feature has a group "${t}" already`);
  return t;
}
/**
 * The group of feature fid that a title names (title: trimmed, one space between words):
 *  - id: a group with this title, or the group that a person renamed from this title
 *  - deleted: a person deleted the group with this title (id is null)
 *  - id null and not deleted: an empty title, or a title that the feature does not know
 */
export function findScopeGroup(fid: number, title: unknown): { title: string; id: number | null; deleted: boolean } {
  const t = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
  if (!t) return { title: t, id: null, deleted: false };
  const now = db.prepare('SELECT id FROM scope_groups WHERE feature_id = ? AND lower(title) = lower(?)').get(fid, t) as any;
  if (now) return { title: t, id: now.id, deleted: false };
  const gone = db.prepare('SELECT group_id FROM scope_group_titles_gone WHERE feature_id = ? AND title_key = lower(trim(?))').get(fid, t) as any;
  if (gone) return { title: t, id: gone.group_id, deleted: gone.group_id === null };
  return { title: t, id: null, deleted: false };
}
/**
 * The ID of the scope group that a title names in feature fid (findScopeGroup). A new group is made when
 * the feature does not know the title. Null: an empty title, or a group that a person deleted.
 * The AI skill (aiMade) and a scope move use it.
 */
export function scopeGroupId(fid: number, title: unknown, aiMade = false): number | null {
  const g = findScopeGroup(fid, title);
  if (g.id !== null || g.deleted || !g.title) return g.id;
  // The length limit is for a new title only.
  if (g.title.length > 200) throw new EditError('Group title is too long');
  return newScopeGroup(fid, g.title, aiMade);
}
/** Adds a group. Its title is not "gone" now, so the AI skills can use it again. */
function newScopeGroup(fid: number, title: string, aiMade = false): number {
  db.prepare('DELETE FROM scope_group_titles_gone WHERE feature_id = ? AND title_key = lower(trim(?))').run(fid, title);
  return Number(
    db.prepare('INSERT INTO scope_groups (feature_id, title, sort, ai_made) VALUES (?, ?, ?, ?)').run(fid, title, nextSort('scope_groups', 'feature_id = ?', fid), aiMade ? 1 : 0)
      .lastInsertRowid,
  );
}
/**
 * Deletes group gid when an AI skill made it, no person changed it, and it has no scopes now.
 * Returns its title when it went. It is not remembered as "deleted": no person deleted it.
 */
export function dropEmptyAiGroup(gid: number | null): string | null {
  if (gid === null) return null;
  const g = db.prepare('SELECT title FROM scope_groups WHERE id = ? AND ai_made = 1 AND NOT EXISTS (SELECT 1 FROM scopes WHERE group_id = ?)').get(gid, gid) as any;
  if (!g) return null;
  db.prepare('DELETE FROM scope_group_titles_gone WHERE group_id = ?').run(gid);
  db.prepare('DELETE FROM scope_groups WHERE id = ?').run(gid);
  return g.title;
}
/** groupId from a request: null (no group), or a group of feature fid. */
function groupOf(projectId: string, fid: number, v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const g = ownScopeGroup(projectId, v);
  if (g.featureId !== fid) throw new EditError('The group is not in this feature');
  return g.id;
}
/**
 * Scope variations: one check in several places (for example on 4 pages). The scope keeps the sentence (its
 * title), the description, the requirements and the group, and has the column names (scopes.columns, a JSON
 * list; NULL: no variations). Each variation is a row of the scopes table with parent_id and var_values (one
 * value for each column, in column order). A person or the AI types each variation: the app does not make
 * combinations. A variation has the test links, screenshots, code and coverage. A scope with variations has
 * none of them, so a test always says which variation it checks.
 * A variation's ID shows as SV-<id>. S- and SV- IDs share one number series, so a number names one row only.
 * The title of a variation is the sentence with the values in brackets (variationTitle), so the AI skills and
 * the Tests page see a full sentence. An empty value is left out of the title.
 */
export const variationTitle = (sentence: string, values: string[]) => {
  const v = values.filter(Boolean);
  return v.length ? `${sentence} (${v.join(', ')})` : sentence;
};
export const MAX_COLUMNS = 6;
export function jsonList(v: string | null | undefined): string[] {
  try {
    const a = JSON.parse(v ?? '[]');
    return Array.isArray(a) ? a.map((x) => String(x ?? '')) : [];
  } catch {
    return [];
  }
}
/** A column name: trimmed, one space between words, not empty, at most 100 characters. */
export function columnWord(v: unknown, what: string): string {
  const t = need(typeof v === 'string' ? v.replace(/\s+/g, ' ') : v, what);
  if (t.length > 100) throw new EditError(`${what} is too long`);
  return t;
}
/** Column names from a request: 1 to MAX_COLUMNS names, each one only one time. */
export function columnList(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new EditError('columns must be a list with at least one name');
  if (v.length > MAX_COLUMNS) throw new EditError(`A scope can have at most ${MAX_COLUMNS} columns`);
  const names = v.map((x) => columnWord(x, 'Column name'));
  const dup = names.find((n, i) => names.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i);
  if (dup) throw new EditError(`The column "${dup}" is in the list two times`);
  return names;
}
/**
 * The values of a variation, one for each column, in column order. The request gives a list (in column
 * order), an object with the column names as keys, or one string for one column. A missing value is empty.
 * A variation needs at least one value.
 */
export function variationValues(columns: string[], v: unknown): string[] {
  let vals: unknown[];
  if (typeof v === 'string') vals = [v];
  else if (Array.isArray(v)) vals = v;
  else if (v && typeof v === 'object') {
    const o = new Map(Object.entries(v).map(([k, x]) => [k.replace(/\s+/g, ' ').trim().toLowerCase(), x]));
    const unknown = [...o.keys()].find((k) => !columns.some((c) => c.toLowerCase() === k));
    if (unknown !== undefined) throw new EditError(`The scope has no column "${unknown}". Its columns: ${columns.join(', ')}`);
    vals = columns.map((c) => o.get(c.toLowerCase()));
  } else throw new EditError('The values are missing');
  if (vals.length > columns.length) throw new EditError(`The scope has ${columns.length} column(s), but the variation has ${vals.length} values`);
  const out = columns.map((c, i) => {
    const x = vals[i];
    if (x === undefined || x === null) return '';
    const t = String(x).trim().replace(/\s+/g, ' ');
    if (t.length > 100) throw new EditError(`The value of column "${c}" is too long`);
    return t;
  });
  if (out.every((x) => !x)) throw new EditError('A variation needs at least one value');
  return out;
}
export const valuesKey = (vals: string[]) => JSON.stringify(vals.map((v) => v.toLowerCase()));

/** A scope row: parentId is set for a variation, columns for a scope with variations. */
export interface ScopeRow { id: number; featureId: number; title: string; groupId: number | null; parentId: number | null; columns: string[] | null; values: string[] | null }
export function scopeRow(id: number): ScopeRow {
  const r = db.prepare('SELECT id, feature_id, title, group_id, parent_id, columns, var_values FROM scopes WHERE id = ?').get(id) as any;
  if (!r) throw new EditError('Scope not found');
  return {
    id: r.id, featureId: r.feature_id, title: r.title, groupId: r.group_id, parentId: r.parent_id,
    columns: r.columns === null ? null : jsonList(r.columns), values: r.parent_id === null ? null : jsonList(r.var_values),
  };
}
/** The ID as people see it: S-12 for a scope, SV-40 for a variation. */
export const scopeLabel = (r: { id: number; parentId?: number | null; parent_id?: number | null }) => `${(r.parentId ?? r.parent_id) != null ? 'SV' : 'S'}-${r.id}`;
/** The variations of scope id, in order. */
export const variationsOf = (id: number) =>
  (db.prepare('SELECT id, title, var_values FROM scopes WHERE parent_id = ? ORDER BY sort, id').all(id) as any[]).map((r) => ({ id: r.id as number, title: r.title as string, values: jsonList(r.var_values) }));
/** A scope of the project that has variations. */
function ownParent(projectId: string, id: unknown): ScopeRow {
  const r = scopeRow(ownScope(projectId, id).id);
  if (r.parentId !== null) throw new EditError(`${scopeLabel(r)} is a variation. Use its scope S-${r.parentId}`);
  if (r.columns === null) throw new EditError(`S-${r.id} has no variations`);
  return r;
}
/**
 * The title of a variation of parent with these values. Refused: a second variation with the same values,
 * or a title that another scope of the feature has. self: the variation that changes.
 */
function variationTitleFor(parent: ScopeRow, sentence: string, values: string[], self: number | null): string {
  const key = valuesKey(values);
  const same = variationsOf(parent.id).find((v) => v.id !== self && valuesKey(v.values) === key);
  if (same) throw new EditError(`The scope has a variation with these values already (SV-${same.id})`);
  const title = variationTitle(sentence, values);
  if (db.prepare('SELECT 1 FROM scopes WHERE feature_id = ? AND lower(title) = lower(?) AND id IS NOT ?').get(parent.featureId, title, self))
    throw new EditError(`Another scope of this feature has the title "${title}" already`);
  return title;
}
/** Adds a variation to scope parent (columns set). It is in the group of its scope. Returns its ID. */
export function newVariation(parent: ScopeRow, values: string[], aiFields: string[] = []): number {
  const title = variationTitleFor(parent, parent.title, values, null);
  return Number(
    db
      .prepare(`INSERT INTO scopes (id, feature_id, title, description, group_id, parent_id, var_values, sort, ai_fields) VALUES (${NEW_SCOPE_ID}, ?, ?, '', ?, ?, ?, ?, ?)`)
      .run(parent.featureId, title, parent.groupId, parent.id, JSON.stringify(values), nextSort('scopes', 'parent_id = ?', parent.id), JSON.stringify(aiFields)).lastInsertRowid,
  );
}
/**
 * Gives each variation of parent new values (change) and the title from sentence and the new values (after a
 * new sentence, or a new or deleted column). The old titles are remembered for the AI skills.
 */
export function resetVariations(parent: ScopeRow, sentence: string, change: (vals: string[]) => string[]) {
  const vars = variationsOf(parent.id);
  const keys = new Map<string, number>();
  const titles = new Map<string, number>();
  for (const v of vars) {
    const vals = change(v.values);
    if (vals.every((x) => !x)) throw new EditError(`Variation SV-${v.id} would have no value`);
    const k = valuesKey(vals);
    if (keys.has(k)) throw new EditError(`Variations SV-${keys.get(k)} and SV-${v.id} would have the same values`);
    keys.set(k, v.id);
    // An empty value is left out of the title, so other values can still give the same title.
    const t = variationTitle(sentence, vals).toLowerCase();
    if (titles.has(t)) throw new EditError(`Variations SV-${titles.get(t)} and SV-${v.id} would have the same title "${variationTitle(sentence, vals)}"`);
    titles.set(t, v.id);
  }
  for (const v of vars) {
    const vals = change(v.values);
    const title = variationTitle(sentence, vals);
    if (db.prepare('SELECT 1 FROM scopes WHERE feature_id = ? AND lower(title) = lower(?) AND id <> ? AND parent_id IS NOT ?').get(parent.featureId, title, v.id, parent.id))
      throw new EditError(`Another scope of this feature has the title "${title}" already`);
    if (title.toLowerCase() !== v.title.toLowerCase()) buryScope(parent.featureId, v.id, v.title);
    db.prepare('UPDATE scopes SET title = ?, var_values = ? WHERE id = ?').run(title, JSON.stringify(vals), v.id);
  }
}
/** Moves the test links, screenshot tags and code tags of scope from to scope to. */
export function moveEvidence(from: number, to: number) {
  for (const [table, col] of [['link_scopes', 'link_id'], ['screenshot_scopes', 'screenshot_id'], ['code_scopes', 'code_id']]) {
    db.prepare(`INSERT OR IGNORE INTO ${table} (${col}, scope_id) SELECT ${col}, ? FROM ${table} WHERE scope_id = ?`).run(to, from);
    db.prepare(`DELETE FROM ${table} WHERE scope_id = ?`).run(from);
  }
}
/** Refuses a scope with variations as the scope of a test link, screenshot or code entry. */
export function evidenceScope(id: number): number {
  const r = db.prepare('SELECT columns FROM scopes WHERE id = ?').get(id) as any;
  if (r && r.columns !== null) {
    const v = variationsOf(id).map((x) => `SV-${x.id}`);
    throw new EditError(`S-${id} has variations. Use a variation: ${v.join(', ')}`);
  }
  return id;
}
/**
 * Remembers an old title of a scope on a feature: a person deleted the scope, moved it away, or
 * renamed it. The AI skill finds scopes by title, so without this it makes the scope again (map.ts goneScope).
 */
function buryScope(featureId: number, scopeId: number, title: string) {
  db.prepare('INSERT OR IGNORE INTO scope_titles_gone (feature_id, scope_id, title_key) VALUES (?, ?, lower(trim(?)))').run(featureId, scopeId, title);
}
/**
 * SQL for the ID of a new scope. SQLite gives a new row the ID of the last deleted row, but an S-id must
 * name one scope only: people use it, and scope_titles_gone remembers the IDs of deleted scopes.
 */
export const NEW_SCOPE_ID =
  '(SELECT MAX(COALESCE((SELECT MAX(id) FROM scopes), 0), COALESCE((SELECT MAX(scope_id) FROM scope_titles_gone), 0)) + 1)';
/** Scope ID in feature featureId, or an EditError. */
export function scopeOf(projectId: string, featureId: number, id: unknown): number {
  const s = ownScope(projectId, id);
  if (s.featureId !== featureId) throw new EditError('The scope is not in this feature');
  return s.id;
}
function ownItem(projectId: string, id: unknown): any {
  const r = db
    .prepare('SELECT i.* FROM feature_items i JOIN features f ON f.id = i.feature_id WHERE i.id = ? AND f.project_id = ?')
    .get(idNumber(id), projectId);
  if (!r) throw new EditError('Item not found in this project');
  return r;
}
/**
 * A feature requirement applies to every scope, so a scope does not repeat it, and the
 * feature does not take one that a scope has. Returns why the text is refused, or null.
 * skipId: the item that changes its text, so it does not clash with itself.
 */
export function requirementClash(fid: number, scopeId: number | null, kind: string, t: string, skipId: number | null = null): string | null {
  if (kind !== SCOPE_ITEM_KIND) return null;
  const other = db
    .prepare(
      `SELECT scope_id FROM feature_items WHERE feature_id = ? AND kind = ? AND lower(text) = lower(?) AND id IS NOT ?
       AND (CASE WHEN ? IS NULL THEN scope_id IS NOT NULL ELSE scope_id IS NULL END) LIMIT 1`,
    )
    .get(fid, kind, t, skipId, scopeId) as any;
  if (!other) return null;
  return scopeId === null
    ? `Scope S-${other.scope_id} has this requirement already. Remove it there first: a feature requirement applies to every scope.`
    : 'The feature has this requirement already, and it applies to every scope.';
}
function ownScreenshot(projectId: string, id: unknown): { id: number; featureId: number } {
  const r = db.prepare('SELECT id, feature_id FROM screenshots WHERE id = ? AND project_id = ? AND removed = 0').get(idNumber(id), projectId) as any;
  if (!r) throw new EditError('Screenshot not found in this project');
  return { id: r.id, featureId: r.feature_id };
}
/** Scope IDs of feature featureId from a request body list, without duplicates. */
function scopeList(projectId: string, featureId: number, v: unknown): number[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new EditError('scopeIds must be a list');
  return [...new Set(v.map((s) => evidenceScope(scopeOf(projectId, featureId, s))))];
}

/** Largest image the app accepts, after base64 decoding. */
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
/** Image types and the first bytes of each. No SVG: an SVG file can run scripts. */
const IMAGE_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** Reads a "data:image/...;base64,..." URL. The first bytes must match the type. */
function imageFromDataUrl(v: unknown): { mime: string; data: Buffer } {
  const m = typeof v === 'string' ? /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v) : null;
  if (!m) throw new EditError('Send the image as a base64 data URL');
  const mime = m[1];
  if (!IMAGE_TYPES[mime]) throw new EditError('Use a PNG, JPEG, WebP or GIF image');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > SCREENSHOT_MAX_BYTES) throw new EditError('The image is too large (10 MB or less)');
  if (!IMAGE_TYPES[mime](data)) throw new EditError(`The file is not a ${mime.slice(6).toUpperCase()} image`);
  return { mime, data };
}
/**
 * The fixed form of a caption that the AI skill uses to find its own screenshots: Unicode-normalized,
 * lower case (all letters, not only A–Z), and with each run of spaces as one space.
 */
export function captionKey(caption: string): string {
  return caption.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Image type from the first bytes of an image file (for files that have no type, like a file on disk). */
export function imageType(data: Buffer): string {
  if (data.length > SCREENSHOT_MAX_BYTES) throw new EditError('The image is too large (10 MB or less)');
  const mime = Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t](data));
  if (!mime) throw new EditError('The file is not a PNG, JPEG, WebP or GIF image');
  return mime;
}

/** Type and upload time of one screenshot, or null. Cheap: it does not read the image. */
export function screenshotInfo(projectId: string, id: unknown): { id: number; mime: string; createdAt: string } | null {
  return (db.prepare('SELECT id, mime, created_at AS createdAt FROM screenshots WHERE id = ? AND project_id = ? AND removed = 0').get(idNumber(id), projectId) as any) ?? null;
}
/** The image bytes of a screenshot (an ID from screenshotInfo). */
export function screenshotData(id: number): Uint8Array {
  return (db.prepare('SELECT data FROM screenshot_images WHERE screenshot_id = ?').get(id) as any).data;
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
    if ('check' in b && (!Array.isArray(b.check) || b.check.some((k: unknown) => typeof k !== 'string'))) throw new EditError('check must be a list of field names');
    if ('toRemove' in b) toRemoveOf(b.toRemove);
    tx(() => {
      if ('toRemove' in b) setToRemove('features', f, b.toRemove);
      if ('title' in b) db.prepare('UPDATE features SET title = ? WHERE id = ?').run(String(b.title).trim(), f);
      if ('description' in b) db.prepare('UPDATE features SET description = ? WHERE id = ?').run(text(b.description), f);
      if ('priority' in b) db.prepare('UPDATE features SET priority = ? WHERE id = ?').run(text(b.priority), f);
      if (groupId !== undefined) db.prepare('UPDATE features SET group_id = ? WHERE id = ?').run(groupId, f);
      if ('sort' in b) db.prepare('UPDATE features SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, f);
      // A person set these fields: they are not AI draft now. Other AI fields keep their mark.
      clearAi('features', f, [...(['title', 'description', 'priority'] as const).filter((k) => k in b), ...(groupId !== undefined ? ['group'] : [])]);
      // check: a person checked these fields (names from aiFields, for example "title" or "roles") without a change.
      if (b.check) clearAi('features', f, b.check);
    });
  },
  /** "Mark as reviewed": a person read the AI draft. Clears the marks on the feature, its lists, its scopes and its AI links, and saves the review time. */
  checkFeature(p: string, id: string) {
    const f = own('features', p, id);
    tx(() => {
      db.prepare("UPDATE features SET ai_fields = '[]' WHERE id = ?").run(f);
      db.prepare('UPDATE feature_items SET ai_draft = 0 WHERE feature_id = ?').run(f);
      // The check accepts each scope's group, or no group, as for one scope (updateScope).
      db.prepare("UPDATE scopes SET ai_fields = '[]', group_by_person = 1 WHERE feature_id = ?").run(f);
      db.prepare("UPDATE links SET checked = 1 WHERE feature_id = ? AND source = 'ai'").run(f);
      db.prepare("UPDATE feature_code SET checked = 1 WHERE feature_id = ? AND source = 'ai'").run(f);
      db.prepare("UPDATE screenshots SET checked = 1 WHERE feature_id = ? AND source = 'ai'").run(f);
      db.prepare('UPDATE features SET reviewed_at = ?, review_wanted = 0 WHERE id = ?').run(now(), f);
      db.prepare(
        `DELETE FROM ai_before WHERE (kind = 'feature' AND row_id = ?)
           OR (kind = 'scope' AND row_id IN (SELECT id FROM scopes WHERE feature_id = ?))
           OR (kind = 'item' AND row_id IN (SELECT id FROM feature_items WHERE feature_id = ?))`,
      ).run(f, f, f);
    });
  },
  /**
   * "Mark as not reviewed": a person wants to review the feature again. It shows as not reviewed until
   * a person uses "Mark as reviewed". The AI marks that a review cleared do not come back.
   */
  uncheckFeature(p: string, id: string) {
    // The date of the last review stays: the app uses it to find the tests that changed after it.
    db.prepare('UPDATE features SET review_wanted = 1 WHERE id = ?').run(own('features', p, id));
  },
  deleteFeature(p: string, id: string) {
    const f = own('features', p, id);
    tx(() => {
      // The links go with the feature. A test with no other link would then make its file come back
      // in the mapping loop (server/map.ts, state "unlinked"), and the AI could make the deleted
      // feature again. So such a test is left out, with the reason (server/left-out.ts).
      const title = (db.prepare('SELECT title FROM features WHERE id = ?').get(f) as any)?.title ?? '';
      db.prepare(
        `INSERT OR IGNORE INTO test_left_out (project_id, test_id, reason, by, created_at)
         SELECT DISTINCT l.project_id, l.test_id, ?, 'person', ? FROM links l
         WHERE l.feature_id = ? AND NOT EXISTS (SELECT 1 FROM links o WHERE o.project_id = l.project_id AND o.test_id = l.test_id AND o.feature_id <> l.feature_id)`,
      ).run(`A person deleted F-${f} "${title}".`, now(), f);
      // Its GitHub issues go off the tracker (they stay on GitHub). An issue that also has a scope of
      // another feature (a scope that moved) stays, and shows on that feature.
      db.prepare(
        `DELETE FROM issues WHERE feature_id = ? AND NOT EXISTS (SELECT 1 FROM issue_scopes s JOIN scopes sc ON sc.id = s.scope_id
           WHERE s.issue_id = issues.id AND sc.feature_id <> ?)`,
      ).run(f, f);
      db.prepare('DELETE FROM features WHERE id = ?').run(f); // labels, lists, scopes and links go too
      sweepBefore();
    });
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
      // The same text two times in one list keeps the first item. It keeps a person's check from the other.
      const sameItem = `SELECT 1 FROM feature_items o WHERE o.feature_id = feature_items.feature_id AND o.kind = feature_items.kind
        AND o.scope_id IS feature_items.scope_id AND lower(o.text) = lower(feature_items.text)`;
      db.prepare(`UPDATE feature_items SET ai_draft = 0 WHERE feature_id = ? AND ai_draft = 1 AND EXISTS (${sameItem} AND o.ai_draft = 0)`).run(into);
      db.prepare(`DELETE FROM feature_items WHERE feature_id = ? AND EXISTS (${sameItem} AND o.id < feature_items.id)`).run(into);
      // A scope requirement that is also a feature requirement goes: the feature one applies to every scope.
      db.prepare(
        `DELETE FROM feature_items WHERE feature_id = ? AND kind = ? AND scope_id IS NOT NULL AND EXISTS (SELECT 1 FROM feature_items o
           WHERE o.feature_id = feature_items.feature_id AND o.kind = feature_items.kind AND o.scope_id IS NULL AND lower(o.text) = lower(feature_items.text))`,
      ).run(into, SCOPE_ITEM_KIND);
      const scopeBase = nextSort('scopes', 'feature_id = ?', into);
      // A "To remove" mark of the source feature stays on each of its scopes that has no mark of its own.
      db.prepare(
        `UPDATE scopes SET remove_reason = f.remove_reason, remove_at = f.remove_at, remove_by = f.remove_by
         FROM features f WHERE f.id = scopes.feature_id AND scopes.feature_id = ? AND f.remove_reason IS NOT NULL AND scopes.remove_reason IS NULL
           AND scopes.parent_id IS NULL`, // a variation has the mark of its scope
      ).run(from);
      db.prepare('UPDATE scopes SET feature_id = ?, sort = sort + ? WHERE feature_id = ?').run(into, scopeBase, from);
      // Scope groups: a group with the title of a target group joins it. The others move after the target's groups.
      const groupBase = nextSort('scope_groups', 'feature_id = ?', into);
      for (const g of db.prepare('SELECT id, title FROM scope_groups WHERE feature_id = ?').all(from) as any[]) {
        const same = db.prepare('SELECT id FROM scope_groups WHERE feature_id = ? AND lower(title) = lower(?)').get(into, g.title) as any;
        if (same) {
          db.prepare('UPDATE scopes SET group_id = ? WHERE group_id = ?').run(same.id, g.id);
          // Old titles of the source group now mean the target group. Without this, the delete
          // below sets them to NULL, and a renamed title looks like a group that a person deleted.
          db.prepare('UPDATE scope_group_titles_gone SET group_id = ? WHERE group_id = ?').run(same.id, g.id);
          // A group that a person made or changed is a person's group after the merge too.
          db.prepare('UPDATE scope_groups SET ai_made = ai_made * (SELECT ai_made FROM scope_groups WHERE id = ?) WHERE id = ?').run(g.id, same.id);
          db.prepare('DELETE FROM scope_groups WHERE id = ?').run(g.id);
        } else {
          // The title is a group of the target now, so it is not "gone" there.
          db.prepare('DELETE FROM scope_group_titles_gone WHERE feature_id = ? AND title_key = lower(trim(?))').run(into, g.title);
          db.prepare('UPDATE scope_groups SET feature_id = ?, sort = sort + ? WHERE id = ?').run(into, groupBase, g.id);
        }
      }
      db.prepare('UPDATE OR IGNORE scope_group_titles_gone SET feature_id = ? WHERE feature_id = ?').run(into, from);
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
      // Mapped code: an active entry wins over one that a person removed. Then keep the target's entry,
      // but it takes the person's work from the source entry (added by hand, or checked).
      db.prepare(
        `UPDATE feature_code SET
           source = CASE WHEN (SELECT o.source FROM feature_code o WHERE o.feature_id = ? AND o.file = feature_code.file AND o.function = feature_code.function AND o.removed = 0) = 'manual' THEN 'manual' ELSE source END,
           checked = MAX(checked, COALESCE((SELECT o.checked FROM feature_code o WHERE o.feature_id = ? AND o.file = feature_code.file AND o.function = feature_code.function AND o.removed = 0), 0))
         WHERE feature_id = ? AND removed = 0`,
      ).run(from, from, into);
      db.prepare(
        `DELETE FROM feature_code WHERE feature_id = ? AND removed = 1
         AND file || char(0) || function IN (SELECT file || char(0) || function FROM feature_code WHERE feature_id = ? AND removed = 0)`,
      ).run(into, from);
      // Before a duplicate entry goes, its scope tags go to the entry that stays (the scopes moved above).
      db.prepare(
        `INSERT OR IGNORE INTO code_scopes (code_id, scope_id)
         SELECT keep.id, cs.scope_id FROM feature_code old
         JOIN feature_code keep ON keep.feature_id = ? AND keep.file = old.file AND keep.function = old.function AND keep.removed = 0
         JOIN code_scopes cs ON cs.code_id = old.id
         WHERE old.feature_id = ?`,
      ).run(into, from);
      db.prepare(
        `DELETE FROM feature_code WHERE feature_id = ?
         AND file || char(0) || function IN (SELECT file || char(0) || function FROM feature_code WHERE feature_id = ?)`,
      ).run(from, into);
      db.prepare('UPDATE feature_code SET feature_id = ? WHERE feature_id = ?').run(into, from);
      // Screenshots move with their scope tags (the scopes moved above). AI screenshots with the same
      // match key: a live one wins over a deleted marker. Then keep the target's screenshot, with the
      // source's scope tags and its "checked" mark added.
      db.prepare(
        `DELETE FROM screenshots WHERE feature_id = ? AND removed = 1 AND match_key IS NOT NULL
         AND match_key IN (SELECT match_key FROM screenshots WHERE feature_id = ? AND removed = 0 AND match_key IS NOT NULL)`,
      ).run(into, from);
      db.prepare(
        `INSERT OR IGNORE INTO screenshot_scopes (screenshot_id, scope_id)
         SELECT keep.id, ss.scope_id FROM screenshots old
         JOIN screenshots keep ON keep.feature_id = ? AND keep.match_key = old.match_key AND keep.removed = 0
         JOIN screenshot_scopes ss ON ss.screenshot_id = old.id
         WHERE old.feature_id = ? AND old.match_key IS NOT NULL`,
      ).run(into, from);
      db.prepare(
        `UPDATE screenshots SET checked = MAX(checked, COALESCE((SELECT MAX(o.checked) FROM screenshots o
           WHERE o.feature_id = ? AND o.match_key = screenshots.match_key AND o.removed = 0), 0))
         WHERE feature_id = ? AND match_key IS NOT NULL AND removed = 0`,
      ).run(from, into);
      db.prepare(
        `DELETE FROM screenshots WHERE feature_id = ? AND match_key IS NOT NULL
         AND match_key IN (SELECT match_key FROM screenshots WHERE feature_id = ? AND match_key IS NOT NULL)`,
      ).run(from, into);
      const shotBase = nextSort('screenshots', 'feature_id = ?', into);
      db.prepare('UPDATE screenshots SET feature_id = ?, sort = sort + ? WHERE feature_id = ?').run(into, shotBase, from);
      // GitHub issues of the source feature stay on the tracker, on the target (scope issues follow their scopes).
      db.prepare('UPDATE issues SET feature_id = ? WHERE feature_id = ?').run(into, from);
      // The deleted and moved scopes of the source stay remembered, on the target.
      db.prepare('UPDATE OR IGNORE scope_titles_gone SET feature_id = ? WHERE feature_id = ?').run(into, from);
      // The answered questions of the source stay answered, on the target.
      db.prepare('UPDATE OR IGNORE answered_questions SET feature_id = ? WHERE feature_id = ?').run(into, from);
      db.prepare('DELETE FROM features WHERE id = ?').run(from);
      sweepBefore();
    });
  },

  // Labels (roles). Removing a label from every feature removes it from the project.
  addLabel(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = labelKind(b.kind);
    db.prepare('INSERT OR IGNORE INTO feature_labels (feature_id, kind, value) VALUES (?, ?, ?)').run(f, kind, labelValue(p, kind, b.value));
    clearAi('features', f, [`${kind}s`]); // a person changed the roles: they are checked now
  },
  deleteLabel(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = labelKind(b.kind);
    db.prepare('DELETE FROM feature_labels WHERE feature_id = ? AND kind = ? AND value = ?').run(f, kind, need(b.value, 'Label'));
    clearAi('features', f, [`${kind}s`]);
  },

  // List items (requirements, notes, out of scope, where, open questions).
  // Body { kind, text, scopeId? }: with scopeId, a requirement of that scope.
  addItem(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = itemKind(b.kind);
    const scope = b.scopeId ? scopeOf(p, f, b.scopeId) : null;
    const parent = scope === null ? null : scopeRow(scope).parentId;
    if (parent !== null) throw new EditError(`A variation has no requirements. Add it to its scope S-${parent}: it applies to each variation`);
    if (scope !== null && kind !== SCOPE_ITEM_KIND) throw new EditError('A scope has only requirements');
    const t = need(b.text, 'Text');
    // The same text two times (a double click, Enter then blur) keeps one item.
    const same = db.prepare('SELECT id FROM feature_items WHERE feature_id = ? AND scope_id IS ? AND kind = ? AND lower(text) = lower(?)').get(f, scope, kind, t) as any;
    if (same) return { id: same.id as number };
    const clash = requirementClash(f, scope, kind, t);
    if (clash) throw new EditError(clash);
    const r = db
      .prepare('INSERT INTO feature_items (feature_id, scope_id, kind, text, sort) VALUES (?, ?, ?, ?, ?)')
      .run(f, scope, kind, t, nextSort('feature_items', 'feature_id = ?', f));
    return { id: Number(r.lastInsertRowid) };
  },
  updateItem(p: string, id: string, b: any) {
    const i = ownItem(p, id);
    const t = 'text' in b ? need(b.text, 'Text') : null;
    const clash = t === null ? null : requirementClash(i.feature_id, i.scope_id, i.kind, t, i.id);
    if (clash) throw new EditError(clash);
    tx(() => {
      // A person changed the text: it is not an AI draft now. A move only (sort) keeps the mark.
      if (t !== null) db.prepare('UPDATE feature_items SET text = ?, ai_draft = 0 WHERE id = ?').run(t, i.id);
      if (b.check) db.prepare('UPDATE feature_items SET ai_draft = 0 WHERE id = ?').run(i.id); // checked without a change
      if (t !== null || b.check) dropBefore('item', i.id);
      if ('sort' in b) db.prepare('UPDATE feature_items SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, i.id);
    });
  },
  deleteItem(p: string, id: string) {
    const i = ownItem(p, id).id;
    tx(() => {
      db.prepare('DELETE FROM feature_items WHERE id = ?').run(i);
      dropBefore('item', i);
    });
  },

  // Scopes.
  addScope(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const r = db.prepare(`INSERT INTO scopes (id, feature_id, title, description, group_id, sort) VALUES (${NEW_SCOPE_ID}, ?, ?, ?, ?, ?)`).run(
      f, need(b.title, 'Title'), text(b.description), groupOf(p, f, b.groupId), nextSort('scopes', 'feature_id = ?', f),
    );
    return { id: Number(r.lastInsertRowid) };
  },
  /**
   * Body { title?, description?, groupId?, sort?, toRemove?, check?, columns?, values? }.
   * - A scope with variations: a new title gives each variation a new title (the old titles are remembered).
   *   columns: new names for the columns, in the same order and number. groupId moves its variations too.
   * - A variation: only values, sort, toRemove and check. Its title comes from the scope title and its values.
   *   It has no description, requirements or group of its own: its scope has them.
   */
  updateScope(p: string, id: string, b: any) {
    const sc = ownScope(p, id);
    const s = sc.id;
    const row = scopeRow(s);
    if (row.parentId !== null) {
      if ('title' in b) throw new EditError(`The title of a variation comes from its scope S-${row.parentId} and its values. Change those instead`);
      if ('description' in b) throw new EditError(`A variation has no description. Write it on its scope S-${row.parentId}`);
      if ('groupId' in b) throw new EditError(`A variation is in the group of its scope S-${row.parentId}`);
      if ('columns' in b) throw new EditError(`Change the columns on the scope S-${row.parentId}`);
    } else if ('values' in b) throw new EditError('Only a variation has values');
    if ('columns' in b && row.columns === null) throw new EditError(`S-${s} has no variations`);
    const title = 'title' in b ? need(b.title, 'Title') : null;
    if ('toRemove' in b) toRemoveOf(b.toRemove);
    tx(() => {
      if ('toRemove' in b) setToRemove('scopes', s, b.toRemove);
      if (title !== null) {
        if (row.title.trim().toLowerCase() !== title.toLowerCase()) buryScope(sc.featureId, s, row.title);
        db.prepare('UPDATE scopes SET title = ? WHERE id = ?').run(title, s);
        if (row.columns !== null) resetVariations({ ...row, title }, title, (v) => v);
      }
      if ('description' in b) db.prepare('UPDATE scopes SET description = ? WHERE id = ?').run(text(b.description), s);
      if ('columns' in b) {
        const columns = columnList(b.columns);
        if (columns.length !== row.columns!.length) throw new EditError('Send a new name for each column, in the same order. To add or delete a column, use its own route');
        db.prepare('UPDATE scopes SET columns = ? WHERE id = ?').run(JSON.stringify(columns), s);
      }
      if ('values' in b) {
        const parent = scopeRow(row.parentId!);
        const values = variationValues(parent.columns!, b.values);
        const t = variationTitleFor(parent, parent.title, values, s);
        if (t.toLowerCase() !== row.title.toLowerCase()) buryScope(sc.featureId, s, row.title);
        db.prepare('UPDATE scopes SET title = ?, var_values = ? WHERE id = ?').run(t, JSON.stringify(values), s);
      }
      // A scope and its variations are in one group.
      if ('groupId' in b) {
        const gid = groupOf(p, sc.featureId, b.groupId);
        db.prepare('UPDATE scopes SET group_id = ?, group_by_person = 1 WHERE id = ? OR parent_id = ?').run(gid, s, s);
      }
      if ('sort' in b) db.prepare('UPDATE scopes SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, s);
      // b.check = true: the person checked the scope without a change. Its requirements are checked too.
      clearAi('scopes', s, b.check ? [...SCOPE_AI_FIELDS] : SCOPE_AI_FIELDS.filter((k) => (k === 'group' ? 'groupId' : k) in b || (k === 'title' && 'values' in b)));
      // A check accepts the group of the scope, or no group. The AI skills do not change it then.
      if (b.check) db.prepare('UPDATE scopes SET group_by_person = 1 WHERE id = ?').run(s);
      if (b.check) db.prepare('UPDATE feature_items SET ai_draft = 0 WHERE scope_id = ?').run(s);
      if (b.check) db.prepare("DELETE FROM ai_before WHERE kind = 'item' AND row_id IN (SELECT id FROM feature_items WHERE scope_id = ?)").run(s);
    });
  },
  /**
   * Body { values, columns? }: adds a variation to a scope. values: a list in column order, an object with the
   * column names as keys, or one string for one column.
   * A scope with no variations gets them now: columns (default: the keys of values, or ["Page"]). Its test
   * links, screenshots and code go to this first variation, because a scope with variations has none.
   */
  addVariation(p: string, id: string, b: any) {
    const row = scopeRow(ownScope(p, id).id);
    if (row.parentId !== null) throw new EditError(`SV-${row.id} is a variation. Add the variation to its scope S-${row.parentId}`);
    if (row.columns !== null) {
      if (b.columns !== undefined) throw new EditError('The scope has its columns already. Add a column with its own route');
      const values = variationValues(row.columns, b.values);
      return { id: tx(() => newVariation(row, values)) };
    }
    const keys = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? Object.keys(b.values) : null;
    const columns = columnList(b.columns ?? keys ?? ['Page']);
    const values = variationValues(columns, b.values);
    return tx(() => {
      db.prepare('UPDATE scopes SET columns = ? WHERE id = ?').run(JSON.stringify(columns), row.id);
      const vid = newVariation({ ...row, columns }, values);
      moveEvidence(row.id, vid);
      return { id: vid };
    });
  },
  /**
   * Ends the variations of a scope when it has one variation (or none) left. The test links, screenshots and
   * code of that variation go back to the scope, and the variation is deleted.
   */
  removeVariations(p: string, id: string) {
    const row = ownParent(p, id);
    const vars = variationsOf(row.id);
    if (vars.length > 1) throw new EditError(`S-${row.id} has ${vars.length} variations. Delete all but one first: only the last one can go back into the scope`);
    tx(() => {
      for (const v of vars) {
        moveEvidence(v.id, row.id);
        // The "To remove" mark of the variation goes to the scope, when the scope has no mark of its own.
        db.prepare(
          `UPDATE scopes SET remove_reason = v.remove_reason, remove_at = v.remove_at, remove_by = v.remove_by
           FROM scopes v WHERE v.id = ? AND scopes.id = ? AND v.remove_reason IS NOT NULL AND scopes.remove_reason IS NULL`,
        ).run(v.id, row.id);
        buryScope(row.featureId, v.id, v.title);
        db.prepare('DELETE FROM scopes WHERE id = ?').run(v.id);
      }
      db.prepare('UPDATE scopes SET columns = NULL WHERE id = ?').run(row.id);
      sweepBefore();
    });
  },
  /** Body { name, value? }: adds a column at the end. Each variation gets value (default empty) in it. */
  addColumn(p: string, id: string, b: any) {
    const row = ownParent(p, id);
    const columns = columnList([...row.columns!, b.name]);
    const value = b.value === undefined || b.value === null ? '' : String(b.value).trim().replace(/\s+/g, ' ');
    if (value.length > 100) throw new EditError('The value is too long');
    tx(() => {
      db.prepare('UPDATE scopes SET columns = ? WHERE id = ?').run(JSON.stringify(columns), row.id);
      resetVariations(row, row.title, (v) => [...v, value]);
    });
  },
  /** Deletes column number index (0 is the first). A scope with variations keeps at least one column. */
  deleteColumn(p: string, id: string, index: string) {
    const row = ownParent(p, id);
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= row.columns!.length) throw new EditError('No such column');
    if (row.columns!.length === 1) throw new EditError('A scope with variations needs at least one column. To end the variations, delete all but one, then use "Remove variations"');
    tx(() => {
      db.prepare('UPDATE scopes SET columns = ? WHERE id = ?').run(JSON.stringify(row.columns!.filter((_, k) => k !== i)), row.id);
      resetVariations(row, row.title, (v) => v.filter((_, k) => k !== i));
    });
  },
  /**
   * Moves a scope to another feature of the project. Body: { featureId }.
   * - The scope goes to the end of the target's scope list. It keeps its ID, text and AI marks.
   *   The target must not have a scope with the same title. The old feature remembers the title (buryScope).
   * - Its requirements go with it. A requirement that the target feature has already goes:
   *   the feature requirement applies to every scope.
   * - Each test link to the scope goes to the target feature. A link that a person removed
   *   from the target comes back, as in addLink. When the old link has no scope left, it is
   *   marked removed, so the AI skill does not link the test to the old feature again.
   * - A screenshot that shows only this scope goes with it. A screenshot that shows other
   *   scopes too stays, and loses only this scope's tag.
   */
  moveScope(p: string, id: string, b: any) {
    const s = ownScope(p, id);
    const from = s.featureId;
    const to = own('features', p, b.featureId);
    if (to === from) throw new EditError('The scope is in this feature already');
    const row = scopeRow(s.id);
    if (row.parentId !== null) throw new EditError(`A variation moves with its scope. Move S-${row.parentId}`);
    // A scope with variations moves with all of them.
    const moving = [{ id: s.id, title: row.title }, ...variationsOf(s.id)];
    // Two scopes with one title: the AI skill finds scopes by title, so it could write to the wrong one.
    for (const m of moving)
      if (db.prepare('SELECT 1 FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(to, m.title))
        throw new EditError(`The target feature has a scope with the title "${m.title}" already. Rename one of them first`);
    tx(() => {
      // The scope goes to the target's group with the same title, or to the group that a person renamed
      // from that title. The target gets that group if it does not know the title. When a person deleted
      // a group with that title from the target, the scope has no group there.
      const oldGroup = db.prepare('SELECT g.id, g.title, g.ai_made FROM scopes s JOIN scope_groups g ON g.id = s.group_id WHERE s.id = ?').get(s.id) as any;
      const newGroup = scopeGroupId(to, oldGroup?.title, oldGroup?.ai_made === 1);
      for (const m of moving) {
        buryScope(from, m.id, m.title);
        db.prepare('UPDATE scopes SET feature_id = ?, group_id = ?, sort = ? WHERE id = ?').run(to, newGroup, nextSort('scopes', 'feature_id = ?', to), m.id);
        carry(m.id);
      }
      dropEmptyAiGroup(oldGroup?.id ?? null);
      sweepBefore();
    });
    return { featureId: to };

    /** Moves the requirements, test links, screenshots and code of scope sid from feature from to feature to. */
    function carry(sid: number) {
      db.prepare('UPDATE feature_items SET feature_id = ? WHERE scope_id = ?').run(to, sid);
      // A scope requirement that the target has as a feature requirement goes. A person's check on it stays.
      const same = `SELECT 1 FROM feature_items o WHERE o.feature_id = ? AND o.kind = ? AND o.scope_id = ?
        AND lower(o.text) = lower(feature_items.text)`;
      db.prepare(`UPDATE feature_items SET ai_draft = 0 WHERE feature_id = ? AND kind = ? AND scope_id IS NULL AND ai_draft = 1
        AND EXISTS (${same} AND o.ai_draft = 0)`).run(to, SCOPE_ITEM_KIND, to, SCOPE_ITEM_KIND, sid);
      db.prepare(
        `DELETE FROM feature_items WHERE scope_id = ? AND kind = ? AND EXISTS (SELECT 1 FROM feature_items o
           WHERE o.feature_id = ? AND o.kind = feature_items.kind AND o.scope_id IS NULL AND lower(o.text) = lower(feature_items.text))`,
      ).run(sid, SCOPE_ITEM_KIND, to);

      // Test links. A person's work (a manual link, a check) wins over an AI link to the same test.
      const upsertLink = db.prepare(
        `INSERT INTO links (project_id, test_id, feature_id, source, checked) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, test_id, feature_id) DO UPDATE SET
           source = CASE WHEN removed = 1 OR excluded.source = 'manual' THEN 'manual' ELSE source END,
           checked = MAX(checked, excluded.checked), removed = 0
         RETURNING id`,
      );
      const untag = db.prepare('DELETE FROM link_scopes WHERE link_id = ? AND scope_id = ?');
      const tag = db.prepare('INSERT OR IGNORE INTO link_scopes (link_id, scope_id) VALUES (?, ?)');
      const hasScope = db.prepare('SELECT 1 FROM link_scopes WHERE link_id = ?');
      const removeLink = db.prepare('UPDATE links SET removed = 1 WHERE id = ?');
      const old = db
        .prepare('SELECT l.* FROM links l JOIN link_scopes ls ON ls.link_id = l.id WHERE ls.scope_id = ? AND l.feature_id = ? AND l.removed = 0')
        .all(sid, from) as any[];
      for (const l of old) {
        const keep = upsertLink.get(p, l.test_id, to, l.source, l.checked) as any;
        untag.run(l.id, sid);
        tag.run(keep.id, sid);
        if (!hasScope.get(l.id)) removeLink.run(l.id); // marker: the skill does not link the test to the old feature again
      }

      // Screenshots that show only this scope move. The others stay and lose this scope's tag.
      const shots = db
        .prepare(
          `SELECT sh.*, (SELECT COUNT(*) FROM screenshot_scopes o WHERE o.screenshot_id = sh.id) AS n
           FROM screenshots sh JOIN screenshot_scopes ss ON ss.screenshot_id = sh.id
           WHERE ss.scope_id = ? AND sh.feature_id = ? AND sh.removed = 0`,
        )
        .all(sid, from) as any[];
      const findKey = db.prepare('SELECT id, removed FROM screenshots WHERE feature_id = ? AND match_key = ? ORDER BY removed, id LIMIT 1');
      const otherWithKey = db.prepare('SELECT 1 FROM screenshots WHERE feature_id = ? AND match_key = ? AND id <> ?');
      const marker = db.prepare(
        "INSERT INTO screenshots (project_id, feature_id, caption, mime, sort, source, removed, match_key) VALUES (?, ?, ?, ?, 0, 'ai', 1, ?)",
      );
      const untagShot = db.prepare('DELETE FROM screenshot_scopes WHERE screenshot_id = ? AND scope_id = ?');
      const tagShot = db.prepare('INSERT OR IGNORE INTO screenshot_scopes (screenshot_id, scope_id) VALUES (?, ?)');
      const addCheck = db.prepare('UPDATE screenshots SET checked = MAX(checked, ?) WHERE id = ?');
      const dropShot = db.prepare('DELETE FROM screenshots WHERE id = ?');
      const moveShot = db.prepare('UPDATE screenshots SET feature_id = ?, sort = ? WHERE id = ?');
      let sort = nextSort('screenshots', 'feature_id = ?', to);
      for (const sh of shots) {
        if (sh.n > 1) {
          untagShot.run(sh.id, sid);
          continue;
        }
        const key: string | null = sh.match_key;
        // An AI screenshot leaves a deleted marker on the old feature, so the skill does not add it there again.
        if (key && !otherWithKey.get(from, key, sh.id)) marker.run(p, from, sh.caption, sh.mime, key);
        const dup = key ? (findKey.get(to, key) as any) : null;
        if (dup && !dup.removed) {
          // The target has the same AI screenshot: keep that one, with this scope's tag and the "checked" mark.
          tagShot.run(dup.id, sid);
          addCheck.run(sh.checked, dup.id);
          dropShot.run(sh.id);
          continue;
        }
        if (dup) dropShot.run(dup.id); // a live screenshot wins over a deleted marker, as in mergeFeature
        moveShot.run(to, sort++, sh.id);
      }
      // Mapped code with only this scope's tag moves with the scope. The old feature keeps a removed
      // marker, so the AI skill does not add the code there again. Code with other tags too stays, and
      // loses this tag.
      const codeRows = db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM code_scopes o WHERE o.code_id = c.id) AS n
           FROM feature_code c JOIN code_scopes cs ON cs.code_id = c.id
           WHERE cs.scope_id = ? AND c.feature_id = ? AND c.removed = 0`,
        )
        .all(sid, from) as any[];
      for (const c of codeRows) {
        if (c.n > 1) {
          db.prepare('DELETE FROM code_scopes WHERE code_id = ? AND scope_id = ?').run(c.id, sid);
          continue;
        }
        const there = db.prepare('SELECT id, removed FROM feature_code WHERE feature_id = ? AND file = ? AND function = ?').get(to, c.file, c.function) as any;
        let keep: number;
        if (there && !there.removed) {
          // The target holds the same code: it keeps its row, with this scope's tag and the person's work.
          keep = there.id;
          db.prepare("UPDATE feature_code SET source = CASE WHEN ? = 'manual' THEN 'manual' ELSE source END, checked = MAX(checked, ?) WHERE id = ?").run(c.source, c.checked, keep);
        } else {
          if (there) db.prepare('DELETE FROM feature_code WHERE id = ?').run(there.id); // a live entry wins over a removed marker
          keep = Number(
            db.prepare('INSERT INTO feature_code (project_id, feature_id, file, function, source, checked) VALUES (?, ?, ?, ?, ?, ?)').run(p, to, c.file, c.function, c.source, c.checked).lastInsertRowid,
          );
        }
        db.prepare('INSERT OR IGNORE INTO code_scopes (code_id, scope_id) VALUES (?, ?)').run(keep, sid);
        db.prepare('DELETE FROM code_scopes WHERE code_id = ?').run(c.id);
        db.prepare('UPDATE feature_code SET removed = 1 WHERE id = ?').run(c.id);
      }
      // The group from before the AI change is a group of the old feature: it cannot come back here.
      dropBefore('scope', sid, ['group']);
    }
  },
  // Scope groups: a feature's scopes show under their group, like the describe blocks of tests.
  addScopeGroup(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const title = scopeGroupTitle(f, b.title);
    return { id: tx(() => newScopeGroup(f, title)) };
  },
  updateScopeGroup(p: string, id: string, b: any) {
    const g = ownScopeGroup(p, id);
    tx(() => {
      if ('title' in b) {
        const title = scopeGroupTitle(g.featureId, b.title, g.id);
        const before = (db.prepare('SELECT title FROM scope_groups WHERE id = ?').get(g.id) as any).title as string;
        db.prepare('UPDATE scope_groups SET title = ? WHERE id = ?').run(title, g.id);
        // The AI skill can still send the old title: it means this group.
        db.prepare('DELETE FROM scope_group_titles_gone WHERE feature_id = ? AND title_key = lower(trim(?))').run(g.featureId, title);
        db.prepare('INSERT OR REPLACE INTO scope_group_titles_gone (feature_id, title_key, group_id) SELECT ?, lower(trim(?)), ? WHERE lower(trim(?)) <> lower(trim(?))').run(
          g.featureId, before, g.id, before, title,
        );
      }
      if ('sort' in b) db.prepare('UPDATE scope_groups SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, g.id);
      // A person changed the group: it stays when it has no scopes.
      db.prepare('UPDATE scope_groups SET ai_made = 0 WHERE id = ?').run(g.id);
    });
  },
  /** Deletes a group. Its scopes stay in the feature, with no group. */
  deleteScopeGroup(p: string, id: string) {
    const g = ownScopeGroup(p, id);
    tx(() => {
      const scopes = db.prepare('SELECT id FROM scopes WHERE group_id = ?').all(g.id) as any[];
      // A person decided: no group. The AI skill does not put these scopes in a group again.
      db.prepare('UPDATE scopes SET group_id = NULL, group_by_person = 1 WHERE group_id = ?').run(g.id);
      for (const s of scopes) clearAi('scopes', s.id, ['group']);
      const title = (db.prepare('SELECT title FROM scope_groups WHERE id = ?').get(g.id) as any).title;
      db.prepare('DELETE FROM scope_groups WHERE id = ?').run(g.id); // old titles of this group become "deleted" (ON DELETE SET NULL)
      db.prepare('INSERT OR REPLACE INTO scope_group_titles_gone (feature_id, title_key, group_id) VALUES (?, lower(trim(?)), NULL)').run(g.featureId, title);
    });
  },
  /**
   * Deletes a scope. A scope with variations goes with all of them. When the last variation of a scope goes,
   * the scope has no variations: it is a normal scope again, with no tests. Its tests stay linked to the feature.
   */
  deleteScope(p: string, id: string) {
    const s = ownScope(p, id);
    tx(() => {
      const row = scopeRow(s.id);
      for (const v of row.columns !== null ? variationsOf(s.id) : []) {
        buryScope(s.featureId, v.id, v.title);
        db.prepare('DELETE FROM scopes WHERE id = ?').run(v.id);
      }
      buryScope(s.featureId, s.id, row.title);
      db.prepare('DELETE FROM scopes WHERE id = ?').run(s.id);
      if (row.parentId !== null && !variationsOf(row.parentId).length) db.prepare('UPDATE scopes SET columns = NULL WHERE id = ?').run(row.parentId);
      sweepBefore();
    });
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
    const scopeId = b.scopeId ? evidenceScope(scopeOf(p, f, b.scopeId)) : null;
    tx(() => {
      db.prepare(`INSERT INTO links (project_id, test_id, feature_id, source) VALUES (?, ?, ?, 'manual')
        ON CONFLICT (project_id, test_id, feature_id) DO UPDATE SET removed = 0, source = 'manual'`).run(p, testId, f);
      const link = (db.prepare('SELECT id FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p, testId, f) as any).id;
      if (scopeId) db.prepare('INSERT OR IGNORE INTO link_scopes (link_id, scope_id) VALUES (?, ?)').run(link, scopeId);
    });
  },
  /**
   * Moves all links of a test to another test: body { from, to } (test IDs).
   * For a renamed test: a new title or file gives a new test ID, and the links stay on the old ID.
   * Each link keeps its scopes, its source (AI or manual), its check and its "removed" mark.
   * When the new test already has a link to the same feature, the two links merge:
   * a manual source wins over AI, and a check stays. A link that a person removed on the new test
   * stays removed: the old link does not bring it back.
   */
  moveTestLinks(p: string, b: any) {
    const from = need(b.from, 'Old test ID');
    const to = need(b.to, 'New test ID');
    if (from === to) throw new EditError('The old and the new test are the same');
    if (from.slice(0, 3) !== to.slice(0, 3)) throw new EditError('The old and the new test must use the same test tool');
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ? AND removed_at IS NULL').get(p, to)) {
      throw new EditError(`Unknown test ${to}, or it is not in the repo now`);
    }
    const links = db.prepare('SELECT * FROM links WHERE project_id = ? AND test_id = ?').all(p, from) as any[];
    if (!links.length) throw new EditError(`Test ${from} has no links`);
    return tx(() => {
      let merged = 0;
      for (const l of links) {
        const keep = db.prepare('SELECT * FROM links WHERE project_id = ? AND test_id = ? AND feature_id = ?').get(p, to, l.feature_id) as any;
        if (!keep) {
          db.prepare('UPDATE links SET test_id = ? WHERE id = ?').run(to, l.id);
          continue;
        }
        merged++;
        const active = !keep.removed;
        db.prepare('UPDATE links SET removed = ?, source = ?, checked = ? WHERE id = ?').run(
          active ? 0 : 1,
          l.source === 'manual' || keep.source === 'manual' ? 'manual' : keep.source,
          Math.max(l.checked, keep.checked),
          keep.id,
        );
        if (active) {
          db.prepare('INSERT OR IGNORE INTO link_scopes (link_id, scope_id) SELECT ?, scope_id FROM link_scopes WHERE link_id = ?').run(keep.id, l.id);
        }
        // A removed link that merges into an active one would give the active link removed scopes: the removed link has none.
        db.prepare('DELETE FROM links WHERE id = ?').run(l.id);
      }
      return { moved: links.length, merged };
    });
  },
  /**
   * Sets the scopes of a link: body { scopeIds: number[] }.
   * Body { check: true }: a person checked an AI link without a change. Its source and scopes stay.
   */
  updateLink(p: string, id: string, b: any) {
    const l = ownLink(p, id);
    if (b.check && !('scopeIds' in b)) return void db.prepare('UPDATE links SET checked = 1 WHERE id = ?').run(l.id);
    if (!Array.isArray(b.scopeIds)) throw new EditError('scopeIds must be a list');
    const ids: number[] = [...new Set<number>(b.scopeIds.map((s: unknown) => evidenceScope(scopeOf(p, l.feature_id, s))))];
    tx(() => {
      if (b.check) db.prepare('UPDATE links SET checked = 1 WHERE id = ?').run(l.id);
      db.prepare('DELETE FROM link_scopes WHERE link_id = ?').run(l.id);
      const add = db.prepare('INSERT INTO link_scopes (link_id, scope_id) VALUES (?, ?)');
      for (const s of ids) add.run(l.id, s);
      db.prepare("UPDATE links SET source = 'manual' WHERE id = ?").run(l.id);
    });
  },
  // Screenshots. Body of add: { image: data URL, caption?, scopeIds? }.
  addScreenshot(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const { mime, data } = imageFromDataUrl(b.image);
    const scopeIds = scopeList(p, f, b.scopeIds);
    return tx(() => {
      const r = db.prepare('INSERT INTO screenshots (project_id, feature_id, caption, mime, sort) VALUES (?, ?, ?, ?, ?)').run(
        p, f, text(b.caption), mime, nextSort('screenshots', 'feature_id = ?', f),
      );
      const shot = Number(r.lastInsertRowid);
      db.prepare('INSERT INTO screenshot_images (screenshot_id, data) VALUES (?, ?)').run(shot, data);
      const add = db.prepare('INSERT INTO screenshot_scopes (screenshot_id, scope_id) VALUES (?, ?)');
      for (const s of scopeIds) add.run(shot, s);
      return { id: shot };
    });
  },
  /**
   * Changes the caption, the order, or the scopes (body { scopeIds } sets the full list).
   * A change of caption or scopes, or b.check = true, marks an AI screenshot as checked.
   */
  updateScreenshot(p: string, id: string, b: any) {
    const s = ownScreenshot(p, id);
    const scopeIds = 'scopeIds' in b ? scopeList(p, s.featureId, b.scopeIds) : null;
    tx(() => {
      if ('caption' in b || scopeIds || b.check) db.prepare('UPDATE screenshots SET checked = 1 WHERE id = ?').run(s.id);
      if ('caption' in b) db.prepare('UPDATE screenshots SET caption = ? WHERE id = ?').run(text(b.caption), s.id);
      if ('sort' in b) db.prepare('UPDATE screenshots SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, s.id);
      if (scopeIds) {
        db.prepare('DELETE FROM screenshot_scopes WHERE screenshot_id = ?').run(s.id);
        const add = db.prepare('INSERT INTO screenshot_scopes (screenshot_id, scope_id) VALUES (?, ?)');
        for (const x of scopeIds) add.run(s.id, x);
      }
    });
  },
  /**
   * A person's own upload is deleted fully. For an AI screenshot, the image and scope tags go,
   * and the row stays as a marker, so the AI skill does not add it again.
   */
  deleteScreenshot(p: string, id: string) {
    const s = ownScreenshot(p, id).id;
    const ai = (db.prepare('SELECT match_key FROM screenshots WHERE id = ?').get(s) as any).match_key !== null;
    if (!ai) return void db.prepare('DELETE FROM screenshots WHERE id = ?').run(s);
    tx(() => {
      db.prepare('UPDATE screenshots SET removed = 1 WHERE id = ?').run(s);
      db.prepare('DELETE FROM screenshot_images WHERE screenshot_id = ?').run(s);
      db.prepare('DELETE FROM screenshot_scopes WHERE screenshot_id = ?').run(s);
    });
  },

  /**
   * "Change back": sets fields to their values from before the AI change.
   * Body { kind, id, field } or { kind, id, fields: [] }. kind: feature or scope.
   * All fields are checked first, then changed in one transaction: all change, or none.
   * A field loses its AI mark, as for a change by a person: the normal edit does the change
   * (updateFeature, updateScope), so a scope title change is remembered for the AI skill too.
   * A list item has no "before" value: the AI changes only its own drafts, never the text of a person.
   */
  revert(p: string, b: any) {
    const kind = b?.kind as BeforeKind;
    if (kind !== 'feature' && kind !== 'scope') throw new EditError('kind must be feature or scope');
    const list: string[] = Array.isArray(b?.fields) ? b.fields.map(String) : [String(b?.field ?? '')];
    if (!list.length) throw new EditError('Send "field" or a list of "fields"');
    const allowed: readonly string[] = kind === 'feature' ? FEATURE_AI_FIELDS : SCOPE_AI_FIELDS;
    const id = kind === 'feature' ? own('features', p, b.id) : ownScope(p, b.id).id;
    const aiFields = json((db.prepare(`SELECT ai_fields FROM ${kind === 'feature' ? 'features' : 'scopes'} WHERE id = ?`).get(id) as any).ai_fields) as string[];
    const getBefore = db.prepare('SELECT before FROM ai_before WHERE kind = ? AND row_id = ? AND field = ?');
    // Check every field before a change.
    const bodies: Array<{ field: string; body: Record<string, unknown> }> = [];
    for (const field of new Set(list)) {
      if (!allowed.includes(field)) throw new EditError(`field must be one of: ${allowed.join(', ')}`);
      const r = aiFields.includes(field) ? (getBefore.get(kind, id, field) as any) : null;
      if (!r) throw new EditError(`The field "${field}" has no value from before the AI change`);
      const value: string | null = r.before;
      if (field === 'title' && !value?.trim()) {
        throw new EditError('This title was empty before the AI change. Delete the scope or feature instead.');
      }
      const body: Record<string, unknown> = {};
      if (field === 'group') {
        const gid = value === null ? null : Number(value);
        if (gid !== null) {
          const ok =
            kind === 'feature'
              ? db.prepare('SELECT 1 FROM feature_groups WHERE id = ? AND project_id = ?').get(gid, p)
              : db.prepare('SELECT 1 FROM scope_groups WHERE id = ? AND feature_id = (SELECT feature_id FROM scopes WHERE id = ?)').get(gid, id);
          if (!ok) throw new EditError('The group from before the AI change does not exist now. Choose a group by hand.');
        }
        body.groupId = gid;
      } else body[field] = value ?? '';
      bodies.push({ field, body });
    }
    return tx(() => {
      for (const { field, body } of bodies) {
        // The AI group that the scope leaves is deleted when it has no scopes now, as in a move.
        const left = kind === 'scope' && field === 'group' ? ((db.prepare('SELECT group_id FROM scopes WHERE id = ?').get(id) as any).group_id as number | null) : null;
        if (kind === 'feature') edits.updateFeature(p, String(id), body);
        else edits.updateScope(p, String(id), body);
        dropEmptyAiGroup(left);
        dropBefore(kind, id, [field]);
      }
      return { ok: true };
    });
  },
  /** Body { check: true }: a person checked an AI code entry. */
  /** Body { check: true } and/or { scopeIds: [] } (the scopes of the feature that this code does). */
  updateFeatureCode(p: string, id: string, b: any) {
    const r = db.prepare('SELECT id, feature_id FROM feature_code WHERE id = ? AND project_id = ? AND removed = 0').get(Number(id), p) as any;
    if (!r) throw new EditError('Unknown code entry');
    if (b.check !== true && !('scopeIds' in b)) throw new EditError('Send { "check": true } or { "scopeIds": [] }');
    if ('scopeIds' in b && !Array.isArray(b.scopeIds)) throw new EditError('scopeIds must be a list');
    const ids: number[] = 'scopeIds' in b ? [...new Set<number>(b.scopeIds.map((s: unknown) => evidenceScope(scopeOf(p, r.feature_id, s))))] : [];
    tx(() => {
      if (b.check === true) db.prepare('UPDATE feature_code SET checked = 1 WHERE id = ?').run(r.id);
      if ('scopeIds' in b) {
        db.prepare('DELETE FROM code_scopes WHERE code_id = ?').run(r.id);
        const add = db.prepare('INSERT INTO code_scopes (code_id, scope_id) VALUES (?, ?)');
        for (const s of ids) add.run(r.id, s);
        // A person set the scopes: the AI skill then only suggests other scopes.
        db.prepare("UPDATE feature_code SET source = 'manual' WHERE id = ?").run(r.id);
      }
    });
  },
  /** Removes code from a feature. The row stays as a marker, so the AI skill does not add it again. */
  deleteFeatureCode(p: string, id: string) {
    const r = db.prepare('SELECT id FROM feature_code WHERE id = ? AND project_id = ? AND removed = 0').get(Number(id), p) as any;
    if (!r) throw new EditError('Unknown code entry');
    db.prepare('UPDATE feature_code SET removed = 1 WHERE id = ?').run(r.id);
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
