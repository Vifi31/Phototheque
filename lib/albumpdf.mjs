// Export d'impression d'un album en PDF : une page PDF par page d'album, au format exact (option
// fonds perdus de 3 mm), photos recadrées « couvrir » et centrées comme dans l'éditeur, rééchantillonnées
// à la résolution de sortie (jamais agrandies au-delà de leur résolution réelle), textes en Helvetica.
// Les originaux sont lus en lecture seule ; s'ils sont indisponibles on prend une copie connue, puis
// l'aperçu en cache (signalé dans le compte rendu).
import fs from 'fs';
import crypto from 'crypto';
import { LAYOUTS } from './albums.mjs';
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

  /** Recadre (couvrir, centré) et rééchantillonne une image pour un cadre de pw × ph pixels. */
  async function renderImage(src, pw, ph, jpeg) {
    const { default: sharp } = await import('sharp');
    const opts = { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' };
    const meta = await sharp(src, opts).metadata();
    let iw = meta.width, ih = meta.height; if ((meta.orientation ?? 1) >= 5) [iw, ih] = [ih, iw];
    if (!iw || !ih) throw new Error('Dimensions illisibles');
    const up = Math.max(pw / iw, ph / ih); // > 1 : l'image est plus petite que le cadre à la résolution visée
    const tw = Math.max(1, Math.round(up > 1 ? pw / up : pw)), th = Math.max(1, Math.round(up > 1 ? ph / up : ph));
    const { data, info } = await sharp(src, opts).rotate().resize(tw, th, { fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: jpeg }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  }

  /**
   * Produit le PDF d'un album. `write(buffer)` reçoit le fichier au fil de l'eau.
   * Renvoie un compte rendu : pages, images, photos prises sur une copie ou sur l'aperçu, cadres non remplis.
   */
  async function render(id, { quality = 'print', bleed = false, write } = {}) {
    const a = albums.get(id); if (!a) throw new Error('Album inconnu');
    const prof = PDF_PROFILES[quality] ?? PDF_PROFILES.print;
    const W = a.width_mm, H = a.height_mm, b = bleed ? BLEED_MM : 0;
    const pdf = new PdfWriter(write);
    const cache = new Map(); // photo + taille → image déjà écrite (photo réutilisée)
    const report = { pages: a.pages.length, images: 0, fromCopy: [], fromPreview: [], unfilled: [], lowDpi: [], quality, bleed: !!bleed, width_mm: W, height_mm: H };
    const minSide = Math.min(W, H) * MM;

    for (let i = 0; i < a.pages.length; i++) {
      const pg = a.pages[i], n = i + 1, lay = LAYOUTS[pg.layout] ?? LAYOUTS.une;
      const c = new PageContent((H + 2 * b) * MM);
      const at = (xmm, ymm) => [(xmm + b) * MM, (ymm + b) * MM];
      const ink = textColorOn(pg.background);
      c.rect(0, 0, (W + 2 * b) * MM, (H + 2 * b) * MM, pg.background);

      for (let s = 0; s < lay.frames.length; s++) {
        const fr = lay.frames[s], pid = pg.slots[s];
        // un bord de cadre posé sur le bord de la page déborde dans les fonds perdus
        const x0 = fr.x <= 0 ? -b : fr.x * W, y0 = fr.y <= 0 ? -b : fr.y * H;
        const x1 = fr.x + fr.w >= 1 ? W + b : (fr.x + fr.w) * W, y1 = fr.y + fr.h >= 1 ? H + b : (fr.y + fr.h) * H;
        const [px, py] = at(x0, y0), pw = (x1 - x0) * MM, ph = (y1 - y0) * MM;
        const tpw = clamp(Math.round((x1 - x0) / 25.4 * prof.dpi), 1, MAX_PX), tph = clamp(Math.round((y1 - y0) / 25.4 * prof.dpi), 1, MAX_PX);
        let ref = null;
        if (pid) {
          const key = `${pid}|${tpw}x${tph}`;
          if (cache.has(key)) ref = cache.get(key);
          else {
            for (const src of sourcesOf(pid)) {
              try {
                const img = await renderImage(src.path, tpw, tph, prof.jpeg);
                ref = { ref: pdf.jpeg(img.data, img.width, img.height, img.channels), from: src.from, dpi: Math.round(img.width / ((x1 - x0) / 25.4)) };
                report.images++; break;
              } catch { /* source illisible : suivante */ }
            }
            cache.set(key, ref);
          }
        }
        if (ref) {
          c.image(ref.ref, px, py, pw, ph);
          if (ref.from === 'copie') report.fromCopy.push({ page: n, slot: s + 1 });
          if (ref.from === 'apercu') report.fromPreview.push({ page: n, slot: s + 1 });
          if (ref.dpi < prof.dpi * 0.8) report.lowDpi.push({ page: n, slot: s + 1, dpi: ref.dpi });
        } else {
          report.unfilled.push({ page: n, slot: s + 1, reason: pid ? 'photo introuvable ou illisible' : 'cadre vide' });
          if (prof.placeholders) c.rect(px, py, pw, ph, mix(pg.background, '#94a3b8', 0.35));
        }
      }

      // Textes : titre et sous-titre centrés (page de titre), sinon légende en bas, numéro de page.
      if (pg.layout === 'titre') {
        const boxW = W * 0.76 * MM, size = clamp(minSide * 0.06, 12, 72), sub = Math.max(8, size * 0.5);
        const tl = wrapText(pg.title || '', size, boxW, true).slice(0, 4), sl = wrapText(pg.caption || '', sub, boxW).slice(0, 4);
        const total = tl.length * size * 1.2 + (sl.length ? size * 0.4 + sl.length * sub * 1.3 : 0);
        let y = (H / 2 + b) * MM - total / 2;
        for (const l of tl) { y += size * 1.2; c.text(l, (W / 2 + b) * MM, y - size * 0.25, size, { bold: true, color: ink, align: 'center' }); }
        if (sl.length) y += size * 0.4;
        for (const l of sl) { y += sub * 1.3; c.text(l, (W / 2 + b) * MM, y - sub * 0.3, sub, { color: mix(pg.background, ink, 0.8), align: 'center' }); }
      } else if (pg.caption && !lay.fullBleed) {
        const boxW = W * 0.88 * MM, bandH = H * 0.06 * MM;
        let size = clamp(minSide * 0.026, 7, 14), lines = wrapText(pg.caption, size, boxW);
        while (size > 6 && lines.length * size * 1.2 > bandH) { size -= 0.5; lines = wrapText(pg.caption, size, boxW); }
        const max = Math.max(1, Math.floor(bandH / (size * 1.2)));
        if (lines.length > max) { lines = lines.slice(0, max); lines[max - 1] += ' …'; }
        let y = (H * 0.955 + b) * MM - (lines.length * size * 1.2) / 2;
        for (const l of lines) { y += size * 1.2; c.text(l, (W / 2 + b) * MM, y - size * 0.3, size, { color: ink, align: 'center' }); }
      }
      if (!lay.fullBleed) {
        const fs2 = clamp(minSide * 0.021, 6, 10);
        c.text(String(n), (W * 0.978 + b) * MM, (H * 0.984 + b) * MM, fs2, { color: mix(pg.background, ink, 0.6), align: 'right' });
      }

      const full = [0, 0, (W + 2 * b) * MM, (H + 2 * b) * MM];
      pdf.page(c, b ? { media: full, bleed: full, trim: [b * MM, b * MM, (W + b) * MM, (H + b) * MM] } : { media: full });
    }

    const out = pdf.end({ title: a.name });
    report.bytes = out.bytes;
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'album-pdf', a.name, quality, a.pages.length, 'ok', new Date().toISOString(), JSON.stringify({ albumId: id, ...report }));
    logHistory(db, 'album.pdf', `PDF de « ${a.name} » produit (${a.pages.length} page(s), ${prof.label}${bleed ? ', fonds perdus' : ''})`, { id, quality, bleed: !!bleed });
    return report;
  }

  return { render, sourcesOf };
}
