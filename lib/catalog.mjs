// Fiche documentaire d'une photo et export CSV (cahier des charges §14) : une seule lecture des
// métadonnées, partagée par les fiches détaillées en PDF (lib/contactsheet.mjs, mise en page « detail »)
// et par l'export CSV d'une sélection ou d'une recherche. Lecture seule.
import { logHistory } from './db.mjs';
import crypto from 'crypto';

const P = s => { try { return JSON.parse(s); } catch { return null; } };

/** « 2022-06-02T10:00:00 » → « 02/06/2022 10:00 ». */
export const fmtDate = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : '';
};
/** Nombre à la française (virgule décimale), sans zéros inutiles. */
const num = (v, d = 2) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? '' : String(+(+v).toFixed(d)).replace('.', ','));
const bytes = n => {
  if (!Number.isFinite(+n) || +n <= 0) return '';
  const u = ['o', 'Ko', 'Mo', 'Go']; let v = +n, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${num(v, i ? 1 : 0)} ${u[i]}`;
};
const STATUS = { available: 'disponible', missing: 'indisponible', error: 'en erreur' };
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Critères de regroupement des catalogues thématiques (cahier des charges §14). */
export const GROUP_BY = { year: 'Année', month: 'Mois', keyword: 'Mot-clé', place: 'Lieu', folder: 'Dossier', support: 'Support', camera: 'Appareil' };

/**
 * Lieu d'une photo : champs IPTC / XMP conservés à l'indexation (Sublocation, City, State, Country),
 * dans `photos.data`. Chaîne vide si aucun n'est renseigné.
 */
export function placeOf(p) {
  const d = typeof p?.data === 'string' ? P(p.data) : p?.data;
  const parts = [];
  for (const k of ['Sublocation', 'City', 'State', 'Country']) {
    let v = d?.[k]; if (Array.isArray(v)) v = v[0];
    if (typeof v === 'string' && v.trim() && !parts.some(x => x.toLowerCase() === v.trim().toLowerCase())) parts.push(v.trim());
  }
  return parts.join(', ');
}

/**
 * Groupes d'une fiche (`record`) pour un critère : [{ key, label, tier }]. Une photo peut appartenir à
 * plusieurs groupes (un par mot-clé). `tier` range les groupes « sans … » après les autres.
 */
export function groupsOf(r, by) {
  const one = (label, none, tier = 0) => [label ? { key: label.toLowerCase(), label, tier } : { key: '￿' + none, label: none, tier: 9 }];
  if (by === 'year') return one(/^\d{4}/.test(r.captured_at ?? '') ? r.captured_at.slice(0, 4) : '', 'Sans date');
  if (by === 'month') {
    const m = /^(\d{4})-(\d{2})/.exec(r.captured_at ?? '');
    return m ? [{ key: `${m[1]}-${m[2]}`, label: `${MONTHS[+m[2] - 1] ?? m[2]} ${m[1]}`, tier: 0 }] : one('', 'Sans date');
  }
  if (by === 'keyword') return r.keywords.length ? [...new Set(r.keywords)].map(k => ({ key: k.toLowerCase(), label: k, tier: 0 })) : one('', 'Sans mot-clé');
  if (by === 'place') {
    const pl = placeOf(r); if (pl) return one(pl);
    // pas de nom de lieu : position GPS arrondie au dixième de degré (une dizaine de kilomètres)
    if (Number.isFinite(r.gps_lat) && Number.isFinite(r.gps_lon)) {
      const label = `Position GPS ${num(r.gps_lat, 1)} ; ${num(r.gps_lon, 1)}`;
      return [{ key: label, label, tier: 1 }];
    }
    return one('', 'Lieu non renseigné');
  }
  if (by === 'folder') return one(r.file?.path ? r.file.path.replace(/[\\/][^\\/]*$/, '') : '', 'Aucun fichier');
  if (by === 'support') return one(r.file?.support ?? '', 'Support inconnu');
  if (by === 'camera') return one(r.camera, 'Appareil inconnu');
  return one('', 'Toutes les photos');
}

/** Ordre des groupes : chronologique pour l'année et le mois, alphabétique (français) sinon ; « sans … » à la fin. */
export function compareGroups(a, b) {
  return a.tier - b.tier || a.key.localeCompare(b.key, 'fr', { numeric: true, sensitivity: 'base' });
}
const KIND = { original: 'original', copy: 'copie', variant: 'variante', derived: 'dérivé' };

/**
 * Colonnes du CSV, dans l'ordre. `get(r)` lit la fiche complète (voir `record`). Les nombres sont écrits
 * avec une virgule décimale et le séparateur est le point-virgule (tableurs réglés en français).
 */
export const CSV_COLUMNS = [
  ['numero', 'N°', r => String(r.n)],
  ['id', 'Identifiant', r => r.id],
  ['fichier', 'Nom du fichier', r => r.file?.file_name ?? ''],
  ['chemin', 'Chemin', r => r.file?.path ?? ''],
  ['support', 'Support', r => r.file?.support ?? ''],
  ['disponibilite', 'Disponibilité', r => STATUS[r.file?.status] ?? r.file?.status ?? ''],
  ['autres_emplacements', 'Autres emplacements', r => r.files.slice(1).map(f => f.path).join(' | ')],
  ['titre', 'Titre', r => r.title ?? ''],
  ['description', 'Description', r => r.description ?? ''],
  ['notes', 'Notes', r => r.notes ?? ''],
  ['date_prise_de_vue', 'Date de prise de vue', r => fmtDate(r.captured_at)],
  ['auteur', 'Auteur', r => r.author ?? ''],
  ['copyright', 'Copyright', r => r.copyright ?? ''],
  ['appareil', 'Appareil', r => r.camera],
  ['objectif', 'Objectif', r => r.lens ?? ''],
  ['focale_mm', 'Focale (mm)', r => num(r.focal_length, 1)],
  ['ouverture', 'Ouverture (f/)', r => num(r.aperture, 1)],
  ['vitesse', 'Vitesse', r => r.shutter ?? ''],
  ['iso', 'ISO', r => num(r.iso, 0)],
  ['largeur', 'Largeur (px)', r => num(r.width, 0)],
  ['hauteur', 'Hauteur (px)', r => num(r.height, 0)],
  ['format', 'Format', r => r.format ?? ''],
  ['taille_octets', 'Taille (octets)', r => num(r.file?.size_bytes, 0)],
  ['note', 'Note (0-5)', r => String(r.rating ?? 0)],
  ['couleur', 'Étiquette de couleur', r => (r.color ? String(r.color) : '')],
  ['mots_cles', 'Mots-clés', r => r.keywords.join(', ')],
  ['lieu', 'Lieu', r => r.place ?? ''],
  ['latitude', 'Latitude', r => num(r.gps_lat, 6)],
  ['longitude', 'Longitude', r => num(r.gps_lon, 6)],
  ['altitude_m', 'Altitude (m)', r => num(r.gps_alt, 1)],
  ['version_retouchee', 'Version retouchée par défaut', r => r.edit ?? ''],
  ['fichiers', 'Nombre de fichiers', r => String(r.files.length)],
  ['sha256', 'Empreinte SHA-256', r => r.sha256 ?? ''],
  ['importee_le', 'Indexée le', r => fmtDate(r.imported_at)],
];

/** Échappe une valeur CSV ; un texte qui commence par = + - @ est préfixé d'une apostrophe (pas de formule). */
export function csvCell(v, numeric = false) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n');
  if (!numeric && /^[=+\-@\t]/.test(s)) s = "'" + s;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const NUMERIC = new Set(['numero', 'focale_mm', 'ouverture', 'iso', 'largeur', 'hauteur', 'taille_octets', 'note', 'couleur', 'latitude', 'longitude', 'altitude_m', 'fichiers']);

export function createCatalog(db) {
  const photoRow = db.prepare('SELECT * FROM photos WHERE id = ?');
  const filesOf = db.prepare(`SELECT f.path, f.file_name, f.size_bytes, f.status, f.kind, f.data, s.name AS support FROM files f LEFT JOIN supports s ON s.id = f.support_id
    WHERE f.photo_id = ? ORDER BY CASE f.kind WHEN 'original' THEN 0 ELSE 1 END, f.indexed_at`);
  const kwOf = db.prepare('SELECT k.name FROM photo_keywords pk JOIN keywords k ON k.id = pk.keyword_id WHERE pk.photo_id = ? ORDER BY k.name COLLATE NOCASE');
  const defaultEdit = db.prepare('SELECT name FROM edits WHERE photo_id = ? AND is_default = 1');

  /** Fiche complète d'une photo (n = son numéro dans le document). `null` si la photo n'existe plus. */
  function record(id, n = 1) {
    const p = photoRow.get(id); if (!p) return null;
    const files = filesOf.all(id);
    let keywords = kwOf.all(id).map(k => k.name);
    if (!keywords.length) keywords = String(p.keywords_text ?? '').split(/\s*\|\s*/).filter(Boolean);
    return { ...p, n, files, file: files[0] ?? null, keywords, camera: [p.camera_make, p.camera_model].filter(Boolean).join(' '), place: placeOf(p), edit: defaultEdit.get(id)?.name ?? null };
  }

  /**
   * Lignes « libellé / valeur » d'une fiche détaillée, dans l'ordre d'affichage ; les valeurs vides sont
   * omises (sauf la date, signalée « sans date »).
   */
  function detailLines(r) {
    const exp = [r.focal_length ? `${num(r.focal_length, 1)} mm` : '', r.aperture ? `f/${num(r.aperture, 1)}` : '', r.shutter ? `${r.shutter} s` : '', r.iso ? `ISO ${r.iso}` : ''].filter(Boolean).join(' · ');
    const gps = Number.isFinite(r.gps_lat) && Number.isFinite(r.gps_lon) ? `${num(r.gps_lat, 6)} ; ${num(r.gps_lon, 6)}${Number.isFinite(r.gps_alt) ? ` · ${num(r.gps_alt, 0)} m` : ''}` : '';
    const lines = [
      ['Titre', r.title], ['Description', r.description], ['Date de prise de vue', fmtDate(r.captured_at) || 'sans date'],
      ['Auteur', r.author], ['Copyright', r.copyright], ['Mots-clés', r.keywords.join(', ')],
      ['Note', r.rating ? `${r.rating} / 5` : ''], ['Étiquette', r.color ? `couleur ${r.color}` : ''],
      ['Appareil', r.camera], ['Objectif', r.lens], ['Exposition', exp],
      ['Dimensions', r.width && r.height ? `${r.width} × ${r.height} px${r.format ? ` · ${String(r.format).toUpperCase()}` : ''}` : (r.format ?? '')],
      ['Lieu', r.place], ['Coordonnées GPS', gps], ['Version retouchée', r.edit ? `${r.edit} (par défaut)` : ''], ['Notes', r.notes],
    ];
    r.files.forEach((f, i) => lines.push([i ? `Emplacement ${i + 1}` : 'Emplacement', `${f.path}${f.support ? ` — ${f.support}` : ''} (${[KIND[f.kind] ?? f.kind, STATUS[f.status] ?? f.status, bytes(f.size_bytes)].filter(Boolean).join(', ')})`]));
    if (!r.files.length) lines.push(['Emplacement', 'aucun fichier connu']);
    lines.push(['Empreinte SHA-256', r.sha256], ['Indexée le', fmtDate(r.imported_at)], ['Identifiant', r.id]);
    return lines.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([label, value]) => ({ label, value: String(value) }));
  }

  /** CSV (UTF-8 avec BOM, « ; », fins de ligne CRLF) des photos `ids`, dans cet ordre. */
  function csv(ids, { label = '' } = {}) {
    const list = [...new Set([].concat(ids ?? []).filter(x => typeof x === 'string'))];
    const rows = [CSV_COLUMNS.map(c => csvCell(c[1])).join(';')];
    let n = 0;
    for (const id of list) {
      const r = record(id, n + 1); if (!r) continue;
      n++; rows.push(CSV_COLUMNS.map(([k, , get]) => csvCell(get(r), NUMERIC.has(k))).join(';'));
    }
    if (!n) throw new Error('Aucune photo à exporter');
    const text = '﻿' + rows.join('\r\n') + '\r\n';
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'catalog-csv', label || 'Catalogue', 'csv', n, 'ok', new Date().toISOString(), JSON.stringify({ columns: CSV_COLUMNS.length }));
    logHistory(db, 'catalog.csv', `Catalogue CSV exporté (${n} photo(s))`, { photos: n });
    return { text, photos: n, columns: CSV_COLUMNS.length };
  }

  return { record, detailLines, csv };
}
