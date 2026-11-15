// Importation physique : transfère des fichiers vers la bibliothèque, détecte les doublons par empreinte,
// gère les collisions de nom, conserve les métadonnées, puis indexe la copie.
//
// Deux modes :
//  - « copy » (défaut) : la source n'est jamais touchée. Seul mode possible depuis un téléphone (MTP, lib/phones.mjs).
//  - « move » (choix explicite de l'utilisateur) : la source n'est supprimée QU'APRÈS une copie vérifiée
//    (taille + empreinte SHA-256 identique) ET indexée. En cas de doute (copie différente, indexation en échec,
//    suppression impossible) la source est conservée et la copie ratée est retirée.
// Dans les deux modes on ne remplace jamais un fichier existant (nom unique généré en cas de collision).
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { logHistory } from './db.mjs';
import { IMPORT_DIR, ROOT, DATA_DIR } from './paths.mjs';
import { isImage } from './library.mjs';
import { detectDrives } from './drives.mjs';
import { createPhones } from './phones.mjs';

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

export function createImports(db, store, library, keywords, supports = null, phones = createPhones()) {
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
      // lecteurs et téléphones sont cherchés en parallèle ; une détection de téléphones en échec ne masque pas les lecteurs
      drivesPending = Promise.all([detectDrives(), phones.detect().catch(() => [])]).then(([list, devices]) => {
        const known = supports?.list() ?? [];
        const out = list.map(d => {
          const fp = supports && d.driveType !== 'network' ? supports.fingerprint(d.root) : null; // pas de sondage des lecteurs réseau
          const s = known.find(k => (k.mount_path && norm(k.mount_path) === norm(d.root)) || (fp && k.fingerprint && k.fingerprint === fp));
          return { ...d, support: s ? { id: s.id, name: s.name, role: s.role } : null };
        });
        // téléphones et appareils photo en transfert de fichiers : pas de lettre de lecteur, import par copie seulement
        for (const p of devices) {
          out.push({ root: 'phone:' + p.id, letter: '', label: p.name, filesystem: '', driveType: 'portable', kind: p.kind, kindLabel: p.kindLabel,
            total: 0, free: 0, serial: null, dcim: null, system: false, likelyImport: true, support: null,
            phone: { id: p.id, name: p.name, brand: p.brand, ready: p.ready, storages: p.storages } });
        }
        out.sort((a, b) => (b.likelyImport - a.likelyImport) || String(a.root).localeCompare(String(b.root)));
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
      const name = String(r.n).toLowerCase();
      // « IMG_0001 (2).jpg » (nom unique généré à l'import) est aussi connu sous son nom d'origine « IMG_0001.jpg »
      const original = name.replace(/ \(\d+\)(\.[^.]*)?$/, '$1');
      for (const k of new Set([`${name}|${r.s}`, `${original}|${r.s}`])) (map.get(k) ?? map.set(k, []).get(k)).push(r.p);
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
  /** Vignette JPEG d'un fichier local ; null si le format n'est pas décodable. */
  async function thumbnailOf(file, size) {
    try {
      const sharp = (await import('sharp')).default;
      return await sharp(file, { limitInputPixels: 1024 * 1024 * 512, failOn: 'none' }).rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    } catch {
      try { // RAW : vignette intégrée au fichier
        const exifr = (await import('exifr')).default;
        const t = await exifr.thumbnail(file);
        if (t) return Buffer.from(t);
      } catch { /* aperçu impossible : l'interface affiche une icône */ }
    }
    return null;
  }
  /** Vignette JPEG d'un fichier d'un dossier analysé ; null si le format n'est pas décodable. */
  async function preview(file, size = 240) {
    file = path.resolve(String(file ?? ''));
    if (!isImage(file) || !isScanned(file)) throw Object.assign(new Error('Fichier hors des dossiers analysés'), { status: 403 });
    let st; try { st = fs.statSync(file); } catch { throw Object.assign(new Error('Fichier introuvable'), { status: 404 }); }
    if (!st.isFile()) throw Object.assign(new Error('Fichier introuvable'), { status: 404 });
    size = Math.max(64, Math.min(1024, Math.round(+size || 240)));
    const key = `${norm(file)}|${st.mtimeMs}|${st.size}|${size}`;
    if (previews.has(key)) { const b = previews.get(key); previews.delete(key); previews.set(key, b); return b; }
    const buf = await thumbnailOf(file, size);
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

  // --- Moteur d'import : un import = une ligne `imports` + un état (compteurs, résultats) partagé par les fichiers traités ---
  function beginImport(total, mode, opts, firstSource) {
    const S = { importId: uid(), mode, total, copied: 0, moved: 0, dupes: 0, removedDupes: 0, skipped: 0, errors: 0, kept: 0, stopped: false, results: [], removed: [], verify: mode === 'move' || !!opts.verify };
    db.prepare('INSERT INTO imports(id,source,dest,mode,total,done,skipped,errors,status,started_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(S.importId, firstSource ?? '', destRoot(), mode, total, 0, 0, 0, 'running', now(), '{}');
    return S;
  }
  function finishImport(S, opts, extra = {}) {
    const data = { mode: S.mode, verify: S.verify, removeDuplicateSources: !!opts.removeDuplicateSources, supportId: opts.supportId ?? null, supportName: opts.supportName ?? null,
      root: opts.root ?? null, moved: S.moved, removedDuplicates: S.removedDupes, keptSources: S.kept, stopped: S.stopped, removedSources: S.removed.slice(0, 500), ...extra };
    db.prepare('UPDATE imports SET done=?, skipped=?, errors=?, status=?, finished_at=?, data=? WHERE id=?')
      .run(S.copied, S.dupes + S.skipped, S.errors, S.stopped ? 'stopped' : S.errors ? 'partial' : 'done', now(), JSON.stringify(data), S.importId);
    const from = extra.phone ? ` depuis « ${extra.phone} »` : '';
    logHistory(db, S.mode === 'move' ? 'import.move' : 'import.copy',
      `Import ${S.importId} (${S.mode === 'move' ? 'déplacement' : 'copie'})${from} : ${S.copied} copiées${S.mode === 'move' ? `, ${S.moved} sources supprimées` : ''}, ${S.dupes} doublons${S.removedDupes ? ` (${S.removedDupes} retirés de la source)` : ''}, ${S.errors} erreurs${S.stopped ? ', interrompu' : ''}`,
      { total: S.total, copied: S.copied, moved: S.moved, dupes: S.dupes, removedDupes: S.removedDupes, errors: S.errors, kept: S.kept, dryRun: !!opts.dryRun, ...extra });
  }
  const summary = S => ({ importId: S.importId, mode: S.mode, total: S.total, copied: S.copied, moved: S.moved, duplicates: S.dupes, removedDuplicates: S.removedDupes,
    keptSources: S.kept, skipped: S.skipped, errors: S.errors, stopped: S.stopped, results: S.results });

  /** Traite UN fichier source : doublon, copie, vérification, indexation et, en mode « move », suppression de la source. */
  async function processOne(src, i, S, opts) {
    const mode = S.mode, verify = S.verify;
    const copyFile = opts.copyFile ?? fs.copyFileSync;
    const removeFile = opts.removeFile ?? removeSource;
    opts.onProgress?.({ done: i, total: S.total, current: src, status: mode === 'move' ? 'déplacement' : 'copie' });
    let dest = null, created = false;
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) { S.skipped++; S.results.push({ src, status: 'ignored', reason: 'pas un fichier' }); return; }
      if (under(destRoot(), src)) { S.skipped++; S.results.push({ src, status: 'ignored', reason: 'déjà dans la photothèque' }); return; }
      if (mode === 'move' && !opts.dryRun) {
        const why = checkMovable(src);
        if (why) { S.skipped++; S.results.push({ src, status: 'ignored', reason: why }); return; }
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
            try { removeFile(src); S.removedDupes++; S.removed.push(src); status = 'duplicate-removed'; dropFileRow(src, null); }
            catch (e) { reason = 'source non supprimée : ' + String(e.message || e); S.kept++; }
          } else reason = 'exemplaire de la photothèque introuvable ou différent : source conservée';
        }
        S.dupes++;
        S.results.push({ src, status, existing: others[0], ...(reason ? { reason } : {}) });
        return;
      }
      if (opts.dryRun) { S.copied++; S.results.push({ src, status: mode === 'move' ? 'would-move' : 'would-copy', hash }); return; }
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
      S.copied++;
      let status = 'copied';
      if (mode === 'move') {
        try { removeFile(src); S.moved++; S.removed.push(src); status = 'moved'; dropFileRow(src, dest); }
        catch (e) { S.kept++; S.results.push({ src, dest, status: 'copied', hash, reason: 'copie vérifiée mais source non supprimée : ' + String(e.message || e) }); opts.onProgress?.({ done: i + 1, total: S.total, current: dest, status: 'indexé' }); return; }
      }
      S.results.push({ src, dest, status, hash });
      opts.onProgress?.({ done: i + 1, total: S.total, current: dest, status: 'indexé' });
    } catch (e) {
      // une copie ratée est retirée (elle n'existait pas avant) ; la source n'a pas été touchée
      if (created && dest) { try { fs.unlinkSync(dest); } catch { /* ignoré */ } }
      S.errors++; S.results.push({ src, status: 'error', error: String(e.message || e) });
    }
  }

  /** Place disponible à la destination (une copie incomplète n'est pas tolérée). Lève une erreur 507 sinon. */
  function checkSpace(bytes) {
    try {
      const sfs = fs.statfsSync(destRoot());
      if (sfs.bavail * sfs.bsize < bytes + 50 * 1024 * 1024) throw Object.assign(new Error('Espace insuffisant à la destination de l\'import'), { status: 507 });
    } catch (e) { if (e.status === 507) throw e; /* statfs indisponible : pas de contrôle */ }
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
    if (!opts.dryRun) checkSpace(sources.reduce((a, s) => { try { return a + fs.statSync(s).size; } catch { return a; } }, 0));
    const S = beginImport(sources.length, mode, opts, sources[0]);
    try {
      for (let i = 0; i < sources.length; i++) {
        if (opts.shouldStop?.()) { S.stopped = true; break; }
        await processOne(sources[i], i, S, opts);
      }
    } finally { finishImport(S, opts); }
    return summary(S);
  }

  // ---------- Téléphones et appareils photo (MTP) : copie uniquement ----------
  /** Photos listées lors de la dernière lecture de chaque appareil (id → Map rel → fichier) : seules celles-ci peuvent être lues. */
  const phoneScans = new Map();
  const PHONE_BATCH = 20;
  const phoneRef = async id => {
    let dev = phones.known.get(id);
    if (!dev) { await phones.detect(); dev = phones.known.get(id); }
    if (!dev) throw Object.assign(new Error('Appareil introuvable (débranché ?)'), { status: 404 });
    return dev;
  };

  /** Liste les photos d'un téléphone (DCIM et Pictures). Peut durer une minute sur un appareil bien rempli. */
  async function scanPhone(id, { limit = 5000 } = {}) {
    const dev = await phoneRef(String(id));
    if (!dev.ready) throw Object.assign(new Error('Aucun stockage accessible : déverrouillez le téléphone, autorisez l\'accès à ses fichiers (« Transfert de fichiers » en USB, « Faire confiance » sur iPhone), puis actualisez.'), { status: 409 });
    const { files, truncated } = await phones.list({ id: dev.id }, { limit });
    phoneScans.set(dev.id, new Map(files.map(f => [f.rel, f])));
    const known = knownIndex();
    const out = files.map(f => {
      const parts = f.rel.split('\\');
      const same = f.size ? (known.get(`${f.name.toLowerCase()}|${f.size}`) ?? []) : [];
      return { path: f.rel, name: f.name, dir: parts.slice(0, -1).join('\\'), size: f.size ?? 0, mtime: f.mtime ?? 0, known: same.length > 0 };
    }).sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { phone: { id: dev.id, name: dev.name, kind: dev.kind }, root: dev.name, total: out.length, bytes: out.reduce((a, f) => a + f.size, 0), newCount: out.filter(f => !f.known).length, truncated, files: out };
  }

  /** Nom de fichier sûr pour Windows (un nom d'appareil peut contenir des caractères interdits). */
  const safeName = n => String(n).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'photo';

  /** Vignette d'une photo du téléphone : copiée un instant dans un dossier temporaire, réduite, puis effacée. */
  async function previewPhone(id, rel, size = 240) {
    const entry = phoneScans.get(String(id))?.get(String(rel));
    if (!entry) throw Object.assign(new Error('Photo inconnue : relisez le téléphone'), { status: 403 });
    size = Math.max(64, Math.min(1024, Math.round(+size || 240)));
    const key = `phone|${id}|${rel}|${entry.size}|${size}`;
    if (previews.has(key)) { const b = previews.get(key); previews.delete(key); previews.set(key, b); return b; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phototheque-prev-'));
    try {
      const name = safeName(entry.name);
      const r = await phones.copy({ id }, [{ rel: entry.rel, name, size: entry.size ?? 0, to: path.join(tmp, '0') }]);
      if (!r.copied) return null;
      const buf = await thumbnailOf(path.join(tmp, '0', name), size);
      if (buf) { previews.set(key, buf); if (previews.size > 400) previews.delete(previews.keys().next().value); }
      return buf;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /**
   * Importe des photos d'un téléphone (copie uniquement, jamais de suppression sur l'appareil) : par lots de
   * PHONE_BATCH, copiées dans un dossier temporaire, puis importées comme n'importe quel fichier (doublons par
   * empreinte, vérification, indexation) et le dossier temporaire est effacé. `rels` = chemins listés par scanPhone.
   */
  async function importFromPhone(id, rels, opts = {}) {
    const dev = await phoneRef(String(id));
    const scan = phoneScans.get(dev.id);
    rels = [].concat(rels ?? []).map(String);
    const entries = rels.map(r => scan?.get(r));
    if (!scan || entries.some(e => !e)) throw Object.assign(new Error('Photos inconnues : relisez le téléphone avant d\'importer'), { status: 403 });
    checkSpace(entries.reduce((a, e) => a + (e.size ?? 0), 0));
    const o = { ...opts, mode: 'copy', verify: opts.verify !== false, removeDuplicateSources: false, root: dev.name };
    const S = beginImport(entries.length, 'copy', o, `${dev.name}\\${rels[0] ?? ''}`);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'phototheque-phone-'));
    try {
      for (let b = 0; b < entries.length && !S.stopped; b += PHONE_BATCH) {
        if (opts.shouldStop?.()) { S.stopped = true; break; }
        const batch = entries.slice(b, b + PHONE_BATCH);
        const jobs = batch.map((e, k) => ({ rel: e.rel, name: safeName(e.name), size: e.size ?? 0, to: path.join(staging, String(b + k)) }));
        opts.onProgress?.({ done: b, total: S.total, current: batch[0].rel, status: 'lecture du téléphone' });
        const failed = new Map();
        const cp = await phones.copy({ id: dev.id }, jobs, { shouldStop: opts.shouldStop, onFile: x => { if (!x.ok) failed.set(x.rel, x.error); } });
        for (let k = 0; k < jobs.length; k++) {
          const job = jobs[k], staged = path.join(job.to, job.name);
          if (!fs.existsSync(staged)) {
            if (cp.stopped) break; // lot interrompu : les fichiers non copiés ne sont pas des erreurs
            S.errors++; S.results.push({ src: job.rel, status: 'error', error: failed.get(job.rel) || 'copie depuis le téléphone impossible' });
            continue;
          }
          await processOne(staged, b + k, S, { ...o, onProgress: opts.onProgress });
          const last = S.results[S.results.length - 1]; if (last) last.src = job.rel; // on rapporte le chemin sur le téléphone
          fs.rmSync(job.to, { recursive: true, force: true });
          if (opts.shouldStop?.()) { S.stopped = true; break; }
        }
        if (cp.stopped) S.stopped = true;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      finishImport(S, o, { phone: dev.name, phoneId: dev.id });
    }
    return summary(S);
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
  return { importFiles, importIndexOnly, list, destRoot, uniqueName, drives, scan, preview, isScanned, checkMovable, scanPhone, previewPhone, importFromPhone };
}
