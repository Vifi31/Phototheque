// Retouche non destructive : les réglages (JSON versionné) sont rangés dans la table `edits`, jamais
// dans les fichiers. Une photo peut avoir plusieurs versions (« variantes virtuelles »), dont une par
// défaut ; chaque version garde son historique (annuler / rétablir, persistant).
// Le rendu passe par sharp (libvips) : les originaux ne sont lus qu'en lecture.
//
// Ordre du rendu (le même pour l'aperçu et l'export) :
//   1. orientation EXIF appliquée, puis rotation par quarts de tour + redressement (angle libre) ;
//   2. découpe : plus grand rectangle sans coins vides après redressement, puis recadrage choisi ;
//   3. miroirs (sharp retourne toujours APRÈS la découpe : le recadrage, exprimé dans l'image telle
//      qu'affichée, est donc converti en coordonnées non retournées) ;
//   4. redimensionnement éventuel ;
//   5. lumière et couleur : exposition, luminosité, contraste, température, teinte (une seule opération
//      linéaire par canal) ;
//   6. traitement pixel par pixel (applyPixelOps, seulement si l'un de ces réglages est actif) : réduction du
//      bruit (luminance : filtre bilatéral ; couleur : flou de la chrominance), hautes lumières et ombres
//      (sur la luminance, teinte conservée), courbe de tonalité, vibrance ;
//   7. saturation, noir et blanc ou sépia, netteté.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logHistory } from './db.mjs';
import { THUMBS_DIR } from './paths.mjs';

export const EDIT_PARAMS_VERSION = 1;
const HISTORY_MAX = 50;

/** Réglages : bornes, valeurs neutres et libellés (l'interface les lit pour construire ses curseurs). */
export const EDIT_FIELDS = {
  exposure: { label: 'Exposition (IL)', min: -2, max: 2, step: 0.05, group: 'Lumière' },
  brightness: { label: 'Luminosité', min: -100, max: 100, step: 1, group: 'Lumière' },
  contrast: { label: 'Contraste', min: -100, max: 100, step: 1, group: 'Lumière' },
  highlights: { label: 'Hautes lumières', min: -100, max: 100, step: 1, group: 'Lumière' },
  shadows: { label: 'Ombres', min: -100, max: 100, step: 1, group: 'Lumière' },
  temperature: { label: 'Température (froid ↔ chaud)', min: -100, max: 100, step: 1, group: 'Couleur' },
  tint: { label: 'Teinte (vert ↔ magenta)', min: -100, max: 100, step: 1, group: 'Couleur' },
  vibrance: { label: 'Vibrance (couleurs ternes d’abord)', min: -100, max: 100, step: 1, group: 'Couleur' },
  saturation: { label: 'Saturation', min: -100, max: 100, step: 1, group: 'Couleur' },
  sharpen: { label: 'Netteté', min: 0, max: 100, step: 1, group: 'Détail' },
  noise: { label: 'Réduction du bruit (luminance)', min: 0, max: 100, step: 1, group: 'Détail' },
  colorNoise: { label: 'Réduction du bruit (couleur)', min: 0, max: 100, step: 1, group: 'Détail' },
  straighten: { label: 'Redressement (°)', min: -15, max: 15, step: 0.1, group: 'Géométrie' },
};
export const DEFAULT_PARAMS = Object.freeze({
  v: EDIT_PARAMS_VERSION, rotate: 0, flipH: false, flipV: false, straighten: 0, crop: null,
  exposure: 0, brightness: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0, sharpen: 0, mono: null,
  highlights: 0, shadows: 0, vibrance: 0, noise: 0, colorNoise: 0, curve: null,
});
/**
 * Courbes de tonalité prédéfinies : points [entrée, sortie] de 0 à 255 (courbe monotone passant par chacun).
 * L'interface les propose comme point de départ ; la courbe peut ensuite être modifiée point par point.
 */
