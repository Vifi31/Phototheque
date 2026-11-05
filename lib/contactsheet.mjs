// Planches-contact (cahier des charges §14) : une grille de vignettes légendées par page, en PDF, pour
// une sélection de photos, une collection ou le résultat d'une recherche. Chaque photo est montrée
// entière (« contenir », jamais recadrée), dans sa version retouchée par défaut si elle en a une.
// Lecture seule : aucun fichier source n'est modifié ; les images sont prises sur les aperçus en cache
// (qualité « écran ») ou sur les originaux (qualité « impression »).
import fs from 'fs';
import crypto from 'crypto';
import { PdfWriter, PageContent, MM, textWidth } from './pdf.mjs';
import { logHistory } from './db.mjs';
import { isNeutral, cleanParams } from './edits.mjs';

export const SHEET_PAGES = {
  'a4-portrait': { label: 'A4 portrait', width: 210, height: 297 },
  'a4-paysage': { label: 'A4 paysage', width: 297, height: 210 },
  'a3-portrait': { label: 'A3 portrait', width: 297, height: 420 },
  'a3-paysage': { label: 'A3 paysage', width: 420, height: 297 },
};
export const SHEET_FIELDS = {
  number: 'Numéro', name: 'Nom du fichier', date: 'Date de prise de vue', title: 'Titre', dimensions: 'Dimensions (pixels)',
  rating: 'Note', camera: 'Appareil', keywords: 'Mots-clés', folder: 'Dossier',
};
export const SHEET_QUALITIES = {
  screen: { label: 'Écran (aperçus en cache, rapide)', dpi: 150, jpeg: 80 },
  print: { label: 'Impression (originaux, 300 ppp)', dpi: 300, jpeg: 88 },
};
export const SHEET_DEFAULTS = { page: 'a4-portrait', columns: 4, rows: 5, fields: ['number', 'name', 'date'], title: '', quality: 'screen', edited: true, margin: 12 };
export const MAX_SHEET_PHOTOS = 3000;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const int = (v, d, a, b) => (Number.isFinite(+v) && v !== '' && v !== null ? clamp(Math.round(+v), a, b) : d);
const P = s => { try { return JSON.parse(s); } catch { return null; } };

/** Options nettoyées (toute valeur inconnue retombe sur la valeur par défaut). */
export function cleanSheetOptions(o = {}) {
  const fields = (Array.isArray(o.fields) ? o.fields : typeof o.fields === 'string' ? o.fields.split(',') : SHEET_DEFAULTS.fields)
    .map(String).filter((f, i, a) => SHEET_FIELDS[f] && a.indexOf(f) === i);
  return {
    page: SHEET_PAGES[o.page] ? o.page : SHEET_DEFAULTS.page,
    columns: int(o.columns, SHEET_DEFAULTS.columns, 1, 12),
    rows: int(o.rows, SHEET_DEFAULTS.rows, 1, 16),
    fields,
    title: String(o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    quality: SHEET_QUALITIES[o.quality] ? o.quality : SHEET_DEFAULTS.quality,
    edited: o.edited !== false && o.edited !== 'false' && o.edited !== 0,
    margin: int(o.margin, SHEET_DEFAULTS.margin, 5, 30),
  };
}

/** Coupe un texte pour qu'il tienne en `max` points (points de suspension). */
export function fitText(text, size, max, bold = false) {
  let s = String(text ?? '');
  if (textWidth(s, size, bold) <= max) return s;
  while (s.length > 1 && textWidth(s + '…', size, bold) > max) s = s.slice(0, -1);
  return s.length > 1 ? s.trimEnd() + '…' : '';
}

/** « 2022-06-02T10:00:00 » → « 02/06/2022 10:00 ». */
const fmtDate = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : '';
};

