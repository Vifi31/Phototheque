// Moteur de recherche du catalogue (§4.2 et §9 du cahier des charges).
//
// Deux chemins :
//   1. FTS5 (index `photos_fts`, table à contenu externe créée par la migration v2 de lib/db.mjs)
//      → insensible à la casse ET aux accents, indexé, adapté aux 100 000 à 500 000 photos.
//   2. Repli `LIKE` si FTS5 est indisponible (build compilé sans l'option) : on ne promet jamais
//      une fonction que le moteur fourni ne peut pas exécuter.
//
// Ce module ne construit que du SQL et des paramètres ; il n'écrit jamais.
import { ftsAvailable } from './db.mjs';

/** État du moteur, affiché dans Administration → Base de données. */
export function searchEngine(db) {
  const fts = ftsAvailable(db);
  return { mode: fts ? 'fts5' : 'like', fts5: fts };
}

// ---------- Texte libre → expression FTS5 ----------
/**
 * Convertit une saisie utilisateur en expression MATCH sûre.
 * On n'injecte jamais la saisie brute dans MATCH (la syntaxe FTS5 : " * : ^ ( ) etc. provoquerait
 * une erreur de syntaxe, donc un 500). On extrait uniquement les suites de lettres/chiffres.
 * @returns {string|null} expression FTS5, ou null si aucun terme exploitable.
 */
export function toMatch(input, { prefixLast = true } = {}) {
  const terms = String(input ?? '').match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) return null;
  return terms.map((t, i) => {
    const quoted = '"' + t.replace(/"/g, '""') + '"';
    // préfixe sur le dernier terme seulement : confort de saisie progressive sans coût excessif
    return prefixLast && i === terms.length - 1 ? quoted + '*' : quoted;
  }).join(' AND ');
}

/** Échappe une liste de termes en expression MATCH (opérateur fourni). */
export function toMatchList(list, op = ' OR ' ) {
  const exprs = (Array.isArray(list) ? list : [list])
    .map(toMatch)
    .filter(Boolean);
  if (!exprs.length) return null;
  return exprs.length === 1 ? exprs[0] : '(' + exprs.join(op) + ')';
}

// ---------- Construction de la requête ----------
/**
 * Construit la clause WHERE d'une recherche photo.
 * @param {object} f     filtres (voir server.mjs pour la correspondance des paramètres d'URL)
 * @param {object} opts  { fts: boolean } — FTS5 disponible ou non
 * @returns {{where: string, params: any[]}}
 */
