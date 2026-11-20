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
 * AI marks: features.ai_fields and scopes.ai_fields list the fields that the AI
 * skill wrote and no person checked yet. A person who changes a field removes it
 * from the list. "Mark as checked" clears the lists, the item marks and the links.
 */
import { db, json, tx } from './db.ts';

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
  for (const f of features) {
    // Mapped code: number of entries, and how many the AI added that no person checked.
    f.code = { entries: codeBy.get(f.id)?.n ?? 0, aiToCheck: codeBy.get(f.id)?.ai ?? 0 };
    f.aiFields = json(f.ai_fields);
    f.aiDraft = f.aiFields.length > 0;
    delete f.ai_fields;
    const myLabels = labelsBy.get(f.id) ?? [];
    for (const [key, kind] of Object.entries(LABEL_KINDS)) f[key] = myLabels.filter((l) => l.kind === kind).map((l) => l.value);
    const myItems = itemsBy.get(f.id) ?? [];
    const toItem = (i: any) => ({ id: i.id, text: i.text, aiDraft: !!i.aiDraft });
    for (const [key, kind] of Object.entries(ITEM_KINDS)) f[key] = myItems.filter((i) => i.kind === kind && i.scope_id === null).map(toItem);
    f.scopes = (scopesBy.get(f.id) ?? []).map(({ feature_id, ai_fields, ...s }) => {
      const aiFields = json(ai_fields) as string[];
      const requirements = myItems.filter((i) => i.scope_id === s.id).map(toItem);
      return { ...s, requirements, aiFields, aiDraft: aiFields.length > 0 };
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
  return [...new Set(v.map((s) => scopeOf(projectId, featureId, s)))];
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
      db.prepare("UPDATE feature_code SET checked = 1 WHERE feature_id = ? AND source = 'ai'").run(f);
      db.prepare("UPDATE screenshots SET checked = 1 WHERE feature_id = ? AND source = 'ai'").run(f);
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
      // The deleted and moved scopes of the source stay remembered, on the target.
      db.prepare('UPDATE OR IGNORE scope_titles_gone SET feature_id = ? WHERE feature_id = ?').run(into, from);
      // The answered questions of the source stay answered, on the target.
      db.prepare('UPDATE OR IGNORE answered_questions SET feature_id = ? WHERE feature_id = ?').run(into, from);
      db.prepare('DELETE FROM features WHERE id = ?').run(from);
    });
  },

  // Labels (roles). Removing a label from every feature removes it from the project.
  addLabel(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = labelKind(b.kind);
    db.prepare('INSERT OR IGNORE INTO feature_labels (feature_id, kind, value) VALUES (?, ?, ?)').run(f, kind, labelValue(p, kind, b.value));
  },
  deleteLabel(p: string, id: string, b: any) {
    const f = own('features', p, id);
    db.prepare('DELETE FROM feature_labels WHERE feature_id = ? AND kind = ? AND value = ?').run(f, labelKind(b.kind), need(b.value, 'Label'));
  },

  // List items (requirements, notes, out of scope, where, open questions).
  // Body { kind, text, scopeId? }: with scopeId, a requirement of that scope.
  addItem(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const kind = itemKind(b.kind);
    const scope = b.scopeId ? scopeOf(p, f, b.scopeId) : null;
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
      if ('sort' in b) db.prepare('UPDATE feature_items SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, i.id);
    });
  },
  deleteItem(p: string, id: string) {
    db.prepare('DELETE FROM feature_items WHERE id = ?').run(ownItem(p, id).id);
  },

  // Scopes.
  addScope(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const r = db.prepare(`INSERT INTO scopes (id, feature_id, title, description, sort) VALUES (${NEW_SCOPE_ID}, ?, ?, ?, ?)`).run(
      f, need(b.title, 'Title'), text(b.description), nextSort('scopes', 'feature_id = ?', f),
    );
    return { id: Number(r.lastInsertRowid) };
  },
  updateScope(p: string, id: string, b: any) {
    const sc = ownScope(p, id);
    const s = sc.id;
    const title = 'title' in b ? need(b.title, 'Title') : null;
    tx(() => {
      if (title !== null) {
        const before = (db.prepare('SELECT title FROM scopes WHERE id = ?').get(s) as any).title as string;
        if (before.trim().toLowerCase() !== title.toLowerCase()) buryScope(sc.featureId, s, before);
        db.prepare('UPDATE scopes SET title = ? WHERE id = ?').run(title, s);
      }
      if ('description' in b) db.prepare('UPDATE scopes SET description = ? WHERE id = ?').run(text(b.description), s);
      if ('sort' in b) db.prepare('UPDATE scopes SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, s);
      // b.check = true: the person checked the scope without a change. Its requirements are checked too.
      clearAi('scopes', s, b.check ? [...SCOPE_AI_FIELDS] : (['title', 'description'] as const).filter((k) => k in b));
      if (b.check) db.prepare('UPDATE feature_items SET ai_draft = 0 WHERE scope_id = ?').run(s);
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
    const title = (db.prepare('SELECT title FROM scopes WHERE id = ?').get(s.id) as any).title as string;
    // Two scopes with one title: the AI skill finds scopes by title, so it could write to the wrong one.
    if (db.prepare('SELECT 1 FROM scopes WHERE feature_id = ? AND lower(title) = lower(?)').get(to, title))
      throw new EditError('The target feature has a scope with this title already. Rename one of them first');
    tx(() => {
      buryScope(from, s.id, title);
      db.prepare('UPDATE scopes SET feature_id = ?, sort = ? WHERE id = ?').run(to, nextSort('scopes', 'feature_id = ?', to), s.id);
      db.prepare('UPDATE feature_items SET feature_id = ? WHERE scope_id = ?').run(to, s.id);
      // A scope requirement that the target has as a feature requirement goes. A person's check on it stays.
      const same = `SELECT 1 FROM feature_items o WHERE o.feature_id = ? AND o.kind = ? AND o.scope_id = ?
        AND lower(o.text) = lower(feature_items.text)`;
      db.prepare(`UPDATE feature_items SET ai_draft = 0 WHERE feature_id = ? AND kind = ? AND scope_id IS NULL AND ai_draft = 1
        AND EXISTS (${same} AND o.ai_draft = 0)`).run(to, SCOPE_ITEM_KIND, to, SCOPE_ITEM_KIND, s.id);
      db.prepare(
        `DELETE FROM feature_items WHERE scope_id = ? AND kind = ? AND EXISTS (SELECT 1 FROM feature_items o
           WHERE o.feature_id = ? AND o.kind = feature_items.kind AND o.scope_id IS NULL AND lower(o.text) = lower(feature_items.text))`,
      ).run(s.id, SCOPE_ITEM_KIND, to);

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
        .all(s.id, from) as any[];
      for (const l of old) {
        const keep = upsertLink.get(p, l.test_id, to, l.source, l.checked) as any;
        untag.run(l.id, s.id);
        tag.run(keep.id, s.id);
        if (!hasScope.get(l.id)) removeLink.run(l.id); // marker: the skill does not link the test to the old feature again
      }

      // Screenshots that show only this scope move. The others stay and lose this scope's tag.
      const shots = db
        .prepare(
          `SELECT sh.*, (SELECT COUNT(*) FROM screenshot_scopes o WHERE o.screenshot_id = sh.id) AS n
           FROM screenshots sh JOIN screenshot_scopes ss ON ss.screenshot_id = sh.id
           WHERE ss.scope_id = ? AND sh.feature_id = ? AND sh.removed = 0`,
        )
        .all(s.id, from) as any[];
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
          untagShot.run(sh.id, s.id);
          continue;
        }
        const key: string | null = sh.match_key;
        // An AI screenshot leaves a deleted marker on the old feature, so the skill does not add it there again.
        if (key && !otherWithKey.get(from, key, sh.id)) marker.run(p, from, sh.caption, sh.mime, key);
        const dup = key ? (findKey.get(to, key) as any) : null;
        if (dup && !dup.removed) {
          // The target has the same AI screenshot: keep that one, with this scope's tag and the "checked" mark.
          tagShot.run(dup.id, s.id);
          addCheck.run(sh.checked, dup.id);
          dropShot.run(sh.id);
          continue;
        }
        if (dup) dropShot.run(dup.id); // a live screenshot wins over a deleted marker, as in mergeFeature
        moveShot.run(to, sort++, sh.id);
      }
    });
    return { featureId: to };
  },
  deleteScope(p: string, id: string) {
    const s = ownScope(p, id);
    tx(() => {
      buryScope(s.featureId, s.id, (db.prepare('SELECT title FROM scopes WHERE id = ?').get(s.id) as any).title);
      db.prepare('DELETE FROM scopes WHERE id = ?').run(s.id); // its tests stay linked to the feature
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
    const scopeId = b.scopeId ? scopeOf(p, f, b.scopeId) : null;
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