export function createContactSheets(db, library, edits = null) {
  const photoRow = db.prepare('SELECT * FROM photos WHERE id = ?');
  const filesOf = db.prepare(`SELECT path, file_name, data FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, indexed_at`);
  const defaultEdit = db.prepare('SELECT id, name, params FROM edits WHERE photo_id = ? AND is_default = 1');

  /** Libellés de la légende d'une photo, dans l'ordre des champs choisis (le numéro est à part). */
  function captionOf(p, file, fields) {
    const out = [];
    for (const f of fields) {
      if (f === 'name') out.push(file?.file_name ?? '');
      else if (f === 'date') out.push(fmtDate(p.captured_at) || 'sans date');
      else if (f === 'title') out.push(p.title ?? '');
      else if (f === 'dimensions') out.push(p.width && p.height ? `${p.width} × ${p.height}` : '');
      else if (f === 'rating') out.push(p.rating ? `Note ${p.rating}/5` : '');
      else if (f === 'camera') out.push([p.camera_make, p.camera_model].filter(Boolean).join(' '));
      else if (f === 'keywords') out.push((p.keywords_text ?? '').split(/\s*\|\s*/).filter(Boolean).join(', '));
      else if (f === 'folder') out.push(file?.path ? file.path.replace(/[\\/][^\\/]*$/, '') : '');
    }
    return out;
  }

  /** Image d'une photo : version retouchée par défaut, sinon aperçu en cache (écran) ou original (impression). */
  async function imageOf(p, files, q, opts, boxPx) {
    const { default: sharp } = await import('sharp');
    const srcs = [];
    const preview = () => { for (const f of files) { const rel = P(f.data)?.thumbs?.preview; if (rel) { const abs = library.thumbAbs(rel); if (fs.existsSync(abs)) return abs; } } return null; };
    const ed = opts.edited ? defaultEdit.get(p.id) : null, prm = ed ? cleanParams(P(ed.params)) : null;
    let edited = null;
    if (ed && prm && !isNeutral(prm) && edits) {
      try { srcs.push({ path: await edits.preview(p.id, prm, { size: clamp(Math.max(...boxPx), 200, 3000) }), from: 'retouche' }); edited = ed.name; } catch { /* rendu impossible : photo d'origine */ }
    }
    const pv = preview();
    if (q === 'screen' && pv) srcs.push({ path: pv, from: 'apercu' });
    for (const f of files) if (f.path && fs.existsSync(f.path)) srcs.push({ path: f.path, from: 'original' });
    if (q !== 'screen' && pv) srcs.push({ path: pv, from: 'apercu' });
    for (const s of srcs) {
      try {
        const { data, info } = await sharp(s.path, { failOn: 'none', limitInputPixels: 1024 * 1024 * 512 }).rotate()
          .resize(boxPx[0], boxPx[1], { fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: SHEET_QUALITIES[q].jpeg }).toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height, channels: info.channels, from: s.from, edited: s.from === 'retouche' ? edited : null };
      } catch { /* source illisible : suivante */ }
    }
    return null;
  }

  /**
   * Produit la planche-contact des photos `ids` (dans cet ordre). `write(buffer)` reçoit le PDF au fil
   * de l'eau. Renvoie un compte rendu : photos, pages, images retouchées, prises sur l'aperçu, illisibles.
   */
  async function render(ids, options = {}, { write, label = '' } = {}) {
    const o = cleanSheetOptions(options), q = o.quality;
    const list = [...new Set([].concat(ids ?? []).filter(x => typeof x === 'string'))].slice(0, MAX_SHEET_PHOTOS)
      .map(id => photoRow.get(id)).filter(Boolean);
    if (!list.length) throw new Error('Aucune photo pour la planche-contact');
    const pg = SHEET_PAGES[o.page], W = pg.width * MM, H = pg.height * MM, M = o.margin * MM;
    const perPage = o.columns * o.rows, pages = Math.ceil(list.length / perPage);
    const headH = o.title ? 12 * MM : 0, footH = 7 * MM, gap = 3 * MM;
    const cellW = (W - 2 * M - gap * (o.columns - 1)) / o.columns;
    const cellH = (H - 2 * M - headH - footH - gap * (o.rows - 1)) / o.rows;
    const fs2 = clamp(cellW / 18, 5, 9), lineH = fs2 * 1.25;
    const capFields = o.fields.filter(f => f !== 'number'), numbered = o.fields.includes('number');
    const capLines = capFields.length + (numbered && !capFields.length ? 1 : 0);
    const capH = capLines * lineH + (capLines ? 2 : 0);
    const boxW = cellW, boxH = cellH - capH;
    if (boxH < 10 * MM || boxW < 10 * MM) throw new Error('Trop de photos par page ou trop de légendes : réduisez les colonnes, les lignes ou les champs');
    const boxPx = [Math.round(boxW / 72 * SHEET_QUALITIES[q].dpi), Math.round(boxH / 72 * SHEET_QUALITIES[q].dpi)];

    const pdf = new PdfWriter(write);
    const report = { photos: list.length, pages, columns: o.columns, rows: o.rows, page: o.page, quality: q, images: 0, edited: 0, fromPreview: [], fromOriginal: 0, unreadable: [] };
    const stamp = fmtDate(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString());
    const footerLeft = fitText([o.title || label || 'Planche-contact', `${list.length} photo(s)`, stamp].filter(Boolean).join(' · '), 7, W / 2);

    for (let pgN = 0; pgN < pages; pgN++) {
      const c = new PageContent(H);
      c.rect(0, 0, W, H, '#ffffff');
      if (o.title) {
        c.text(fitText(o.title, 14, W - 2 * M, true), M, M + 10, 14, { bold: true, color: '#1e293b' });
        c.rect(M, M + headH - 4 * MM, W - 2 * M, 0.6, '#cbd5e1');
      }
      for (let k = 0; k < perPage; k++) {
        const i = pgN * perPage + k; if (i >= list.length) break;
        const p = list[i], files = filesOf.all(p.id);
        const col = k % o.columns, row = Math.floor(k / o.columns);
        const x = M + col * (cellW + gap), y = M + headH + row * (cellH + gap);
        c.rect(x, y, boxW, boxH, '#f1f5f9');
        const img = await imageOf(p, files, q, o, boxPx);
        if (img) {
          // taille affichée : l'image « contient » la case, centrée, sans jamais être recadrée
          const s = Math.min(boxW / img.width, boxH / img.height), dw = img.width * s, dh = img.height * s;
          c.image(pdf.jpeg(img.data, img.width, img.height, img.channels), x + (boxW - dw) / 2, y + (boxH - dh) / 2, dw, dh);
          report.images++;
          if (img.edited) report.edited++;
          if (img.from === 'apercu' && q === 'print') report.fromPreview.push(i + 1);
          if (img.from === 'original') report.fromOriginal++;
        } else {
          report.unreadable.push({ n: i + 1, id: p.id, name: files[0]?.file_name ?? null });
          c.text('illisible', x + boxW / 2, y + boxH / 2, fs2, { color: '#94a3b8', align: 'center' });
        }
        // légende : numéro en gras devant la première ligne, chaque champ sur sa ligne, coupé à la largeur
        const cap = captionOf(p, files[0], capFields);
        let ly = y + boxH + 2 + fs2;
        if (numbered) {
          const num = String(i + 1), nw = textWidth(num, fs2, true) + 3;
          c.text(num, x, ly, fs2, { bold: true, color: '#1e293b' });
          if (cap.length) c.text(fitText(cap[0], fs2, cellW - nw), x + nw, ly, fs2, { color: '#1e293b' });
          ly += lineH;
          cap.slice(1).forEach(t => { c.text(fitText(t, fs2, cellW), x, ly, fs2, { color: '#475569' }); ly += lineH; });
        } else cap.forEach((t, j) => { c.text(fitText(t, fs2, cellW), x, ly, fs2, { color: j ? '#475569' : '#1e293b' }); ly += lineH; });
      }
      c.text(footerLeft, M, H - M + 2, 7, { color: '#64748b' });
      c.text(`Page ${pgN + 1} / ${pages}`, W - M, H - M + 2, 7, { color: '#64748b', align: 'right' });
      pdf.page(c, { media: [0, 0, W, H] });
    }
    const out = pdf.end({ title: o.title || label || 'Planche-contact' });
    report.bytes = out.bytes;
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'contact-sheet', o.title || label || 'Planche-contact', q, list.length, 'ok', new Date().toISOString(), JSON.stringify({ options: o, ...report }));
    logHistory(db, 'contactsheet.pdf', `Planche-contact produite (${list.length} photo(s), ${pages} page(s), ${o.columns} × ${o.rows})`, { photos: list.length, pages });
    return report;
  }

  return { render };
}
