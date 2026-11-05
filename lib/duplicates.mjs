// Doublons et photos similaires, sur plusieurs niveaux (cahier des charges §11) :
//   - exacts       : même contenu (empreinte SHA-256) — plusieurs fichiers d'une même fiche, ou plusieurs fiches ;
//   - potentiels   : même nom de fichier et mêmes dimensions, ou même instant de prise de vue, même appareil
//                    et mêmes dimensions, mais contenu différent — à confirmer ;
//   - similaires   : empreinte visuelle (dHash 64 bits) proche (distance de Hamming ≤ seuil) ; un groupe dont
//                    les dimensions diffèrent est présenté comme « versions » (autre résolution, recadrage, export…) ;
//   - rafales      : photos du même appareil prises à quelques secondes d'intervalle.
// Rien n'est jamais supprimé automatiquement. L'utilisateur peut désigner une photo de référence (les autres
// sont notées comme ses variantes, dans photos.data), déclarer qu'un groupe n'est pas un doublon (paires
// ignorées, table config), ou choisir le fichier de référence d'une photo présente en plusieurs fichiers.
import fs from 'fs';
import { logHistory, tx } from './db.mjs';

export const LEVELS = {
  exact: 'Doublons exacts',
  potential: 'Doublons potentiels',
  similar: 'Photos similaires',
  burst: 'Rafales',
};
export const DEFAULT_THRESHOLD = 8, MAX_THRESHOLD = 20, DEFAULT_BURST_SECONDS = 2;

/**
 * Empreinte visuelle : dHash (9 × 8 niveaux de gris, 64 comparaisons horizontales → 16 chiffres hexadécimaux)
 * suivi de la couleur moyenne (6 chiffres). Le dHash seul ne voit que les variations de luminosité : deux
 * aplats de couleurs différentes auraient la même empreinte ; la couleur moyenne les distingue.
 */