export const CURVES = {
  lineaire: { label: 'Linéaire (aucune)', points: null },
  's-doux': { label: 'S doux (contraste léger)', points: [[0, 0], [64, 56], [192, 200], [255, 255]] },
  's-fort': { label: 'S marqué', points: [[0, 0], [64, 44], [192, 212], [255, 255]] },
  fondu: { label: 'Fondu (noirs relevés)', points: [[0, 28], [128, 132], [255, 245]] },
  eclaircir: { label: 'Éclaircir les tons moyens', points: [[0, 0], [128, 158], [255, 255]] },
  assombrir: { label: 'Assombrir les tons moyens', points: [[0, 0], [128, 100], [255, 255]] },
};
/** Préréglages intégrés (« filtres ») : ils remplacent les réglages de lumière et de couleur, pas la géométrie. */
export const PRESETS = {
  nb: { label: 'Noir et blanc', params: { mono: 'bw', contrast: 10 } },
  'nb-contraste': { label: 'Noir et blanc contrasté', params: { mono: 'bw', contrast: 35, brightness: -5 } },
  sepia: { label: 'Sépia', params: { mono: 'sepia', contrast: 5 } },
  chaud: { label: 'Chaud', params: { temperature: 30, saturation: 10 } },
  froid: { label: 'Froid', params: { temperature: -30 } },
  vif: { label: 'Couleurs vives', params: { vibrance: 35, saturation: 10, contrast: 15 } },
  doux: { label: 'Doux', params: { contrast: -20, brightness: 8, saturation: -10 } },
  film: { label: 'Film (fondu)', params: { curve: CURVES.fondu.points, vibrance: -10, temperature: 8 } },
  hdr: { label: 'Détails dans les ombres', params: { shadows: 45, highlights: -35, vibrance: 15 } },
};
/** Réglages de lumière et de couleur (remplacés par un filtre ; la géométrie et le bruit restent). */
export const TONE_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'temperature', 'tint', 'vibrance', 'saturation', 'sharpen', 'mono', 'curve'];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);
const r3 = n => Math.round(n * 1000) / 1000;

/** Réglages nettoyés et bornés (toute valeur inconnue est ignorée). */
export function cleanParams(p = {}) {
  const o = { ...DEFAULT_PARAMS };
  if (!p || typeof p !== 'object') return o;
  for (const [k, f] of Object.entries(EDIT_FIELDS)) o[k] = r3(clamp(num(p[k], DEFAULT_PARAMS[k]), f.min, f.max));
  o.rotate = (((Math.round(num(p.rotate) / 90) * 90) % 360) + 360) % 360;
  o.flipH = p.flipH === true || p.flipH === 'true'; o.flipV = p.flipV === true || p.flipV === 'true';
  o.mono = p.mono === 'bw' || p.mono === 'sepia' ? p.mono : null;
  o.curve = cleanCurve(p.curve);
  const c = p.crop;
  if (c && typeof c === 'object') {
    const w = clamp(num(c.w, 1), 0.02, 1), h = clamp(num(c.h, 1), 0.02, 1);
    const x = clamp(num(c.x, 0), 0, 1 - w), y = clamp(num(c.y, 0), 0, 1 - h);
    o.crop = w >= 0.999 && h >= 0.999 ? null : { x: r3(x), y: r3(y), w: r3(w), h: r3(h) };
  }
  return o;
}
/** Points de courbe nettoyés : 2 à 16 points [x, y] entiers de 0 à 255, x strictement croissants ; identité → null. */
export function cleanCurve(c) {
  if (!Array.isArray(c)) return null;
  const pts = c.filter(q => Array.isArray(q) && q.length >= 2 && Number.isFinite(+q[0]) && Number.isFinite(+q[1]))
    .map(([x, y]) => [Math.round(clamp(+x, 0, 255)), Math.round(clamp(+y, 0, 255))]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const q of pts) if (!out.length || q[0] > out[out.length - 1][0]) out.push(q);
  if (out.length < 2 || out.length > 16) return null;
  return curveLut(out).every((v, i) => v === i) ? null : out;
}
/**
 * Table de 256 valeurs d'une courbe passant par les points (interpolation cubique monotone de
 * Fritsch-Carlson : pas d'oscillation, la courbe ne « rebondit » jamais). Hors des points extrêmes : constante.
 */
export function curveLut(points) {
  const lut = new Uint8Array(256);
  if (!points?.length) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  const n = points.length, xs = points.map(q => q[0]), ys = points.map(q => q[1]);
  if (n === 1) return lut.fill(ys[0]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], t = a * a + b * b;
    if (t > 9) { const k = 3 / Math.sqrt(t); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  for (let x = 0; x < 256; x++) {
    let y;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      let i = 0; while (x > xs[i + 1]) i++;
      const hh = xs[i + 1] - xs[i], t = (x - xs[i]) / hh, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1];
    }
    lut[x] = Math.round(clamp(y, 0, 255));
  }
  return lut;
}
/** Courbe des hautes lumières et des ombres sur la luminance L (0 à 1) ; sh, hl de -1 à 1 ; toujours croissante. */
export const toneCurve = (L, sh, hl) => L + 0.9 * sh * L * (1 - L) * (1 - L) + 0.9 * hl * L * L * (1 - L);
const needsPixelOps = p => !!(p.highlights || p.shadows || p.vibrance || p.noise || p.colorNoise || p.curve);

