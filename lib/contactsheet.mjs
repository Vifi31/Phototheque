// Planches-contact et fiches détaillées (cahier des charges §14) : une grille de vignettes légendées par page
// (ou une photo par page avec toutes ses informations, mise en page « detail »), en PDF, pour
// une sélection de photos, une collection ou le résultat d'une recherche. Chaque photo est montrée
// entière (« contenir », jamais recadrée), dans sa version retouchée par défaut si elle en a une.
// Lecture seule : aucun fichier source n'est modifié ; les images sont prises sur les aperçus en cache
// (qualité « écran ») ou sur les originaux (qualité « impression »).
import fs from 'fs';
import crypto from 'crypto';
import { PdfWriter, PageContent, MM, textWidth } from './pdf.mjs';
import { logHistory } from './db.mjs';
import { keywordNamesOf } from './keywords.mjs';
import { isNeutral, cleanParams } from './edits.mjs';
import { createCatalog, groupsOf, compareGroups, GROUP_BY } from './catalog.mjs';

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
export const SHEET_LAYOUTS = { grid: 'Planche-contact (grille de vignettes)', detail: 'Fiches détaillées (une photo par page)', catalog: 'Catalogue thématique (par groupes)', portfolio: 'Portfolio (couverture, une photo par page)' };
/** Fonds du portfolio : couleur de page, du texte principal et secondaire. */
export const SHEET_BACKGROUNDS = {
  white: { label: 'Blanc', page: '#ffffff', ink: '#1e293b', soft: '#64748b', rule: '#cbd5e1' },
  grey: { label: 'Gris clair', page: '#e7e5e4', ink: '#1c1917', soft: '#57534e', rule: '#a8a29e' },
  black: { label: 'Noir', page: '#111111', ink: '#f5f5f5', soft: '#a3a3a3', rule: '#404040' },
};
export const SHEET_DEFAULTS = { layout: 'grid', groupBy: 'year', page: 'a4-portrait', columns: 4, rows: 5, fields: ['number', 'name', 'date'], title: '', quality: 'screen', edited: true, margin: 12, background: 'white', subtitle: '', author: '', cover: true };
export const MAX_SHEET_PHOTOS = 3000;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const int = (v, d, a, b) => (Number.isFinite(+v) && v !== '' && v !== null ? clamp(Math.round(+v), a, b) : d);
const P = s => { try { return JSON.parse(s); } catch { return null; } };

