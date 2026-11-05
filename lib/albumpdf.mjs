// Export d'impression d'un album en PDF : une page PDF par page d'album, au format exact (option
// fonds perdus de 3 mm), photos recadrées « couvrir » et centrées comme dans l'éditeur, rééchantillonnées
// à la résolution de sortie (jamais agrandies au-delà de leur résolution réelle), textes en Helvetica.
// Les originaux sont lus en lecture seule ; s'ils sont indisponibles on prend une copie connue, puis
// l'aperçu en cache (signalé dans le compte rendu).
import fs from 'fs';
import crypto from 'crypto';
import { LAYOUTS, cropWindow } from './albums.mjs';
import { PdfWriter, PageContent, MM, wrapText, textColorOn } from './pdf.mjs';
import { logHistory } from './db.mjs';

/** Profils de sortie : impression (300 ppp) ou écran / aperçu (150 ppp, cadres vides visibles). */
export const PDF_PROFILES = {
  print: { label: 'Impression (300 ppp)', dpi: 300, jpeg: 90, placeholders: false },
  screen: { label: 'Écran / aperçu (150 ppp)', dpi: 150, jpeg: 80, placeholders: true },
};
export const BLEED_MM = 3;
const MAX_PX = 12000;
const P = s => { try { return JSON.parse(s); } catch { return null; } };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (c1, c2, t) => { const p = h => [0, 2, 4].map(i => parseInt(h.slice(1 + i, 3 + i), 16)); const a = p(c1), b = p(c2); return '#' + a.map((v, i) => Math.round(v * (1 - t) + b[i] * t).toString(16).padStart(2, '0')).join(''); };

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
  async function renderImage(src, pw, ph, jpeg, crop) {
    const { default: sharp } = await import('sharp');
    const opts = { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' };
    const meta = await sharp(src, opts).metadata();
    let iw = meta.width, ih = meta.height; if ((meta.orientation ?? 1) >= 5) [iw, ih] = [ih, iw];
    if (!iw || !ih) throw new Error('Dimensions illisibles');
    const win = cropWindow(iw, ih, pw, ph, crop);
    const left = Math.min(iw - 1, Math.max(0, Math.round(win.left * iw))), top = Math.min(ih - 1, Math.max(0, Math.round(win.top * ih)));
    const rw = Math.max(1, Math.min(iw - left, Math.round(win.width * iw))), rh = Math.max(1, Math.min(ih - top, Math.round(win.height * ih)));
    const up = Math.max(pw / rw, ph / rh); // > 1 : la partie visible a moins de pixels que le cadre à la résolution visée
    const tw = Math.max(1, Math.round(up > 1 ? pw / up : pw)), th = Math.max(1, Math.round(up > 1 ? ph / up : ph));
    const { data, info } = await sharp(src, opts).rotate().extract({ left, top, width: rw, height: rh }).resize(tw, th, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: jpeg }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  }

  /**
   * Produit le PDF d'un album. `write(buffer)` reçoit le fichier au fil de l'eau.
   * `layout` : 'pages' (une page PDF par page imprimée, pour l'imprimeur) ou 'spreads' (planches :
   * deux pages en vis-à-vis par page PDF, la page 1 seule à droite, pour l'écran).
   * Une ligne d'album à gabarit double page donne deux pages imprimées, coupées au pli.
   * Renvoie un compte rendu : pages, images, photos prises sur une copie ou sur l'aperçu, cadres non remplis.
   */
  async function render(id, { quality = 'print', bleed = false, layout = 'pages', write } = {}) {
    const a = albums.get(id); if (!a) throw new Error('Album inconnu');
    const prof = PDF_PROFILES[quality] ?? PDF_PROFILES.print;
    const spreadsOut = layout === 'spreads';
    const W = a.width_mm, H = a.height_mm, b = bleed ? BLEED_MM : 0;
    const pdf = new PdfWriter(write);
    const cache = new Map(); // photo + taille + recadrage → image déjà écrite (photo réutilisée)
    const minSide = Math.min(W, H) * MM;

    // pages imprimées : { row, half } (half = 0 ou 1 pour les deux moitiés d'une double page)
    const phys = [];
    a.pages.forEach((pg, row) => { if (pg.span === 2) phys.push({ row, half: 0 }, { row, half: 1 }); else phys.push({ row, half: null }); });
    phys.forEach((p, k) => { p.folio = k + 1; });
    // pages PDF : une page imprimée, ou une planche [gauche, droite] (page 1 seule à droite)
    const sheets = [];
    if (!spreadsOut) for (const p of phys) sheets.push([p]);
    else { if (phys.length) sheets.push([null, phys[0]]); for (let k = 1; k < phys.length; k += 2) sheets.push([phys[k], phys[k + 1] ?? null]); }
    const report = { pages: phys.length, pdfPages: sheets.length, layout: spreadsOut ? 'spreads' : 'pages', images: 0, fromCopy: [], fromPreview: [], unfilled: [], lowDpi: [], quality, bleed: !!bleed, width_mm: W, height_mm: H };

    /** Dessine une page imprimée dont le coin haut gauche (hors fonds perdus) est à ox, oy millimètres. */
    async function drawPhysical(c, p, ox, oy, clip) {
      const pg = a.pages[p.row], lay = LAYOUTS[pg.layout] ?? LAYOUTS.une, SW = W * (pg.span ?? 1);
      const sx = ox - (p.half === 1 ? W : 0); // origine de la planche (double page) ou de la page
      const ink = textColorOn(pg.background), folio = pg.folio ?? p.folio, first = p.half !== 1; // compte rendu : une fois par ligne
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
        if (pid) {
          const key = `${pid}|${tpw}x${tph}|${crop ? `${crop.x},${crop.y},${crop.zoom}` : ''}`;
          if (cache.has(key)) ref = cache.get(key);
          else {
            for (const src of sourcesOf(pid)) {
              try {
                const img = await renderImage(src.path, tpw, tph, prof.jpeg, crop);
                ref = { ref: pdf.jpeg(img.data, img.width, img.height, img.channels), from: src.from, dpi: Math.round(img.width / ((x1 - x0) / 25.4)) };
                report.images++; break;
              } catch { /* source illisible : suivante */ }
            }
            cache.set(key, ref);
          }
        }
        if (ref) {
          c.image(ref.ref, px, py, pw, ph);
          if (first && ref.from === 'copie') report.fromCopy.push({ page: folio, slot: s + 1 });
          if (first && ref.from === 'apercu') report.fromPreview.push({ page: folio, slot: s + 1 });
          if (first && ref.dpi < prof.dpi * 0.8) report.lowDpi.push({ page: folio, slot: s + 1, dpi: ref.dpi });
        } else {
          if (first) report.unfilled.push({ page: folio, slot: s + 1, reason: pid ? 'photo introuvable ou illisible' : 'cadre vide' });
          if (prof.placeholders) c.rect(px, py, pw, ph, mix(pg.background, '#94a3b8', 0.35));
        }
      }

      // Textes : titre et sous-titre centrés (page de titre), sinon légende en bas (sur la page de droite
      // pour une double page, pour ne pas la couper au pli).
      if (pg.layout === 'titre') {
        const boxW = W * 0.76 * MM, size = clamp(minSide * 0.06, 12, 72), sub = Math.max(8, size * 0.5);
        const tl = wrapText(pg.title || '', size, boxW, true).slice(0, 4), sl = wrapText(pg.caption || '', sub, boxW).slice(0, 4);
        const total = tl.length * size * 1.2 + (sl.length ? size * 0.4 + sl.length * sub * 1.3 : 0);
        let y = (H / 2 + oy) * MM - total / 2;
        for (const l of tl) { y += size * 1.2; c.text(l, (sx + W / 2) * MM, y - size * 0.25, size, { bold: true, color: ink, align: 'center' }); }
        if (sl.length) y += size * 0.4;
        for (const l of sl) { y += sub * 1.3; c.text(l, (sx + W / 2) * MM, y - sub * 0.3, sub, { color: mix(pg.background, ink, 0.8), align: 'center' }); }
      } else if (pg.caption && !lay.fullBleed) {
        const cx = sx + (pg.span === 2 ? W * 1.5 : W / 2);
        const boxW = W * 0.88 * MM, bandH = H * 0.06 * MM;
        let size = clamp(minSide * 0.026, 7, 14), lines = wrapText(pg.caption, size, boxW);
        while (size > 6 && lines.length * size * 1.2 > bandH) { size -= 0.5; lines = wrapText(pg.caption, size, boxW); }
        const max = Math.max(1, Math.floor(bandH / (size * 1.2)));
        if (lines.length > max) { lines = lines.slice(0, max); lines[max - 1] += ' …'; }
        let y = (H * 0.955 + oy) * MM - (lines.length * size * 1.2) / 2;
        for (const l of lines) { y += size * 1.2; c.text(l, cx * MM, y - size * 0.3, size, { color: ink, align: 'center' }); }
      }
      c.restore();
      // numéro de la page imprimée, au coin extérieur (droite pour une page impaire, gauche pour une paire)
      if (!lay.fullBleed) {
        const fs2 = clamp(minSide * 0.021, 6, 10), odd = p.folio % 2 === 1;
        c.text(String(p.folio), (ox + (odd ? W * 0.978 : W * 0.022)) * MM, (H * 0.984 + oy) * MM, fs2, { color: mix(pg.background, ink, 0.6), align: odd ? 'right' : 'left' });
      }
    }

    for (const sheet of sheets) {
      const n = sheet.length, TW = W * n + 2 * b, TH = H + 2 * b;
      const c = new PageContent(TH * MM);
      c.rect(0, 0, TW * MM, TH * MM, '#ffffff');
      for (let j = 0; j < n; j++) {
        if (!sheet[j]) continue;
        // zone de la page j : sa largeur, plus les fonds perdus côté extérieur de la page PDF
        const x0 = j === 0 ? 0 : b + W * j, x1 = j === n - 1 ? TW : b + W * (j + 1);
        await drawPhysical(c, sheet[j], b + W * j, b, [x0, 0, x1 - x0, TH]);
      }
      const full = [0, 0, TW * MM, TH * MM];
      pdf.page(c, b ? { media: full, bleed: full, trim: [b * MM, b * MM, (TW - b) * MM, (TH - b) * MM] } : { media: full });
    }

    const out = pdf.end({ title: a.name });
    report.bytes = out.bytes;
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'album-pdf', a.name, quality, phys.length, 'ok', new Date().toISOString(), JSON.stringify({ albumId: id, ...report }));
    logHistory(db, 'album.pdf', `PDF de « ${a.name} » produit (${phys.length} page(s)${spreadsOut ? ' en planches' : ''}, ${prof.label}${bleed ? ', fonds perdus' : ''})`, { id, quality, bleed: !!bleed, layout: report.layout });
    return report;
  }

  return { render, sourcesOf };
}