/**
 * Traitements pixel par pixel sur une image brute 8 bits (1 à 4 canaux, l'éventuel 4e est l'alpha, inchangé).
 * Modifie `buf` en place. Ordre : bruit (Y : bilatéral, Cb/Cr : flou), hautes lumières / ombres, courbe, vibrance.
 */
export function applyPixelOps(buf, width, height, channels, params) {
  const p = cleanParams(params), n = width * height, color = channels >= 3;
  // --- réduction du bruit, dans l'espace YCbCr ---
  if (p.noise || (p.colorNoise && color)) {
    const Y = new Float32Array(n), Cb = color ? new Float32Array(n) : null, Cr = color ? new Float32Array(n) : null;
    for (let i = 0, o = 0; i < n; i++, o += channels) {
      if (!color) { Y[i] = buf[o]; continue; }
      const r = buf[o], g = buf[o + 1], b = buf[o + 2];
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b; Cb[i] = (b - Y[i]) * 0.564; Cr[i] = (r - Y[i]) * 0.713;
    }
    if (p.noise) bilateral(Y, width, height, p.noise);
    if (color && p.colorNoise) { const rad = 1 + Math.round(p.colorNoise / 100 * 6); boxBlur(Cb, width, height, rad); boxBlur(Cr, width, height, rad); }
    for (let i = 0, o = 0; i < n; i++, o += channels) {
      if (!color) { buf[o] = Y[i] < 0 ? 0 : Y[i] > 255 ? 255 : Y[i] + 0.5; continue; }
      const y = Y[i], cr = Cr[i] / 0.713, cb = Cb[i] / 0.564;
      const r = y + cr, b = y + cb, g = (y - 0.299 * r - 0.114 * b) / 0.587;
      buf[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5; buf[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5; buf[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5;
    }
  }
  // --- hautes lumières / ombres (rapport appliqué aux trois canaux : la teinte est conservée) ---
  const sh = p.shadows / 100, hl = p.highlights / 100;
  const tone = (sh || hl) ? new Float32Array(1024).map((_, i) => { const L = i / 1023; return L > 0 ? toneCurve(L, sh, hl) / L : 1; }) : null;
  const lut = p.curve ? curveLut(p.curve) : null, vib = p.vibrance / 100;
  if (!tone && !lut && !(vib && color)) return buf;
  for (let o = 0; o < buf.length; o += channels) {
    let r = buf[o], g = color ? buf[o + 1] : r, b = color ? buf[o + 2] : r;
    if (tone) {
      const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, k = tone[Math.round(L * 1023)];
      r *= k; g *= k; b *= k;
      if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
    }
    if (lut) { r = lut[r + 0.5 | 0]; g = lut[g + 0.5 | 0]; b = lut[b + 0.5 | 0]; }
    if (vib && color) {
      // saturation actuelle (0 à 1) : les couleurs déjà vives bougent peu, les ternes davantage
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx > 0 ? (mx - mn) / mx : 0;
      const L = 0.299 * r + 0.587 * g + 0.114 * b, k = 1 + vib * (1 - sat) * (vib > 0 ? 1 : 0.9);
      r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;
    }
    buf[o] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
    if (color) { buf[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5; buf[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b + 0.5; }
  }
  return buf;
}
/** Filtre bilatéral sur un plan (lisse le grain sans adoucir les contours nets). Force 1 à 100. */
function bilateral(Y, w, h, strength) {
  const R = strength > 50 ? 2 : 1, sr = 4 + strength * 0.3, ss = R;
  const rangeW = new Float32Array(256).map((_, d) => Math.exp(-(d * d) / (2 * sr * sr)));
  // voisinage à plat : décalages en x, en y, dans le tableau, et poids spatiaux
  const DX = [], DY = [], OFF = [], WS = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { DX.push(dx); DY.push(dy); OFF.push(dy * w + dx); WS.push(Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss))); }
  const K = OFF.length, off = Int32Array.from(OFF), wsp = Float32Array.from(WS);
  const src = Float32Array.from(Y);
  for (let y = 0; y < h; y++) {
    const inner = y >= R && y < h - R;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, c = src[i]; let sum = 0, ws = 0;
      if (inner && x >= R && x < w - R) {
        // intérieur : pas de test de bord
        for (let k = 0; k < K; k++) { const v = src[i + off[k]]; let d = v - c; if (d < 0) d = -d; const wt = wsp[k] * rangeW[d > 255 ? 255 : d | 0]; sum += v * wt; ws += wt; }
      } else {
        for (let k = 0; k < K; k++) {
          let xx = x + DX[k], yy = y + DY[k]; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          const v = src[yy * w + xx]; let d = v - c; if (d < 0) d = -d; const wt = wsp[k] * rangeW[d > 255 ? 255 : d | 0]; sum += v * wt; ws += wt;
        }
      }
      Y[i] = sum / ws;
    }
  }
}
/** Flou en boîte séparable (deux passes, bords répétés). */
function boxBlur(A, w, h, r) {
  const tmp = new Float32Array(A.length), win = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let k = -r; k <= r; k++) acc += A[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += A[row + Math.min(w - 1, x + r + 1)] - A[row + Math.max(0, x - r)];
      }
    }
    // passe verticale ligne par ligne (accumulateur d'une ligne entière : lecture contiguë en mémoire)
    const acc = new Float32Array(w);
    for (let k = -r; k <= r; k++) { const row = Math.min(h - 1, Math.max(0, k)) * w; for (let x = 0; x < w; x++) acc[x] += tmp[row + x]; }
    for (let y = 0; y < h; y++) {
      const row = y * w, add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) { A[row + x] = acc[x] / win; acc[x] += tmp[add + x] - tmp[sub + x]; }
    }
  }
}
export const isNeutral = p => JSON.stringify(cleanParams(p)) === JSON.stringify(cleanParams({}));

