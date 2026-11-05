// Écriture PDF minimale, sans dépendance : pages, aplats de couleur, images JPEG (DCTDecode) et texte
// en Helvetica (police standard du PDF, encodage WinAnsi : accents français pris en charge).
// Les objets sont écrits au fil de l'eau par `write(buffer)` (synchrone) : une image n'est jamais
// gardée en mémoire après son écriture, ce qui permet de produire de gros albums.

export const MM = 72 / 25.4; // points par millimètre

// Chasses Helvetica (AFM Adobe, millièmes de cadratin) pour les caractères 32 à 126.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Caractères WinAnsi hors Latin-1 (plage 0x80–0x9F) utiles en français.
const WIN_EXTRA = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, 'œ': 0x9c, 'Œ': 0x8c, 'Ÿ': 0x9f, '™': 0x99 };
const WIDE = { 0x80: 556, 0x82: 222, 0x84: 333, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x9c: 944, 0x8c: 1000, 0x9f: 667, 0x99: 1000,
  0xa0: 278, 0xab: 556, 0xbb: 556, 0xb0: 400, 0xc6: 1000, 0xe6: 889, 0xdf: 611 };

/** Texte → octets WinAnsi (les caractères non représentables sont ramenés à leur lettre de base, sinon « ? »). */
export function winAnsi(text) {
  const out = [];
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 0x202f || c === 0x2009) out.push(0xa0); // espaces fines → insécable
    else if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN_EXTRA[ch]) out.push(WIN_EXTRA[ch]);
    else if (c === 9 || c === 10 || c === 13) out.push(32);
    else {
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      const b = base.codePointAt(0);
      out.push(base && b >= 32 && b <= 126 ? b : 63);
    }
  }
  return Buffer.from(out);
}

function charWidth(b, bold) {
  if (b >= 32 && b <= 126) return (bold ? HELV_BOLD : HELV)[b - 32];
  if (WIDE[b]) return WIDE[b];
  if (b >= 0xc0) { // lettres accentuées : chasse de la lettre de base
    const base = String.fromCharCode(b).normalize('NFD')[0].charCodeAt(0);
    if (base >= 32 && base <= 126) return (bold ? HELV_BOLD : HELV)[base - 32];
  }
  return 556;
}
/** Largeur d'un texte en points pour un corps donné. */
export function textWidth(text, size, bold = false) {
  let w = 0; for (const b of winAnsi(text)) w += charWidth(b, bold);
  return (w * size) / 1000;
}

/** Coupe un texte en lignes d'au plus `maxWidth` points (un mot trop long reste seul sur sa ligne). */
export function wrapText(text, size, maxWidth, bold = false) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    const tryLine = cur ? cur + ' ' + w : w;
    if (!cur || textWidth(tryLine, size, bold) <= maxWidth) cur = tryLine;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const pdfString = buf => {
  let s = '(';
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
};
const num = n => (Math.round(n * 1000) / 1000).toString();
const rgb = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') ?? [, 'ffffff']; const v = parseInt(m[1], 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]; };

/** Couleur de texte lisible sur un fond donné (sombre sur fond clair, blanc sur fond foncé). */
export function textColorOn(bg) {
  const [r, g, b] = rgb(bg).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.25 ? '#1e293b' : '#ffffff';
}

