// Gestionnaire de mots-clés : arborescence, normalisation, affectations, fusion, suggestions, import/export,
// synonymes, catégories et description (keywords.data), doublons de vocabulaire, statistiques d'utilisation.
import crypto from 'crypto';
import { logHistory } from './db.mjs';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const ROOT_KEY = '__root__'; // sentinel de parent racine (parent_id IS NULL côté base)
const norm = s => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
/** Forme normalisée d'un nom de mot-clé (colonne keywords.normalized) : utilisée aussi par la recherche. */
export const normalizeKeyword = norm;

/** Séparateur, dans keywords_text, entre les mots-clés de la photo et le texte d'appui (parents, synonymes). */
export const KW_EXTRA = ' ¦ ';
/** Noms des mots-clés lus dans keywords_text (sans le texte d'appui). */
export const keywordNamesOf = text => String(text ?? '').split(KW_EXTRA)[0].split(/\s*\|\s*/).filter(Boolean);
const P = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/**
 * Réécrit photos.keywords_text (texte cherché par FTS5) d'une photo depuis ses affectations :
 * « mot1 | mot2 », puis, après KW_EXTRA, les parents et les synonymes de ces mots-clés, pour que la
 * recherche plein texte trouve « animaux » sur une photo marquée « chat » rangé sous « animaux ».
 */
export function syncPhotoKeywordsText(db, photoId) {
  const rows = db.prepare('SELECT k.id, k.name, k.parent_id, k.data FROM keywords k JOIN photo_keywords pk ON pk.keyword_id=k.id WHERE pk.photo_id=?').all(photoId);
  const names = rows.map(r => r.name);
  const extra = new Set(); const seen = new Set(rows.map(r => r.id));
  const parentOf = db.prepare('SELECT id, name, parent_id, data FROM keywords WHERE id = ?');
  for (const r of rows) {
    for (const syn of P(r.data).synonyms ?? []) extra.add(syn);
    let p = r.parent_id;
    for (let depth = 0; p && depth < 32; depth++) {
      const k = parentOf.get(p); if (!k) break;
      if (!seen.has(k.id)) { seen.add(k.id); extra.add(k.name); for (const syn of P(k.data).synonyms ?? []) extra.add(syn); }
      p = k.parent_id;
    }
  }
  for (const n of names) extra.delete(n);
  const text = names.join(' | ') + (extra.size ? KW_EXTRA + [...extra].join(' | ') : '');
  db.prepare('UPDATE photos SET keywords_text = ? WHERE id = ?').run(text, photoId);
}

/** Nettoie les champs documentaires d'un mot-clé : description, catégorie, synonymes (liste ou texte « a, b »). */
export function cleanKeywordData(b = {}, name = '') {
  const out = {};
  if (b.description !== undefined) out.description = String(b.description ?? '').trim().slice(0, 2000);
  if (b.category !== undefined) out.category = String(b.category ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (b.synonyms !== undefined) {
    const list = Array.isArray(b.synonyms) ? b.synonyms : String(b.synonyms ?? '').split(/[,;\n]/);
    const seen = new Set([norm(name)]); out.synonyms = [];
    for (const raw of list) {
      const v = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 80); const n = norm(v);
      if (v && !seen.has(n)) { seen.add(n); out.synonyms.push(v); }
      if (out.synonyms.length >= 30) break;
    }
    out.synonymsNorm = out.synonyms.map(norm);
  }
  return out;
}

/**
 * Sous-requête SQL : ids des mots-clés désignés par un nom (libellé ou synonyme, forme normalisée)
 * et de tous leurs descendants. Paramètres : [n, n]. Utilisée par lib/search.mjs.
 */
export const KEYWORD_TREE_SQL = `WITH RECURSIVE kt(id) AS (
  SELECT id FROM keywords WHERE normalized = ? OR EXISTS (SELECT 1 FROM json_each(keywords.data, '$.synonymsNorm') WHERE value = ?)
  UNION SELECT k.id FROM keywords k JOIN kt ON k.parent_id = kt.id) SELECT id FROM kt`;
/** Même chose à partir d'un identifiant de mot-clé. Paramètre : [id]. */
export const KEYWORD_ID_TREE_SQL = `WITH RECURSIVE kt(id) AS (
  SELECT id FROM keywords WHERE id = ?
  UNION SELECT k.id FROM keywords k JOIN kt ON k.parent_id = kt.id) SELECT id FROM kt`;