/** Taille des rendus retouchés servis à la place de la vignette et de l'aperçu (cache data/thumbs/edits). */
export const RENDER_SIZES = { thumb: 400, preview: 1200 };

/**
 * Carte d'une photo montrée avec sa version retouchée par défaut (grille, visionneuse, albums) :
 * vignette et aperçu rendus, dimensions après rotation / redressement / recadrage, et `original`
 * (vignette, aperçu, dimensions) pour comparer. Version neutre ou absente : carte inchangée.
 * @param card  vue « carte » (lib/library.mjs cardView), dimensions telles qu'affichées
 * @param ed    { id, name, params (JSON ou objet), applied_at } ou null
 */
export function editedCard(card, ed) {
  const prm = ed ? (typeof ed.params === 'string' ? (() => { try { return JSON.parse(ed.params); } catch { return null; } })() : ed.params) : null;
  if (!prm || isNeutral(prm) || !card.width || !card.height) return card;
  const g = geometry(card.width, card.height, prm);
  // v = empreinte des réglages : l'URL change dès qu'une retouche change, même dans la même milliseconde
  const v = crypto.createHash('sha1').update(JSON.stringify(cleanParams(prm))).digest('hex').slice(0, 12);
  const render = size => `/api/photos/${encodeURIComponent(card.id)}/render?edit=${encodeURIComponent(ed.id)}&size=${size}&v=${v}`;
  return { ...card, width: g.width, height: g.height, thumb: render(RENDER_SIZES.thumb), preview: render(RENDER_SIZES.preview),
    original: { width: card.width, height: card.height, preview: card.preview, thumb: card.thumb },
    edit: { id: ed.id, name: ed.name, params: cleanParams(prm) } };
}

/** Plus grand rectangle (même proportion n'est pas exigée) sans coin vide dans une image w × h tournée de `deg`. */
export function inscribedRect(w, h, deg) {
  const a = Math.abs(deg) * Math.PI / 180;
  if (a < 1e-9) return { w, h };
  const sin = Math.sin(a), cos = Math.cos(a), long = Math.max(w, h), short = Math.min(w, h);
  if (short <= 2 * sin * cos * long || Math.abs(sin - cos) < 1e-10) {
    const x = 0.5 * short;
    return w >= h ? { w: x / sin, h: x / cos } : { w: x / cos, h: x / sin };
  }
  const cos2 = cos * cos - sin * sin;
  return { w: (w * cos - h * sin) / cos2, h: (h * cos - w * sin) / cos2 };
}

