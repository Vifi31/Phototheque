// Importation physique (copie) : transfère des fichiers vers la bibliothèque, détecte les doublons
// par empreinte, gère les collisions de nom, conserve les métadonnées, puis indexe la copie.
// Règle absolue : on ne supprime jamais la source ; on ne remplace jamais un fichier existant.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { tx, logHistory } from './db.mjs';
import { IMPORT_DIR } from './paths.mjs';

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

export function createImports(db, store, library, keywords) {
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

  /** Importe une liste de fichiers (copie vers la bibliothèque) + indexation des copies.
   *  opts.onProgress({done,total,current,status}) ; opts.dryRun simule sans écrire. */
  async function importFiles(sources, opts = {}) {
    sources = [].concat(sources ?? []).filter(Boolean);
    const importId = uid();
    const started = now();
    let total = sources.length, copied = 0, dupes = 0, skipped = 0, errors = 0;
    const results = [];
    db.prepare('INSERT INTO imports(id,source,dest,mode,total,done,skipped,errors,status,started_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(importId, sources.slice(0, 1).join(''), destRoot(), 'copy', total, 0, 0, 0, 'running', started, '{}');
    try {
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        opts.onProgress?.({ done: i, total, current: src, status: 'copie' });
        try {
          const st = fs.statSync(src);
          if (!st.isFile()) { skipped++; results.push({ src, status: 'ignored', reason: 'pas un fichier' }); continue; }
          const hash = await sha256(src);
          // doublon exact déjà présent dans la bibliothèque ?
          const existing = db.prepare('SELECT path FROM files WHERE sha256 = ? LIMIT 1').get(hash);
          if (existing && !opts.force) { dupes++; results.push({ src, status: 'duplicate', existing: existing.path }); continue; }
          if (opts.dryRun) { copied++; results.push({ src, status: 'would-copy', hash }); continue; }
          // métadonnées pour structurer la destination
          const meta = await library.readMeta(src).catch(() => null);
          const dir = destFor(meta);
          const name = uniqueName(dir, path.basename(src)); // jamais d'écrasement
          const dest = path.join(dir, name);
          fs.copyFileSync(src, dest); // copie binaire, métadonnées EXIF incluses
          // indexe la copie (sans toucher à la source) : la photo apparaît dans la
          // bibliothèque et son empreinte permet de détecter un futur ré-import.
          const destFolder = ensureFolder(dir);
          await library.indexFile(dest, { folderId: destFolder, supportId: opts.supportId ?? null }).catch(() => null);
          copied++;
          results.push({ src, dest, status: 'copied', hash });
          opts.onProgress?.({ done: i + 1, total, current: dest, status: 'indexé' });
        } catch (e) { errors++; results.push({ src, status: 'error', error: String(e.message || e) }); }
      }
    } finally {
      db.prepare('UPDATE imports SET done=?, skipped=?, errors=?, status=?, finished_at=? WHERE id=?')
        .run(copied, dupes + skipped, errors, errors ? 'partial' : 'done', now(), importId);
      logHistory(db, 'import.copy', `Import ${importId} : ${copied} copiées, ${dupes} doublons, ${errors} erreurs`, { total, copied, dupes, errors, dryRun: !!opts.dryRun });
    }
    return { importId, total, copied, duplicates: dupes, skipped, errors, results };
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
  return { importFiles, importIndexOnly, list, destRoot, uniqueName };
}
