// Service de sauvegarde : création, liste, vérification, restauration, import, purge, planification.
// Les sauvegardes « données » emportent la base SQLite du catalogue (phototheque.db), le store.json
// et le dossier Documents. Les vignettes (data/thumbs) sont un cache régénérable et ne sont pas incluses.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createZip, readZip } from './zip.mjs';
import { BACKUP_DIR, DATA_DIR, DOCS_DIR, REPORTS_DIR } from './paths.mjs';
import { APP } from './appinfo.mjs';

export const BACKUP_TYPES = {
  data: { label: 'Données', desc: "Catalogue (base phototheque.db), réglages (store.json) et dossier Documents" },
  program: { label: 'Programme', desc: "Code de l'application (sans les données personnelles)" },
  full: { label: 'Complète', desc: 'Données + programme + rapports' },
};
const PROGRAM_FILES = ['server.mjs', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'app.config.json', '.env.example', '.gitignore'];
const PROGRAM_DIRS = ['lib', 'public', 'scripts', 'docs'];
const DB_FILE = path.join(DATA_DIR, 'phototheque.db');
const STORE = path.join(DATA_DIR, 'store.json');

export function listProgramFiles(root) {
  const walk = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  return [...PROGRAM_FILES.map(f => path.join(root, f)).filter(fs.existsSync), ...PROGRAM_DIRS.flatMap(d => walk(path.join(root, d)))];
}
export const PROGRAM_PATHS = { files: PROGRAM_FILES, dirs: PROGRAM_DIRS };

export const backupSettings = (s = {}) => ({ auto: s.auto ?? false, every: s.every ?? 7, weekday: s.weekday ?? 1, time: s.time ?? '20:00', type: s.type ?? 'data', keep: s.keep ?? 10 });

