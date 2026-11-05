// Gestionnaire de mots-clés : arborescence, normalisation, affectations, fusion, suggestions, import/export.
import crypto from 'crypto';
import { logHistory } from './db.mjs';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const ROOT_KEY = '__root__'; // sentinel de parent racine (parent_id IS NULL côté base)
const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
/** Forme normalisée d'un nom de mot-clé (colonne keywords.normalized) : utilisée aussi par la recherche. */
export const normalizeKeyword = norm;

export function createKeywords(db) {
  const map = r => r ? ({ ...r, data: r.data ? JSON.parse(r.data) : {} }) : null;

  const list = () => db.prepare('SELECT * FROM keywords ORDER BY normalized').all().map(map);
  const get = id => map(db.prepare('SELECT * FROM keywords WHERE id = ?').get(id));
  const byName = name => map(db.prepare('SELECT * FROM keywords WHERE normalized = ?').get(norm(name)));

  /** Crée (ou retrouve) un mot-clé. parentId optionnel pour l'arborescence. */
  function ensure(name, parentId = null) {
    name = String(name || '').trim(); if (!name) throw new Error('Mot-clé vide');
    const n = norm(name);
    const hit = parentId
      ? db.prepare('SELECT * FROM keywords WHERE normalized = ? AND parent_id = ?').get(n, parentId)
      : db.prepare('SELECT * FROM keywords WHERE normalized = ? AND parent_id IS NULL').get(n);
    if (hit) return map(hit);
    const id = uid();
    db.prepare('INSERT INTO keywords(id,name,parent_id,normalized,photo_count,created_at,data) VALUES(?,?,?,?,0,?,?)')
      .run(id, name, parentId, n, now(), '{}');
    return get(id);
  }

  /** Renomme, change le parent. */
  function update(id, { name, parentId }) {
    const k = get(id); if (!k) throw new Error('Mot-clé inconnu');
    const nm = name != null ? String(name).trim() : k.name;
    const np = parentId !== undefined ? parentId : k.parent_id;
    if (np === id) throw new Error('Un mot-clé ne peut pas être son propre parent');
    db.prepare('UPDATE keywords SET name=?, parent_id=?, normalized=? WHERE id=?').run(nm, np, norm(nm), id);
    logHistory(db, 'keyword.update', `Mot-clé « ${nm} » modifié`, { id });
    return get(id);
  }

  /** Recompte les photos par mot-clé (rafraîchit photo_count). */
  function recount() {
    db.prepare('UPDATE keywords SET photo_count = (SELECT COUNT(*) FROM photo_keywords pk WHERE pk.keyword_id = keywords.id)').run();
  }

  /** Affecte un mot-clé à une photo (idempotent). */
  function attach(photoId, keywordId) {
    db.prepare('INSERT OR IGNORE INTO photo_keywords(photo_id, keyword_id) VALUES(?,?)').run(photoId, keywordId);
  }
  function detach(photoId, keywordId) {
    db.prepare('DELETE FROM photo_keywords WHERE photo_id=? AND keyword_id=?').run(photoId, keywordId);
  }
  /** Affecte par noms (crée au besoin) une liste de mots-clés à une photo. Renvoie les ids. */
  function attachNames(photoId, names) {
    const ids = [];
    for (const nm of [].concat(names ?? []).filter(Boolean)) { const k = ensure(nm); attach(photoId, k.id); ids.push(k.id); }
    return ids;
  }
  const ofPhoto = photoId => db.prepare('SELECT k.* FROM keywords k JOIN photo_keywords pk ON pk.keyword_id=k.id WHERE pk.photo_id=? ORDER BY k.normalized').all(photoId).map(map);

  /** Supprime un mot-clé (et ses affectations). Les enfants sont ré-attachés au parent. */
  function remove(id) {
    const k = get(id); if (!k) throw new Error('Mot-clé inconnu');
    db.prepare('UPDATE keywords SET parent_id=? WHERE parent_id=?').run(k.parent_id, id);
    db.prepare('DELETE FROM photo_keywords WHERE keyword_id=?').run(id);
    db.prepare('DELETE FROM keywords WHERE id=?').run(id);
    recount();
    logHistory(db, 'keyword.remove', `Mot-clé « ${k.name} » supprimé`, { id });
  }

  /** Fusionne plusieurs mots-clés : toutes les affectations vont vers targetId, les sources sont supprimées. */
  function merge(sourceIds, targetId) {
    const target = get(targetId); if (!target) throw new Error('Cible inconnue');
    const sources = [].concat(sourceIds).filter(x => x !== targetId).map(get).filter(Boolean);
    for (const s of sources) {
      db.prepare('INSERT OR IGNORE INTO photo_keywords(photo_id, keyword_id) SELECT photo_id, ? FROM photo_keywords WHERE keyword_id=?').run(targetId, s.id);
      db.prepare('UPDATE keywords SET parent_id=? WHERE parent_id=?').run(targetId, s.id);
      db.prepare('DELETE FROM photo_keywords WHERE keyword_id=?').run(s.id);
      db.prepare('DELETE FROM keywords WHERE id=?').run(s.id);
    }
    recount();
    logHistory(db, 'keyword.merge', `Fusion de ${sources.length} mot(s)-clé(s) vers « ${target.name} »`, { target: targetId, sources: sources.map(s => s.id) });
    return get(targetId);
  }

  /** Suggestions pour l'autocomplétion (prefixe + fréquence). */
  function suggest(prefix = '', limit = 20) {
    const p = norm(prefix);
    const rows = p
      ? db.prepare('SELECT * FROM keywords WHERE normalized LIKE ? ORDER BY photo_count DESC, normalized LIMIT ?').all(p + '%', limit)
      : db.prepare('SELECT * FROM keywords ORDER BY photo_count DESC, normalized LIMIT ?').all(limit);
    return rows.map(map);
  }

  /** Arborescence (parents → enfants) pour l'affichage. */
  function tree() {
    const all = list(); const byParent = new Map();
    for (const k of all) { const p = k.parent_id ?? ROOT_KEY; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(k); }
    const build = parent => (byParent.get(parent) ?? []).map(k => ({ ...k, children: build(k.id) }));
    return build(ROOT_KEY);
  }

  /** Export (CSV simple) et import de la liste. */
  function exportCsv() {
    const esc = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const rows = [['Nom', 'Parent', 'Photos']];
    for (const k of list()) { const p = k.parent_id ? get(k.parent_id)?.name : ''; rows.push([k.name, p ?? '', k.photo_count]); }
    return rows.map(r => r.map(esc).join(',')).join('\r\n');
  }
  /** Import : crée les mots-clés manquants (names = liste de chaînes ou [{name,parent}]). */
  function importList(names) {
    let created = 0;
    for (const item of [].concat(names ?? []).filter(Boolean)) {
      if (typeof item === 'string') { ensure(item); created++; }
      else if (item?.name) { const parent = item.parent ? ensure(item.parent).id : null; ensure(item.name, parent); created++; }
    }
    recount();
    logHistory(db, 'keyword.import', `${created} mot(s)-clé(s) importé(s)`, {});
    return { created };
  }

  return { list, get, byName, ensure, update, recount, attach, detach, attachNames, ofPhoto, remove, merge, suggest, tree, exportCsv, importList };
}
