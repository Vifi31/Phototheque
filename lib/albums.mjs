// Albums photo : format de page, pages ordonnées, gabarits de mise en page, textes, contrôles.
// Un album ne contient que des RÉFÉRENCES aux photos (jamais de copie) : chaque page garde la liste
// de ses cadres (slots) avec l'identifiant de la photo placée. album_photos est un index dérivé
// (« quelles photos sont utilisées par quel album »), reconstruit à chaque enregistrement, qui sert
// au filtre albumId de la recherche.
import crypto from 'crypto';
import { logHistory, tx } from './db.mjs';

/** Version du format de projet d'album (exporté et stocké dans albums.data.formatVersion). */
export const ALBUM_FORMAT_VERSION = 1;

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const P = s => { try { return JSON.parse(s); } catch { return null; } };

// ---------- Formats de page (millimètres) ----------
export const FORMATS = {
  'carre-30': { label: 'Carré 30 × 30 cm', width: 300, height: 300 },
  'carre-20': { label: 'Carré 20 × 20 cm', width: 200, height: 200 },
  'a4-portrait': { label: 'A4 portrait (21 × 29,7 cm)', width: 210, height: 297 },
  'a4-paysage': { label: 'A4 paysage (29,7 × 21 cm)', width: 297, height: 210 },
  '20x30-portrait': { label: 'Portrait 20 × 30 cm', width: 200, height: 300 },
  '30x20-paysage': { label: 'Paysage 30 × 20 cm', width: 300, height: 200 },
  custom: { label: 'Format personnalisé', width: null, height: null },
};
export const orientationOf = (w, h) => (w > h ? 'landscape' : w < h ? 'portrait' : 'square');

// ---------- Gabarits : cadres en fractions de la page (x, y, largeur, hauteur) ----------
// Marge de sécurité M autour de la zone utile, gouttière G entre cadres, bande de légende CAP en bas.
const M = 0.06, G = 0.03, CAP = 0.06;
const AREA = { x: M, y: M, w: 1 - 2 * M, h: 1 - 2 * M - CAP };
const r4 = n => Math.round(n * 10000) / 10000;
const frame = (x, y, w, h) => ({ x: r4(x), y: r4(y), w: r4(w), h: r4(h) });
/** Grille cols × rows dans une zone (par défaut la zone utile). */
function grid(cols, rows, a = AREA, gx = G, gy = G) {
  const w = (a.w - gx * (cols - 1)) / cols, h = (a.h - gy * (rows - 1)) / rows, out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(frame(a.x + c * (w + gx), a.y + r * (h + gy), w, h));
  return out;
}
// Doubles pages : cadres en fractions de la PLANCHE (deux pages côte à côte, pli au milieu).
// Une marge M d'une page vaut M / 2 de la planche en largeur ; idem pour la gouttière.
const HM = M / 2, HG = G / 2;
const pageArea = k => ({ x: k * 0.5 + HM, y: M, w: 0.5 - 2 * HM, h: AREA.h });
const band = (AREA.h - G) / 2;
const spreadBand = [frame(HM, M, 1 - 2 * HM, band),
  ...[0, 1].flatMap(k => grid(2, 1, { ...pageArea(k), y: M + band + G, h: AREA.h - band - G }, HG))];
const bigLeft = (() => { const wBig = (AREA.w - G) * 2 / 3; return [frame(AREA.x, AREA.y, wBig, AREA.h), ...grid(1, 2, { x: AREA.x + wBig + G, y: AREA.y, w: AREA.w - wBig - G, h: AREA.h })]; })();

