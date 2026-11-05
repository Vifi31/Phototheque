// Moteur de la photothèque : scan, indexation sans copie, métadonnées, vignettes, recherche, stats.
//
// Principe fondamental : l'indexation ne copie ni ne modifie jamais les originaux. Elle lit les
// fichiers, extrait les métadonnées (exifr), génère des vignettes en cache (sharp) dans data/thumbs,
// et enregistre le tout en base. Un support absent rend la photo « indisponible », jamais « supprimée ».
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { dhash } from './duplicates.mjs';
import exifr from 'exifr';
import { tx, logHistory } from './db.mjs';
import * as Search from './search.mjs';
import { syncPhotoKeywordsText } from './keywords.mjs';
import { THUMBS_DIR, DATA_DIR } from './paths.mjs';

// ---- Extensions image reconnues (minuscules, sans le point) ----
export const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'tif', 'tiff', 'webp', 'bmp', 'heic', 'heif', 'avif',
  // formats bruts courants (métadonnées lisibles, vignette via exifr ou sharp si supporté)
  'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng', 'raf', 'pef', 'srw', 'raw',
]);
const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng', 'raf', 'pef', 'srw', 'raw']);
export const isImage = f => IMAGE_EXTS.has(path.extname(f).slice(1).toLowerCase());

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const J = v => JSON.stringify(v ?? {});
const P = s => { try { return JSON.parse(s); } catch { return {}; } };

const sha256 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

/** Normalise une date EXIF (souvent "2024:05:12 10:30:00") en ISO. */
function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
    const dt = new Date(+y, +mo - 1, +d, +h, +mi, +se);
    return isNaN(dt) ? null : dt.toISOString();
  }
  const dt = new Date(s); return isNaN(dt) ? null : dt.toISOString();
}

/** Emplacement d'une vignette en cache (chemin relatif à data/thumbs), déterministe par empreinte. */
const thumbRel = (key, size, ext = 'jpg') => path.join('by', key.slice(0, 2), `${key}_${size}.${ext}`).replace(/\\/g, '/');
const thumbAbs = rel => path.join(THUMBS_DIR, rel);

/** Liste récursive des fichiers image sous une racine. */
export function walkImages(root, { followSymlinks = false, onFile } = {}) {
  const out = [];
  const rec = dir => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try { const st = fs.statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
      }
      if (isDir) rec(full);
      else if (isFile && isImage(e.name)) { out.push(full); onFile?.(full); }
    }
  };
  rec(root);
  return out;
}

