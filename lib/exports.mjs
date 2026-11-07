// Export de photos (avec ou sans retouche) vers le dossier Exports : format, taille, qualité,
// métadonnées (toutes, sans GPS, aucune), filigrane, renommage, sous-dossier. Profils intégrés et
// profils enregistrés (table config). Les originaux ne sont jamais modifiés ; un fichier existant n'est
// jamais écrasé (nom unique) ; chaque export est consigné (table exports + historique).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logHistory } from './db.mjs';
import { EXPORT_DIR, HOME, THUMBS_DIR } from './paths.mjs';
import { pipeline, cleanParams } from './edits.mjs';
import { uniqueName } from './imports.mjs';

export const EXPORT_FORMATS = {
  jpeg: { label: 'JPEG', ext: 'jpg', quality: true },
  png: { label: 'PNG (sans perte)', ext: 'png', quality: false },
  tiff: { label: 'TIFF (archive, compression LZW)', ext: 'tif', quality: false },
  webp: { label: 'WebP', ext: 'webp', quality: true },
};
export const METADATA_MODES = { keep: 'Principales, avec GPS', nogps: 'Principales, sans GPS', none: 'Aucune' };
/**
 * Profil de couleur du fichier exporté. Le rendu se fait en sRGB, puis il est converti vers le profil choisi
 * (sharp / LittleCMS). « original » reprend le profil embarqué dans le fichier d'origine (sinon sRGB) ;
 * `file:<nom>` : un fichier .icc / .icm déposé dans le dossier Profils (profil fourni par un laboratoire).
 */
export const COLOR_PROFILES = {
  srgb: 'sRGB (écrans, web, la plupart des laboratoires)',
  p3: 'Display P3 (écrans à gamut étendu)',
  original: 'Profil de l’original (sRGB s’il n’en a pas)',
  cmyk: 'CMJN générique (imprimeur ; JPEG ou TIFF seulement)',
};
export const PROFILES_DIR = path.join(HOME, 'Profils');
/** Profils ICC personnels : fichiers .icc / .icm du dossier Profils. */
export function iccFiles() {
  try { return fs.readdirSync(PROFILES_DIR).filter(n => /\.(icc|icm)$/i.test(n)).sort((a, b) => a.localeCompare(b, 'fr')); } catch { return []; }
}
export const WATERMARK_POSITIONS = { br: 'En bas à droite', bl: 'En bas à gauche', tr: 'En haut à droite', tl: 'En haut à gauche', c: 'Au centre' };

const BASE = { format: 'jpeg', quality: 90, maxSide: null, version: 'default', metadata: 'nogps', colorProfile: 'srgb', watermark: { text: '', position: 'br', opacity: 0.5, size: 3 }, naming: '{nom}', folder: '' };
export const BUILTIN_PROFILES = {
  web: { name: 'Partage (web, messagerie)', ...BASE, quality: 85, maxSide: 2048, metadata: 'nogps' },
  reseaux: { name: 'Réseaux sociaux (filigrane)', ...BASE, quality: 85, maxSide: 1600, metadata: 'none', watermark: { ...BASE.watermark, text: '©' } },
  tirage: { name: 'Tirage photo (pleine définition)', ...BASE, quality: 95, metadata: 'keep' },
  archive: { name: 'Archive (TIFF sans perte)', ...BASE, format: 'tiff', metadata: 'keep' },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? +v : d);
const safeName = s => String(s ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 150);

