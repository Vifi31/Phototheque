// Rendu d'une page en image (pour un dossier « JPEG par page ») avec la même interface de dessin que
// PageContent (lib/pdf.mjs) : coordonnées en points, origine en haut à gauche, save / clip / restore,
// aplats, images, texte. Le dessin est enregistré en calques puis composé par sharp en une passe :
// les aplats et les textes consécutifs forment un calque SVG, chaque image un calque à part.

const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const n2 = v => Math.round(v * 100) / 100;

export class RasterCanvas {
  /** `scale` : pixels par point (dpi / 72). */
  constructor(widthPt, heightPt, scale) {
    this.s = scale; this.W = Math.max(1, Math.round(widthPt * scale)); this.H = Math.max(1, Math.round(heightPt * scale));
    this.layers = []; this.clips = [[0, 0, this.W, this.H]]; this.stack = []; this.vec = null; this.k = 0;
  }
  get clipBox() { return this.clips[this.clips.length - 1]; }
  save() { this.stack.push(this.clips.length); }
  restore() { this.clips.length = Math.max(1, this.stack.pop() ?? 1); this.vec = null; }
  clip(x, y, w, h) {
    const s = this.s, c = this.clipBox;
    const x0 = Math.max(c[0], x * s), y0 = Math.max(c[1], y * s), x1 = Math.min(c[2], (x + w) * s), y1 = Math.min(c[3], (y + h) * s);
    this.clips.push([x0, y0, Math.max(x0, x1), Math.max(y0, y1)]); this.vec = null;
  }
  svg(el) { if (!this.vec) { this.vec = []; this.layers.push({ svg: this.vec }); } this.vec.push(el); }
  rect(x, y, w, h, color) {
    const s = this.s, c = this.clipBox;
    const x0 = Math.max(c[0], x * s), y0 = Math.max(c[1], y * s), x1 = Math.min(c[2], (x + w) * s), y1 = Math.min(c[3], (y + h) * s);
    if (x1 <= x0 || y1 <= y0) return;
    this.svg(`<rect x="${n2(x0)}" y="${n2(y0)}" width="${n2(x1 - x0)}" height="${n2(y1 - y0)}" fill="${xml(color)}"/>`);
  }
  /** `ref` : { data (JPEG), width, height } ; l'image est étirée au rectangle, puis rognée à la zone de dessin. */
  image(ref, x, y, w, h) {
    const s = this.s, c = this.clipBox;
    const L = Math.round(x * s), T = Math.round(y * s), R = Math.round((x + w) * s), B = Math.round((y + h) * s);
    const cx0 = Math.max(L, Math.ceil(c[0]), 0), cy0 = Math.max(T, Math.ceil(c[1]), 0);
    const cx1 = Math.min(R, Math.floor(c[2]), this.W), cy1 = Math.min(B, Math.floor(c[3]), this.H);
    if (cx1 <= cx0 || cy1 <= cy0) return;
    this.layers.push({ image: ref, tw: R - L, th: B - T, extract: { left: cx0 - L, top: cy0 - T, width: cx1 - cx0, height: cy1 - cy0 }, left: cx0, top: cy0 });
    this.vec = null;
  }
  text(str, x, y, size, { bold = false, color = '#000000', align = 'left' } = {}) {
    if (!str) return;
    const s = this.s, c = this.clipBox, id = 'k' + (++this.k);
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    this.svg(`<clipPath id="${id}"><rect x="${n2(c[0])}" y="${n2(c[1])}" width="${n2(c[2] - c[0])}" height="${n2(c[3] - c[1])}"/></clipPath>`
      + `<text clip-path="url(#${id})" x="${n2(x * s)}" y="${n2(y * s)}" font-family="Helvetica, Arial, sans-serif" font-size="${n2(size * s)}"${bold ? ' font-weight="bold"' : ''} text-anchor="${anchor}" fill="${xml(color)}">${xml(str)}</text>`);
  }
  /** Image finale : instance sharp (fond blanc, calques composés), à encoder par l'appelant. */
  async compose() {
    const { default: sharp } = await import('sharp');
    const inputs = [];
    for (const l of this.layers) {
      if (l.svg) {
        if (!l.svg.length) continue;
        inputs.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${this.W}" height="${this.H}">${l.svg.join('')}</svg>`), left: 0, top: 0 });
      } else {
        const buf = await sharp(l.image.data, { failOn: 'none' }).resize(Math.max(1, l.tw), Math.max(1, l.th), { fit: 'fill' }).extract(l.extract).toBuffer();
        inputs.push({ input: buf, left: l.left, top: l.top });
      }
    }
    const base = sharp({ create: { width: this.W, height: this.H, channels: 3, background: '#ffffff' }, limitInputPixels: false });
    // composite en une passe, puis repris comme image ordinaire (encodage, profil, densité)
    const { data, info } = await base.composite(inputs).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
    return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: false });
  }
}