export const LAYOUTS = {
  titre: { label: 'Page de titre (texte seul)', frames: [] },
  plein: { label: '1 photo pleine page (fond perdu)', frames: [frame(0, 0, 1, 1)], fullBleed: true },
  une: { label: '1 photo avec marges', frames: grid(1, 1) },
  'deux-cote': { label: '2 photos côte à côte', frames: grid(2, 1) },
  'deux-pile': { label: '2 photos l\'une sous l\'autre', frames: grid(1, 2) },
  trois: { label: '3 photos (1 grande + 2)', frames: bigLeft },
  quatre: { label: '4 photos (2 × 2)', frames: grid(2, 2) },
  six: { label: '6 photos (3 × 2)', frames: grid(3, 2) },
  // gabarits sur deux pages en vis-à-vis (une ligne de l'album = deux pages imprimées)
  'double-plein': { label: 'Double page : 1 panoramique (fond perdu)', frames: [frame(0, 0, 1, 1)], fullBleed: true, spread: true },
  'double-marges': { label: 'Double page : 1 panoramique avec marges', frames: [frame(HM, M, 1 - 2 * HM, AREA.h)], spread: true },
  'double-face': { label: 'Double page : 2 photos face à face', frames: [0, 1].flatMap(k => grid(1, 1, pageArea(k))), spread: true },
  'double-bandeau': { label: 'Double page : bandeau panoramique + 4', frames: spreadBand, spread: true },
};
export const SAFETY_MARGIN = M;
export const isSpread = layout => !!LAYOUTS[layout]?.spread;

/**
 * Numérotation des pages imprimées : une ligne d'album à gabarit double occupe deux pages.
 * La page 1 est une page de droite ; une double page doit donc commencer sur un numéro pair.
 */
export function folios(pages) {
  let f = 1;
  return pages.map(p => { const span = isSpread(p.layout) ? 2 : 1, out = { folio: f, span }; f += span; return out; });
}
export const folioLabel = ({ folio, span }) => (span === 2 ? `Pages ${folio}–${folio + 1}` : `Page ${folio}`);

// Résolution effective à l'impression (points par pouce) en dessous de laquelle on prévient.
export const DPI_LOW = 150, DPI_WARN = 240;

// ---------- Recadrage manuel d'une photo dans son cadre ----------
// { x, y } : centre de la partie visible, en fractions de l'image (0,5 ; 0,5 = centré) ;
// zoom : 1 = la photo couvre juste le cadre (recadrage par défaut), jusqu'à ZOOM_MAX.
export const ZOOM_MAX = 5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Recadrage nettoyé, ou null s'il équivaut au recadrage par défaut (centré, sans zoom). */
export function cleanCrop(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v, d) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);
  const x = r4(clamp(n(c.x, 0.5), 0, 1)), y = r4(clamp(n(c.y, 0.5), 0, 1)), zoom = r4(clamp(n(c.zoom, 1), 1, ZOOM_MAX));
  return x === 0.5 && y === 0.5 && zoom === 1 ? null : { x, y, zoom };
}
/**
 * Partie visible d'une image (iw × ih, orientée) dans un cadre (fw × fh, même unité quelconque) :
 * { left, top, width, height } en fractions de l'image. Le centre est ramené pour ne jamais montrer de vide.
 * Même calcul que l'éditeur (public/app.js, cropBox) et que le PDF (lib/albumpdf.mjs).
 */