/** Options nettoyées (toute valeur inconnue retombe sur la valeur par défaut). */
export function cleanSheetOptions(o = {}) {
  const fields = (Array.isArray(o.fields) ? o.fields : typeof o.fields === 'string' ? o.fields.split(',') : SHEET_DEFAULTS.fields)
    .map(String).filter((f, i, a) => SHEET_FIELDS[f] && a.indexOf(f) === i);
  return {
    layout: SHEET_LAYOUTS[o.layout] ? o.layout : SHEET_DEFAULTS.layout,
    groupBy: GROUP_BY[o.groupBy] ? o.groupBy : SHEET_DEFAULTS.groupBy,
    page: SHEET_PAGES[o.page] ? o.page : SHEET_DEFAULTS.page,
    columns: int(o.columns, SHEET_DEFAULTS.columns, 1, 12),
    rows: int(o.rows, SHEET_DEFAULTS.rows, 1, 16),
    fields,
    title: String(o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    quality: SHEET_QUALITIES[o.quality] ? o.quality : SHEET_DEFAULTS.quality,
    edited: o.edited !== false && o.edited !== 'false' && o.edited !== 0,
    margin: int(o.margin, SHEET_DEFAULTS.margin, 5, 30),
    background: SHEET_BACKGROUNDS[o.background] ? o.background : SHEET_DEFAULTS.background,
    subtitle: String(o.subtitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    author: String(o.author ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    cover: o.cover !== false && o.cover !== 'false' && o.cover !== 0,
  };
}

/** Coupe un texte pour qu'il tienne en `max` points (points de suspension). */
export function fitText(text, size, max, bold = false) {
  let s = String(text ?? '');
  if (textWidth(s, size, bold) <= max) return s;
  while (s.length > 1 && textWidth(s + '…', size, bold) > max) s = s.slice(0, -1);
  return s.length > 1 ? s.trimEnd() + '…' : '';
}

/** Découpe un texte en lignes de `max` points au plus (mots entiers, mot trop long coupé), `maxLines` lignes au plus. */
export function wrapText(text, size, max, maxLines = 3, bold = false) {
  const out = [];
  for (const para of String(text ?? '').split(/\n/)) {
    let line = '';
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (textWidth(w, size, bold) > max) { // mot plus large que la colonne (chemin, empreinte) : coupé
        let k = w.length; while (k > 1 && textWidth((line ? line + ' ' : '') + w.slice(0, k), size, bold) > max) k--;
        if (k <= 1 && line) { out.push(line); line = ''; continue; }
        out.push((line ? line + ' ' : '') + w.slice(0, Math.max(1, k))); line = ''; w = w.slice(Math.max(1, k));
      }
      const t = line ? line + ' ' + w : w;
      if (textWidth(t, size, bold) <= max) line = t; else { out.push(line); line = w; }
    }
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  if (out.length > maxLines) { const keep = out.slice(0, maxLines); let l = keep[maxLines - 1]; while (l && textWidth(l + ' …', size, bold) > max) l = l.slice(0, -1); keep[maxLines - 1] = l.trimEnd() + ' …'; return keep; }
  return out;
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
  const catalog = createCatalog(db);

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
      else if (f === 'keywords') out.push(keywordNamesOf(p.keywords_text).join(', '));
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
    if (o.layout === 'detail') return renderDetail(list, o, { write, label, W, H, M });
    if (o.layout === 'portfolio') return renderPortfolio(list, o, { write, label, W, H, M });
    const isCat = o.layout === 'catalog';
    // sections : une seule (planche-contact) ou une par groupe (catalogue thématique), chacune sur ses pages
    let sections = [{ name: null, items: list.map((p, i) => ({ p, n: i + 1 })) }], capped = false;
    if (isCat) {
      const groups = new Map();
      for (const p of list) {
        const r = catalog.record(p.id);
        for (const g of groupsOf(r, o.groupBy)) {
          if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
          groups.get(g.key).items.push(p);
        }
      }
      let n = 0;
      sections = [...groups.values()].sort(compareGroups).map(g => ({ name: g.label, items: g.items.map(p => ({ p, n: ++n })) }));
      // une photo peut figurer dans plusieurs groupes (mots-clés) : le total des cases reste borné
      if (n > MAX_SHEET_PHOTOS) {
        capped = true; let left = MAX_SHEET_PHOTOS;
        sections = sections.map(s => { const it = s.items.slice(0, Math.max(0, left)); left -= it.length; return { ...s, items: it }; }).filter(s => s.items.length);
      }
    }
    const perPage = o.columns * o.rows;
    const headH = o.title ? 12 * MM : 0, footH = 7 * MM, gap = 3 * MM, bandH = isCat ? 10 * MM : 0;
    // sommaire du catalogue : une ligne par groupe (nombre de photos, page de début)
    const sumLineH = 5.5 * MM, sumTop = M + headH + 16 * MM;
    const sumPerPage = Math.max(1, Math.floor((H - M - footH - sumTop) / sumLineH));
    const sumPages = isCat ? Math.ceil(sections.length / sumPerPage) : 0;
    let pageNo = sumPages;
    for (const s of sections) { s.first = pageNo + 1; s.pages = Math.ceil(s.items.length / perPage); pageNo += s.pages; }
    const pages = pageNo, cells = sections.reduce((a, s) => a + s.items.length, 0);
    const cellW = (W - 2 * M - gap * (o.columns - 1)) / o.columns;
    const cellH = (H - 2 * M - headH - bandH - footH - gap * (o.rows - 1)) / o.rows;
    const fs2 = clamp(cellW / 18, 5, 9), lineH = fs2 * 1.25;
    const capFields = o.fields.filter(f => f !== 'number'), numbered = o.fields.includes('number');
    const capLines = capFields.length + (numbered && !capFields.length ? 1 : 0);
    const capH = capLines * lineH + (capLines ? 2 : 0);
    const boxW = cellW, boxH = cellH - capH;
    if (boxH < 10 * MM || boxW < 10 * MM) throw new Error('Trop de photos par page ou trop de légendes : réduisez les colonnes, les lignes ou les champs');
    const boxPx = [Math.round(boxW / 72 * SHEET_QUALITIES[q].dpi), Math.round(boxH / 72 * SHEET_QUALITIES[q].dpi)];

    const pdf = new PdfWriter(write);
    const report = { layout: o.layout, photos: list.length, pages, columns: o.columns, rows: o.rows, page: o.page, quality: q, images: 0, edited: 0, fromPreview: [], fromOriginal: 0, unreadable: [] };
    if (isCat) Object.assign(report, { groupBy: o.groupBy, groups: sections.map(s => ({ name: s.name, photos: s.items.length, page: s.first })), cells, capped });
    const stamp = fmtDate(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString());
    const docTitle = o.title || label || (isCat ? `Catalogue par ${GROUP_BY[o.groupBy].toLowerCase()}` : 'Planche-contact');
    const footerLeft = fitText([docTitle, `${list.length} photo(s)`, stamp].filter(Boolean).join(' · '), 7, W / 2);
    const header = c => {
      c.rect(0, 0, W, H, '#ffffff');
      if (o.title) {
        c.text(fitText(o.title, 14, W - 2 * M, true), M, M + 10, 14, { bold: true, color: '#1e293b' });
        c.rect(M, M + headH - 4 * MM, W - 2 * M, 0.6, '#cbd5e1');
      }
    };
    const footer = (c, n, extra) => {
      c.text(extra ? fitText(`${footerLeft} · ${extra}`, 7, W * 0.7) : footerLeft, M, H - M + 2, 7, { color: '#64748b' });
      c.text(`Page ${n} / ${pages}`, W - M, H - M + 2, 7, { color: '#64748b', align: 'right' });
    };

    // ---- sommaire (catalogue thématique) ----
    for (let sp = 0; sp < sumPages; sp++) {
      const c = new PageContent(H); header(c);
      let y = M + headH + 8 * MM;
      c.text(sp ? 'Sommaire (suite)' : 'Sommaire', M, y, 13, { bold: true, color: '#1e293b' });
      c.text(fitText(`Catalogue par ${GROUP_BY[o.groupBy].toLowerCase()} · ${sections.length} groupe(s) · ${list.length} photo(s)${capped ? ` · limité à ${MAX_SHEET_PHOTOS} cases` : ''}`, 8, W / 2), W - M, y, 8, { color: '#64748b', align: 'right' });
      y = sumTop;
      for (const s of sections.slice(sp * sumPerPage, (sp + 1) * sumPerPage)) {
        const right = `${s.items.length} photo(s)`, pw = 14 * MM, cw = textWidth(right, 9) + 6 * MM;
        c.text(fitText(s.name, 9, W - 2 * M - pw - cw), M, y, 9, { color: '#1e293b' });
        c.text(right, W - M - pw, y, 9, { color: '#64748b', align: 'right' });
        c.text(String(s.first), W - M, y, 9, { bold: true, color: '#1e293b', align: 'right' });
        c.rect(M, y + 1.6 * MM, W - 2 * M, 0.3, '#e2e8f0');
        y += sumLineH;
      }
      footer(c, sp + 1, null);
      pdf.page(c, { media: [0, 0, W, H] });
    }

    for (const sec of sections) for (let sp = 0; sp < sec.pages; sp++) {
      const c = new PageContent(H); header(c);
      if (isCat) { // bandeau du groupe, répété (« suite ») sur ses pages suivantes
        const by = M + headH;
        c.rect(M, by, W - 2 * M, bandH - 3 * MM, '#e2e8f0');
        const cnt = `${sec.items.length} photo(s)`;
        c.text(cnt, W - M - 2 * MM, by + 4.8 * MM, 8, { color: '#475569', align: 'right' });
        c.text(fitText(sec.name + (sp ? ' (suite)' : ''), 10.5, W - 2 * M - textWidth(cnt, 8) - 8 * MM, true), M + 2 * MM, by + 5 * MM, 10.5, { bold: true, color: '#1e293b' });
      }
      for (let k = 0; k < perPage; k++) {
        const it = sec.items[sp * perPage + k]; if (!it) break;
        const p = it.p, i = it.n - 1, files = filesOf.all(p.id);
        const col = k % o.columns, row = Math.floor(k / o.columns);
        const x = M + col * (cellW + gap), y = M + headH + bandH + row * (cellH + gap);
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
      footer(c, sec.first + sp, sec.name);
      pdf.page(c, { media: [0, 0, W, H] });
    }
    const out = pdf.end({ title: docTitle });
    report.bytes = out.bytes;
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), isCat ? 'catalog' : 'contact-sheet', docTitle, q, list.length, 'ok', new Date().toISOString(), JSON.stringify({ options: o, ...report }));
    if (isCat) logHistory(db, 'catalog.pdf', `Catalogue par ${GROUP_BY[o.groupBy].toLowerCase()} produit (${list.length} photo(s), ${sections.length} groupe(s), ${pages} page(s))`, { photos: list.length, pages });
    else logHistory(db, 'contactsheet.pdf', `Planche-contact produite (${list.length} photo(s), ${pages} page(s), ${o.columns} × ${o.rows})`, { photos: list.length, pages });
    return report;
  }

  /**
   * Fiches détaillées : une photo par page, l'image en haut (entière), puis toutes ses informations
   * documentaires (lib/catalog.mjs detailLines) en tableau libellé / valeur. Les colonnes, lignes et
   * champs de légende de la planche ne s'appliquent pas.
   */
  async function renderDetail(list, o, { write, label, W, H, M }) {
    const q = o.quality, pages = list.length;
    const headH = o.title ? 12 * MM : 0, footH = 7 * MM;
    const top = M + headH, bottom = H - M - footH;
    const boxW = W - 2 * M, boxH = (bottom - top) * (W > H ? 0.62 : 0.55);
    const boxPx = [Math.round(boxW / 72 * SHEET_QUALITIES[q].dpi), Math.round(boxH / 72 * SHEET_QUALITIES[q].dpi)];
    const fsz = 8.5, lineH = fsz * 1.3, labW = 34 * MM, valW = boxW - labW - 2 * MM;
    const pdf = new PdfWriter(write);
    const report = { layout: 'detail', photos: list.length, pages, page: o.page, quality: q, images: 0, edited: 0, fromPreview: [], fromOriginal: 0, unreadable: [], truncated: [] };
    const stamp = fmtDate(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString());
    const docTitle = o.title || label || 'Fiches détaillées';
    const footerLeft = fitText([docTitle, `${list.length} fiche(s)`, stamp].filter(Boolean).join(' · '), 7, W / 2);

    for (let i = 0; i < list.length; i++) {
      const p = list[i], files = filesOf.all(p.id), r = catalog.record(p.id, i + 1);
      const c = new PageContent(H);
      c.rect(0, 0, W, H, '#ffffff');
      if (o.title) {
        c.text(fitText(o.title, 14, W - 2 * M, true), M, M + 10, 14, { bold: true, color: '#1e293b' });
        c.rect(M, M + headH - 4 * MM, W - 2 * M, 0.6, '#cbd5e1');
      }
      c.rect(M, top, boxW, boxH, '#f1f5f9');
      const img = await imageOf(p, files, q, o, boxPx);
      if (img) {
        const s = Math.min(boxW / img.width, boxH / img.height), dw = img.width * s, dh = img.height * s;
        c.image(pdf.jpeg(img.data, img.width, img.height, img.channels), M + (boxW - dw) / 2, top + (boxH - dh) / 2, dw, dh);
        report.images++;
        if (img.edited) report.edited++;
        if (img.from === 'apercu' && q === 'print') report.fromPreview.push(i + 1);
        if (img.from === 'original') report.fromOriginal++;
      } else {
        report.unreadable.push({ n: i + 1, id: p.id, name: files[0]?.file_name ?? null });
        c.text('image illisible', M + boxW / 2, top + boxH / 2, 10, { color: '#94a3b8', align: 'center' });
      }
      // en-tête de la fiche : numéro et nom du fichier
      let y = top + boxH + 6 * MM;
      const num = `N° ${i + 1}`, nw = textWidth(num, 11, true) + 8;
      c.text(num, M, y, 11, { bold: true, color: '#1e293b' });
      c.text(fitText(files[0]?.file_name ?? r.title ?? p.id, 11, boxW - nw, true), M + nw, y, 11, { bold: true, color: '#334155' });
      y += 3 * MM; c.rect(M, y, boxW, 0.5, '#cbd5e1'); y += 2 * MM + fsz;
      // tableau libellé / valeur ; ce qui ne tient pas sur la page est signalé
      let cut = false;
      for (const { label: lab, value } of catalog.detailLines(r)) {
        const lines = wrapText(value, fsz, valW, /^(Description|Notes)$/.test(lab) ? 6 : 3);
        if (y + (lines.length - 1) * lineH > bottom - 2) { cut = true; break; }
        c.text(fitText(lab, fsz, labW - 2, true), M, y, fsz, { bold: true, color: '#64748b' });
        lines.forEach((t, j) => c.text(t, M + labW, y + j * lineH, fsz, { color: '#1e293b' }));
        y += lines.length * lineH + 2;
      }
      if (cut) { report.truncated.push(i + 1); c.text('… informations suivantes non imprimées (place insuffisante)', M + labW, Math.min(y, bottom), 7, { color: '#94a3b8' }); }
      c.text(footerLeft, M, H - M + 2, 7, { color: '#64748b' });
      c.text(`Page ${i + 1} / ${pages}`, W - M, H - M + 2, 7, { color: '#64748b', align: 'right' });
      pdf.page(c, { media: [0, 0, W, H] });
    }
    const out = pdf.end({ title: docTitle });
    report.bytes = out.bytes;
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'detail-sheets', docTitle, q, list.length, 'ok', new Date().toISOString(), JSON.stringify({ options: o, ...report }));
    logHistory(db, 'detailsheets.pdf', `Fiches détaillées produites (${list.length} photo(s))`, { photos: list.length });
    return report;
  }

  /**
   * Portfolio : une couverture (première photo, titre, sous-titre, auteur), puis une photo par page,
   * aussi grande que les marges le permettent, sur un fond blanc, gris ou noir, avec une légende sobre
   * centrée sous l'image (titre ou nom en gras, puis les autres champs choisis) et un folio discret.
   */
  async function renderPortfolio(list, o, { write, label, W, H, M }) {
    const q = o.quality, bg = SHEET_BACKGROUNDS[o.background], cover = o.cover ? 1 : 0, pages = list.length + cover;
    const capFields = o.fields.filter(f => f !== 'number'), numbered = o.fields.includes('number');
    const capH = capFields.length || numbered ? (capFields.length > 1 ? 16 : 11) * MM : 4 * MM, folioH = 6 * MM;
    const boxW = W - 2 * M, boxH = H - 2 * M - capH - folioH;
    const boxPx = [Math.round(boxW / 72 * SHEET_QUALITIES[q].dpi), Math.round(boxH / 72 * SHEET_QUALITIES[q].dpi)];
    const pdf = new PdfWriter(write);
    const report = { layout: 'portfolio', photos: list.length, pages, page: o.page, quality: q, background: o.background, cover: !!cover, images: 0, edited: 0, fromPreview: [], fromOriginal: 0, unreadable: [] };
    const docTitle = o.title || label || 'Portfolio';
    const today = fmtDate(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString()).slice(0, 10);
    const count = (img, i) => {
      report.images++;
      if (img.edited) report.edited++;
      if (img.from === 'apercu' && q === 'print') report.fromPreview.push(i + 1);
      if (img.from === 'original') report.fromOriginal++;
    };
    const place = (c, img, x, y, w, h) => {
      const s = Math.min(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
      c.image(pdf.jpeg(img.data, img.width, img.height, img.channels), x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      return { top: y + (h - dh) / 2, bottom: y + (h + dh) / 2 };
    };

    // ---- couverture : la première photo, puis le titre ----
    if (cover) {
      const c = new PageContent(H); c.rect(0, 0, W, H, bg.page);
      const ch = (H - 2 * M) * 0.58, p = list[0], files = filesOf.all(p.id);
      const img = await imageOf(p, files, q, o, [boxPx[0], Math.round(boxPx[1] * 0.75)]);
      let y = M + 8 * MM + ch;
      if (img) y = place(c, img, M, M + 8 * MM, boxW, ch).bottom;
      y += 16 * MM;
      for (const t of wrapText(docTitle, 24, boxW, 2, true)) { c.text(t, W / 2, y, 24, { bold: true, color: bg.ink, align: 'center' }); y += 29; }
      if (o.subtitle) for (const t of wrapText(o.subtitle, 12, boxW, 2)) { y += 2; c.text(t, W / 2, y, 12, { color: bg.soft, align: 'center' }); y += 15; }
      c.rect(W / 2 - 12 * MM, y + 2 * MM, 24 * MM, 0.8, bg.rule);
      y += 10 * MM;
      if (o.author) { c.text(fitText(o.author, 11, boxW), W / 2, y, 11, { color: bg.ink, align: 'center' }); y += 15; }
      c.text(`${list.length} photographie${list.length > 1 ? 's' : ''} · ${today}`, W / 2, y + 2, 8, { color: bg.soft, align: 'center' });
      pdf.page(c, { media: [0, 0, W, H] });
    }

    // ---- une photo par page ----
    for (let i = 0; i < list.length; i++) {
      const p = list[i], files = filesOf.all(p.id);
      const c = new PageContent(H); c.rect(0, 0, W, H, bg.page);
      const img = await imageOf(p, files, q, o, boxPx);
      let bottom = M + boxH;
      if (img) { bottom = place(c, img, M, M, boxW, boxH).bottom; count(img, i); }
      else { report.unreadable.push({ n: i + 1, id: p.id, name: files[0]?.file_name ?? null }); c.text('image illisible', W / 2, M + boxH / 2, 10, { color: bg.soft, align: 'center' }); }
      // légende : le titre (ou le nom du fichier) en gras, puis les autres champs sur une ligne
      const vals = captionOf(p, files[0], capFields);
      const pairs = capFields.map((f, k) => [f, vals[k]]).filter(([, v]) => v && v !== 'sans date');
      let mi = pairs.findIndex(([f]) => f === 'title'); if (mi < 0) mi = pairs.findIndex(([f]) => f === 'name');
      const rest = pairs.filter((_, k) => k !== mi).map(([, v]) => v);
      let y = bottom + 7 * MM;
      const head = [numbered ? String(i + 1) : '', mi >= 0 ? pairs[mi][1] : ''].filter(Boolean).join('  ·  ');
      if (head) { c.text(fitText(head, 10, boxW, true), W / 2, y, 10, { bold: true, color: bg.ink, align: 'center' }); y += 13; }
      if (rest.length) c.text(fitText(rest.join('  ·  '), 8, boxW), W / 2, y, 8, { color: bg.soft, align: 'center' });
      c.text(String(i + 1 + cover), W / 2, H - M + 2, 7, { color: bg.soft, align: 'center' });
      pdf.page(c, { media: [0, 0, W, H] });
    }
    const out = pdf.end({ title: docTitle });
    report.bytes = out.bytes;
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), 'portfolio', docTitle, q, list.length, 'ok', new Date().toISOString(), JSON.stringify({ options: o, ...report }));
    logHistory(db, 'portfolio.pdf', `Portfolio produit (${list.length} photo(s), ${pages} page(s))`, { photos: list.length, pages });
    return report;
  }

  return { render };
}