/** Dimensions et découpe : image orientée iw × ih → rectangle à extraire (après rotation) et taille finale. */
export function geometry(iw, ih, params) {
  const p = cleanParams(params);
  const q = p.rotate % 180 !== 0, w = q ? ih : iw, h = q ? iw : ih; // après quarts de tour
  const t = p.straighten * Math.PI / 180, sin = Math.abs(Math.sin(t)), cos = Math.abs(Math.cos(t));
  const W = Math.round(w * cos + h * sin), H = Math.round(w * sin + h * cos); // toile après redressement
  const ins = inscribedRect(w, h, p.straighten);
  const L0 = (W - ins.w) / 2, T0 = (H - ins.h) / 2;
  // recadrage exprimé dans l'image affichée (après miroirs) → coordonnées avant miroirs
  const c = p.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cx = p.flipH ? 1 - c.x - c.w : c.x, cy = p.flipV ? 1 - c.y - c.h : c.y;
  let left = Math.floor(L0 + cx * ins.w), top = Math.floor(T0 + cy * ins.h);
  let width = Math.max(1, Math.floor(c.w * ins.w)), height = Math.max(1, Math.floor(c.h * ins.h));
  left = clamp(left, 0, W - 1); top = clamp(top, 0, H - 1);
  width = Math.min(width, W - left); height = Math.min(height, H - top);
  return { angle: p.rotate + p.straighten, canvas: { width: W, height: H }, extract: { left, top, width, height }, width, height };
}

/**
 * Applique les réglages à une image sharp. `src` : chemin ou tampon ; `opts.maxSide` : plus grand côté
 * de sortie (sans jamais agrandir) ; `opts.noCrop` : ignore le recadrage (aperçu de l'outil de recadrage).
 * Renvoie l'instance sharp prête à encoder et la taille de sortie.
 */