export function buildQuery(f = {}, opts = {}) {
  const fts = opts.fts !== false;
  const where = [], params = [];
  const add = (sql, ...p) => { where.push(sql); params.push(...p); };

  // ---- texte libre : ET (tous les termes) ----
  if (f.q) {
    const m = toMatch(f.q, { prefixLast: f.prefix !== false });
    if (fts && m) add('p.rowid IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)', m);
    else if (fts) { /* saisie sans terme exploitable : aucun filtre plutôt qu'une erreur */ }
    else add('(p.title LIKE ? OR p.description LIKE ? OR p.notes LIKE ? OR p.keywords_text LIKE ? OR p.camera_model LIKE ? OR p.camera_make LIKE ?)', ...Array(6).fill('%' + f.q + '%'));
  }
  // ---- texte libre : OU (au moins un terme) ----
  if (f.anyText?.length) {
    const m = toMatchList(f.anyText, ' OR ');
    if (fts && m) add('p.rowid IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)', m);
    else if (!fts) { const likes = f.anyText.map(() => '(p.title LIKE ? OR p.description LIKE ? OR p.notes LIKE ? OR p.keywords_text LIKE ?)').join(' OR '); if (likes) add(likes, ...f.anyText.flatMap(t => Array(4).fill('%' + t + '%'))); }
  }
  // ---- texte libre : NON (aucun de ces termes) ----
  if (f.excludeText?.length) {
    const m = toMatchList(f.excludeText, ' OR ');
    if (fts && m) add('p.rowid NOT IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)', m);
    else if (!fts) { const likes = f.excludeText.map(() => '(p.title LIKE ? OR p.notes LIKE ? OR p.keywords_text LIKE ?)').join(' AND '); if (likes) add(likes, ...f.excludeText.flatMap(t => Array(3).fill('%' + t + '%'))); }
  }

  // ---- mots-clés : ET / OU / NON ----
  if (f.keywordId) add('p.id IN (SELECT photo_id FROM photo_keywords WHERE keyword_id = ?)', f.keywordId);
  if (f.keywords?.length) { for (const k of f.keywords) add('p.id IN (SELECT photo_id FROM photo_keywords kw JOIN keywords kk ON kk.id=kw.keyword_id WHERE kk.normalized = ?)', String(k).toLowerCase()); }
  if (f.anyKeywords?.length) {
    add('p.id IN (SELECT photo_id FROM photo_keywords kw JOIN keywords kk ON kk.id=kw.keyword_id WHERE kk.normalized IN (' + f.anyKeywords.map(() => '?').join(',') + '))', ...f.anyKeywords.map(k => String(k).toLowerCase()));
  }
  if (f.excludeKeywords?.length) {
    add('p.id NOT IN (SELECT photo_id FROM photo_keywords kw JOIN keywords kk ON kk.id=kw.keyword_id WHERE kk.normalized IN (' + f.excludeKeywords.map(() => '?').join(',') + '))', ...f.excludeKeywords.map(k => String(k).toLowerCase()));
  }
  if (f.noKeyword) add('p.id NOT IN (SELECT photo_id FROM photo_keywords)');
  if (f.hasKeyword) add('p.id IN (SELECT photo_id FROM photo_keywords)');

  // ---- descriptions légendes ----
  if (f.hasCaption) add(`(p.description IS NOT NULL AND TRIM(p.description) != '')`);
  if (f.noCaption) add(`(p.description IS NULL OR TRIM(p.description) = '')`);

  // ---- prise de vue ----
  if (f.from) add('p.captured_at >= ?', f.from);
  if (f.to) add('p.captured_at <= ?', f.to);
  if (f.year) add('substr(p.captured_at, 1, 4) = ?', String(f.year));

  // ---- appareil / objectif / auteur ----
  if (f.camera) add('(p.camera_model LIKE ? OR p.camera_make LIKE ?)', '%' + f.camera + '%', '%' + f.camera + '%');
  if (f.lens) add('p.lens LIKE ?', '%' + f.lens + '%');
  if (f.author) add('p.author LIKE ?', '%' + f.author + '%');

  // ---- format, dimensions, orientation ----
  if (f.format) add('p.format = ?', f.format);
  if (f.minWidth) add('p.width >= ?', +f.minWidth);
  if (f.maxWidth) add('p.width <= ?', +f.maxWidth);
  if (f.minHeight) add('p.height >= ?', +f.minHeight);
  if (f.maxHeight) add('p.height <= ?', +f.maxHeight);
  if (f.orientation) {
    if (f.orientation === 'portrait') add('p.height > p.width');
    else if (f.orientation === 'landscape') add('p.width > p.height');
    else if (f.orientation === 'square') add('p.width = p.height');
  }

  // ---- appréciations ----
  if (f.rating != null && f.rating !== '') add('p.rating >= ?', +f.rating);
  if (f.color != null && f.color !== '') add('p.color = ?', +f.color);

  // ---- emplacements, supports, disponibilité ----
  if (f.supportId) add('p.id IN (SELECT photo_id FROM files WHERE support_id = ?)', f.supportId);
  if (f.folderId) add('p.id IN (SELECT photo_id FROM files WHERE folder_id = ?)', f.folderId);
  if (f.albumId) add('p.id IN (SELECT photo_id FROM album_photos WHERE album_id = ?)', f.albumId);
  if (f.collectionId) add('p.id IN (SELECT photo_id FROM collection_photos WHERE collection_id = ?)', f.collectionId);
  if (f.missing != null && f.missing !== '') add('p.missing = ?', +f.missing ? 1 : 0);

  // ---- GPS, intégrité, doublons ----
  // hasGps arrive en booléen (critères enregistrés) ou en chaîne d'URL : « 0 » / « false » valent « sans GPS »
  if (f.hasGps != null && f.hasGps !== '') add(![false, 0, '0', 'false'].includes(f.hasGps) ?'(p.gps_lat IS NOT NULL AND p.gps_lon IS NOT NULL)' : '(p.gps_lat IS NULL OR p.gps_lon IS NULL)');
  if (f.integrity) add('p.id IN (SELECT photo_id FROM files WHERE status = ?)', f.integrity);
  if (f.duplicate) add(`p.sha256 IN (SELECT sha256 FROM photos WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1)`);

  return { where: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

/** Tri : liste des tris réellement implémentés (toute autre valeur retombe sur le tri par défaut). */
export const SORTS = {
  captured_desc: 'p.captured_at DESC, p.id',
  captured_asc: 'p.captured_at ASC, p.id',
  added_desc: 'p.imported_at DESC',
  rating_desc: 'p.rating DESC, p.captured_at DESC',
  name_asc: 'p.id ASC',
  size_desc: 'p.width * p.height DESC',
  size_asc: 'p.width * p.height ASC',
  title_asc: 'p.title ASC, p.captured_at DESC',
};

// ---------- Critères enregistrés (recherches sauvegardées des collections) ----------
const TEXT_KEYS = ['q', 'camera', 'lens', 'author', 'format', 'from', 'to', 'year', 'orientation', 'integrity', 'keywordId', 'supportId', 'folderId', 'albumId'];
const NUM_KEYS = ['rating', 'color', 'missing', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'];
const FLAG_KEYS = ['noKeyword', 'hasKeyword', 'hasCaption', 'noCaption', 'duplicate'];
const LIST_KEYS = ['keywords', 'anyKeywords', 'excludeKeywords', 'anyText', 'excludeText'];
export const FILTER_KEYS = [...TEXT_KEYS, ...NUM_KEYS, ...FLAG_KEYS, ...LIST_KEYS, 'hasGps', 'prefix'];

/**
 * Ne garde d'un objet de critères que les clés connues de buildQuery, avec des types propres :
 * c'est ce qui est enregistré dans `collections.query`. `collectionId` est exclu volontairement
 * (une recherche enregistrée ne dépend pas d'une autre collection).
 */
export function cleanFilters(input = {}) {
  const f = {};
  const flag = v => v === true || v === 'true' || v === 1 || v === '1' || v === '';
  for (const k of TEXT_KEYS) if (input[k] != null && String(input[k]).trim() !== '') f[k] = String(input[k]).trim().slice(0, 200);
  for (const k of NUM_KEYS) if (input[k] != null && input[k] !== '' && Number.isFinite(+input[k])) f[k] = +input[k];
  for (const k of FLAG_KEYS) if (flag(input[k])) f[k] = true;
  for (const k of LIST_KEYS) {
    const v = Array.isArray(input[k]) ? input[k] : typeof input[k] === 'string' ? input[k].split(',') : [];
    const list = v.map(s => String(s).trim()).filter(Boolean).slice(0, 50);
    if (list.length) f[k] = list;
  }
  if (input.hasGps != null && input.hasGps !== '') f.hasGps = flag(input.hasGps);
  if (input.prefix === false || input.prefix === 'false') f.prefix = false;
  return f;
}