export async function dhash(src) {
  const { default: sharp } = await import('sharp');
  const { data } = await sharp(src, { failOn: 'none' }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let hex = '';
  for (let r = 0; r < 8; r++) {
    let nib = 0;
    for (let c = 0; c < 8; c++) {
      nib = (nib << 1) | (data[r * 9 + c] < data[r * 9 + c + 1] ? 1 : 0);
      if (c === 3 || c === 7) { hex += nib.toString(16); nib = 0; }
    }
  }
  const { data: rgb } = await sharp(src, { failOn: 'none' }).rotate().removeAlpha().toColourspace('srgb').resize(1, 1, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  return hex + [0, 1, 2].map(i => rgb[i].toString(16).padStart(2, '0')).join('');
}
const pop32 = x => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const split = hex => [parseInt(hex.slice(0, 8), 16) | 0, parseInt(hex.slice(8, 16), 16) | 0];
/** Écart de couleur moyenne (0 à 441) ; 0 si l'une des empreintes n'a pas de couleur (ancien format). */
export function colorGap(a, b) {
  if (a.length < 22 || b.length < 22) return 0;
  const c = h => [16, 18, 20].map(i => parseInt(h.slice(i, i + 2), 16)), x = c(a), y = c(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
export const MAX_COLOR_GAP = 48;
/** Distance de Hamming entre deux empreintes (0 = identiques, 64 = opposées). */
export function hamming(a, b) { const [a1, a2] = split(a), [b1, b2] = split(b); return pop32(a1 ^ b1) + pop32(a2 ^ b2); }

/** Arbre BK : recherche des voisins à distance ≤ d sans comparer chaque paire. */
class BKTree {
  constructor() { this.root = null; }
  add(hash, id) {
    const node = { hash, ids: [id], kids: new Map() };
    if (!this.root) { this.root = node; return; }
    let n = this.root;
    for (;;) {
      const d = hamming(hash, n.hash);
      if (d === 0) { n.ids.push(id); return; }
      const next = n.kids.get(d);
      if (!next) { n.kids.set(d, node); return; }
      n = next;
    }
  }
  near(hash, max) {
    const out = [], stack = this.root ? [this.root] : [];
    while (stack.length) {
      const n = stack.pop(), d = hamming(hash, n.hash);
      if (d <= max) for (const id of n.ids) out.push([id, d]);
      for (const [k, kid] of n.kids) if (k >= d - max && k <= d + max) stack.push(kid);
    }
    return out;
  }
}

export function createDuplicates(db, library) {
  const P = s => { try { return JSON.parse(s); } catch { return null; } };
  const IGN = 'duplicates.ignored';
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const ignored = () => new Set(P(db.prepare('SELECT data FROM config WHERE key = ?').get(IGN)?.data) ?? []);
  const saveIgnored = set => db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(IGN, JSON.stringify([...set]));

  // ---------- empreintes visuelles ----------
  /** Image à analyser : la vignette en cache (rapide), sinon un fichier lisible. */
  function hashSource(photoId) {
    for (const f of db.prepare('SELECT path, data FROM files WHERE photo_id = ?').all(photoId)) {
      const rel = P(f.data)?.thumbs?.thumb; if (rel) { const abs = library.thumbAbs(rel); if (fs.existsSync(abs)) return abs; }
    }
    for (const f of db.prepare('SELECT path FROM files WHERE photo_id = ?').all(photoId)) if (f.path && fs.existsSync(f.path)) return f.path;
    return null;
  }
  const missingHashes = () => db.prepare('SELECT COUNT(*) n FROM photos WHERE perceptual_hash IS NULL').get().n;
  /** Calcule les empreintes manquantes (ou toutes avec `all`). Les photos illisibles sont comptées à part. */
  async function computeHashes({ all = false, onProgress } = {}) {
    const ids = db.prepare(`SELECT id FROM photos${all ? '' : ' WHERE perceptual_hash IS NULL'}`).all().map(r => r.id);
    const upd = db.prepare('UPDATE photos SET perceptual_hash = ? WHERE id = ?');
    let done = 0, failed = 0;
    for (const id of ids) {
      onProgress?.({ done, total: ids.length, current: id });
      const src = hashSource(id);
      try { if (!src) throw new Error('illisible'); upd.run(await dhash(src), id); } catch { failed++; }
      done++;
    }
    onProgress?.({ done, total: ids.length, current: null });
    return { computed: done - failed, failed, total: ids.length };
  }

  // ---------- fiches présentées dans l'outil de comparaison ----------
  function details(ids) {
    const st = db.prepare('SELECT * FROM photos WHERE id = ?');
    const files = db.prepare(`SELECT f.id, f.path, f.file_name, f.size_bytes, f.kind, f.status, f.sha256, s.name support, s.status support_status
      FROM files f LEFT JOIN supports s ON s.id = f.support_id WHERE f.photo_id = ? ORDER BY CASE f.kind WHEN 'original' THEN 0 ELSE 1 END, f.indexed_at`);
    const edits = db.prepare('SELECT COUNT(*) n FROM edits WHERE photo_id = ?');
    return ids.map(id => {
      const r = st.get(id); if (!r) return null;
      const fl = files.all(id), first = fl[0];
      const card = library.cardView({ ...r, path: first?.path, fdata: db.prepare('SELECT data FROM files WHERE photo_id = ? LIMIT 1').get(id)?.data, support_id: null });
      const dup = P(r.data)?.duplicate ?? null;
      return { id, title: r.title, thumb: card.thumb, preview: card.preview, width: r.width, height: r.height, format: r.format,
        captured_at: r.captured_at, camera: [r.camera_make, r.camera_model].filter(Boolean).join(' ') || null, rating: r.rating,
        missing: !!r.missing, sha256: r.sha256, hash: r.perceptual_hash, edits: edits.get(id).n,
        bytes: first?.size_bytes ?? null, reference: dup?.reference ?? null, isReference: !!dup?.isReference,
        files: fl.map(f => ({ id: f.id, path: f.path, name: f.file_name, bytes: f.size_bytes, kind: f.kind, available: f.status === 'available' && f.support_status !== 'absent', support: f.support })) };
    }).filter(Boolean);
  }

  // ---------- groupes par niveau ----------
  /** Regroupe des paires en composantes connexes (union-find), en écartant les paires déclarées « pas un doublon ». */
  function components(pairs) {
    const ign = ignored(), parent = new Map(), dist = new Map();
    const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const [a, b, d = 0] of pairs) {
      if (a === b || ign.has(pairKey(a, b))) continue;
      for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
      const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb);
      dist.set(pairKey(a, b), d);
    }
    const groups = new Map();
    for (const x of parent.keys()) { const r = find(x); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x); }
    return [...groups.values()].filter(g => g.length > 1).map(ids => {
      let max = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) max = Math.max(max, dist.get(pairKey(ids[i], ids[j])) ?? 0);
      return { ids, distance: max };
    });
  }

  function exactGroups() {
    // (a) une fiche, plusieurs fichiers identiques (rattachés par l'indexation)
    const multi = db.prepare('SELECT photo_id id, COUNT(*) n FROM files GROUP BY photo_id HAVING COUNT(*) > 1').all()
      .map(r => ({ ids: [r.id], kind: 'files', reason: `${r.n} fichiers identiques pour une même photo` }));
    // (b) plusieurs fiches de même empreinte
    const pairs = [];
    for (const r of db.prepare('SELECT sha256, GROUP_CONCAT(id) ids FROM photos WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1').all()) {
      const ids = r.ids.split(','); for (let i = 1; i < ids.length; i++) pairs.push([ids[0], ids[i], 0]);
    }
    return [...multi, ...components(pairs).map(g => ({ ...g, kind: 'photos', reason: 'Même contenu (empreinte SHA-256) sur plusieurs fiches' }))];
  }

  function potentialGroups() {
    const pairs = [];
    const byName = db.prepare(`SELECT GROUP_CONCAT(DISTINCT f.photo_id) ids FROM files f JOIN photos p ON p.id = f.photo_id
      WHERE f.file_name IS NOT NULL AND p.width IS NOT NULL GROUP BY lower(f.file_name), p.width, p.height HAVING COUNT(DISTINCT f.photo_id) > 1`).all();
    const byShot = db.prepare(`SELECT GROUP_CONCAT(id) ids FROM photos WHERE captured_at IS NOT NULL AND camera_model IS NOT NULL AND width IS NOT NULL
      GROUP BY captured_at, camera_model, width, height HAVING COUNT(*) > 1`).all();
    for (const r of [...byName, ...byShot]) { const ids = r.ids.split(','); for (let i = 1; i < ids.length; i++) pairs.push([ids[0], ids[i], 0]); }
    // contenu différent seulement (les doublons exacts sont déjà au niveau « exacts »)
    const sha = new Map(db.prepare('SELECT id, sha256 FROM photos').all().map(r => [r.id, r.sha256]));
    return components(pairs.filter(([a, b]) => !sha.get(a) || sha.get(a) !== sha.get(b)))
      .map(g => ({ ...g, reason: 'Même nom et mêmes dimensions, ou même prise de vue (instant, appareil, dimensions) — à confirmer' }));
  }

  function similarGroups(threshold = DEFAULT_THRESHOLD) {
    const t = Math.max(0, Math.min(MAX_THRESHOLD, Math.round(+threshold || 0)));
    const rows = db.prepare('SELECT id, perceptual_hash h, width, height FROM photos WHERE perceptual_hash IS NOT NULL').all();
    const tree = new BKTree(), pairs = [];
    const hashOf = new Map(rows.map(r => [r.id, r.h]));
    for (const r of rows) {
      for (const [id, d] of tree.near(r.h, t)) if (colorGap(r.h, hashOf.get(id)) <= MAX_COLOR_GAP) pairs.push([id, r.id, d]);
      tree.add(r.h, r.id);
    }
    const dims = new Map(rows.map(r => [r.id, `${r.width}x${r.height}`]));
    return components(pairs).map(g => {
      const versions = new Set(g.ids.map(id => dims.get(id))).size > 1;
      return { ...g, kind: versions ? 'versions' : 'similar', reason: versions ? `Même image à d'autres dimensions (recadrage, réduction, export…) — distance ${g.distance}/64` : `Images très proches — distance ${g.distance}/64` };
    });
  }

  function burstGroups(seconds = DEFAULT_BURST_SECONDS) {
    const s = Math.max(0.5, Math.min(60, +seconds || DEFAULT_BURST_SECONDS));
    const rows = db.prepare('SELECT id, camera_model cam, captured_at t FROM photos WHERE captured_at IS NOT NULL AND camera_model IS NOT NULL ORDER BY camera_model, captured_at').all();
    const pairs = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (a.cam === b.cam && Math.abs(new Date(b.t) - new Date(a.t)) <= s * 1000) pairs.push([a.id, b.id, 0]);
    }
    return components(pairs).map(g => ({ ...g, reason: `Prises à moins de ${s} s d'intervalle avec le même appareil` }));
  }

  /** Groupes d'un niveau, du plus grand au plus petit, avec la fiche de chaque photo. */
  function groups(level = 'exact', { threshold, seconds, offset = 0, limit = 50 } = {}) {
    if (!LEVELS[level]) throw new Error('Niveau inconnu');
    const all = level === 'exact' ? exactGroups() : level === 'potential' ? potentialGroups() : level === 'similar' ? similarGroups(threshold) : burstGroups(seconds);
    // tri : plus de photos d'abord ; dans un groupe, la référence en tête, puis la plus grande image
    all.sort((a, b) => b.ids.length - a.ids.length);
    const off = Math.max(0, +offset || 0), lim = Math.max(1, Math.min(200, +limit || 50));
    return {
      level, label: LEVELS[level], total: all.length, offset: off, limit: lim,
      groups: all.slice(off, off + lim).map(g => {
        const photos = details(g.ids).sort((a, b) => (b.isReference - a.isReference) || ((b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)));
        return { ...g, key: [...g.ids].sort().join('|'), photos };
      }),
      hashesMissing: missingHashes(),
    };
  }

  function summary({ threshold, seconds } = {}) {
    return {
      exact: exactGroups().length, potential: potentialGroups().length,
      similar: similarGroups(threshold).length, burst: burstGroups(seconds).length,
      hashesMissing: missingHashes(), photos: db.prepare('SELECT COUNT(*) n FROM photos').get().n, ignoredPairs: ignored().size,
      excludedFiles: db.prepare('SELECT COUNT(*) n FROM excluded_files').get().n,
    };
  }

  // ---------- décisions de l'utilisateur ----------
  const setDup = (id, val) => {
    const r = db.prepare('SELECT data FROM photos WHERE id = ?').get(id); if (!r) return;
    const d = P(r.data) ?? {}; if (val) d.duplicate = val; else delete d.duplicate;
    db.prepare('UPDATE photos SET data = ? WHERE id = ?').run(JSON.stringify(d), id);
  };
  /** Désigne la photo de référence d'un groupe ; les autres deviennent ses variantes (rien n'est supprimé). */
  function setReference(photoIds, reference) {
    const ids = [...new Set([].concat(photoIds ?? []))].filter(id => db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id));
    if (!ids.includes(reference)) throw new Error('La référence doit faire partie du groupe');
    const at = new Date().toISOString();
    for (const id of ids) setDup(id, id === reference ? { isReference: true, at } : { reference, at });
    logHistory(db, 'duplicates.reference', `Référence désignée parmi ${ids.length} photo(s) (variantes conservées)`, { reference, ids });
    return { reference, variants: ids.filter(id => id !== reference) };
  }
  function clearReference(photoIds) {
    for (const id of [].concat(photoIds ?? [])) setDup(id, null);
    return { cleared: [].concat(photoIds ?? []).length };
  }
  /** « Ce ne sont pas des doublons » : toutes les paires du groupe sont écartées des regroupements. */
  function ignore(photoIds) {
    const ids = [...new Set([].concat(photoIds ?? []))]; if (ids.length < 2) throw new Error('Il faut au moins deux photos');
    const set = ignored();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) set.add(pairKey(ids[i], ids[j]));
    saveIgnored(set);
    logHistory(db, 'duplicates.ignore', `${ids.length} photo(s) déclarées distinctes`, { ids });
    return { ignoredPairs: set.size };
  }
  function resetIgnored() { saveIgnored(new Set()); return { ignoredPairs: 0 }; }
  /** Fichier de référence d'une photo présente en plusieurs fichiers : les autres deviennent des copies. */
  function setReferenceFile(fileId) {
    const f = db.prepare('SELECT id, photo_id, path FROM files WHERE id = ?').get(fileId); if (!f) throw new Error('Fichier inconnu');
    db.prepare("UPDATE files SET kind = 'copy' WHERE photo_id = ? AND id <> ?").run(f.photo_id, f.id);
    db.prepare("UPDATE files SET kind = 'original' WHERE id = ?").run(f.id);
    logHistory(db, 'duplicates.file', `Fichier de référence : ${f.path}`, { photoId: f.photo_id, fileId });
    return { photoId: f.photo_id, reference: f.id };
  }

  // ---------- suppression d'une fiche en double (index seulement, jamais le fichier sur le disque) ----------
  const exclude = db.prepare(`INSERT INTO excluded_files(path, sha256, photo_id, excluded_at) VALUES(?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, photo_id = excluded.photo_id, excluded_at = excluded.excluded_at`);
  /** Disponibilité / drapeau « indisponible » de la photo après retrait d'un de ses fichiers. */
  function refreshPhoto(photoId) {
    const fl = db.prepare(`SELECT f.id, f.kind, f.status, s.status sst FROM files f LEFT JOIN supports s ON s.id = f.support_id WHERE f.photo_id = ?
      ORDER BY CASE f.kind WHEN 'original' THEN 0 ELSE 1 END, f.indexed_at`).all(photoId);
    // il reste toujours un fichier de référence : le premier disponible si l'ancien vient d'être retiré
    if (fl.length && !fl.some(f => f.kind === 'original')) {
      const best = fl.find(f => f.status === 'available' && f.sst !== 'absent') ?? fl[0];
      db.prepare("UPDATE files SET kind = 'original' WHERE id = ?").run(best.id);
    }
    const missing = fl.length && fl.every(f => f.status !== 'available' || f.sst === 'absent') ? 1 : 0;
    db.prepare('UPDATE photos SET missing = ? WHERE id = ?').run(missing, photoId);
  }
  /**
   * Supprime la fiche d'un fichier en double : la photo garde ses autres fichiers. Le fichier n'est ni
   * effacé ni déplacé ; il est noté « écarté » pour que l'indexation ne le rattache pas de nouveau.
   */
  function removeFile(fileId) {
    const f = db.prepare('SELECT id, photo_id, path, sha256 FROM files WHERE id = ?').get(fileId); if (!f) throw new Error('Fichier inconnu');
    const n = db.prepare('SELECT COUNT(*) n FROM files WHERE photo_id = ?').get(f.photo_id).n;
    if (n < 2) throw new Error('C’est le seul fichier de cette photo : supprimez la fiche de la photo à la place');
    tx(db, () => {
      db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
      exclude.run(f.path, f.sha256, f.photo_id, new Date().toISOString());
      refreshPhoto(f.photo_id);
    });
    logHistory(db, 'duplicates.removeFile', `Fiche en double supprimée : ${f.path} (fichier conservé sur le disque)`, { photoId: f.photo_id, fileId, path: f.path });
    return { removed: f.id, photoId: f.photo_id, path: f.path, fileUntouched: true };
  }
  /**
   * Supprime la fiche d'une photo en double (avec ses mots-clés et versions retouchées ; un album qui
   * l'utilisait signale le cadre). Ses fichiers restent sur le disque et sont écartés de l'indexation.
   * Ses variantes redeviennent visibles.
   */
  function removePhoto(photoId) {
    const p = db.prepare('SELECT id, title FROM photos WHERE id = ?').get(photoId); if (!p) throw new Error('Photo inconnue');
    const files = db.prepare('SELECT path, sha256 FROM files WHERE photo_id = ?').all(photoId);
    const t = new Date().toISOString();
    tx(db, () => { for (const f of files) exclude.run(f.path, f.sha256, photoId, t); });
    library.removeFromIndex([photoId]);
    return { removed: photoId, files: files.map(f => f.path), filesUntouched: true };
  }
  const excludedCount = () => db.prepare('SELECT COUNT(*) n FROM excluded_files').get().n;
  /** Réautorise l'indexation des fichiers écartés (ils reviennent à la prochaine indexation de leur dossier). */
  function resetExcluded() { const n = excludedCount(); db.prepare('DELETE FROM excluded_files').run(); logHistory(db, 'duplicates.unexclude', `${n} fichier(s) écarté(s) réautorisé(s)`, {}); return { reset: n }; }

  return { computeHashes, missingHashes, groups, summary, setReference, clearReference, ignore, resetIgnored, setReferenceFile, removeFile, removePhoto, excludedCount, resetExcluded };
}