export async function pipeline(src, params, { maxSide = null, noCrop = false } = {}) {
  const { default: sharp } = await import('sharp');
  const p = cleanParams(params); if (noCrop) p.crop = null;
  const opts = { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' };
  const meta = await sharp(src, opts).metadata();
  let iw = meta.width, ih = meta.height; if ((meta.orientation ?? 1) >= 5) [iw, ih] = [ih, iw];
  if (!iw || !ih) throw new Error('Dimensions illisibles');
  const g = geometry(iw, ih, p);
  // étape 1 (géométrie) dans un tampon intermédiaire : l'ordre est alors garanti
  let img = sharp(src, opts).autoOrient();
  if (g.angle % 360 !== 0) img = img.rotate(g.angle, { background: '#ffffff' });
  const geo = await img.extract(g.extract).raw().toBuffer({ resolveWithObject: true });
  let out = sharp(geo.data, { raw: { width: geo.info.width, height: geo.info.height, channels: geo.info.channels } });
  if (p.flipH) out = out.flop();
  if (p.flipV) out = out.flip();
  let width = g.width, height = g.height;
  if (maxSide && Math.max(width, height) > maxSide) {
    const k = maxSide / Math.max(width, height); width = Math.max(1, Math.round(width * k)); height = Math.max(1, Math.round(height * k));
    out = out.resize(width, height, { fit: 'fill' });
  }
  if (geo.info.channels === 4) out = out.flatten({ background: '#ffffff' });
  // lumière + balance des blancs + contraste : v' = v·k·wb·c + (lum − 128)·c + 128, par canal
  const k = 2 ** p.exposure, c = 1 + p.contrast / 100, lum = p.brightness * 1.28;
  const wb = [1 + p.temperature / 250, 1 - p.tint / 250, 1 - p.temperature / 250];
  // (en noir et blanc, sharp passe en niveaux de gris AVANT cette opération : un seul canal, sans balance des blancs)
  if (p.mono && (p.exposure || p.contrast || p.brightness)) out = out.linear(k * c, (lum - 128) * c + 128);
  else if (!p.mono && (p.exposure || p.contrast || p.brightness || p.temperature || p.tint))
    out = out.linear(wb.map(x => k * x * c), wb.map(() => (lum - 128) * c + 128));
  if (needsPixelOps(p)) {
    // traitement pixel par pixel sur le résultat intermédiaire (l'ordre des opérations est ainsi garanti)
    const mid = await out.raw().toBuffer({ resolveWithObject: true });
    applyPixelOps(mid.data, mid.info.width, mid.info.height, mid.info.channels, p);
    out = sharp(mid.data, { raw: { width: mid.info.width, height: mid.info.height, channels: mid.info.channels } });
  }
  if (p.saturation && !p.mono) out = out.modulate({ saturation: Math.max(0, 1 + p.saturation / 100) });
  if (p.mono === 'bw') out = out.grayscale();
  if (p.mono === 'sepia') out = out.tint({ r: 112, g: 66, b: 20 });
  if (p.sharpen > 0) out = out.sharpen({ sigma: 0.5 + p.sharpen / 100 * 1.5 });
  return { image: out.toColourspace('srgb'), width, height };
}

export function createEdits(db, library) {
  const P = s => { try { return JSON.parse(s); } catch { return null; } };
  const now = () => new Date().toISOString();
  const photoRow = db.prepare('SELECT id, title, width, height, orientation, format FROM photos WHERE id = ?');
  const filesOf = db.prepare(`SELECT path, kind, data FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, indexed_at`);
  const RAW = /\.(cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|dng|srw|x3f|3fr|erf|kdc|mef|mos|mrw|raw|rwl|iiq)$/i;

  const view = r => r && ({ id: r.id, photo_id: r.photo_id, name: r.name, params: cleanParams(P(r.params)), is_default: !!r.is_default,
    created_at: r.created_at, applied_at: r.applied_at, neutral: isNeutral(P(r.params)),
    undo: (P(r.data)?.history ?? []).length, redo: (P(r.data)?.future ?? []).length });
  const rowOf = id => db.prepare('SELECT * FROM edits WHERE id = ?').get(id);
  const need = id => { const r = rowOf(id); if (!r) throw new Error('Version inconnue'); return r; };

  /**
   * Fichier source d'une photo pour le rendu : original, sinon copie identique, sinon aperçu en cache.
   * Les RAW ne sont pas décodés par sharp : on prend alors l'aperçu (signalé). `preferPreview` sert
   * aux aperçus d'écran (plus rapides).
   */
  function sourceOf(photoId, { preferPreview = false } = {}) {
    const files = filesOf.all(photoId);
    const cached = () => { for (const f of files) { const rel = P(f.data)?.thumbs?.preview; if (rel) { const abs = library.thumbAbs(rel); if (fs.existsSync(abs)) return { path: abs, from: 'apercu' }; } } return null; };
    if (preferPreview) { const c = cached(); if (c) return c; }
    for (const [k, f] of files.entries()) if (f.path && !RAW.test(f.path) && fs.existsSync(f.path)) return { path: f.path, from: k === 0 ? 'original' : 'copie' };
    const c = cached(); if (c) return { ...c, raw: files.some(f => RAW.test(f.path || '')) };
    return null;
  }

  function list(photoId) {
    if (!photoRow.get(photoId)) throw new Error('Photo inconnue');
    return db.prepare('SELECT * FROM edits WHERE photo_id = ? ORDER BY created_at').all(photoId).map(view);
  }
  const defaultOf = photoId => view(db.prepare('SELECT * FROM edits WHERE photo_id = ? AND is_default = 1').get(photoId)) ?? null;

  /** Nouvelle version : réglages neutres, copie d'une autre version, ou réglages fournis. La première devient celle par défaut. */
  function create(photoId, { name, from, params } = {}) {
    if (!photoRow.get(photoId)) throw new Error('Photo inconnue');
    const count = db.prepare('SELECT COUNT(*) n FROM edits WHERE photo_id = ?').get(photoId).n;
    const base = from ? need(from) : null;
    if (base && base.photo_id !== photoId) throw new Error('Version d\'une autre photo');
    const prm = cleanParams(params ?? (base ? P(base.params) : {}));
    const id = crypto.randomUUID(), t = now();
    const nm = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || (base ? `${base.name} (copie)` : `Version ${count + 1}`);
    db.prepare('INSERT INTO edits(id, photo_id, name, params, is_default, created_at, applied_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, photoId, nm, JSON.stringify(prm), count === 0 ? 1 : 0, t, t, JSON.stringify({ v: EDIT_PARAMS_VERSION, history: [], future: [] }));
    logHistory(db, 'edit.create', `Version « ${nm} » créée`, { photoId, id });
    return view(rowOf(id));
  }

  /** Change les réglages (étape annulable), le nom ou la version par défaut. */
  function update(id, { params, name, isDefault } = {}) {
    const r = need(id), data = P(r.data) ?? {};
    if (params !== undefined) {
      const next = cleanParams(params), cur = cleanParams(P(r.params));
      if (JSON.stringify(next) !== JSON.stringify(cur)) {
        data.history = [...(data.history ?? []), cur].slice(-HISTORY_MAX); data.future = [];
        db.prepare('UPDATE edits SET params = ?, applied_at = ?, data = ? WHERE id = ?').run(JSON.stringify(next), now(), JSON.stringify(data), id);
      }
    }
    if (name !== undefined) {
      const nm = String(name).replace(/\s+/g, ' ').trim().slice(0, 80); if (!nm) throw new Error('Nom de version vide');
      db.prepare('UPDATE edits SET name = ? WHERE id = ?').run(nm, id);
    }
    if (isDefault) {
      db.prepare('UPDATE edits SET is_default = 0 WHERE photo_id = ?').run(r.photo_id);
      db.prepare('UPDATE edits SET is_default = 1 WHERE id = ?').run(id);
    }
    return view(rowOf(id));
  }
  function step(id, from, to) {
    const r = need(id), data = P(r.data) ?? {};
    const list = data[from] ?? []; if (!list.length) throw new Error(from === 'history' ? 'Rien à annuler' : 'Rien à rétablir');
    const prev = list.pop();
    data[to] = [...(data[to] ?? []), cleanParams(P(r.params))].slice(-HISTORY_MAX); data[from] = list;
    db.prepare('UPDATE edits SET params = ?, applied_at = ?, data = ? WHERE id = ?').run(JSON.stringify(cleanParams(prev)), now(), JSON.stringify(data), id);
    return view(rowOf(id));
  }
  const undo = id => step(id, 'history', 'future');
  const redo = id => step(id, 'future', 'history');
  /** Réinitialisation (annulable) : retour aux réglages neutres. */
  const reset = id => update(id, { params: {} });

  /** Supprime une version ; si c'était celle par défaut, la plus ancienne restante le devient. */
  function remove(id) {
    const r = need(id);
    db.prepare('DELETE FROM edits WHERE id = ?').run(id);
    if (r.is_default) {
      const next = db.prepare('SELECT id FROM edits WHERE photo_id = ? ORDER BY created_at LIMIT 1').get(r.photo_id);
      if (next) db.prepare('UPDATE edits SET is_default = 1 WHERE id = ?').run(next.id);
    }
    logHistory(db, 'edit.remove', `Version « ${r.name} » supprimée (original intact)`, { photoId: r.photo_id, id });
    return { removed: id, originalUntouched: true };
  }

  /**
   * Aperçu JPEG d'une photo avec des réglages (version enregistrée ou réglages à l'essai), mis en cache
   * dans data/thumbs/edits (régénérable). Renvoie le chemin du fichier.
   */
  async function preview(photoId, params, { size = 1200, noCrop = false } = {}) {
    const src = sourceOf(photoId, { preferPreview: true }); if (!src) throw new Error('Aucun fichier lisible pour cette photo');
    const p = cleanParams(params), sz = clamp(Math.round(num(size, 1200)), 100, 3000);
    const key = crypto.createHash('sha1').update(JSON.stringify([photoId, src.path, p, sz, noCrop])).digest('hex');
    const file = path.join(THUMBS_DIR, 'edits', key.slice(0, 2), key + '.jpg');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const { image } = await pipeline(src.path, p, { maxSide: sz, noCrop });
      await image.jpeg({ quality: 85 }).toFile(file);
    }
    return file;
  }

  /** Une photo est-elle retouchable à pleine définition ? (les RAW ne le sont pas avec sharp) */
  function capability(photoId) {
    const src = sourceOf(photoId);
    if (!src) return { ok: false, reason: 'Aucun fichier lisible (support absent ?)' };
    if (src.raw) return { ok: true, fullRes: false, reason: 'Fichier RAW : le moteur (sharp/libvips) ne le décode pas ; la retouche s\'appuie sur l\'aperçu en cache.' };
    if (src.from === 'apercu') return { ok: true, fullRes: false, reason: 'Original indisponible : la retouche s\'appuie sur l\'aperçu en cache.' };
    return { ok: true, fullRes: true };
  }

  return { list, create, update, undo, redo, reset, remove, preview, capability, sourceOf, defaultOf, get: id => view(rowOf(id)) };
}
