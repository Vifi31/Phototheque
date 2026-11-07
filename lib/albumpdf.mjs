// Export d'impression d'un album : PDF (une page PDF par page d'album, au format exact, option fonds
// perdus) ou images JPEG (une par page ou par planche, même dessin, lib/raster.mjs). Photos recadrées
// « couvrir » et centrées comme dans l'éditeur, rééchantillonnées à la résolution de sortie (jamais
// agrandies au-delà de leur résolution réelle), bordures, textes en Helvetica.
// Les originaux sont lus en lecture seule ; s'ils sont indisponibles on prend une copie connue, puis
// l'aperçu en cache (signalé dans le compte rendu).
// « Dossier prêt à envoyer » : fichiers d'impression + fiche LISEZ-MOI + projet, selon un profil de
// prestataire (spécifications saisies par l'utilisateur, ou profils génériques). Aucun envoi.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LAYOUTS, cropWindow, SAFETY_MARGIN, cleanStyle } from './albums.mjs';
import { PdfWriter, PageContent, MM, wrapText, textColorOn } from './pdf.mjs';
import { RasterCanvas } from './raster.mjs';
import { logHistory } from './db.mjs';
import { pipeline } from './edits.mjs';
import { EXPORT_DIR } from './paths.mjs';
import { PROFILES_DIR } from './exports.mjs';