/** Instructions de dessin d'une page (coordonnées en points, origine en HAUT à gauche pour l'appelant). */
export class PageContent {
  constructor(height) { this.h = height; this.ops = []; this.images = {}; this.fonts = new Set(); }
  rect(x, y, w, h, color) {
    const [r, g, b] = rgb(color);
    this.ops.push(`${num(r)} ${num(g)} ${num(b)} rg ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re f`);
  }
  image(ref, x, y, w, h) {
    const name = 'Im' + ref; this.images[name] = ref;
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.h - y - h)} cm /${name} Do Q`);
  }
  /** Texte sur une ligne ; `align` : left, center, right par rapport à x ; y = ligne de base. */
  text(str, x, y, size, { bold = false, color = '#000000', align = 'left' } = {}) {
    if (!str) return;
    const font = bold ? 'F2' : 'F1'; this.fonts.add(font);
    const w = textWidth(str, size, bold);
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const [r, g, b] = rgb(color);
    this.ops.push(`BT ${num(r)} ${num(g)} ${num(b)} rg /${font} ${num(size)} Tf ${num(x0)} ${num(this.h - y)} Td ${pdfString(winAnsi(str))} Tj ET`);
  }
}

/** Écrivain PDF 1.4. `write(buf)` reçoit les octets dans l'ordre (synchrone). */
export class PdfWriter {
  constructor(write) {
    this.write = write; this.offset = 0; this.offsets = []; this.pages = []; this.fontRefs = {};
    this.next = 3; // 1 = catalogue, 2 = arbre des pages (écrits à la fin)
    this.out(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  }
  out(buf) { this.write(buf); this.offset += buf.length; }
  object(dict, stream = null, ref = this.next++) {
    this.offsets[ref] = this.offset;
    if (stream) {
      this.out(Buffer.from(`${ref} 0 obj\n${dict.replace(/>>$/, '')} /Length ${stream.length} >>\nstream\n`, 'latin1'));
      this.out(stream); this.out(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else this.out(Buffer.from(`${ref} 0 obj\n${dict}\nendobj\n`, 'latin1'));
    return ref;
  }
  /** Image JPEG (1 composante = gris, 3 = RVB) ; renvoie sa référence, réutilisable sur plusieurs pages. */
  jpeg(buf, width, height, channels = 3) {
    const cs = channels === 1 ? '/DeviceGray' : channels === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    return this.object(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode >>`, buf);
  }
  font(key) {
    if (!this.fontRefs[key]) this.fontRefs[key] = this.object(`<< /Type /Font /Subtype /Type1 /BaseFont /${key === 'F2' ? 'Helvetica-Bold' : 'Helvetica'} /Encoding /WinAnsiEncoding >>`);
    return this.fontRefs[key];
  }
  /** Ajoute une page. Boîtes en points [x0, y0, x1, y1] ; `trim` et `bleed` facultatifs (fonds perdus). */
  page(content, { media, trim, bleed }) {
    const fonts = [...content.fonts].map(f => `/${f} ${this.font(f)} 0 R`).join(' ');
    const xobj = Object.entries(content.images).map(([n, r]) => `/${n} ${r} 0 R`).join(' ');
    const stream = Buffer.from(content.ops.join('\n'), 'latin1');
    const c = this.object('<< >>', stream);
    const box = b => `[${b.map(num).join(' ')}]`;
    const ref = this.object(`<< /Type /Page /Parent 2 0 R /MediaBox ${box(media)}${trim ? ` /TrimBox ${box(trim)}` : ''}${bleed ? ` /BleedBox ${box(bleed)}` : ''}`
      + ` /Resources << /ProcSet [/PDF /Text /ImageB /ImageC] ${fonts ? `/Font << ${fonts} >> ` : ''}${xobj ? `/XObject << ${xobj} >> ` : ''}>> /Contents ${c} 0 R >>`);
    this.pages.push(ref);
    return ref;
  }
  /** Termine le fichier (arbre des pages, catalogue, métadonnées, table des références). */
  end({ title = '', producer = 'Photothèque' } = {}) {
    if (!this.pages.length) throw new Error('PDF sans page');
    this.object(`<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map(r => `${r} 0 R`).join(' ')}] >>`, null, 2);
    this.object('<< /Type /Catalog /Pages 2 0 R >>', null, 1);
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const date = `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    const info = this.object(`<< /Title ${pdfString(winAnsi(title))} /Producer ${pdfString(winAnsi(producer))} /CreationDate (${date}) >>`);
    const size = this.next, xref = this.offset;
    let t = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) t += `${String(this.offsets[i] ?? 0).padStart(10, '0')} 00000 ${this.offsets[i] != null ? 'n' : 'f'} \n`;
    t += `trailer\n<< /Size ${size} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.out(Buffer.from(t, 'latin1'));
    return { pages: this.pages.length, bytes: this.offset };
  }
}
