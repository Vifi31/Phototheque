// Collections : sélections statiques (liste de photos choisies) et recherches enregistrées
// (collections dynamiques, dont le contenu est recalculé à chaque consultation).
// Supprimer une collection ou en retirer une photo ne touche jamais aux photos ni aux originaux.
import crypto from 'crypto';
import { logHistory, tx } from './db.mjs';
import { cleanFilters } from './search.mjs';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const P = s => { try { return JSON.parse(s); } catch { return null; } };
export const COLLECTION_KINDS = { static: 'Sélection', dynamic: 'Recherche enregistrée' };

export function createCollections(db, library) {
  const map = r => r ? ({ ...r, query: r.query ? P(r.query) ?? {} : null, data: P(r.data) ?? {} }) : null;
  const cleanName = name => { const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120); if (!n) throw new Error('Nom de collection vide'); return n; };
  const ids = list => [...new Set([].concat(list ?? []).filter(x => typeof x === 'string' && x))];

  /** Nombre de photos : réel pour une sélection, recalculé pour une recherche enregistrée. */
  const countOf = c => c.kind === 'dynamic'
    ? library.search(c.query ?? {}, { limit: 1 }).total
    : db.prepare('SELECT COUNT(*) n FROM collection_photos WHERE collection_id = ?').get(c.id).n;

  const get = id => { const c = map(db.prepare('SELECT * FROM collections WHERE id = ?').get(id)); return c && { ...c, photo_count: countOf(c) }; };
  const list = () => db.prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE').all().map(map).map(c => ({ ...c, photo_count: countOf(c) }));
  const need = id => { const c = get(id); if (!c) throw new Error('Collection inconnue'); return c; };
  const needStatic = id => { const c = need(id); if (c.kind !== 'static') throw new Error('Une recherche enregistrée se met à jour seule : on ne peut pas y ajouter ou en retirer des photos'); return c; };
  const touch = id => db.prepare('UPDATE collections SET updated_at = ?, photo_count = (SELECT COUNT(*) FROM collection_photos WHERE collection_id = ?) WHERE id = ?').run(now(), id, id);

  /** Crée une sélection (photoIds optionnels) ou une recherche enregistrée (query = critères de buildQuery). */
  function create({ name, kind = 'static', query, photoIds } = {}) {
    if (!COLLECTION_KINDS[kind]) throw new Error('Type de collection inconnu');
    const nm = cleanName(name);
    let q = null;
    if (kind === 'dynamic') { q = cleanFilters(query); if (!Object.keys(q).length) throw new Error('Une recherche enregistrée doit comporter au moins un critère'); }
    const id = uid(), t = now();
    tx(db, () => {
      db.prepare('INSERT INTO collections(id,name,kind,query,created_at,updated_at,photo_count,data) VALUES(?,?,?,?,?,?,0,?)')
        .run(id, nm, kind, q ? JSON.stringify(q) : null, t, t, '{}');
      if (kind === 'static' && photoIds) insertPhotos(id, photoIds);
    });
    logHistory(db, 'collection.create', `Collection « ${nm} » créée (${COLLECTION_KINDS[kind]})`, { id, kind });
    return get(id);
  }

  /** Renomme ; pour une recherche enregistrée, remplace aussi les critères si fournis. */
  function update(id, { name, query } = {}) {
    const c = need(id);
    const nm = name != null ? cleanName(name) : c.name;
    let q = c.query;
    if (query !== undefined) {
      if (c.kind !== 'dynamic') throw new Error('Seule une recherche enregistrée a des critères');
      q = cleanFilters(query); if (!Object.keys(q).length) throw new Error('Une recherche enregistrée doit comporter au moins un critère');
    }
    db.prepare('UPDATE collections SET name = ?, query = ?, updated_at = ? WHERE id = ?').run(nm, q ? JSON.stringify(q) : null, now(), id);
    logHistory(db, 'collection.update', `Collection « ${nm} » modifiée`, { id });
    return get(id);
  }

  /** Supprime la collection seule (les photos restent au catalogue). */
  function remove(id) {
    const c = need(id);
    db.prepare('DELETE FROM collections WHERE id = ?').run(id); // collection_photos : ON DELETE CASCADE
    logHistory(db, 'collection.remove', `Collection « ${c.name} » supprimée (photos conservées)`, { id });
    return { removed: id, photosUntouched: true };
  }

  function insertPhotos(id, photoIds) {
    let pos = db.prepare('SELECT COALESCE(MAX(position), 0) m FROM collection_photos WHERE collection_id = ?').get(id).m;
    const exists = db.prepare('SELECT 1 FROM photos WHERE id = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO collection_photos(collection_id, photo_id, position) VALUES(?,?,?)');
    let added = 0;
    for (const pid of ids(photoIds)) if (exists.get(pid) && ins.run(id, pid, pos + 1).changes) { pos++; added++; }
    touch(id);
    return added;
  }

  /** Ajoute des photos à une sélection (idempotent : une photo déjà présente est ignorée). */
  function addPhotos(id, photoIds) {
    const c = needStatic(id);
    const added = tx(db, () => insertPhotos(id, photoIds));
    logHistory(db, 'collection.add', `${added} photo(s) ajoutée(s) à « ${c.name} »`, { id, added });
    return { added, collection: get(id) };
  }

  /** Retire des photos d'une sélection (les photos restent au catalogue). */
  function removePhotos(id, photoIds) {
    const c = needStatic(id);
    const del = db.prepare('DELETE FROM collection_photos WHERE collection_id = ? AND photo_id = ?');
    const removed = tx(db, () => { let n = 0; for (const pid of ids(photoIds)) n += Number(del.run(id, pid).changes); touch(id); return n; });
    logHistory(db, 'collection.removePhotos', `${removed} photo(s) retirée(s) de « ${c.name} »`, { id, removed });
    return { removed, collection: get(id) };
  }

  /**
   * Traduit `collectionId` dans des critères de recherche : une sélection reste un filtre sur
   * collection_photos ; une recherche enregistrée est remplacée par ses critères, auxquels
   * s'ajoutent les filtres choisis par ailleurs (année, note…).
   */
  function resolveFilters(f = {}) {
    if (!f.collectionId) return f;
    const c = need(f.collectionId);
    if (c.kind !== 'dynamic') return f;
    const { collectionId, q, prefix, ...rest } = f;
    const out = { ...c.query, ...rest };
    const text = [c.query.q, q].filter(Boolean).join(' '); // le texte saisi s'ajoute (ET) au texte enregistré
    if (text) out.q = text;
    if (prefix === false) out.prefix = false;
    return out;
  }

  return { list, get, create, update, remove, addPhotos, removePhotos, resolveFilters };
}