/** Forme approchée d'un libellé pour repérer les variantes de vocabulaire (pluriel, tirets, apostrophes). */
const loose = s => norm(s).replace(/[-'’_.]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  .map(w => w.length > 3 ? w.replace(/eaux$/, 'eau').replace(/aux$/, 'al').replace(/[sx]$/, '') : w).join(' ');
/** Distance d'édition bornée (au-delà de max, renvoie max + 1). */
function editDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function createKeywords(db) {
  const map = r => r ? ({ ...r, data: r.data ? JSON.parse(r.data) : {} }) : null;

  const list = () => db.prepare('SELECT * FROM keywords ORDER BY normalized').all().map(map);
  // photos d'un mot-clé et de ses descendants : leur texte d'appui (parents) suit un déplacement
  const photosOfTree = id => db.prepare(`SELECT DISTINCT photo_id FROM photo_keywords WHERE keyword_id IN (${KEYWORD_ID_TREE_SQL})`).all(id).map(r => r.photo_id);
  /** Vrai si `candidate` est `id` ou l'un de ses descendants (déplacement interdit : boucle). */
  const inSubtree = (id, candidate) => !!candidate && !!db.prepare(`SELECT 1 FROM (${KEYWORD_ID_TREE_SQL}) WHERE id = ?`).get(id, candidate);
  const get = id => map(db.prepare('SELECT * FROM keywords WHERE id = ?').get(id));
  const byName = name => map(db.prepare('SELECT * FROM keywords WHERE normalized = ?').get(norm(name)));
  // photos portant l'un de ces mots-clés : leur keywords_text doit suivre un renommage, une fusion ou une suppression
  const photosOf = ids => db.prepare(`SELECT DISTINCT photo_id FROM photo_keywords WHERE keyword_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.photo_id);
  const resync = photoIds => { for (const pid of photoIds) syncPhotoKeywordsText(db, pid); };

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

  /**
   * Mot-clé désigné par un nom saisi : à la racine d'abord, sinon n'importe où dans l'arborescence,
   * sinon par synonyme ; créé à la racine s'il n'existe nulle part (affectation depuis une photo).
   */
  function resolve(name) {
    const n = norm(name); if (!n) throw new Error('Mot-clé vide');
    const hit = db.prepare('SELECT * FROM keywords WHERE normalized = ? ORDER BY parent_id IS NOT NULL, photo_count DESC LIMIT 1').get(n)
      ?? db.prepare("SELECT * FROM keywords WHERE EXISTS (SELECT 1 FROM json_each(keywords.data, '$.synonymsNorm') WHERE value = ?) ORDER BY photo_count DESC LIMIT 1").get(n);
    return hit ? map(hit) : ensure(name);
  }

  /** Renomme, change le parent, la description, la catégorie ou les synonymes. */
  function update(id, b = {}) {
    const k = get(id); if (!k) throw new Error('Mot-clé inconnu');
    const nm = b.name != null ? String(b.name).trim().replace(/\s+/g, ' ') : k.name;
    if (!nm) throw new Error('Mot-clé vide');
    const np = b.parentId !== undefined ? (b.parentId || null) : k.parent_id;
    if (np === id) throw new Error('Un mot-clé ne peut pas être son propre parent');
    if (np && !get(np)) throw new Error('Parent inconnu');
    if (np && np !== k.parent_id && inSubtree(id, np)) throw new Error('Un mot-clé ne peut pas être rangé sous l’un de ses descendants');
    const twin = np ? db.prepare('SELECT id FROM keywords WHERE normalized=? AND parent_id=? AND id<>?').get(norm(nm), np, id)
      : db.prepare('SELECT id FROM keywords WHERE normalized=? AND parent_id IS NULL AND id<>?').get(norm(nm), id);
    if (twin) throw new Error(`« ${nm} » existe déjà à cet endroit : utiliser la fusion`);
    const data = { ...k.data, ...cleanKeywordData(b, nm) };
    if (b.synonyms === undefined && nm !== k.name && data.synonyms) Object.assign(data, cleanKeywordData({ synonyms: data.synonyms }, nm));
    db.prepare('UPDATE keywords SET name=?, parent_id=?, normalized=?, data=? WHERE id=?').run(nm, np, norm(nm), JSON.stringify(data), id);
    const textChanged = nm !== k.name || np !== k.parent_id || JSON.stringify(data.synonyms ?? []) !== JSON.stringify(k.data.synonyms ?? []);
    if (textChanged) resync(photosOfTree(id));
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
    for (const nm of [].concat(names ?? []).filter(Boolean)) { const k = resolve(nm); attach(photoId, k.id); ids.push(k.id); }
    return ids;
  }
  const ofPhoto = photoId => db.prepare('SELECT k.* FROM keywords k JOIN photo_keywords pk ON pk.keyword_id=k.id WHERE pk.photo_id=? ORDER BY k.normalized').all(photoId).map(map);

  /** Supprime un mot-clé (et ses affectations). Les enfants sont ré-attachés au parent. */
  function remove(id) {
    const k = get(id); if (!k) throw new Error('Mot-clé inconnu');
    const touched = photosOfTree(id);
    db.prepare('UPDATE keywords SET parent_id=? WHERE parent_id=?').run(k.parent_id, id);
    db.prepare('DELETE FROM photo_keywords WHERE keyword_id=?').run(id);
    db.prepare('DELETE FROM keywords WHERE id=?').run(id);
    resync(touched);
    recount();
    logHistory(db, 'keyword.remove', `Mot-clé « ${k.name} » supprimé`, { id });
  }

  /** Fusionne plusieurs mots-clés : toutes les affectations vont vers targetId, les sources sont supprimées. */
  function merge(sourceIds, targetId) {
    const target = get(targetId); if (!target) throw new Error('Cible inconnue');
    const sources = [].concat(sourceIds).filter(x => x !== targetId).map(get).filter(Boolean);
    for (const s of sources) if (inSubtree(s.id, targetId)) throw new Error(`« ${target.name} » est rangé sous « ${s.name} » : fusionner dans l’autre sens`);
    const touched = sources.length ? [...new Set(sources.flatMap(s => photosOfTree(s.id)))] : [];
    // les libellés fusionnés deviennent des synonymes de la cible : chercher l'ancien nom trouve encore les photos
    const syn = cleanKeywordData({ synonyms: [...(target.data.synonyms ?? []), ...sources.flatMap(s => [s.name, ...(s.data.synonyms ?? [])])] }, target.name);
    db.prepare('UPDATE keywords SET data=? WHERE id=?').run(JSON.stringify({ ...target.data, ...syn }), targetId);
    for (const s of sources) {
      db.prepare('INSERT OR IGNORE INTO photo_keywords(photo_id, keyword_id) SELECT photo_id, ? FROM photo_keywords WHERE keyword_id=?').run(targetId, s.id);
      db.prepare('UPDATE keywords SET parent_id=? WHERE parent_id=?').run(targetId, s.id);
      db.prepare('DELETE FROM photo_keywords WHERE keyword_id=?').run(s.id);
      db.prepare('DELETE FROM keywords WHERE id=?').run(s.id);
    }
    resync(touched);
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

  /**
   * Doublons de vocabulaire : groupes de mots-clés qui désignent probablement la même chose.
   * Raisons : même libellé à deux endroits de l'arborescence, libellé égal au synonyme d'un autre,
   * même forme au pluriel / tiret près, ou une lettre d'écart (libellés d'au moins 5 lettres).
   * Ne modifie rien : la fusion reste un choix de l'utilisateur.
   */
  function vocabularyDuplicates() {
    const all = list();
    const byId = new Map(all.map(k => [k.id, k]));
    const path = k => { const out = []; let p = k; for (let i = 0; p && i < 32; i++) { out.unshift(p.name); p = p.parent_id ? byId.get(p.parent_id) : null; } return out.join(' › '); };
    const pairs = new Map(); // « idA|idB » → raison
    const addPair = (a, b, why) => { if (a.id === b.id) return; const key = [a.id, b.id].sort().join('|'); if (!pairs.has(key)) pairs.set(key, why); };
    const bucket = (m, key, k) => { if (!m.has(key)) m.set(key, []); m.get(key).push(k); };
    const byNorm = new Map(), byLoose = new Map();
    for (const k of all) { bucket(byNorm, k.normalized, k); bucket(byLoose, loose(k.name), k); }
    for (const g of byNorm.values()) for (let i = 1; i < g.length; i++) addPair(g[0], g[i], 'même libellé');
    for (const k of all) for (const s of k.data.synonymsNorm ?? []) for (const o of byNorm.get(s) ?? []) addPair(k, o, 'synonyme d’un autre mot-clé');
    for (const g of byLoose.values()) for (let i = 1; i < g.length; i++) addPair(g[0], g[i], 'pluriel, tiret ou apostrophe');
    const long = all.filter(k => k.normalized.length >= 5).sort((a, b) => a.normalized.length - b.normalized.length);
    if (long.length <= 5000) for (let i = 0; i < long.length; i++) for (let j = i + 1; j < long.length; j++) {
      if (long[j].normalized.length - long[i].normalized.length > 1) break;
      if (editDistance(long[i].normalized, long[j].normalized, 1) === 1) addPair(long[i], long[j], 'une lettre d’écart');
    }
    // regroupement transitif des paires (union-find)
    const link = new Map();
    const find = x => { while (link.get(x) !== x) x = link.get(x); return x; };
    for (const key of pairs.keys()) { const [a, b] = key.split('|'); for (const x of [a, b]) if (!link.has(x)) link.set(x, x); link.set(find(a), find(b)); }
    const byRoot = new Map();
    for (const id of link.keys()) bucket(byRoot, find(id), id);
    const groups = [];
    for (const ids of byRoot.values()) {
      const set = new Set(ids);
      const items = ids.map(id => byId.get(id)).sort((a, b) => b.photo_count - a.photo_count || a.normalized.localeCompare(b.normalized));
      const reasons = [...new Set([...pairs].filter(([key]) => key.split('|').every(x => set.has(x))).map(([, w]) => w))];
      groups.push({ reasons, keywords: items.map(k => ({ id: k.id, name: k.name, path: path(k), photo_count: k.photo_count, category: k.data.category ?? '' })) });
    }
    return groups.sort((a, b) => b.keywords.length - a.keywords.length || a.keywords[0].name.localeCompare(b.keywords[0].name, 'fr'));
  }

  /** Statistiques d'utilisation du vocabulaire. */
  function usage() {
    const all = list();
    const used = all.filter(k => k.photo_count > 0);
    const cats = new Map();
    for (const k of all) { const c = k.data.category || ''; const e = cats.get(c) ?? { category: c, keywords: 0, assignments: 0 }; e.keywords++; e.assignments += k.photo_count; cats.set(c, e); }
    const one = q => db.prepare(q).get().n;
    return {
      keywords: all.length, used: used.length, unused: all.length - used.length,
      roots: all.filter(k => !k.parent_id).length, withSynonyms: all.filter(k => k.data.synonyms?.length).length,
      assignments: one('SELECT COUNT(*) n FROM photo_keywords'),
      photosWith: one('SELECT COUNT(DISTINCT photo_id) n FROM photo_keywords'),
      photos: one('SELECT COUNT(*) n FROM photos'),
      top: [...used].sort((a, b) => b.photo_count - a.photo_count || a.normalized.localeCompare(b.normalized)).slice(0, 15).map(k => ({ id: k.id, name: k.name, photo_count: k.photo_count })),
      categories: [...cats.values()].sort((a, b) => (a.category === '') - (b.category === '') || a.category.localeCompare(b.category, 'fr')),
    };
  }

  /** Catégories utilisées (pour les listes de choix). */
  const categories = () => [...new Set(list().map(k => k.data.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));

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
    const rows = [['Nom', 'Parent', 'Photos', 'Catégorie', 'Synonymes', 'Description']];
    for (const k of list()) { const p = k.parent_id ? get(k.parent_id)?.name : ''; rows.push([k.name, p ?? '', k.photo_count, k.data.category ?? '', (k.data.synonyms ?? []).join(', '), k.data.description ?? '']); }
    return rows.map(r => r.map(esc).join(',')).join('\r\n');
  }
  /** Import : crée les mots-clés manquants (names = liste de chaînes ou [{name,parent}]). */
  function importList(names) {
    let created = 0;
    for (const item of [].concat(names ?? []).filter(Boolean)) {
      if (typeof item === 'string') { ensure(item); created++; }
      else if (item?.name) {
        const parent = item.parent ? ensure(item.parent).id : null; const k = ensure(item.name, parent); created++;
        const fields = Object.fromEntries(['category', 'synonyms', 'description'].filter(x => item[x] != null).map(x => [x, item[x]]));
        if (Object.keys(fields).length) db.prepare('UPDATE keywords SET data=? WHERE id=?').run(JSON.stringify({ ...k.data, ...cleanKeywordData(fields, k.name) }), k.id);
      }
    }
    recount();
    logHistory(db, 'keyword.import', `${created} mot(s)-clé(s) importé(s)`, {});
    return { created };
  }

  return { list, get, byName, ensure, resolve, update, recount, attach, detach, attachNames, ofPhoto, remove, merge, suggest, tree, exportCsv, importList, vocabularyDuplicates, usage, categories };
}
