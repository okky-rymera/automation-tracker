/**
 * Feature list: groups > features > abilities, and links from tests to them.
 * People type this data in the app. The database holds the only copy.
 *
 * Tag links: a test with "@feature:<tag>" links to the feature that owns <tag>.
 * A scan adds these links. It removes a tag link only when the test lost the
 * tag and no person changed the link. When a person removes a tag link, the row
 * stays with removed = 1, so a scan does not add it again.
 */
import { db, json, tx } from './db.ts';

const FEATURE_TAG = '@feature:';
const tagName = (t: string) => t.slice(FEATURE_TAG.length).trim().toLowerCase();
const humanize = (tag: string) => {
  const s = tag.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Feature tag names in each active test of the project. */
function testFeatureTags(projectId: string) {
  const rows = db.prepare('SELECT id, framework, tags FROM tests WHERE project_id = ? AND removed_at IS NULL').all(projectId) as any[];
  return rows.map((r) => ({
    id: r.id as string,
    framework: r.framework as string,
    tags: [...new Set((json(r.tags) as string[]).filter((t) => t.toLowerCase().startsWith(FEATURE_TAG)).map(tagName))].filter(Boolean),
  }));
}

/**
 * One time per project: makes one feature for each feature tag in the tests.
 * Tags that differ only in letter case become one feature. Later new tags are
 * listed in the app as "tags with no feature"; they do not make features.
 */
export function seedFeaturesFromTags(projectId: string) {
  if (db.prepare('SELECT 1 FROM feature_seeds WHERE project_id = ?').get(projectId)) return;
  const tests = testFeatureTags(projectId);
  if (!tests.length) return; // no scan yet
  tx(() => {
    const tags = [...new Set(tests.flatMap((t) => t.tags))].sort();
    tags.forEach((tag, i) => {
      if (db.prepare('SELECT 1 FROM feature_tags WHERE project_id = ? AND tag = ?').get(projectId, tag)) return;
      const r = db.prepare('INSERT INTO features (project_id, title, sort) VALUES (?, ?, ?)').run(projectId, humanize(tag), i);
      db.prepare('INSERT INTO feature_tags (project_id, tag, feature_id) VALUES (?, ?, ?)').run(projectId, tag, r.lastInsertRowid);
    });
    db.prepare('INSERT INTO feature_seeds (project_id) VALUES (?)').run(projectId);
  });
}

export function syncTagLinks(projectId: string) {
  const owner = new Map(
    (db.prepare('SELECT tag, feature_id FROM feature_tags WHERE project_id = ?').all(projectId) as any[]).map((r) => [r.tag, r.feature_id as number]),
  );
  const tests = testFeatureTags(projectId);
  const want = new Set<string>();
  for (const t of tests) for (const tag of t.tags) if (owner.has(tag)) want.add(`${t.id}|${owner.get(tag)}`);
  const active = new Set(tests.map((t) => t.id));

  tx(() => {
    const add = db.prepare("INSERT OR IGNORE INTO links (project_id, test_id, feature_id, source) VALUES (?, ?, ?, 'tag')");
    for (const k of want) {
      const [testId, fid] = k.split('|');
      add.run(projectId, testId, Number(fid));
    }
    // Tag links that no tag supports now, on tests that still exist, and that no person changed.
    const stale = db
      .prepare("SELECT id, test_id, feature_id FROM links WHERE project_id = ? AND source = 'tag' AND removed = 0 AND ability_id IS NULL")
      .all(projectId) as any[];
    const del = db.prepare('DELETE FROM links WHERE id = ?');
    for (const l of stale) if (active.has(l.test_id) && !want.has(`${l.test_id}|${l.feature_id}`)) del.run(l.id);
  });
}

/** Everything the feature editor needs, in one response. */
export function featureData(projectId: string) {
  const groups = db.prepare('SELECT id, title, description, sort FROM feature_groups WHERE project_id = ? ORDER BY sort, id').all(projectId);
  const features = db
    .prepare('SELECT id, group_id AS groupId, title, description, sort FROM features WHERE project_id = ? ORDER BY sort, id')
    .all(projectId) as any[];
  const tags = db.prepare('SELECT tag, feature_id FROM feature_tags WHERE project_id = ? ORDER BY tag').all(projectId) as any[];
  const abilities = db
    .prepare(
      'SELECT a.id, a.feature_id, a.title, a.description, a.sort FROM abilities a JOIN features f ON f.id = a.feature_id WHERE f.project_id = ? ORDER BY a.sort, a.id',
    )
    .all(projectId) as any[];
  const links = db
    .prepare(
      `SELECT l.id, l.test_id AS testId, l.feature_id, l.ability_id AS abilityId, l.source,
              t.framework, t.title, t.file, t.removed_at AS testRemovedAt
       FROM links l LEFT JOIN tests t ON t.project_id = l.project_id AND t.id = l.test_id
       WHERE l.project_id = ? AND l.removed = 0 ORDER BY t.framework, t.file, t.line`,
    )
    .all(projectId) as any[];

  for (const f of features) {
    f.tags = tags.filter((t) => t.feature_id === f.id).map((t) => t.tag);
    f.abilities = abilities.filter((a) => a.feature_id === f.id).map(({ feature_id, ...a }) => a);
    f.links = links
      .filter((l) => l.feature_id === f.id)
      .map(({ feature_id, ...l }) => ({ ...l, framework: l.framework ?? (l.testId.startsWith('CY-') ? 'cypress' : 'playwright'), missing: !l.framework || !!l.testRemovedAt }));
  }

  // Feature tags in tests that no feature owns.
  const owned = new Set(tags.map((t) => t.tag));
  const tests = testFeatureTags(projectId);
  const unknown = new Map<string, { playwright: number; cypress: number }>();
  for (const t of tests)
    for (const tag of t.tags)
      if (!owned.has(tag)) {
        const c = unknown.get(tag) ?? { playwright: 0, cypress: 0 };
        c[t.framework as 'playwright' | 'cypress']++;
        unknown.set(tag, c);
      }

  const linked = new Set(links.map((l) => l.testId));
  const all = db.prepare('SELECT id, framework FROM tests WHERE project_id = ? AND removed_at IS NULL').all(projectId) as any[];
  const unlinked = { playwright: 0, cypress: 0 };
  for (const t of all) if (!linked.has(t.id)) unlinked[t.framework as 'playwright' | 'cypress']++;

  return {
    groups,
    features,
    unknownTags: [...unknown.entries()].sort().map(([tag, c]) => ({ tag, ...c })),
    unlinked,
    tests: { playwright: all.filter((t) => t.framework === 'playwright').length, cypress: all.filter((t) => t.framework === 'cypress').length },
  };
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
function ownAbility(projectId: string, id: unknown): { id: number; featureId: number } {
  const r = db
    .prepare('SELECT a.id, a.feature_id FROM abilities a JOIN features f ON f.id = a.feature_id WHERE a.id = ? AND f.project_id = ?')
    .get(Number(id), projectId) as any;
  if (!r) throw new EditError('Ability not found in this project');
  return { id: r.id, featureId: r.feature_id };
}
function ownLink(projectId: string, id: unknown): any {
  const r = db.prepare('SELECT * FROM links WHERE id = ? AND project_id = ?').get(Number(id), projectId);
  if (!r) throw new EditError('Link not found in this project');
  return r;
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
    return tx(() => edits.addFeatureNow(p, b));
  },
  addFeatureNow(p: string, b: any) {
    const groupId = b.groupId ? own('feature_groups', p, b.groupId) : null;
    const r = db.prepare('INSERT INTO features (project_id, group_id, title, description, sort) VALUES (?, ?, ?, ?, ?)').run(
      p, groupId, need(b.title, 'Title'), text(b.description), nextSort('features', 'project_id = ?', p),
    );
    const id = Number(r.lastInsertRowid);
    if (b.tag) edits.addTag(p, String(id), { tag: b.tag }); // a refused tag undoes the new feature too
    return { id };
  },
  updateFeature(p: string, id: string, b: any) {
    const f = own('features', p, id);
    if ('title' in b) db.prepare('UPDATE features SET title = ? WHERE id = ?').run(need(b.title, 'Title'), f);
    if ('description' in b) db.prepare('UPDATE features SET description = ? WHERE id = ?').run(text(b.description), f);
    if ('groupId' in b) db.prepare('UPDATE features SET group_id = ? WHERE id = ?').run(b.groupId ? own('feature_groups', p, b.groupId) : null, f);
    if ('sort' in b) db.prepare('UPDATE features SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, f);
  },
  deleteFeature(p: string, id: string) {
    db.prepare('DELETE FROM features WHERE id = ?').run(own('features', p, id)); // tags, abilities and links go too
  },
  /** Moves tags, abilities and links of feature "from" into feature id, then deletes "from". */
  mergeFeature(p: string, id: string, b: any) {
    const into = own('features', p, id);
    const from = own('features', p, b.from);
    if (into === from) throw new EditError('A feature cannot merge with itself');
    tx(() => {
      db.prepare('UPDATE feature_tags SET feature_id = ? WHERE feature_id = ?').run(into, from);
      const base = nextSort('abilities', 'feature_id = ?', into);
      db.prepare('UPDATE abilities SET feature_id = ?, sort = sort + ? WHERE feature_id = ?').run(into, base, from);
      // A test linked to both: an active link wins over a link that a person removed.
      // Then keep the link of the target feature.
      db.prepare(
        'DELETE FROM links WHERE feature_id = ? AND removed = 1 AND test_id IN (SELECT test_id FROM links WHERE feature_id = ? AND removed = 0)',
      ).run(into, from);
      db.prepare('DELETE FROM links WHERE feature_id = ? AND test_id IN (SELECT test_id FROM links WHERE feature_id = ?)').run(from, into);
      db.prepare('UPDATE links SET feature_id = ? WHERE feature_id = ?').run(into, from);
      db.prepare('DELETE FROM features WHERE id = ?').run(from);
    });
  },

  addTag(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const tag = need(b.tag, 'Tag').replace(/^@?feature:/i, '').toLowerCase();
    const holder = db.prepare('SELECT feature_id FROM feature_tags WHERE project_id = ? AND tag = ?').get(p, tag) as any;
    if (holder && holder.feature_id !== f) throw new EditError(`Tag "${tag}" belongs to feature F-${holder.feature_id}`);
    db.prepare('INSERT OR IGNORE INTO feature_tags (project_id, tag, feature_id) VALUES (?, ?, ?)').run(p, tag, f);
    syncTagLinks(p);
  },
  deleteTag(p: string, id: string, tag: string) {
    const f = own('features', p, id);
    db.prepare('DELETE FROM feature_tags WHERE project_id = ? AND tag = ? AND feature_id = ?').run(p, tag.toLowerCase(), f);
    syncTagLinks(p);
  },

  addAbility(p: string, id: string, b: any) {
    const f = own('features', p, id);
    const r = db.prepare('INSERT INTO abilities (feature_id, title, description, sort) VALUES (?, ?, ?, ?)').run(
      f, need(b.title, 'Title'), text(b.description), nextSort('abilities', 'feature_id = ?', f),
    );
    return { id: Number(r.lastInsertRowid) };
  },
  updateAbility(p: string, id: string, b: any) {
    const a = ownAbility(p, id).id;
    if ('title' in b) db.prepare('UPDATE abilities SET title = ? WHERE id = ?').run(need(b.title, 'Title'), a);
    if ('description' in b) db.prepare('UPDATE abilities SET description = ? WHERE id = ?').run(text(b.description), a);
    if ('sort' in b) db.prepare('UPDATE abilities SET sort = ? WHERE id = ?').run(Number(b.sort) || 0, a);
  },
  deleteAbility(p: string, id: string) {
    db.prepare('DELETE FROM abilities WHERE id = ?').run(ownAbility(p, id).id); // its links stay on the feature
  },

  /** Links a test to a feature (and ability). Restores a link that a person removed before. */
  addLink(p: string, b: any) {
    const testId = need(b.testId, 'Test ID');
    if (!db.prepare('SELECT 1 FROM tests WHERE project_id = ? AND id = ?').get(p, testId)) throw new EditError(`Unknown test ${testId}`);
    const f = own('features', p, b.featureId);
    let abilityId: number | null = null;
    if (b.abilityId) {
      const a = ownAbility(p, b.abilityId);
      if (a.featureId !== f) throw new EditError('The ability is not in this feature');
      abilityId = a.id;
    }
    db.prepare(`INSERT INTO links (project_id, test_id, feature_id, ability_id, source) VALUES (?, ?, ?, ?, 'manual')
      ON CONFLICT (project_id, test_id, feature_id) DO UPDATE SET removed = 0, source = 'manual',
        ability_id = COALESCE(excluded.ability_id, ability_id)`).run(p, testId, f, abilityId);
  },
  updateLink(p: string, id: string, b: any) {
    const l = ownLink(p, id);
    let abilityId: number | null = null;
    if (b.abilityId) {
      const a = ownAbility(p, b.abilityId);
      if (a.featureId !== l.feature_id) throw new EditError('The ability is not in this feature');
      abilityId = a.id;
    }
    db.prepare("UPDATE links SET ability_id = ?, source = 'manual' WHERE id = ?").run(abilityId, l.id);
  },
  deleteLink(p: string, id: string) {
    const l = ownLink(p, id);
    // Keep the row as a marker, so the next scan does not add a tag link again.
    db.prepare('UPDATE links SET removed = 1, ability_id = NULL WHERE id = ?').run(l.id);
  },
};
