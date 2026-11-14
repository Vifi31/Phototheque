// Importation physique : transfère des fichiers vers la bibliothèque, détecte les doublons par empreinte,
// gère les collisions de nom, conserve les métadonnées, puis indexe la copie.
//
// Deux modes :
//  - « copy » (défaut) : la source n'est jamais touchée.
//  - « move » (choix explicite de l'utilisateur) : la source n'est supprimée QU'APRÈS une copie vérifiée
//    (taille + empreinte SHA-256 identique) ET indexée. En cas de doute (copie différente, indexation en échec,
//    suppression impossible) la source est conservée et la copie ratée est retirée.
// Dans les deux modes on ne remplace jamais un fichier existant (nom unique généré en cas de collision).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logHistory } from './db.mjs';
import { IMPORT_DIR, ROOT, DATA_DIR } from './paths.mjs';
import { isImage } from './library.mjs';
import { detectDrives } from './drives.mjs';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sha256 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

/** Nom de destination sans collision : « photo.jpg » → « photo (2).jpg » si besoin. */
export function uniqueName(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let candidate = name, i = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base} (${i++})${ext}`;
  return candidate;
}

const WIN = process.platform === 'win32';
/** Chemin normalisé pour comparer (casse ignorée sous Windows). */
const norm = p => { let q = String(p); if (/^[A-Za-z]:$/.test(q)) q += '\\'; const r = path.resolve(q); return WIN ? r.toLowerCase() : r; }; // « E: » seul désignerait le dossier courant du lecteur
const under = (base, target) => { const b = norm(base), t = norm(target); return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };

/** Dossiers que l'analyse ne parcourt pas (corbeilles et dossiers système des supports). */
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '.trashes', '.spotlight-v100', '.fseventsd', 'lost+found', '$recycle.bin']);

export function createImports(db, store, library, keywords, supports = null) {
  void keywords;
  const cfg = () => store.import ?? {};

  /** Destination d'import (bibliothèque), structurée par année de prise de vue si demandé. */
  function destRoot() {
    const d = cfg().dest || IMPORT_DIR;
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  function destFor(meta) {
    const root = destRoot();
    if (cfg().keepFolders !== false && meta?.captured_at) {
      const y = meta.captured_at.slice(0, 4);
      const dir = path.join(root, y);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    return root;
  }

  /** Crée (ou retrouve) un enregistrement `folders` pour un chemin de destination d'import. */
  function ensureFolder(dir) {
    const existing = db.prepare('SELECT id FROM folders WHERE path = ?').get(dir);
    if (existing) return existing.id;
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    db.prepare('INSERT INTO folders(id,support_id,path,rel_path,photo_count,indexed_at,status,data) VALUES(?,?,?,NULL,0,NULL,?,?)')
      .run(id, null, dir, 'ok', '{}');
    return id;
  }

  // ---------- Supports détectés ----------
  let drivesCache = null, drivesPending = null;
  /**
   * Lecteurs branchés, avec le support enregistré correspondant (même point de montage ou même empreinte).
   * Résultat gardé 4 s et appels simultanés regroupés : la détection lance PowerShell (~2 s).
   */
  async function drives({ fresh = false } = {}) {
    if (!fresh && drivesCache && Date.now() - drivesCache.at < 4000) return drivesCache.list;
    if (!drivesPending) {
      drivesPending = detectDrives().then(list => {
        const known = supports?.list() ?? [];
        const out = list.map(d => {
          const fp = supports && d.driveType !== 'network' ? supports.fingerprint(d.root) : null; // pas de sondage des lecteurs réseau
          const s = known.find(k => (k.mount_path && norm(k.mount_path) === norm(d.root)) || (fp && k.fingerprint && k.fingerprint === fp));
          return { ...d, support: s ? { id: s.id, name: s.name, role: s.role } : null };
        });
        drivesCache = { at: Date.now(), list: out };
        return out;
      }).finally(() => { drivesPending = null; });
    }
    return drivesPending;
  }

  // ---------- Analyse d'un dossier source (choix des photos) ----------
  /** Dossiers analysés pendant cette session : seuls leurs fichiers peuvent être prévisualisés ou déplacés. */
  const scanRoots = new Map();
  const rootOf = file => { for (const r of scanRoots.values()) if (under(r, file)) return r; return null; };
  const isScanned = file => !!rootOf(file);

  /** Index (nom, taille) → chemins des fichiers déjà connus de la bibliothèque : repère les photos probablement déjà importées. */
  function knownIndex() {
    const map = new Map();
    for (const r of db.prepare("SELECT file_name n, size_bytes s, path p FROM files WHERE status = 'available'").iterate()) {
      const k = `${String(r.n).toLowerCase()}|${r.s}`;
      (map.get(k) ?? map.set(k, []).get(k)).push(r.p);
    }
    return map;
  }

  /**
   * Liste les images d'un dossier (récursif) : chemin, taille, date de modification, et `known` si un fichier de
   * même nom et de même taille est déjà dans la photothèque (ce n'est qu'une indication : le doublon exact est
   * décidé par empreinte à l'import). Mémorise le dossier comme « analysé ».
   */
  async function scan(root, { limit = 20000 } = {}) {
    root = path.resolve(String(root ?? '').trim());
    let st; try { st = fs.statSync(root); } catch { throw new Error('Dossier introuvable : ' + root); }
    if (!st.isDirectory()) throw new Error('Ce chemin n\'est pas un dossier : ' + root);
    scanRoots.set(norm(root), root);
    if (scanRoots.size > 20) scanRoots.delete(scanRoots.keys().next().value);
    const known = knownIndex();
    const files = []; let truncated = false;
    const stack = [root];
    while (stack.length && !truncated) {
      const dir = stack.pop();
      let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(full); continue; }
        if (!e.isFile() || !isImage(e.name)) continue;
        if (files.length >= limit) { truncated = true; break; }
        let s; try { s = await fs.promises.stat(full); } catch { continue; }
        const same = known.get(`${e.name.toLowerCase()}|${s.size}`) ?? [];
        files.push({ path: full, name: e.name, dir: path.relative(root, dir), size: s.size, mtime: s.mtimeMs, known: same.some(p => norm(p) !== norm(full)) });
      }
    }
    files.sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { root, total: files.length, bytes: files.reduce((a, f) => a + f.size, 0), newCount: files.filter(f => !f.known).length, truncated, files };
  }

  // ---------- Aperçus des fichiers à importer ----------
  const previews = new Map(); // petit cache mémoire (chemin|date|taille → JPEG)
  /** Vignette JPEG d'un fichier d'un dossier analysé ; null si le format n'est pas décodable. */
  async function preview(file, size = 240) {
    file = path.resolve(String(file ?? ''));
    if (!isImage(file) || !isScanned(file)) throw Object.assign(new Error('Fichier hors des dossiers analysés'), { status: 403 });
    let st; try { st = fs.statSync(file); } catch { throw Object.assign(new Error('Fichier introuvable'), { status: 404 }); }
    if (!st.isFile()) throw Object.assign(new Error('Fichier introuvable'), { status: 404 });
    size = Math.max(64, Math.min(1024, Math.round(+size || 240)));
    const key = `${norm(file)}|${st.mtimeMs}|${st.size}|${size}`;
    if (previews.has(key)) { const b = previews.get(key); previews.delete(key); previews.set(key, b); return b; }
    let buf = null;
    try {
      const sharp = (await import('sharp')).default;
      buf = await sharp(file, { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' }).rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    } catch {
      try { // RAW : vignette intégrée au fichier
        const exifr = (await import('exifr')).default;
        const t = await exifr.thumbnail(file);
        if (t) buf = Buffer.from(t);
      } catch { /* aperçu impossible : l'interface affiche une icône */ }
    }
    if (buf) { previews.set(key, buf); if (previews.size > 400) previews.delete(previews.keys().next().value); }
    return buf;
  }

  // ---------- Import ----------
  /** Supprime un fichier ordinaire ; lève une erreur si c'est impossible (support protégé, fichier ouvert…). */
  function removeSource(file) {
    const st = fs.lstatSync(file);
    if (!st.isFile()) throw new Error('pas un fichier ordinaire');
    try { fs.unlinkSync(file); }
    catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      fs.chmodSync(file, 0o666); // attribut « lecture seule » (cartes mémoire)
      fs.unlinkSync(file);
    }
  }

  /** Une source ne peut être déplacée que si l'utilisateur l'a désignée par une analyse et qu'elle n'est pas dans le programme ni la photothèque. */
  function checkMovable(src) {
    if (!isScanned(src)) return 'dossier non analysé : choisissez d\'abord les photos dans l\'écran Importation';
    if (under(destRoot(), src)) return 'déjà dans la photothèque';
    if (under(DATA_DIR, src) || under(ROOT, src)) return 'fichier du programme ou de ses données';
    return null;
  }

  /**
   * Importe une liste de fichiers vers la bibliothèque + indexation des copies.
   * opts : mode ('copy' | 'move'), verify (empreinte de la copie ; toujours vrai en mode « move »),
   *   removeDuplicateSources (mode « move » : retire aussi de la source les photos déjà importées, après avoir
   *   revérifié le fichier de la photothèque), supportId, dryRun, force, onProgress, shouldStop,
   *   copyFile / removeFile (remplacements pour les tests).
   */
  async function importFiles(sources, opts = {}) {
    sources = [].concat(sources ?? []).filter(Boolean).map(String);
    const mode = opts.mode === 'move' ? 'move' : 'copy';
    const verify = mode === 'move' || !!opts.verify;
    const copyFile = opts.copyFile ?? fs.copyFileSync;
    const removeFile = opts.removeFile ?? removeSource;
    const importId = uid();
    const started = now();
    let total = sources.length, copied = 0, moved = 0, dupes = 0, removedDupes = 0, skipped = 0, errors = 0, kept = 0, stopped = false;
    const results = [], removed = [];
    // place disponible à la destination (une copie incomplète n'est pas tolérée)
    if (!opts.dryRun) {
      try {
        const need = sources.reduce((a, s) => { try { return a + fs.statSync(s).size; } catch { return a; } }, 0);
        const sfs = fs.statfsSync(destRoot());
        if (sfs.bavail * sfs.bsize < need + 50 * 1024 * 1024) throw Object.assign(new Error('Espace insuffisant à la destination de l\'import'), { status: 507 });
      } catch (e) { if (e.status === 507) throw e; /* statfs indisponible : pas de contrôle */ }
    }
    db.prepare('INSERT INTO imports(id,source,dest,mode,total,done,skipped,errors,status,started_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(importId, sources.slice(0, 1).join(''), destRoot(), mode, total, 0, 0, 0, 'running', started, '{}');
    try {
      for (let i = 0; i < sources.length; i++) {
        if (opts.shouldStop?.()) { stopped = true; break; }
        const src = sources[i];
        opts.onProgress?.({ done: i, total, current: src, status: mode === 'move' ? 'déplacement' : 'copie' });
        let dest = null, created = false;
        try {
          const st = fs.statSync(src);
          if (!st.isFile()) { skipped++; results.push({ src, status: 'ignored', reason: 'pas un fichier' }); continue; }
          if (under(destRoot(), src)) { skipped++; results.push({ src, status: 'ignored', reason: 'déjà dans la photothèque' }); continue; }
          if (mode === 'move' && !opts.dryRun) {
            const why = checkMovable(src);
            if (why) { skipped++; results.push({ src, status: 'ignored', reason: why }); continue; }
          }
          const hash = await sha256(src);
          // doublon exact déjà dans la bibliothèque ? (un fichier indexé « sur place » ne compte pas : c'est la source elle-même)
          const others = db.prepare('SELECT path FROM files WHERE sha256 = ?').all(hash).map(r => r.path).filter(p => norm(p) !== norm(src));
          if (others.length && !opts.force) {
            let status = 'duplicate', reason;
            if (mode === 'move' && opts.removeDuplicateSources && !opts.dryRun) {
              // on ne supprime la source que si un exemplaire est bel et bien présent, de même taille et de même empreinte
              let proof = null;
              const srcRoot = rootOf(src);
              for (const p of others) {
                if (srcRoot && under(srcRoot, p)) continue; // un autre exemplaire sur le même support ne prouve rien
                try { if (fs.statSync(p).size === st.size && await sha256(p) === hash) { proof = p; break; } } catch { /* exemplaire absent */ }
              }
              if (proof) {
                try { removeFile(src); removedDupes++; removed.push(src); status = 'duplicate-removed'; dropFileRow(src, null); }
                catch (e) { reason = 'source non supprimée : ' + String(e.message || e); kept++; }
              } else reason = 'exemplaire de la photothèque introuvable ou différent : source conservée';
            }
            dupes++;
            results.push({ src, status, existing: others[0], ...(reason ? { reason } : {}) });
            continue;
          }
          if (opts.dryRun) { copied++; results.push({ src, status: mode === 'move' ? 'would-move' : 'would-copy', hash }); continue; }
          // métadonnées pour structurer la destination
          const meta = await library.readMeta(src).catch(() => null);
          const dir = destFor(meta);
          const name = uniqueName(dir, path.basename(src)); // jamais d'écrasement
          dest = path.join(dir, name);
          copyFile(src, dest); // copie binaire, métadonnées EXIF incluses
          created = true;
          if (fs.statSync(dest).size !== st.size) throw new Error('copie incomplète (taille différente)');
          if (verify && await sha256(dest) !== hash) throw new Error('copie différente de la source (empreinte SHA-256)');
          try { fs.utimesSync(dest, st.atime, st.mtime); } catch { /* dates non reportées : sans conséquence */ }
          // indexe la copie : la photo apparaît dans la bibliothèque et son empreinte permet de détecter un futur ré-import.
          const destFolder = ensureFolder(dir);
          if (mode === 'move') await library.indexFile(dest, { folderId: destFolder, supportId: null }); // échec = source conservée
          else await library.indexFile(dest, { folderId: destFolder, supportId: null }).catch(() => null);
          copied++;
          let status = 'copied';
          if (mode === 'move') {
            try { removeFile(src); moved++; removed.push(src); status = 'moved'; dropFileRow(src, dest); }
            catch (e) { kept++; results.push({ src, dest, status: 'copied', hash, reason: 'copie vérifiée mais source non supprimée : ' + String(e.message || e) }); opts.onProgress?.({ done: i + 1, total, current: dest, status: 'indexé' }); continue; }
          }
          results.push({ src, dest, status, hash });
          opts.onProgress?.({ done: i + 1, total, current: dest, status: 'indexé' });
        } catch (e) {
          // une copie ratée est retirée (elle n'existait pas avant) ; la source n'a pas été touchée
          if (created && dest) { try { fs.unlinkSync(dest); } catch { /* ignoré */ } }
          errors++; results.push({ src, status: 'error', error: String(e.message || e) });
        }
      }
    } finally {
      const data = { mode, verify, removeDuplicateSources: !!opts.removeDuplicateSources, supportId: opts.supportId ?? null, supportName: opts.supportName ?? null,
        root: opts.root ?? null, moved, removedDuplicates: removedDupes, keptSources: kept, stopped, removedSources: removed.slice(0, 500) };
      db.prepare('UPDATE imports SET done=?, skipped=?, errors=?, status=?, finished_at=?, data=? WHERE id=?')
        .run(copied, dupes + skipped, errors, stopped ? 'stopped' : errors ? 'partial' : 'done', now(), JSON.stringify(data), importId);
      logHistory(db, mode === 'move' ? 'import.move' : 'import.copy',
        `Import ${importId} (${mode === 'move' ? 'déplacement' : 'copie'}) : ${copied} copiées${mode === 'move' ? `, ${moved} sources supprimées` : ''}, ${dupes} doublons${removedDupes ? ` (${removedDupes} retirés de la source)` : ''}, ${errors} erreurs${stopped ? ', interrompu' : ''}`,
        { total, copied, moved, dupes, removedDupes, errors, kept, dryRun: !!opts.dryRun });
    }
    return { importId, mode, total, copied, moved, duplicates: dupes, removedDuplicates: removedDupes, keptSources: kept, skipped, errors, stopped, results };
  }

  /**
   * Après un déplacement : le fichier source n'existe plus. Sa ligne `files` (s'il était indexé sur place) est retirée ;
   * si la photo n'a plus de fichier « original », la copie de la bibliothèque le devient.
   */
  function dropFileRow(src, dest) {
    const row = db.prepare('SELECT id, photo_id FROM files WHERE path = ?').get(src);
    if (!row) return;
    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    if (dest) {
      const left = db.prepare("SELECT COUNT(*) n FROM files WHERE photo_id = ? AND kind = 'original'").get(row.photo_id).n;
      if (!left) db.prepare("UPDATE files SET kind = 'original' WHERE path = ? AND photo_id = ?").run(dest, row.photo_id);
    }
  }

  /** Indexe récursivement un dossier (par ex. une carte mémoire montée) SANS copie. */
  async function importIndexOnly(folderPath, opts = {}) {
    // crée un dossier indexé (sans support) puis indexe
    const id = uid();
    db.prepare('INSERT INTO folders(id,support_id,path,rel_path,photo_count,indexed_at,status,data) VALUES(?,?,?,NULL,0,NULL,?,?)')
      .run(id, opts.supportId ?? null, folderPath, 'pending', '{}');
    try {
      const r = await library.indexFolder(id, opts);
      return { folderId: id, ...r };
    } catch (e) {
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
      throw e;
    }
  }

  const list = () => db.prepare('SELECT * FROM imports ORDER BY started_at DESC LIMIT 50').all();
  return { importFiles, importIndexOnly, list, destRoot, uniqueName, drives, scan, preview, isScanned, checkMovable };
}
