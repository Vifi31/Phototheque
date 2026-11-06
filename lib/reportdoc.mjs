// Documents tabulaires en PDF (inventaires et rapports, cahier des charges §14) : titre, indicateurs,
// blocs « libellé / valeur » et tableaux paginés dont l'en-tête est répété sur chaque page. Sans image,
// sans dépendance (lib/pdf.mjs). Mise en page en deux temps : les pages sont composées, puis écrites
// avec leur pied de page « Page n / N ».
import { PdfWriter, PageContent, MM } from './pdf.mjs';
import { fitText, wrapText } from './contactsheet.mjs';

const TONES = { bad: '#b91c1c', warn: '#b45309', ok: '#15803d', dim: '#64748b' };
const W = 210 * MM, H = 297 * MM, M = 14 * MM, FOOT = 8 * MM;

/**
 * doc = { title, subtitle, sections: [section] } ; section = {
 *   heading, note,                       // titre de section et texte d'introduction (facultatifs)
 *   kpis: [[libellé, valeur, ton]],      // indicateurs en cases
 *   info: [[libellé, valeur]],           // bloc libellé / valeur
 *   columns: [{ label, w, align }],      // tableau : largeurs relatives
 *   rows: [[cellules] | { cells, tone }],
 *   empty,                               // texte si le tableau est vide
 *   newPage,                             // commencer sur une nouvelle page
 * }
 * `write(buffer)` reçoit le PDF. Renvoie { pages, bytes }.
 */
export function renderTableDoc(doc, write) {
  const pages = [];
  let c = null, y = 0;
  const newPage = () => { c = new PageContent(H); c.rect(0, 0, W, H, '#ffffff'); pages.push(c); y = M; };
  const room = need => { if (y + need > H - M - FOOT) { newPage(); return true; } return false; };
  newPage();
  // ---- titre ----
  c.text(fitText(doc.title, 16, W - 2 * M, true), M, y + 14, 16, { bold: true, color: '#0f172a' });
  y += 20;
  if (doc.subtitle) for (const l of wrapText(doc.subtitle, 8.5, W - 2 * M, 3)) { c.text(l, M, y + 8, 8.5, { color: '#475569' }); y += 11; }
  c.rect(M, y + 3, W - 2 * M, 0.7, '#cbd5e1'); y += 10;

  for (const s of doc.sections ?? []) {
    if (s.newPage && y > M + 40) newPage();
    if (s.heading) {
      room(40); y += 6;
      c.text(fitText(s.heading, 12, W - 2 * M, true), M, y + 10, 12, { bold: true, color: '#1e293b' });
      y += 16;
    }
    if (s.note) for (const l of wrapText(s.note, 8, W - 2 * M, 8)) { room(11); c.text(l, M, y + 7, 8, { color: '#475569' }); y += 10.5; }
    if (s.note) y += 3;
    // ---- indicateurs ----
    if (s.kpis?.length) {
      const per = Math.min(4, s.kpis.length), gap = 3 * MM, kw = (W - 2 * M - gap * (per - 1)) / per, kh = 13 * MM;
      for (let i = 0; i < s.kpis.length; i += per) {
        room(kh + 4);
        s.kpis.slice(i, i + per).forEach(([lab, val, tone], k) => {
          const x = M + k * (kw + gap);
          c.rect(x, y, kw, kh, tone === 'bad' ? '#fee2e2' : tone === 'warn' ? '#fef3c7' : tone === 'ok' ? '#dcfce7' : '#f1f5f9');
          c.text(fitText(String(val ?? ''), 13, kw - 6, true), x + 3 * MM, y + 6.2 * MM, 13, { bold: true, color: TONES[tone] ?? '#0f172a' });
          c.text(fitText(lab, 7, kw - 6), x + 3 * MM, y + 10.5 * MM, 7, { color: '#475569' });
        });
        y += kh + 3 * MM;
      }
    }
    // ---- bloc libellé / valeur ----
    if (s.info?.length) {
      const labW = 42 * MM, valW = W - 2 * M - labW, fz = 8.5, lh = fz * 1.3;
      for (const [lab, val] of s.info) {
        if (val === null || val === undefined || String(val).trim() === '') continue;
        const lines = wrapText(String(val), fz, valW, 4);
        room(lines.length * lh + 2);
        c.text(fitText(lab, fz, labW - 4, true), M, y + fz, fz, { bold: true, color: '#64748b' });
        lines.forEach((t, j) => c.text(t, M + labW, y + fz + j * lh, fz, { color: '#1e293b' }));
        y += lines.length * lh + 2;
      }
      y += 4;
    }
    // ---- tableau ----
    if (s.columns?.length) {
      const fz = 7.5, lh = fz * 1.25, pad = 2.2, tot = s.columns.reduce((a, col) => a + (col.w ?? 1), 0);
      const xs = [], ws = []; let x = M;
      for (const col of s.columns) { const w = (W - 2 * M) * (col.w ?? 1) / tot; xs.push(x); ws.push(w); x += w; }
      const head = () => {
        const hh = lh + 2 * pad;
        c.rect(M, y, W - 2 * M, hh, '#e2e8f0');
        s.columns.forEach((col, k) => {
          const tx = col.align === 'right' ? xs[k] + ws[k] - pad : xs[k] + pad;
          c.text(fitText(col.label, fz, ws[k] - 2 * pad, true), tx, y + pad + fz, fz, { bold: true, color: '#1e293b', align: col.align === 'right' ? 'right' : 'left' });
        });
        y += hh;
      };
      room(3 * lh + 8); head();
      if (!s.rows?.length) { c.text(s.empty ?? 'Aucune ligne.', M + pad, y + pad + fz, fz, { color: '#64748b' }); y += lh + 2 * pad; }
      (s.rows ?? []).forEach((r, i) => {
        const cells = Array.isArray(r) ? r : r.cells, tone = Array.isArray(r) ? null : r.tone;
        const wrapped = cells.map((v, k) => wrapText(String(v ?? ''), fz, ws[k] - 2 * pad, s.columns[k].lines ?? 3));
        const rh = Math.max(1, ...wrapped.map(l => l.length)) * lh + 2 * pad;
        if (room(rh)) { if (s.heading) { c.text(fitText(`${s.heading} (suite)`, 9, W - 2 * M, true), M, y + 9, 9, { bold: true, color: '#64748b' }); y += 14; } head(); }
        if (i % 2) c.rect(M, y, W - 2 * M, rh, '#f8fafc');
        wrapped.forEach((lines, k) => lines.forEach((t, j) => {
          const right = s.columns[k].align === 'right';
          c.text(t, right ? xs[k] + ws[k] - pad : xs[k] + pad, y + pad + fz + j * lh, fz, { color: TONES[tone] ?? '#1e293b', align: right ? 'right' : 'left' });
        }));
        y += rh;
      });
      c.rect(M, y, W - 2 * M, 0.5, '#cbd5e1');
      y += 8;
    }
  }

  const pdf = new PdfWriter(write);
  const foot = fitText(`${doc.title}${doc.stamp ? ' · ' + doc.stamp : ''}`, 7, W * 0.65);
  pages.forEach((p, i) => {
    p.text(foot, M, H - M + 2, 7, { color: '#64748b' });
    p.text(`Page ${i + 1} / ${pages.length}`, W - M, H - M + 2, 7, { color: '#64748b', align: 'right' });
    pdf.page(p, { media: [0, 0, W, H] });
  });
  const out = pdf.end({ title: doc.title });
  return { pages: pages.length, bytes: out.bytes };
}