/** Profils de sortie : impression (300 ppp) ou écran / aperçu (150 ppp, cadres vides visibles). */
export const PDF_PROFILES = {
  print: { label: 'Impression (300 ppp)', dpi: 300, jpeg: 90, placeholders: false },
  screen: { label: 'Écran / aperçu (150 ppp)', dpi: 150, jpeg: 80, placeholders: true },
};
export const BLEED_MM = 3;
const MAX_PX = 12000;
const P = s => { try { return JSON.parse(s); } catch { return null; } };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? +v : d);
const mix = (c1, c2, t) => { const p = h => [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16)); const a = p(c1), b = p(c2); return '#' + a.map((v, i) => Math.round(v * (1 - t) + b[i] * t).toString(16).padStart(2, '0')).join(''); };
const safeName = s => String(s ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || 'album';

// ---------- Profils de prestataire (livres photo) ----------
// Les profils intégrés sont GÉNÉRIQUES (pratiques courantes : 300 ppp, 3 mm de fonds perdus, sRGB) : ils ne
// reprennent les spécifications d'aucun prestataire. Pour un prestataire donné, l'utilisateur crée un profil
// à partir de sa documentation (format, fonds perdus, zone de sécurité, nombre de pages, type de fichier).
export const SERVICE_OUTPUTS = { pdf: 'PDF unique', jpeg: 'Un fichier JPEG par page' };
export const SERVICE_LAYOUTS = { pages: 'Page par page', spreads: 'Par planche (doubles pages en un fichier)' };
const SERVICE_BASE = { name: '', output: 'pdf', layout: 'pages', dpi: 300, bleed_mm: 3, jpegQuality: 92, colorProfile: 'srgb', width_mm: null, height_mm: null, safety_mm: 0, minPages: null, maxPages: null, pageMultiple: null, notes: '' };
export const BUILTIN_SERVICES = {
  'generique-pdf': { ...SERVICE_BASE, name: 'Générique — PDF page par page, 300 ppp, fonds perdus 3 mm' },
  'generique-jpeg': { ...SERVICE_BASE, name: 'Générique — JPEG par page, 300 ppp, fonds perdus 3 mm', output: 'jpeg' },
  'generique-planches': { ...SERVICE_BASE, name: 'Générique — JPEG par planche, 300 ppp, fonds perdus 3 mm', output: 'jpeg', layout: 'spreads' },
};
export function cleanService(s = {}) {
  const o = { ...SERVICE_BASE, ...(s && typeof s === 'object' ? s : {}) };
  const opt = (v, a, b) => { const x = num(v, null); return x === null || x <= 0 ? null : Math.round(clamp(x, a, b)); };
  const output = SERVICE_OUTPUTS[o.output] ? o.output : 'pdf';
  const w = opt(o.width_mm, 50, 1000), h = opt(o.height_mm, 50, 1000);
  return {
    name: String(o.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
    output, layout: SERVICE_LAYOUTS[o.layout] ? o.layout : 'pages',
    dpi: Math.round(clamp(num(o.dpi, 300), 100, 600)),
    bleed_mm: Math.round(clamp(num(o.bleed_mm, 3), 0, 10) * 10) / 10,
    jpegQuality: Math.round(clamp(num(o.jpegQuality, 92), 60, 100)),
    // profil ICC : sRGB, ou un fichier du dossier Profils (images JPEG seulement ; le PDF reste en sRGB)
    colorProfile: output === 'jpeg' && /^file:[^\\/:*?"<>|]+\.(icc|icm)$/i.test(String(o.colorProfile ?? '')) ? o.colorProfile : 'srgb',
    width_mm: w && h ? w : null, height_mm: w && h ? h : null,
    safety_mm: Math.round(clamp(num(o.safety_mm, 0), 0, 30) * 10) / 10,
    minPages: opt(o.minPages, 1, 1000), maxPages: opt(o.maxPages, 1, 1000), pageMultiple: opt(o.pageMultiple, 1, 16),
    notes: String(o.notes ?? '').slice(0, 1000),
  };
}

/**
 * Contrôles propres au prestataire : format, nombre de pages, zone de sécurité, profil ICC.
 * `a` : album tel que renvoyé par albums.get. Chaque alerte : { level: 'bad' | 'warn', message }.
 */
export function checkService(a, svc) {
  const fr = v => String(v).replace('.', ',');
  const out = [], W = a.width_mm, H = a.height_mm, n = a.printedPages;
  if (svc.width_mm && svc.height_mm && (Math.abs(svc.width_mm - W) > 0.5 || Math.abs(svc.height_mm - H) > 0.5))
    out.push({ level: 'bad', message: `Format de l'album ${W} × ${H} mm, le profil attend ${svc.width_mm} × ${svc.height_mm} mm (Propriétés de l'album)` });
  if (svc.minPages && n < svc.minPages) out.push({ level: 'bad', message: `${n} page(s) : le profil en demande au moins ${svc.minPages} (ajoutez-en ${svc.minPages - n})` });
  if (svc.maxPages && n > svc.maxPages) out.push({ level: 'bad', message: `${n} pages : le profil en accepte au plus ${svc.maxPages} (retirez-en ${n - svc.maxPages})` });
  if (svc.pageMultiple && n % svc.pageMultiple) out.push({ level: 'warn', message: `${n} page(s) : le profil demande un multiple de ${svc.pageMultiple} (ajoutez-en ${svc.pageMultiple - (n % svc.pageMultiple)})` });
  if (svc.safety_mm) {
    // distances au bord (mm) des éléments posés par les gabarits : cadres à marges, légende, numéro de page
    const frames = Math.round(SAFETY_MARGIN * Math.min(W, H) * 10) / 10, caption = Math.round(0.03 * H * 10) / 10;
    const folio = Math.round(Math.min(0.016 * H, 0.022 * W) * 10) / 10;
    const pages = a.pages, inner = pages.some(p => !LAYOUTS[p.layout]?.fullBleed && LAYOUTS[p.layout]?.frames.length);
    if (inner && frames < svc.safety_mm) out.push({ level: 'warn', message: `Les photos des gabarits à marges sont à ${fr(frames)} mm du bord, en deçà de la zone de sécurité du profil (${fr(svc.safety_mm)} mm) : elles risquent d'être rognées` });
    if (pages.some(p => p.caption && !LAYOUTS[p.layout]?.fullBleed) && caption < svc.safety_mm) out.push({ level: 'warn', message: `Les légendes sont à ${fr(caption)} mm du bas de page, en deçà de la zone de sécurité (${fr(svc.safety_mm)} mm)` });
    if (pages.some(p => !LAYOUTS[p.layout]?.fullBleed) && folio < svc.safety_mm) out.push({ level: 'warn', message: `Les numéros de page sont à environ ${fr(folio)} mm du bord, en deçà de la zone de sécurité (${fr(svc.safety_mm)} mm)` });
    if (pages.some(p => LAYOUTS[p.layout]?.fullBleed)) out.push({ level: 'info', message: `Pages à fond perdu : les ${fr(svc.safety_mm)} mm du bord de la photo peuvent disparaître à la coupe` });
  }
  if (svc.colorProfile.startsWith('file:') && !fs.existsSync(path.join(PROFILES_DIR, path.basename(svc.colorProfile.slice(5)))))
    out.push({ level: 'bad', message: `Profil ICC introuvable dans le dossier Profils : ${svc.colorProfile.slice(5)}` });
  return out;
}

export function createAlbumPdf(db, library, albums) {
  const filesOf = db.prepare(`SELECT path, kind, data FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, indexed_at`);

  /** Sources lisibles d'une photo, dans l'ordre de préférence : original, autres fichiers, aperçu en cache. */
  function sourcesOf(photoId) {
    const out = [], files = filesOf.all(photoId);
    // le premier fichier est l'original de référence ; un autre fichier de même empreinte est une copie
    files.forEach((f, k) => { if (f.path && fs.existsSync(f.path)) out.push({ path: f.path, from: k === 0 ? 'original' : 'copie' }); });
    for (const f of files) {
      const rel = P(f.data)?.thumbs?.preview;
      if (rel) { const abs = library.thumbAbs(rel); if (fs.existsSync(abs)) { out.push({ path: abs, from: 'apercu' }); break; } }
    }
    return out;
  }

  /**
   * Découpe la partie visible (recadrage manuel, sinon « couvrir » centré) et la rééchantillonne
   * pour un cadre de pw × ph pixels.
   */
  async function renderImage(src, pw, ph, jpeg, crop, edit = null) {
    const { default: sharp } = await import('sharp');
    const opts = { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' };
    let input = src, inOpts = opts, iw, ih, orient = img => img.rotate();
    if (edit) {
      // version retouchée : rendue d'abord en pleine définition (lib/edits.mjs), puis cadrée comme une image ordinaire
      const r = await pipeline(src, edit);
      const { data, info } = await r.image.raw().toBuffer({ resolveWithObject: true });
      input = data; inOpts = { raw: { width: info.width, height: info.height, channels: info.channels } };
      iw = info.width; ih = info.height; orient = img => img;
    } else {
      const meta = await sharp(src, opts).metadata();
      iw = meta.width; ih = meta.height; if ((meta.orientation ?? 1) >= 5) [iw, ih] = [ih, iw];
    }
    if (!iw || !ih) throw new Error('Dimensions illisibles');
    const win = cropWindow(iw, ih, pw, ph, crop);
    const left = Math.min(iw - 1, Math.max(0, Math.round(win.left * iw))), top = Math.min(ih - 1, Math.max(0, Math.round(win.top * ih)));
    const rw = Math.max(1, Math.min(iw - left, Math.round(win.width * iw))), rh = Math.max(1, Math.min(ih - top, Math.round(win.height * ih)));
    const up = Math.max(pw / rw, ph / rh); // > 1 : la partie visible a moins de pixels que le cadre à la résolution visée
    const tw = Math.max(1, Math.round(up > 1 ? pw / up : pw)), th = Math.max(1, Math.round(up > 1 ? ph / up : ph));
    const { data, info } = await orient(sharp(input, inOpts)).extract({ left, top, width: rw, height: rh }).resize(tw, th, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: jpeg }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  }

  /**
   * Produit les fichiers d'impression d'un album.
   * - `output` 'pdf' : `write(buffer)` reçoit le PDF au fil de l'eau ;
   *   `output` 'jpeg' : une image par page PDF équivalente, écrite dans `dir` (page-001.jpg ou planche-01.jpg).
   * - `layout` : 'pages' (une page par page imprimée, pour l'imprimeur) ou 'spreads' (planches : deux pages
   *   en vis-à-vis, la page 1 seule à droite).
   * - `dpi`, `jpeg` (qualité), `bleedMm` remplacent ceux du profil `quality` ; `colorProfile` (JPEG) : 'srgb'
   *   ou chemin d'un fichier ICC.
   * Une ligne d'album à gabarit double page donne deux pages imprimées, coupées au pli.
   * Renvoie un compte rendu : pages, images, photos prises sur une copie ou sur l'aperçu, cadres non remplis.
   */
  async function render(id, { quality = 'print', bleed = false, layout = 'pages', write, output = 'pdf', dir = null, dpi = null, jpeg = null, bleedMm = null, colorProfile = 'srgb', onProgress = null, record = true } = {}) {
    const a = albums.get(id); if (!a) throw new Error('Album inconnu');
    const base = PDF_PROFILES[quality] ?? PDF_PROFILES.print;
    const prof = { ...base, dpi: dpi ? clamp(Math.round(+dpi), 72, 600) : base.dpi, jpeg: jpeg ? clamp(Math.round(+jpeg), 40, 100) : base.jpeg };
    const raster = output === 'jpeg';
    if (raster && !dir) throw new Error('Dossier de sortie manquant');
    const spreadsOut = layout === 'spreads';
    const W = a.width_mm, H = a.height_mm, b = bleed ? (bleedMm != null ? clamp(+bleedMm || 0, 0, 10) : BLEED_MM) : 0;
    const pdf = raster ? null : new PdfWriter(write);
    const addImage = img => (raster ? img : pdf.jpeg(img.data, img.width, img.height, img.channels));
    const cache = new Map(); // photo + taille + recadrage → image déjà écrite (photo réutilisée)
    const minSide = Math.min(W, H) * MM;

    // pages imprimées : { row, half } (half = 0 ou 1 pour les deux moitiés d'une double page)
    const phys = [];
    a.pages.forEach((pg, row) => { if (pg.span === 2) phys.push({ row, half: 0 }, { row, half: 1 }); else phys.push({ row, half: null }); });
    phys.forEach((p, k) => { p.folio = k + 1; });
    // pages de sortie : une page imprimée, ou une planche [gauche, droite] (page 1 seule à droite)
    const sheets = [];
    if (!spreadsOut) for (const p of phys) sheets.push([p]);
    else { if (phys.length) sheets.push([null, phys[0]]); for (let k = 1; k < phys.length; k += 2) sheets.push([phys[k], phys[k + 1] ?? null]); }
    const report = { pages: phys.length, pdfPages: sheets.length, layout: spreadsOut ? 'spreads' : 'pages', output: raster ? 'jpeg' : 'pdf', dpi: prof.dpi, images: 0, fromCopy: [], fromPreview: [], edited: [], unfilled: [], lowDpi: [], quality, bleed: !!b, bleedMm: b, width_mm: W, height_mm: H, files: [] };

    /** Dessine une page imprimée dont le coin haut gauche (hors fonds perdus) est à ox, oy millimètres. */
    async function drawPhysical(c, p, ox, oy, clip) {
      const pg = a.pages[p.row], lay = LAYOUTS[pg.layout] ?? LAYOUTS.une, SW = W * (pg.span ?? 1), st = cleanStyle(pg.style);
      const sx = ox - (p.half === 1 ? W : 0); // origine de la planche (double page) ou de la page
      const ink = st.textColor ?? textColorOn(pg.background), folio = pg.folio ?? p.folio, first = p.half !== 1; // compte rendu : une fois par ligne
      c.save(); c.clip(...clip.map(v => v * MM));
      c.rect(...clip.map(v => v * MM), pg.background);
      for (let s = 0; s < lay.frames.length; s++) {
        const fr = lay.frames[s], pid = pg.slots[s], crop = pg.crops?.[s] ?? null;
        // un bord de cadre posé sur le bord de la page (ou de la planche) déborde dans les fonds perdus
        const x0 = fr.x <= 0 ? -b : fr.x * SW, y0 = fr.y <= 0 ? -b : fr.y * H;
        const x1 = fr.x + fr.w >= 1 ? SW + b : (fr.x + fr.w) * SW, y1 = fr.y + fr.h >= 1 ? H + b : (fr.y + fr.h) * H;
        const px = (sx + x0) * MM, py = (oy + y0) * MM, pw = (x1 - x0) * MM, ph = (y1 - y0) * MM;
        const tpw = clamp(Math.round((x1 - x0) / 25.4 * prof.dpi), 1, MAX_PX), tph = clamp(Math.round((y1 - y0) / 25.4 * prof.dpi), 1, MAX_PX);
        let ref = null;
        const edit = pid ? a.photos[pid]?.edit ?? null : null; // version retouchée par défaut, s'il y en a une
        if (pid) {
          const key = `${pid}|${tpw}x${tph}|${crop ? `${crop.x},${crop.y},${crop.zoom}` : ''}|${edit ? JSON.stringify(edit.params) : ''}`;
          if (cache.has(key)) ref = cache.get(key);
          else {
            for (const src of sourcesOf(pid)) {
              try {
                const img = await renderImage(src.path, tpw, tph, prof.jpeg, crop, edit?.params);
                ref = { ref: addImage(img), from: src.from, dpi: Math.round(img.width / ((x1 - x0) / 25.4)) };
                report.images++; break;
              } catch { /* source illisible : suivante */ }
            }
            cache.set(key, ref);
          }
        }
        if (ref) {
          c.image(ref.ref, px, py, pw, ph);
          // bordure : filet intérieur au cadre (position nominale, hors fonds perdus), sauf gabarit à fond perdu
          const bw = st.border.width * MM;
          if (bw > 0 && !lay.fullBleed) {
            const nx = (sx + fr.x * SW) * MM, ny = (oy + fr.y * H) * MM, nw = fr.w * SW * MM, nh = fr.h * H * MM, col = st.border.color, t = Math.min(bw, nw / 2, nh / 2);
            c.rect(nx, ny, nw, t, col); c.rect(nx, ny + nh - t, nw, t, col); c.rect(nx, ny, t, nh, col); c.rect(nx + nw - t, ny, t, nh, col);
          }
          if (first && ref.from === 'copie') report.fromCopy.push({ page: folio, slot: s + 1 });
          if (first && ref.from === 'apercu') report.fromPreview.push({ page: folio, slot: s + 1 });
          if (first && edit) report.edited.push({ page: folio, slot: s + 1, version: edit.name });
          if (first && ref.dpi < prof.dpi * 0.8) report.lowDpi.push({ page: folio, slot: s + 1, dpi: ref.dpi });
        } else {
          if (first) report.unfilled.push({ page: folio, slot: s + 1, reason: pid ? 'photo introuvable ou illisible' : 'cadre vide' });
          if (prof.placeholders) c.rect(px, py, pw, ph, mix(pg.background, '#94a3b8', 0.35));
        }
      }

      // Textes : titre et sous-titre (page de titre), sinon légende en bas (sur la page de droite pour une
      // double page, pour ne pas la couper au pli). Alignement du style de la page.
      const at = (x0, boxW) => (st.align === 'left' ? x0 : st.align === 'right' ? x0 + boxW : x0 + boxW / 2);
      if (pg.layout === 'titre') {
        const boxW = W * 0.76 * MM, size = clamp(minSide * 0.06, 12, 72), sub = Math.max(8, size * 0.5);
        const tl = wrapText(pg.title || '', size, boxW, true).slice(0, 4), sl = wrapText(pg.caption || '', sub, boxW).slice(0, 4);
        const total = tl.length * size * 1.2 + (sl.length ? size * 0.4 + sl.length * sub * 1.3 : 0);
        const tx = at((sx + W * 0.12) * MM, boxW);
        let y = (H / 2 + oy) * MM - total / 2;
        for (const l of tl) { y += size * 1.2; c.text(l, tx, y - size * 0.25, size, { bold: true, color: ink, align: st.align }); }
        if (sl.length) y += size * 0.4;
        for (const l of sl) { y += sub * 1.3; c.text(l, tx, y - sub * 0.3, sub, { color: mix(pg.background, ink, 0.8), align: st.align }); }
      } else if (pg.caption && !lay.fullBleed) {
        const px0 = sx + (pg.span === 2 ? W : 0) + W * 0.06;
        const boxW = W * 0.88 * MM, bandH = H * 0.06 * MM;
        let size = clamp(minSide * 0.026, 7, 14), lines = wrapText(pg.caption, size, boxW);
        while (size > 6 && lines.length * size * 1.2 > bandH) { size -= 0.5; lines = wrapText(pg.caption, size, boxW); }
        const max = Math.max(1, Math.floor(bandH / (size * 1.2)));
        if (lines.length > max) { lines = lines.slice(0, max); lines[max - 1] += ' …'; }
        let y = (H * 0.955 + oy) * MM - (lines.length * size * 1.2) / 2;
        for (const l of lines) { y += size * 1.2; c.text(l, at(px0 * MM, boxW), y - size * 0.3, size, { color: ink, align: st.align }); }
      }
      c.restore();
      // numéro de la page imprimée, au coin extérieur (droite pour une page impaire, gauche pour une paire)
      if (!lay.fullBleed) {
        const fs2 = clamp(minSide * 0.021, 6, 10), odd = p.folio % 2 === 1;
        c.text(String(p.folio), (ox + (odd ? W * 0.978 : W * 0.022)) * MM, (H * 0.984 + oy) * MM, fs2, { color: mix(pg.background, ink, 0.6), align: odd ? 'right' : 'left' });
      }
    }

    for (const [k, sheet] of sheets.entries()) {
      onProgress?.({ done: k, total: sheets.length });
      const n = sheet.length, TW = W * n + 2 * b, TH = H + 2 * b;
      const c = raster ? new RasterCanvas(TW * MM, TH * MM, prof.dpi / 72) : new PageContent(TH * MM);
      c.rect(0, 0, TW * MM, TH * MM, '#ffffff');
      for (let j = 0; j < n; j++) {
        if (!sheet[j]) continue;
        // zone de la page j : sa largeur, plus les fonds perdus côté extérieur de la page de sortie
        const x0 = j === 0 ? 0 : b + W * j, x1 = j === n - 1 ? TW : b + W * (j + 1);
        await drawPhysical(c, sheet[j], b + W * j, b, [x0, 0, x1 - x0, TH]);
      }
      if (raster) {
        const name = spreadsOut ? `planche-${String(k + 1).padStart(2, '0')}.jpg` : `page-${String(k + 1).padStart(3, '0')}.jpg`;
        const img = (await c.compose()).withMetadata({ density: prof.dpi }).withIccProfile(colorProfile || 'srgb').jpeg({ quality: prof.jpeg, chromaSubsampling: '4:4:4' });
        const info = await img.toFile(path.join(dir, name));
        report.files.push({ name, width: info.width, height: info.height, bytes: info.size, pages: sheet.map(p => p?.folio ?? null) });
      } else {
        const full = [0, 0, TW * MM, TH * MM];
        pdf.page(c, b ? { media: full, bleed: full, trim: [b * MM, b * MM, (TW - b) * MM, (TH - b) * MM] } : { media: full });
      }
    }
    onProgress?.({ done: sheets.length, total: sheets.length });

    if (raster) report.bytes = report.files.reduce((s, f) => s + f.bytes, 0);
    else report.bytes = pdf.end({ title: a.name }).bytes;
    if (record) {
      db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), raster ? 'album-jpeg' : 'album-pdf', a.name, quality, phys.length, 'ok', new Date().toISOString(), JSON.stringify({ albumId: id, ...report }));
      logHistory(db, 'album.pdf', `${raster ? 'Images' : 'PDF'} de « ${a.name} » produit${raster ? 'es' : ''} (${phys.length} page(s)${spreadsOut ? ' en planches' : ''}, ${prof.dpi} ppp${b ? `, fonds perdus ${b} mm` : ''})`, { id, quality, bleed: b, layout: report.layout, output: report.output });
    }
    return report;
  }

  // ---------- Profils de prestataire enregistrés (table config, clé album.services) ----------
  const SVC_KEY = 'album.services';
  const savedServices = () => { const r = db.prepare('SELECT data FROM config WHERE key = ?').get(SVC_KEY); const o = P(r?.data); return o && typeof o === 'object' ? o : {}; };
  const writeServices = all => db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(SVC_KEY, JSON.stringify(all));
  const services = () => ({ builtin: Object.fromEntries(Object.entries(BUILTIN_SERVICES).map(([k, v]) => [k, cleanService(v)])), saved: Object.fromEntries(Object.entries(savedServices()).map(([k, v]) => [k, cleanService(v)])) });
  function saveService(s) {
    const svc = cleanService(s); if (!svc.name) throw new Error('Nom de profil vide');
    const all = savedServices(), key = Object.entries(all).find(([, v]) => v.name === svc.name)?.[0] ?? crypto.randomUUID();
    all[key] = svc; writeServices(all);
    return { key, service: svc };
  }
  function removeService(key) { const all = savedServices(); if (!all[key]) throw new Error('Profil inconnu'); delete all[key]; writeServices(all); return { removed: key }; }
  /** Profil désigné par sa clé (intégré ou enregistré), ou profil donné en entier (essai sans enregistrement). */
  function serviceOf(ref) {
    if (ref && typeof ref === 'object') return cleanService(ref);
    const s = services(); const v = s.builtin[ref] ?? s.saved[ref]; if (!v) throw new Error('Profil de prestataire inconnu'); return v;
  }
  /** Contrôles avant préparation : ceux de l'album + ceux du profil. */
  function check(id, ref) {
    const a = albums.get(id); if (!a) throw new Error('Album inconnu');
    const svc = serviceOf(ref);
    return { service: svc, issues: [...a.issues.filter(i => i.level !== 'info'), ...checkService(a, svc)] };
  }

  /**
   * Dossier prêt à envoyer : Exports/Envoi <album> <date>/ avec les fichiers d'impression (album.pdf ou
   * pages/), le projet (album.json) et LISEZ-MOI.txt (spécifications, contrôles, liste des fichiers).
   * Rien n'est transmis : l'utilisateur dépose lui-même ces fichiers chez le prestataire.
   */
  async function sendFolder(id, ref, { onProgress, version = '' } = {}) {
    const a = albums.get(id); if (!a) throw new Error('Album inconnu');
    const { service: svc, issues } = check(id, ref);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
    let dir = path.join(EXPORT_DIR, `Envoi ${safeName(a.name)} ${stamp}`);
    for (let k = 2; fs.existsSync(dir); k++) dir = path.join(EXPORT_DIR, `Envoi ${safeName(a.name)} ${stamp} (${k})`);
    fs.mkdirSync(dir, { recursive: true });
    const icc = svc.colorProfile.startsWith('file:') ? path.join(PROFILES_DIR, path.basename(svc.colorProfile.slice(5))) : 'srgb';
    if (icc !== 'srgb' && !fs.existsSync(icc)) throw new Error('Profil ICC introuvable : ' + path.basename(icc));
    const opts = { quality: 'print', bleed: svc.bleed_mm > 0, bleedMm: svc.bleed_mm, layout: svc.layout, dpi: svc.dpi, jpeg: svc.jpegQuality, onProgress, record: false };
    let report;
    if (svc.output === 'pdf') {
      const file = path.join(dir, 'album.pdf'), fd = fs.openSync(file, 'w');
      try { report = await render(id, { ...opts, output: 'pdf', write: buf => fs.writeSync(fd, buf) }); } finally { fs.closeSync(fd); }
      report.files = [{ name: 'album.pdf', bytes: report.bytes }];
    } else {
      const pages = path.join(dir, 'pages'); fs.mkdirSync(pages);
      report = await render(id, { ...opts, output: 'jpeg', dir: pages, colorProfile: icc });
      report.files = report.files.map(f => ({ ...f, name: 'pages/' + f.name }));
    }
    fs.writeFileSync(path.join(dir, 'album.json'), JSON.stringify(albums.exportProject(id), null, 2));
    const readme = readmeText(a, svc, report, issues, version);
    fs.writeFileSync(path.join(dir, 'LISEZ-MOI.txt'), '\ufeff' + readme.replace(/\n/g, '\r\n'));
    const out = { dir, service: svc, issues, ...report };
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'album-envoi', dir, svc.name, report.pages, issues.some(i => i.level === 'bad') ? 'partial' : 'ok', new Date().toISOString(), JSON.stringify({ albumId: id, ...out }));
    logHistory(db, 'album.send', `Dossier d'envoi de « ${a.name} » préparé (${svc.name}) : ${dir}`, { id, dir });
    return out;
  }

  function readmeText(a, svc, r, issues, version) {
    const fmt = n => String(n).replace('.', ',');
    const L = [];
    L.push(`Album « ${a.name} » — dossier prêt à envoyer`, '');
    L.push(`Préparé le ${new Date().toLocaleString('fr-FR')} par Photothèque${version ? ' ' + version : ''}.`);
    L.push('Photothèque n’envoie rien : déposez vous-même ces fichiers sur le site du prestataire,', 'après avoir vérifié ses spécifications.', '');
    L.push(`Profil : ${svc.name}`);
    L.push(`Format fini : ${fmt(a.width_mm)} × ${fmt(a.height_mm)} mm`);
    if (r.bleedMm) L.push(`Fonds perdus : ${fmt(r.bleedMm)} mm de chaque côté (fichier de ${fmt(a.width_mm * (r.layout === 'spreads' ? 2 : 1) + 2 * r.bleedMm)} × ${fmt(a.height_mm + 2 * r.bleedMm)} mm${r.layout === 'spreads' ? ' par planche' : ''})`);
    else L.push('Fonds perdus : aucun');
    if (svc.safety_mm) L.push(`Zone de sécurité du profil : ${fmt(svc.safety_mm)} mm`);
    L.push(`Pages imprimées : ${r.pages}`);
    L.push(`Résolution : ${r.dpi} ppp ; profil de couleur : ${svc.output === 'jpeg' && svc.colorProfile.startsWith('file:') ? svc.colorProfile.slice(5) : 'sRGB'}`);
    L.push(`Fichiers : ${svc.output === 'pdf' ? 'album.pdf (une page PDF par page imprimée, boîte de coupe TrimBox)' : `${r.files.length} image(s) JPEG dans « pages »`}`);
    if (svc.output === 'jpeg' && r.layout === 'spreads') L.push('  planche-01.jpg : page 1 seule à droite, puis les pages en vis-à-vis.');
    if (svc.notes) L.push('', 'Notes du profil :', ...svc.notes.split(/\r?\n/).map(s => '  ' + s));
    L.push('', 'Contrôles :');
    const all = [...issues.filter(i => i.level !== 'info'),
      ...r.unfilled.filter(u => u.reason !== 'cadre vide').map(u => ({ level: 'bad', message: `Page ${u.page}, cadre ${u.slot} : ${u.reason}` })),
      ...r.fromPreview.map(u => ({ level: 'warn', message: `Page ${u.page}, cadre ${u.slot} : prise sur l’aperçu (original indisponible), qualité réduite` }))];
    if (!all.length) L.push('  Aucune alerte.');
    for (const i of all) L.push(`  [${i.level === 'bad' ? 'À CORRIGER' : 'à vérifier'}] ${i.message}`);
    L.push('', 'Liste des fichiers :');
    for (const f of r.files) L.push(`  ${f.name}${f.width ? ` — ${f.width} × ${f.height} px` : ''} — ${Math.max(1, Math.round(f.bytes / 1024))} Ko`);
    L.push('  album.json — projet de l’album (format phototheque-album, pour le rouvrir ou l’archiver)');
    return L.join('\n') + '\n';
  }

  return { render, sourcesOf, services, saveService, removeService, check, sendFolder };
}