export function cropWindow(iw, ih, fw, fh, crop) {
  const z = crop?.zoom ?? 1, s = Math.max(fw / iw, fh / ih) * z;
  const w = Math.min(1, fw / (iw * s)), h = Math.min(1, fh / (ih * s));
  const cx = clamp(crop?.x ?? 0.5, w / 2, 1 - w / 2), cy = clamp(crop?.y ?? 0.5, h / 2, 1 - h / 2);
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

const cleanText = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanColor = c => (/^#[0-9a-f]{6}$/i.test(String(c ?? '')) ? String(c).toLowerCase() : '#ffffff');
const cleanLayout = l => (LAYOUTS[l] ? l : 'une');

export function createAlbums(db, library) {
  const photoExists = db.prepare('SELECT 1 FROM photos WHERE id = ?');

  // ---------- lecture ----------
  const mapAlbum = r => r ? ({ ...r, data: P(r.data) ?? {} }) : null;
  const row = id => mapAlbum(db.prepare('SELECT * FROM albums WHERE id = ?').get(id));
  const need = id => { const a = row(id); if (!a) throw new Error('Album inconnu'); return a; };
  const loadPages = id => db.prepare('SELECT * FROM album_pages WHERE album_id = ? ORDER BY page').all(id).map(p => {
    const d = P(p.data) ?? {};
    const slots = Array.isArray(d.slots) ? d.slots : [];
    const crops = slots.map((_, i) => cleanCrop(Array.isArray(d.crops) ? d.crops[i] : null));
    return { layout: cleanLayout(p.layout), background: cleanColor(p.background), title: d.title ?? '', caption: d.caption ?? '', slots, crops };
  });

  /** Fiches des photos utilisées (vue « carte » de la bibliothèque : vignette, dimensions, disponibilité). */
  function photosOf(ids) {
    const out = {};
    const st = db.prepare(`SELECT p.*, (SELECT path FROM files WHERE photo_id = p.id AND kind='original' LIMIT 1) path,
      (SELECT data FROM files WHERE photo_id = p.id AND kind='original' LIMIT 1) fdata,
      (SELECT support_id FROM files WHERE photo_id = p.id AND kind='original' LIMIT 1) support_id FROM photos p WHERE p.id = ?`);
    // dimensions telles qu'affichées (orientation EXIF 5 à 8 : largeur et hauteur échangées)
    for (const id of new Set(ids)) { const r = st.get(id); if (r) { const c = library.cardView(r); out[id] = r.orientation >= 5 ? { ...c, width: r.height, height: r.width } : c; } }
    return out;
  }
  const size = a => ({ width: a.data.width_mm ?? FORMATS[a.format]?.width ?? 300, height: a.data.height_mm ?? FORMATS[a.format]?.height ?? 300 });

  /** Contrôles : photos introuvables ou indisponibles, résolution insuffisante, photos hors gabarit, cadres vides. */
  function checkPages(a, pages, photos) {
    const { width: pageW, height } = size(a), issues = [], fol = folios(pages);
    // `page` = rang de la ligne dans l'album (adresse de l'API) ; les messages citent les pages imprimées.
    pages.forEach((pg, i) => {
      const page = i + 1, frames = LAYOUTS[pg.layout].frames, P = folioLabel(fol[i]);
      const width = pageW * fol[i].span; // largeur de la planche pour une double page
      if (fol[i].span === 2 && fol[i].folio % 2 === 1)
        issues.push({ page, level: 'warn', message: `${P} : la double page commence sur une page de droite, le panoramique sera coupé au pli (ajoutez ou retirez une page avant)` });
      frames.forEach((fr, s) => {
        const id = pg.slots[s];
        if (!id) { issues.push({ page, slot: s, level: 'info', message: `${P} : cadre ${s + 1} vide` }); return; }
        const ph = photos[id];
        if (!ph) { issues.push({ page, slot: s, level: 'bad', message: `${P} : la photo du cadre ${s + 1} n'est plus au catalogue` }); return; }
        if (ph.missing) issues.push({ page, slot: s, level: 'warn', message: `${P} : la photo du cadre ${s + 1} est indisponible (support absent ?)` });
        if (ph.width && ph.height) {
          // pixels de la partie visible (recadrage « couvrir », zoom éventuel) rapportés à la taille imprimée du cadre
          const win = cropWindow(ph.width, ph.height, fr.w * width, fr.h * height, pg.crops?.[s]);
          const dpi = Math.round(25.4 * Math.min(ph.width * win.width / (fr.w * width), ph.height * win.height / (fr.h * height)));
          if (dpi < DPI_LOW) issues.push({ page, slot: s, level: 'bad', dpi, message: `${P} : résolution insuffisante dans le cadre ${s + 1} (${dpi} ppp, ${DPI_WARN} conseillés)` });
          else if (dpi < DPI_WARN) issues.push({ page, slot: s, level: 'warn', dpi, message: `${P} : résolution limite dans le cadre ${s + 1} (${dpi} ppp, ${DPI_WARN} conseillés)` });
        }
      });
      const hidden = pg.slots.slice(frames.length).filter(Boolean).length;
      if (hidden) issues.push({ page, level: 'warn', message: `${P} : ${hidden} photo(s) hors gabarit, non affichée(s) (choisissez un gabarit avec plus de cadres)` });
    });
    return issues;
  }

  /** Album complet : pages, fiches des photos utilisées, contrôles. */
  function get(id) {
    const a = row(id); if (!a) return null;
    const pages = loadPages(id);
    const photos = photosOf(pages.flatMap(p => p.slots).filter(Boolean));
    const { width, height } = size(a), fol = folios(pages);
    const issues = checkPages(a, pages, photos);
    return { ...a, width_mm: width, height_mm: height, formatLabel: FORMATS[a.format]?.label ?? a.format,
      spreads: !!a.data.spreads, printedPages: fol.reduce((n, f) => n + f.span, 0),
      pages: pages.map((p, i) => ({ ...p, ...fol[i] })), photos, issues };
  }

  /** Liste : résumé de chaque album (pages, photos, couverture, nombre d'alertes). */
  function list() {
    return db.prepare('SELECT id FROM albums ORDER BY updated_at DESC').all().map(({ id }) => {
      const a = get(id);
      const used = a.pages.flatMap(p => p.slots).filter(Boolean);
      const cover = used.map(pid => a.photos[pid]).find(Boolean);
      return { id: a.id, name: a.name, description: a.description, format: a.format, formatLabel: a.formatLabel, orientation: a.orientation,
        width_mm: a.width_mm, height_mm: a.height_mm, updated_at: a.updated_at, created_at: a.created_at,
        pageCount: a.printedPages, spreads: a.spreads, photoCount: new Set(used).size, cover: cover?.thumb ?? null,
        alerts: a.issues.filter(i => i.level !== 'info').length };
    });
  }

  // ---------- écriture ----------
  /** Réécrit toutes les pages (numérotées 1..n), reconstruit l'index album_photos, date la modification. */
  function savePages(id, pages) {
    if (pages.length > 500) throw new Error('500 pages au maximum par album');
    tx(db, () => {
      db.prepare('DELETE FROM album_pages WHERE album_id = ?').run(id);
      db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(id);
      const insPage = db.prepare('INSERT INTO album_pages(album_id, page, layout, background, data) VALUES(?,?,?,?,?)');
      const insPhoto = db.prepare('INSERT OR IGNORE INTO album_photos(album_id, photo_id, position, page) VALUES(?,?,?,?)');
      let pos = 0;
      pages.forEach((pg, i) => {
        insPage.run(id, i + 1, cleanLayout(pg.layout), cleanColor(pg.background), JSON.stringify({ slots: pg.slots, crops: pg.slots.map((_, k) => cleanCrop(pg.crops?.[k])), title: pg.title, caption: pg.caption }));
        for (const pid of pg.slots) if (pid && photoExists.get(pid)) insPhoto.run(id, pid, ++pos, i + 1);
      });
      db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(now(), id);
    });
  }
  const blankPage = (layout = 'une') => ({ layout: cleanLayout(layout), background: '#ffffff', title: '', caption: '', slots: [], crops: [] });
  const pageIndex = (pages, n) => { const i = Math.floor(+n) - 1; if (!(i >= 0 && i < pages.length)) throw new Error('Page inconnue'); return i; };

  /** Format : prédéfini, ou personnalisé (50 à 1000 mm de côté). */
  function resolveFormat(format, width_mm, height_mm) {
    const f = FORMATS[format] ? format : 'carre-30';
    if (f !== 'custom') return { format: f, width: FORMATS[f].width, height: FORMATS[f].height };
    const w = Math.round(+width_mm), h = Math.round(+height_mm);
    if (!(w >= 50 && w <= 1000 && h >= 50 && h <= 1000)) throw new Error('Format personnalisé : largeur et hauteur entre 50 et 1000 mm');
    return { format: f, width: w, height: h };
  }

  /** Crée un album avec une page de titre portant son nom. */
  function create({ name, description, format, width_mm, height_mm, spreads } = {}) {
    const nm = cleanText(name, 120); if (!nm) throw new Error("Nom d'album vide");
    const fmt = resolveFormat(format, width_mm, height_mm);
    const id = uid(), t = now();
    db.prepare('INSERT INTO albums(id,name,description,format,orientation,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, nm, cleanText(description, 1000), fmt.format, orientationOf(fmt.width, fmt.height), t, t,
        JSON.stringify({ formatVersion: ALBUM_FORMAT_VERSION, width_mm: fmt.width, height_mm: fmt.height, spreads: !!spreads }));
    savePages(id, [{ ...blankPage('titre'), title: nm }]);
    logHistory(db, 'album.create', `Album « ${nm} » créé (${FORMATS[fmt.format].label})`, { id });
    return get(id);
  }

  /** Renomme, décrit, change de format (les gabarits étant relatifs, la mise en page suit). */
  function update(id, { name, description, format, width_mm, height_mm, spreads } = {}) {
    const a = need(id);
    if (spreads !== undefined) a.data.spreads = !!spreads && spreads !== '0' && spreads !== 'false'; // vue en planches (doubles pages)
    const nm = name != null ? cleanText(name, 120) : a.name; if (!nm) throw new Error("Nom d'album vide");
    const desc = description != null ? cleanText(description, 1000) : a.description;
    const cur = size(a);
    const fmt = format != null ? resolveFormat(format, width_mm ?? cur.width, height_mm ?? cur.height) : { format: a.format, ...cur };
    db.prepare('UPDATE albums SET name=?, description=?, format=?, orientation=?, updated_at=?, data=? WHERE id=?')
      .run(nm, desc, fmt.format, orientationOf(fmt.width, fmt.height), now(), JSON.stringify({ ...a.data, formatVersion: ALBUM_FORMAT_VERSION, width_mm: fmt.width, height_mm: fmt.height }), id);
    logHistory(db, 'album.update', `Album « ${nm} » modifié`, { id });
    return get(id);
  }

  /** Supprime l'album (pages et références) ; les photos et les originaux ne sont jamais touchés. */
  function remove(id) {
    const a = need(id);
    db.prepare('DELETE FROM albums WHERE id = ?').run(id); // album_pages, album_photos : ON DELETE CASCADE
    logHistory(db, 'album.remove', `Album « ${a.name} » supprimé (photos conservées)`, { id });
    return { removed: id, photosUntouched: true };
  }

  /** Ajoute une page vide (après la page `after`, sinon à la fin). */
  function addPage(id, { layout, after } = {}) {
    need(id); const pages = loadPages(id);
    const at = after != null ? Math.min(pages.length, Math.max(0, Math.floor(+after) || 0)) : pages.length;
    pages.splice(at, 0, blankPage(layout));
    savePages(id, pages); return get(id);
  }

  /**
   * Modifie une page : gabarit, fond, titre, légende, cadres. Une photo nouvelle doit exister au
   * catalogue ; une référence déjà présente (même devenue introuvable) est conservée pour être signalée.
   */
  function updatePage(id, n, { layout, background, title, caption, slots, crops } = {}) {
    need(id); const pages = loadPages(id); const i = pageIndex(pages, n), pg = pages[i];
    if (layout !== undefined) pg.layout = cleanLayout(layout);
    if (background !== undefined) pg.background = cleanColor(background);
    if (title !== undefined) pg.title = cleanText(title);
    if (caption !== undefined) pg.caption = cleanText(caption);
    if (slots !== undefined) {
      const known = new Set(pg.slots.filter(Boolean)), before = pg.slots, oldCrops = pg.crops;
      pg.slots = [].concat(slots ?? []).slice(0, 24).map(s => (typeof s === 'string' && s && (known.has(s) || photoExists.get(s)) ? s : null));
      while (pg.slots.length && !pg.slots[pg.slots.length - 1]) pg.slots.pop();
      // sans recadrages fournis, un cadre garde le sien seulement s'il garde la même photo
      pg.crops = pg.slots.map((pid, i) => (pid && pid === before[i] ? oldCrops[i] ?? null : null));
    }
    if (crops !== undefined) {
      const list = [].concat(crops ?? []);
      pg.crops = pg.slots.map((pid, i) => (pid ? cleanCrop(list[i]) : null));
    }
    savePages(id, pages); return get(id);
  }

  function movePage(id, n, to) {
    need(id); const pages = loadPages(id); const i = pageIndex(pages, n);
    const j = Math.min(pages.length - 1, Math.max(0, Math.floor(+to) - 1));
    pages.splice(j, 0, ...pages.splice(i, 1));
    savePages(id, pages); return get(id);
  }
  function duplicatePage(id, n) {
    need(id); const pages = loadPages(id); const i = pageIndex(pages, n);
    pages.splice(i + 1, 0, structuredClone(pages[i]));
    savePages(id, pages); return get(id);
  }
  function removePage(id, n) {
    need(id); const pages = loadPages(id); const i = pageIndex(pages, n);
    pages.splice(i, 1);
    savePages(id, pages); return get(id);
  }

  /** Ajoute des pages au gabarit choisi, remplies dans l'ordre avec les photos données. */
  function fill(id, photoIds, layout = 'une') {
    const a = need(id);
    const lay = cleanLayout(layout === 'titre' ? 'une' : layout), per = LAYOUTS[lay].frames.length;
    const ids = [...new Set([].concat(photoIds ?? []).filter(x => typeof x === 'string' && photoExists.get(x)))];
    if (!ids.length) throw new Error('Aucune photo à placer');
    const pages = loadPages(id);
    for (let k = 0; k < ids.length; k += per) pages.push({ ...blankPage(lay), slots: ids.slice(k, k + per), crops: [] });
    savePages(id, pages);
    logHistory(db, 'album.fill', `${ids.length} photo(s) placée(s) dans « ${a.name} »`, { id, count: ids.length, layout: lay });
    return { added: ids.length, pagesAdded: Math.ceil(ids.length / per), album: get(id) };
  }

  /** Projet d'album exportable (format versionné, documenté dans docs/ARCHITECTURE.md §9). */
  function exportProject(id) {
    const a = get(id); if (!a) throw new Error('Album inconnu');
    const refs = {};
    for (const [pid, ph] of Object.entries(a.photos)) {
      const p = db.prepare('SELECT sha256, title FROM photos WHERE id = ?').get(pid);
      refs[pid] = { path: ph.path, sha256: p?.sha256 ?? null, title: p?.title ?? null, width: ph.width, height: ph.height };
    }
    return {
      format: 'phototheque-album', formatVersion: ALBUM_FORMAT_VERSION, exportedAt: now(),
      album: { id: a.id, name: a.name, description: a.description, format: a.format, orientation: a.orientation, width_mm: a.width_mm, height_mm: a.height_mm, created_at: a.created_at, updated_at: a.updated_at },
      layouts: Object.fromEntries([...new Set(a.pages.map(p => p.layout))].map(l => [l, LAYOUTS[l]])),
      pages: a.pages.map((p, i) => ({ page: i + 1, ...p })),
      photos: refs,
    };
  }

  return { list, get, create, update, remove, addPage, updatePage, movePage, duplicatePage, removePage, fill, exportProject };
}