export function createBackupService({ root, getStats, onRestored, db }) {
  const DIR = BACKUP_DIR;
  const RELEVES = DOCS_DIR;
  const RAPPORTS = REPORTS_DIR;
  fs.mkdirSync(DIR, { recursive: true });
  const version = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return '0.1.0'; } };

  const walk = (dir, base = dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const f = path.join(dir, e.name);
      return e.isDirectory() ? walk(f, base) : [f];
    });
  };
  const slash = p => p.replace(/\\/g, '/');
  // nom logique dans l'archive (identique en mode développement et installé)
  const rel = f => f === STORE ? 'data/store.json'
    : f === DB_FILE ? 'data/phototheque.db'
      : f.startsWith(RELEVES + path.sep) ? 'Documents/' + slash(path.relative(RELEVES, f))
        : f.startsWith(RAPPORTS + path.sep) ? 'Rapports/' + slash(path.relative(RAPPORTS, f))
          : slash(path.relative(root, f));
  // chemin physique d'un nom logique de données (null = élément du programme)
  const physical = name => name === 'data/store.json' ? STORE
    : name === 'data/phototheque.db' ? DB_FILE
      : name.startsWith('Documents/') ? path.join(RELEVES, name.slice(10))
        : null;

  // La base doit être copiée de façon cohérente (WAL) : on vide d'abord le WAL dans le fichier principal.
  function checkpoint() { try { db?.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* pas de base ouverte */ } }

  function sources(type) {
    const out = { data: [], program: [], reports: [] };
    if (fs.existsSync(STORE)) out.data.push(STORE);
    if (fs.existsSync(DB_FILE)) out.data.push(DB_FILE);
    out.data.push(...walk(RELEVES));
    out.program.push(...PROGRAM_FILES.map(f => path.join(root, f)).filter(fs.existsSync));
    for (const d of PROGRAM_DIRS) out.program.push(...walk(path.join(root, d)));
    out.reports.push(...walk(RAPPORTS));
    if (type === 'data') return out.data;
    if (type === 'program') return out.program;
    return [...out.data, ...out.program, ...out.reports];
  }
  const sizeOf = files => files.reduce((s, f) => s + fs.statSync(f).size, 0);

  function volumes() {
    checkpoint();
    const s = { data: sources('data'), program: sources('program') };
    const rel_ = walk(RELEVES);
    const rep = walk(RAPPORTS);
    return {
      statements: { count: rel_.length, size: sizeOf(rel_) },
      settings: { count: (fs.existsSync(STORE) ? 1 : 0) + (fs.existsSync(DB_FILE) ? 1 : 0), size: (fs.existsSync(STORE) ? fs.statSync(STORE).size : 0) + (fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0) },
      program: { count: s.program.length, size: sizeOf(s.program) },
      reports: { count: rep.length, size: sizeOf(rep) },
    };
  }

  function create(type, { label = '', auto = false } = {}) {
    if (!BACKUP_TYPES[type]) throw new Error('Type de sauvegarde inconnu');
    checkpoint();
    const files = sources(type);
    const entries = files.map(f => ({ name: rel(f), data: fs.readFileSync(f), mtime: fs.statSync(f).mtime }));
    const st = getStats ? getStats() : {};
    const manifest = {
      app: APP.name, version: version(), type, label: String(label).slice(0, 80), auto, createdAt: new Date().toISOString(),
      files: entries.length, rawSize: entries.reduce((s, e) => s + e.data.length, 0),
      counts: type === 'program' ? {} : { photos: st.photos ?? 0, supports: st.supports ?? 0, keywords: st.keywords ?? 0, albums: st.albums ?? 0, documents: files.filter(f => f.startsWith(RELEVES)).length },
    };
    entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `${APP.slug}_${type}_${stamp}${auto ? '_auto' : ''}.zip`;
    fs.writeFileSync(path.join(DIR, name), createZip(entries));
    return { name, manifest, size: fs.statSync(path.join(DIR, name)).size };
  }

  const safeName = n => {
    n = path.basename(String(n || ''));
    if (!/^[\w.\- ()]+\.zip$/i.test(n)) throw new Error('Nom de sauvegarde invalide');
    return n;
  };
  const readManifest = file => {
    const buf = fs.readFileSync(file);
    const m = readZip(buf).find(e => e.name === 'manifest.json');
    if (!m) throw new Error('manifest absent');
    const mf = JSON.parse(m.read().toString('utf8'));
    if (mf.app !== APP.name) throw new Error('Ce n’est pas une sauvegarde ' + APP.name);
    return mf;
  };

  function list() {
    return fs.readdirSync(DIR).filter(f => /\.zip$/i.test(f)).map(name => {
      const f = path.join(DIR, name), st = fs.statSync(f);
      try { return { name, size: st.size, mtime: st.mtime.toISOString(), manifest: readManifest(f) }; }
      catch (e) { return { name, size: st.size, mtime: st.mtime.toISOString(), error: String(e.message || e) }; }
    }).sort((a, b) => (b.manifest?.createdAt ?? b.mtime).localeCompare(a.manifest?.createdAt ?? a.mtime));
  }

  function verify(name) {
    const entries = readZip(fs.readFileSync(path.join(DIR, safeName(name))));
    const bad = [];
    for (const e of entries) {
      try { if (zlib.crc32(e.read()) !== e.crc) bad.push(e.name); } catch { bad.push(e.name); }
    }
    return { ok: bad.length === 0, entries: entries.length, bad };
  }

  /** Restauration : sauvegarde de sécurité puis remplacement de la base + store + Documents. */
  function restore(name) {
    const file = path.join(DIR, safeName(name));
    const mf = readManifest(file);
    if (mf.type === 'program') throw new Error('Une sauvegarde « Programme » ne se restaure pas depuis l’application : téléchargez-la et décompressez-la dans le dossier du projet.');
    const v = verify(name);
    if (!v.ok) throw new Error('Archive corrompue : ' + v.bad.slice(0, 3).join(', '));
    const safety = create('data', { label: 'Avant restauration de ' + name, auto: false });
    let restored = 0;
    for (const e of readZip(fs.readFileSync(file))) {
      const isStore = e.name === 'data/store.json', isDb = e.name === 'data/phototheque.db', isDocs = e.name.startsWith('Documents/');
      if (!isStore && !isDb && !isDocs) continue;
      const dest = physical(e.name);
      if (!dest) continue;
      if (!path.resolve(dest).startsWith(path.resolve(isDocs ? RELEVES : DATA_DIR))) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isDb) { try { db?.close?.(); } catch { /* déjà fermée */ } }
      fs.writeFileSync(dest, e.read()); restored++;
    }
    onRestored?.();
    return { restored, safety: safety.name };
  }

  function remove(name) { fs.unlinkSync(path.join(DIR, safeName(name))); }
  function importZip(name, buf) {
    name = safeName(name);
    const tmp = path.join(DIR, '.import.tmp');
    fs.writeFileSync(tmp, buf);
    try {
      readManifest(tmp);
      let final = name, i = 2;
      while (fs.existsSync(path.join(DIR, final))) final = name.replace(/\.zip$/i, `_${i++}.zip`);
      fs.renameSync(tmp, path.join(DIR, final)); return final;
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  function prune(keep, onlyAuto = true) {
    const items = list().filter(b => b.manifest && (!onlyAuto || b.manifest.auto));
    const del = items.slice(Math.max(1, keep));
    del.forEach(b => remove(b.name)); return del.length;
  }

  const filePath = name => path.join(DIR, safeName(name));
  return { create, list, verify, restore, remove, importZip, prune, volumes, filePath, DIR, types: BACKUP_TYPES };
}