/** Profil nettoyé (valeurs bornées, inconnues ignorées). */
export function cleanProfile(p = {}) {
  const o = { ...BASE, ...(p && typeof p === 'object' ? p : {}) };
  const wm = { ...BASE.watermark, ...(o.watermark && typeof o.watermark === 'object' ? o.watermark : {}) };
  return {
    name: String(o.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    format: EXPORT_FORMATS[o.format] ? o.format : 'jpeg',
    quality: Math.round(clamp(num(o.quality, 90), 30, 100)),
    maxSide: o.maxSide ? Math.round(clamp(num(o.maxSide, 0), 64, 20000)) || null : null,
    version: o.version === 'original' ? 'original' : 'default',
    metadata: METADATA_MODES[o.metadata] ? o.metadata : 'nogps',
    watermark: { text: String(wm.text ?? '').slice(0, 120), position: WATERMARK_POSITIONS[wm.position] ? wm.position : 'br',
      opacity: clamp(num(wm.opacity, 0.5), 0.1, 1), size: clamp(num(wm.size, 3), 1, 15) },
    naming: String(o.naming ?? '{nom}').slice(0, 120) || '{nom}',
    colorProfile: COLOR_PROFILES[o.colorProfile] || (/^file:[^\\/:*?"<>|]+\.(icc|icm)$/i.test(String(o.colorProfile ?? '')) ) ? o.colorProfile : 'srgb',
    folder: safeName(o.folder),
  };
}

/** Nom de fichier à partir du modèle : {nom} (fichier d'origine), {titre}, {date} (AAAA-MM-JJ), {n} (rang, 3 chiffres). */
export function fileNameFor(pattern, { original, title, captured_at, index }) {
  const base = path.parse(original || 'photo').name;
  const out = String(pattern || '{nom}')
    .replaceAll('{nom}', base).replaceAll('{titre}', title || base)
    .replaceAll('{date}', captured_at ? String(captured_at).slice(0, 10) : 'sans-date')
    .replaceAll('{n}', String(index).padStart(3, '0'));
  return safeName(out) || 'photo';
}

const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** Filigrane : texte blanc semi-transparent avec ombre, en SVG composé sur l'image. */
function watermarkSvg(w, h, wm) {
  const size = Math.max(10, Math.round(Math.min(w, h) * wm.size / 100)), pad = Math.round(size * 0.8);
  const pos = { br: [w - pad, h - pad, 'end'], bl: [pad, h - pad, 'start'], tr: [w - pad, pad + size, 'end'], tl: [pad, pad + size, 'start'], c: [w / 2, h / 2 + size / 3, 'middle'] }[wm.position];
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g font-family="Arial, Helvetica, sans-serif" font-size="${size}" text-anchor="${pos[2]}" opacity="${wm.opacity}">`
    + `<text x="${pos[0] + size / 15}" y="${pos[1] + size / 15}" fill="#000" fill-opacity="0.6">${xml(wm.text)}</text>`
    + `<text x="${pos[0]}" y="${pos[1]}" fill="#fff">${xml(wm.text)}</text></g></svg>`);
}

export function createExports(db, edits) {
  const P = s => { try { return JSON.parse(s); } catch { return null; } };
  const photoRow = db.prepare('SELECT * FROM photos WHERE id = ?');
  const origName = db.prepare(`SELECT file_name, path FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END LIMIT 1`);
  const KEY = 'export.profiles';

  // ---------- profils enregistrés (table config) ----------
  const saved = () => { const r = db.prepare('SELECT data FROM config WHERE key = ?').get(KEY); return P(r?.data) ?? {}; };
  const profiles = () => ({ builtin: Object.fromEntries(Object.entries(BUILTIN_PROFILES).map(([k, v]) => [k, cleanProfile(v)])), saved: saved() });
  function saveProfile(p) {
    const prof = cleanProfile(p); if (!prof.name) throw new Error('Nom de profil vide');
    const all = saved(), id = Object.entries(all).find(([, v]) => v.name === prof.name)?.[0] ?? crypto.randomUUID();
    all[id] = prof;
    db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(KEY, JSON.stringify(all));
    return { id, profile: prof };
  }
  function removeProfile(id) {
    const all = saved(); if (!all[id]) throw new Error('Profil inconnu');
    delete all[id];
    db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(KEY, JSON.stringify(all));
    return { removed: id };
  }

  /**
   * Métadonnées principales réécrites à partir de la fiche (appareil, date, auteur, copyright, titre,
   * et GPS si demandé). L'orientation est déjà appliquée aux pixels : elle n'est pas réécrite.
   */
  function mainExif(ph, withGps) {
    const d = s => (s ? String(s).replace('T', ' ').replace(/-/g, ':').slice(0, 19) : undefined);
    const IFD0 = {}, IFD2 = {};
    if (ph.camera_make) IFD0.Make = ph.camera_make;
    if (ph.camera_model) IFD0.Model = ph.camera_model;
    if (ph.author) IFD0.Artist = ph.author;
    if (ph.copyright) IFD0.Copyright = ph.copyright;
    if (ph.title) IFD0.ImageDescription = ph.title;
    if (ph.captured_at) { IFD0.DateTime = d(ph.captured_at); IFD2.DateTimeOriginal = d(ph.captured_at); }
    IFD0.Software = 'Phototheque';
    const out = { IFD0, IFD2 };
    if (withGps && ph.gps_lat != null && ph.gps_lon != null) {
      const dms = v => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 10000); return `${d}/1 ${m}/1 ${s}/10000`; };
      out.IFD3 = { GPSLatitudeRef: ph.gps_lat >= 0 ? 'N' : 'S', GPSLatitude: dms(ph.gps_lat), GPSLongitudeRef: ph.gps_lon >= 0 ? 'E' : 'W', GPSLongitude: dms(ph.gps_lon) };
      if (ph.gps_alt != null) { out.IFD3.GPSAltitudeRef = ph.gps_alt >= 0 ? '0' : '1'; out.IFD3.GPSAltitude = `${Math.round(Math.abs(ph.gps_alt) * 100)}/100`; }
    }
    return out;
  }

  /** Exporte une photo ; renvoie la fiche du fichier produit. */
  async function exportOne(photoId, prof, dir, index) {
    const ph = photoRow.get(photoId); if (!ph) throw new Error('Photo inconnue');
    const src = edits.sourceOf(photoId); if (!src) throw new Error('Aucun fichier lisible (support absent ?)');
    const ver = prof.version === 'default' ? edits.defaultOf(photoId) : null;
    const params = ver ? ver.params : cleanParams({});
    const { image, width, height } = await pipeline(src.path, params, { maxSide: prof.maxSide });
    let img = image;
    if (prof.watermark.text) {
      // le filigrane se compose sur l'image déjà rendue (taille finale connue)
      const { default: sharp } = await import('sharp');
      const rendered = await img.png().toBuffer();
      img = sharp(rendered).composite([{ input: watermarkSvg(width, height, prof.watermark), top: 0, left: 0 }]);
    }
    if (prof.metadata !== 'none') img = img.withExif(mainExif(ph, prof.metadata === 'keep'));
    const icc = await outputProfile(prof, src.path);
    img = img.withIccProfile(icc.use);
    const f = EXPORT_FORMATS[prof.format];
    img = prof.format === 'jpeg' ? img.jpeg({ quality: prof.quality, mozjpeg: true })
      : prof.format === 'webp' ? img.webp({ quality: prof.quality })
      : prof.format === 'png' ? img.png({ compressionLevel: 9 })
      : img.tiff({ compression: 'lzw' });
    const o = origName.get(photoId);
    const name = uniqueName(dir, fileNameFor(prof.naming, { original: o?.file_name || o?.path, title: ph.title, captured_at: ph.captured_at, index }) + '.' + f.ext);
    const target = path.join(dir, name);
    const info = await img.toFile(target);
    return { photoId, file: target, name, width: info.width, height: info.height, bytes: info.size, source: src.from, version: ver ? ver.name : null, colorProfile: icc.label };
  }

  /** Profil de sortie à passer à sharp (nom intégré ou chemin d'un fichier ICC) et son libellé. */
  async function outputProfile(prof, srcPath) {
    const p = prof.colorProfile;
    if (p === 'cmyk') return ['jpeg', 'tiff'].includes(prof.format) ? { use: 'cmyk', label: 'CMJN générique' } : { use: 'srgb', label: 'sRGB (le CMJN exige JPEG ou TIFF)' };
    if (p === 'p3') return { use: 'p3', label: 'Display P3' };
    if (p?.startsWith('file:')) {
      const file = path.join(PROFILES_DIR, path.basename(p.slice(5)));
      if (!fs.existsSync(file)) throw new Error('Profil ICC introuvable : ' + path.basename(file));
      return { use: file, label: path.basename(file) };
    }
    if (p === 'original') {
      const { default: sharp } = await import('sharp');
      const m = await sharp(srcPath, { failOn: 'none' }).metadata().catch(() => ({}));
      if (m.icc?.length) {
        // le profil embarqué est écrit une fois dans le cache (sharp attend un chemin de fichier)
        const dir = path.join(THUMBS_DIR, 'icc'); fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, crypto.createHash('sha1').update(m.icc).digest('hex') + '.icc');
        if (!fs.existsSync(file)) fs.writeFileSync(file, m.icc);
        return { use: file, label: 'profil de l’original' };
      }
      return { use: 'srgb', label: 'sRGB (l’original n’a pas de profil)' };
    }
    return { use: 'srgb', label: 'sRGB' };
  }

  /**
   * Exporte un lot de photos avec un profil. Destination : Exports/<sous-dossier> (ou Exports/<date-heure>).
   * `onProgress({ done, total, current })`. Renvoie le compte rendu (fichiers, erreurs, dossier).
   */
  async function run(photoIds, profile, { onProgress } = {}) {
    const ids = [...new Set([].concat(photoIds ?? []).filter(x => typeof x === 'string'))];
    if (!ids.length) throw new Error('Aucune photo à exporter');
    if (ids.length > 5000) throw new Error('5000 photos au plus par export');
    const prof = cleanProfile(profile);
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
    const dir = path.join(EXPORT_DIR, prof.folder || `Export ${stamp}`);
    const rel = path.relative(EXPORT_DIR, dir);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Dossier de destination invalide');
    fs.mkdirSync(dir, { recursive: true });
    const report = { dir, profile: prof, total: ids.length, files: [], errors: [], startedAt: new Date().toISOString() };
    for (const [k, id] of ids.entries()) {
      onProgress?.({ done: k, total: ids.length, current: id });
      try { report.files.push(await exportOne(id, prof, dir, k + 1)); }
      catch (e) { report.errors.push({ photoId: id, error: String(e.message || e) }); }
    }
    onProgress?.({ done: ids.length, total: ids.length, current: null });
    report.bytes = report.files.reduce((n, f) => n + f.bytes, 0);
    report.fromPreview = report.files.filter(f => f.source === 'apercu').length;
    report.finishedAt = new Date().toISOString();
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'photos', dir, prof.name || prof.format, report.files.length, report.errors.length ? 'partial' : 'ok', report.startedAt,
        JSON.stringify({ ...report, files: report.files.map(f => ({ photoId: f.photoId, name: f.name, bytes: f.bytes, source: f.source, version: f.version })) }));
    logHistory(db, 'export.photos', `${report.files.length} photo(s) exportée(s) vers ${dir}${report.errors.length ? ` (${report.errors.length} erreur(s))` : ''}`, { dir, count: report.files.length });
    return report;
  }

  return { run, profiles, saveProfile, removeProfile };
}