export function createLibrary(db, store, supports, keywords) {
  const cfg = () => store.scan ?? {};

  // ---------- Extraction métadonnées ----------
  /** Lit les métadonnées d'un fichier : dimensions, orientation, EXIF/IPTC/XMP. Ne l'altère pas. */
  async function readMeta(file) {
    const out = { format: null, width: null, height: null, orientation: null, captured_at: null, camera_make: null, camera_model: null, lens: null, focal_length: null, aperture: null, shutter: null, iso: null, gps_lat: null, gps_lon: null, gps_alt: null, author: null, copyright: null, raw: {} };
    const ext = path.extname(file).slice(1).toLowerCase();
    // 1) dimensions + orientation via sharp (fiable pour les formats non RAW)
    if (!RAW_EXTS.has(ext)) {
      try {
        const m = await sharp(file, { limitInputPixels: 1024 * 1024 * 512 }).metadata();
        out.format = m.format ?? ext; out.width = m.width ?? null; out.height = m.height ?? null; out.orientation = m.orientation ?? null;
      } catch { out.format = ext; }
    } else out.format = ext;
    // 2) métadonnées riches via exifr (EXIF/IPTC/XMP/GPS)
    try {
      const t = await exifr.parse(file, { tiff: true, ifd0: true, exif: true, gps: true, iptc: true, xmp: true, translateKeys: true, translateValues: true, reviveValues: true, mergeOutput: true });
      if (t) {
        out.captured_at = toIso(t.DateTimeOriginal ?? t.CreateDate ?? t.ModifyDate);
        out.camera_make = t.Make ?? t.manufacturer ?? null;
        out.camera_model = t.Model ?? null;
        out.lens = t.LensModel ?? t.Lens ?? null;
        out.focal_length = num(t.FocalLength); out.aperture = num(t.FNumber ?? t.ApertureValue);
        out.shutter = shutterStr(t.ExposureTime); out.iso = num(t.ISO ?? t.ISOSpeedRatings ?? t.PhotographicSensitivity);
        const g = t.GPSLatitude != null ? dmsToDec(t.GPSLatitude, t.GPSLatitudeRef) : num(t.latitude);
        const gg = t.GPSLongitude != null ? dmsToDec(t.GPSLongitude, t.GPSLongitudeRef) : num(t.longitude);
        if (g != null) out.gps_lat = g; if (gg != null) out.gps_lon = gg;
        out.gps_alt = num(t.GPSAltitude);
        out.author = t.Artist ?? t.creator ?? null; out.copyright = t.Copyright ?? t.rights ?? null;
        // conserve les champs non exposés en colonnes
        out.raw = pick(t, ['ImageDescription', 'Artist', 'Copyright', 'Software', 'UserComment', 'XPTitle', 'XPComment', 'Keywords', 'Subject', 'City', 'Country', 'State', 'Sublocation', 'Rating', 'Label', 'ColorSpace', 'ExposureMode', 'MeteringMode', 'WhiteBalance', 'Flash', 'LightSource']);
      }
    } catch { /* fichier sans métadonnées exploitables */ }
    if (!out.width || !out.height) { try { const m = await sharp(file).metadata(); out.width = m.width; out.height = m.height; } catch { /* brut illisible */ } }
    if (!out.captured_at) { try { out.captured_at = toIso(fs.statSync(file).mtime); } catch { /* ignoré */ } }
    return out;
  }
  const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; };
  const shutterStr = v => { if (v == null) return null; const n = num(v); if (n == null) return String(v); return n >= 1 ? n.toFixed(1) + ' s' : '1/' + Math.round(1 / n) + ' s'; };
  const dmsToDec = (dms, ref) => {
    if (!Array.isArray(dms)) return num(dms);
    const [d, m = 0, s = 0] = dms.map(num); let dec = d + m / 60 + s / 3600;
    if (typeof ref === 'string' && /s|w/i.test(ref)) dec = -dec;
    return dec;
  };
  const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] != null) r[k] = o[k] instanceof Date ? o[k].toISOString() : o[k]; return r; };

  // ---------- Vignettes ----------
  /** Génère (en cache) une vignette et un aperçu pour un fichier. Renvoie les chemins relatifs. */
  async function makeThumbs(file, key) {
    const s = cfg(); const results = {};
    for (const [label, size] of [['thumb', s.thumbSize ?? 320], ['preview', s.previewSize ?? 1600]]) {
      const rel = thumbRel(key, size); const abs = thumbAbs(rel);
      if (fs.existsSync(abs)) { results[label] = rel; continue; }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const img = sharp(file, { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' });
        await img.rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: label === 'thumb' ? 80 : 90, mozjpeg: true }).toFile(abs);
        results[label] = rel;
      } catch (e) {
        // tentative via exifr (extraction de vignette intégrée pour certains RAW)
        try {
          const t = await exifr.thumbnail(file);
          if (t) { fs.writeFileSync(abs, Buffer.from(await t.arrayBuffer?.() ?? t)); results[label] = rel; }
        } catch { /* vignette impossible */ }
      }
    }
    return results;
  }

  // ---------- Indexation sans copie ----------
  /** Indexe un dossier. `opts.onProgress` reçoit { done, total, current }. Ne copie rien. */
  async function indexFolder(folderId, opts = {}) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    if (!folder) throw new Error('Dossier inconnu');
    const root = folder.path;
    if (!fs.existsSync(root)) throw new Error('Chemin introuvable : ' + root);
    const files = walkImages(root, { followSymlinks: cfg().followSymlinks });
    let done = 0, added = 0, updated = 0, skipped = 0, errors = 0;
    const supportId = folder.support_id;
    for (const file of files) {
      try {
        const r = await indexFile(file, { folderId, supportId });
        if (r === 'added') added++; else if (r === 'updated') updated++; else skipped++;
      } catch (e) { errors++; opts.onError?.(file, e); }
      done++; opts.onProgress?.({ done, total: files.length, current: file });
    }
    const count = db.prepare('SELECT COUNT(*) n FROM files WHERE folder_id = ?').get(folderId).n;
    db.prepare('UPDATE folders SET photo_count = ?, indexed_at = ?, status = ? WHERE id = ?').run(count, now(), 'ok', folderId);
    recountMissing();
    logHistory(db, 'index.folder', `Dossier indexé : ${root}`, { added, updated, skipped, errors, total: files.length });
    return { total: files.length, added, updated, skipped, errors, photoCount: count };
  }

  /** Indexe un fichier unique (sans copie). Déduplique par chemin puis par empreinte. */
  async function indexFile(file, { folderId, supportId } = {}) {
    const st = fs.statSync(file);
    const relPath = folderId ? path.relative(db.prepare('SELECT path FROM folders WHERE id=?').get(folderId).path, file) : file;
    const existing = db.prepare('SELECT * FROM files WHERE path = ?').get(file);
    if (existing && existing.status === 'available' && +existing.size_bytes === st.size && sameTime(existing.indexed_at, st.mtime)) return 'skipped';
    const hash = cfg().hash !== false ? await sha256(file) : null;
    const meta = await readMeta(file);
    // doublon par empreinte (même contenu, autre chemin) : on crée un second "file" sur la même photo
    let photoId;
    const dupOf = hash ? db.prepare('SELECT photo_id FROM files WHERE sha256 = ? AND kind = ? LIMIT 1').get(hash, 'original') : null;
    if (dupOf) photoId = dupOf.photo_id;
    else {
      photoId = uid();
      db.prepare(`INSERT INTO photos(id,captured_at,modified_at,imported_at,title,description,notes,rating,color,width,height,orientation,format,camera_make,camera_model,lens,focal_length,aperture,shutter,iso,gps_lat,gps_lon,gps_alt,author,copyright,keywords_text,sha256,perceptual_hash,missing,data)
        VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`)
        .run(photoId, meta.captured_at, toIso(st.mtime), now(), null, null, null, 0,
          meta.width, meta.height, meta.orientation, meta.format, meta.camera_make, meta.camera_model, meta.lens,
          meta.focal_length, meta.aperture, meta.shutter, meta.iso, meta.gps_lat, meta.gps_lon, meta.gps_alt,
          meta.author, meta.copyright, '', hash, null, J(meta.raw));
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const key = hash ?? crypto.createHash('sha1').update(file + ':' + st.size).digest('hex');
    let thumbs = {};
    if (cfg().thumb !== false) thumbs = await makeThumbs(file, key);
    // empreinte visuelle (photos similaires, lib/duplicates.mjs), calculée sur la vignette
    if (!dupOf && thumbs.thumb) { try { db.prepare('UPDATE photos SET perceptual_hash = ? WHERE id = ?').run(await dhash(thumbAbs(thumbs.thumb)), photoId); } catch { /* vignette illisible : calcul différé */ } }
    if (existing) {
      db.prepare('UPDATE files SET photo_id=?, folder_id=?, support_id=?, rel_path=?, file_name=?, extension=?, size_bytes=?, sha256=?, status=?, indexed_at=? WHERE id=?')
        .run(photoId, folderId ?? existing.folder_id, supportId ?? existing.support_id, relPath, path.basename(file), ext, st.size, hash, 'available', now(), existing.id);
      updatedFlags(photoId);
      return 'updated';
    }
    db.prepare(`INSERT INTO files(id,photo_id,folder_id,support_id,path,rel_path,file_name,extension,size_bytes,sha256,kind,status,indexed_at,data)
      VALUES(?,?,?,?,?,?,?,?,?,?, 'original','available',?,?)`)
      .run(uid(), photoId, folderId ?? null, supportId ?? null, file, relPath, path.basename(file), ext, st.size, hash, now(), J({ thumbs }));
    updatedFlags(photoId);
    return 'added';
  }
  const sameTime = (indexedAt, mtime) => Math.abs(new Date(indexedAt) - mtime) < 2000;

  /** Recalcule le drapeau "missing" d'une photo selon la disponibilité de ses fichiers + supports. */
  function updatedFlags(photoId) {
    const rows = db.prepare(`SELECT f.status, s.status sstatus FROM files f LEFT JOIN supports s ON s.id = f.support_id WHERE f.photo_id = ?`).all(photoId);
    const missing = rows.some(r => r.status !== 'available' || (r.sstatus && r.sstatus !== 'available')) ? 1 : 0;
    db.prepare('UPDATE photos SET missing = ? WHERE id = ?').run(missing, photoId);
  }
  /** Recalcule "missing" pour toutes les photos (après un rafraîchissement des supports). */
  function recountMissing() {
    db.exec(`UPDATE photos SET missing = 1 WHERE id IN (
      SELECT f.photo_id FROM files f LEFT JOIN supports s ON s.id = f.support_id
      WHERE f.status != 'available' OR (s.id IS NOT NULL AND s.status != 'available'))`);
    db.exec(`UPDATE photos SET missing = 0 WHERE id NOT IN (
      SELECT f.photo_id FROM files f LEFT JOIN supports s ON s.id = f.support_id
      WHERE f.status != 'available' OR (s.id IS NOT NULL AND s.status != 'available'))`);
  }

  // ---------- Recherche ----------
  // Le moteur (FTS5 + critères avancés) vit dans lib/search.mjs ; ce module ne fait que l'appeler.
  // Alias `Search` car la fonction locale `search` porte le même nom que le module.
  // `HAS_FTS` est calculé une seule fois à l'ouverture (les données de compilation ne changent pas).
  const HAS_FTS = Search.searchEngine(db).fts5;
  const buildQuery = f => Search.buildQuery(f, { fts: HAS_FTS });

  /** Liste paginée des photos selon filtres. */
  function search(f = {}, { limit = 60, offset = 0, sort = 'captured_desc' } = {}) {
    const { where, params } = buildQuery(f);
    const ORDER = Search.SORTS[sort] ?? Search.SORTS.captured_desc;
    const lim = Math.min(300, Math.max(1, +limit || 60)), off = Math.max(0, +offset || 0);
    const total = db.prepare('SELECT COUNT(*) n FROM photos p' + where).get(...params).n;
    const rows = db.prepare(`SELECT p.*, (SELECT path FROM files WHERE photo_id = p.id AND kind='original' LIMIT 1) path,
      (SELECT data FROM files WHERE photo_id = p.id AND kind='original' LIMIT 1) fdata,
      (SELECT support_id FROM files WHERE photo_id = p.id AND kind='original' LIMIT 1) support_id,
      (SELECT COUNT(*) FROM edits WHERE photo_id = p.id) edit_count
      FROM photos p${where} ORDER BY ${ORDER} LIMIT ? OFFSET ?`).all(...params, lim, off);
    return { total, offset: off, limit: lim, rows: rows.map(cardView) };
  }

  /** Vue « carte » d'une photo (liste + vignette). */
  function cardView(r) {
    const fd = P(r.fdata) || {};
    return {
      id: r.id, title: r.title, captured_at: r.captured_at, modified_at: r.modified_at, imported_at: r.imported_at,
      width: r.width, height: r.height, format: r.format, camera_make: r.camera_make, camera_model: r.camera_model,
      rating: r.rating, color: r.color, missing: !!r.missing, hasGps: r.gps_lat != null && r.gps_lon != null,
      keywords_text: r.keywords_text, path: r.path, support_id: r.support_id, edits: r.edit_count ?? 0,
      thumb: fd.thumbs?.thumb ? '/api/thumb/' + encodeURIComponent(fd.thumbs.thumb) : null,
      preview: fd.thumbs?.preview ? '/api/thumb/' + encodeURIComponent(fd.thumbs.preview) : null,
    };
  }

  /** Fiche complète d'une photo (métadonnées, mots-clés, fichiers). */
  function detail(id) {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(id); if (!p) return null;
    const files = db.prepare('SELECT * FROM files WHERE photo_id = ? ORDER BY kind').all(id).map(f => ({ ...f, data: P(f.data) }));
    const kws = keywords ? keywords.ofPhoto(id) : [];
    return { ...p, data: P(p.data), files, keywords: kws };
  }

  /** Liste des années présentes (navigation). */
  function years() {
    return db.prepare(`SELECT substr(captured_at,1,4) y, COUNT(*) n FROM photos WHERE captured_at IS NOT NULL GROUP BY y ORDER BY y DESC`).all();
  }
  /** Appareils présents. */
  function cameras() {
    return db.prepare(`SELECT camera_make, camera_model, COUNT(*) n FROM photos WHERE camera_model IS NOT NULL GROUP BY camera_make, camera_model ORDER BY n DESC`).all();
  }
  /** Formats présents. */
  function formats() {
    return db.prepare(`SELECT format, COUNT(*) n FROM photos GROUP BY format ORDER BY n DESC`).all();
  }

  // ---------- Modification d'une fiche ----------
  function update(id, fields) {
    const allowed = ['title', 'description', 'notes', 'rating', 'color', 'author', 'copyright', 'captured_at'];
    const sets = [], params = [];
    for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(k === 'rating' || k === 'color' ? +fields[k] : fields[k]); }
    if (!sets.length) return detail(id);
    db.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    logHistory(db, 'photo.update', `Photo ${id} mise à jour`, { fields: Object.keys(fields) });
    return detail(id);
  }
  /** Synchronise keywords_text (recherche plein texte) depuis photo_keywords. */
  const syncKeywordsText = id => syncPhotoKeywordsText(db, id);

  // ---------- Suppression (uniquement de l'index, jamais des originaux) ----------
  /** Retire des photos de l'index. Les fichiers sources ne sont JAMAIS supprimés. */
  function removeFromIndex(ids) {
    let n = 0;
    tx(db, () => {
      for (const id of [].concat(ids)) {
        db.prepare('DELETE FROM photo_keywords WHERE photo_id = ?').run(id);
        db.prepare('DELETE FROM files WHERE photo_id = ?').run(id);
        db.prepare('DELETE FROM photos WHERE id = ?').run(id);
        n++;
      }
    });
    logHistory(db, 'photo.removeIndex', `${n} photo(s) retirée(s) de l'index (originaux intacts)`, { count: n });
    return { removed: n, originalsUntouched: true };
  }

  // ---------- Statistiques ----------
  function stats() {
    const photos = db.prepare('SELECT COUNT(*) n FROM photos').get().n;
    const files = db.prepare('SELECT COUNT(*) n FROM files').get().n;
    const bytes = db.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM files').get().n;
    const missing = db.prepare('SELECT COUNT(*) n FROM photos WHERE missing = 1').get().n;
    const gps = db.prepare('SELECT COUNT(*) n FROM photos WHERE gps_lat IS NOT NULL').get().n;
    const rated = db.prepare('SELECT COUNT(*) n FROM photos WHERE rating > 0').get().n;
    return { photos, files, bytes, missing, gps, rated, supports: supports?.stats?.() ?? {}, keywords: db.prepare('SELECT COUNT(*) n FROM keywords').get().n, albums: db.prepare('SELECT COUNT(*) n FROM albums').get().n };
  }

  return { walkImages, readMeta, indexFolder, indexFile, search, detail, years, cameras, formats, update, syncKeywordsText, removeFromIndex, stats, recountMissing, cardView, thumbAbs };
}
