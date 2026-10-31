// Base de données SQLite (module intégré à Node : node:sqlite, aucune dépendance) pour le catalogue Photothèque.
// Deux familles de tables :
//   1. Tables « catalogues » relationnelles (supports, dossiers, photos, fichiers, mots-clés, albums,
//      collections, retouches, imports/exports, historique) : requêtées pour la recherche et la navigation.
//   2. Tables « administration » (config, settings, license, prompt_journal, meta) : réglages, gérées
//      comme dans les applications voisines (sections JSON).
// Le fichier data/store.json reste écrit en copie lisible (miroir) pour les sauvegardes « données ».
import fs from 'fs';

// node:sqlite émet un avertissement « experimental » à l'import : inutile dans le journal du serveur
const emit0 = process.emit;
process.emit = function (name, data, ...rest) { return name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message ?? '') ? false : emit0.call(this, name, data, ...rest); };
const { DatabaseSync } = await import('node:sqlite');
process.emit = emit0;

export const SCHEMA_VERSION = 2;

const SCHEMA = `
-- ---------- Administration ----------
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prompt_journal (pos INTEGER PRIMARY KEY, id INTEGER, date TEXT, source TEXT, status TEXT, version TEXT, text TEXT, notes TEXT, data TEXT NOT NULL);

-- ---------- Supports de stockage ----------
CREATE TABLE IF NOT EXISTS supports (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'disk',
  brand TEXT, model TEXT, serial TEXT, filesystem TEXT,
  total_bytes INTEGER, free_bytes INTEGER,
  mount_path TEXT, drive_label TEXT, volume_serial TEXT,
  role TEXT NOT NULL DEFAULT 'original', status TEXT NOT NULL DEFAULT 'unknown',
  location TEXT, comments TEXT,
  added_at TEXT, checked_at TEXT, fingerprint TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_supports_status ON supports(status);

-- ---------- Dossiers indexés ----------
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, support_id TEXT REFERENCES supports(id) ON DELETE SET NULL,
  path TEXT NOT NULL, rel_path TEXT, photo_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT, status TEXT NOT NULL DEFAULT 'unknown',
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_folders_support ON folders(support_id);
CREATE INDEX IF NOT EXISTS ix_folders_path ON folders(path);

-- ---------- Photos (identité logique) ----------
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  captured_at TEXT,            -- date de prise de vue (EXIF) — distincte de modified_at
  modified_at TEXT,            -- date de modification du fichier
  imported_at TEXT,
  title TEXT, description TEXT, notes TEXT,
  rating INTEGER NOT NULL DEFAULT 0,     -- 0..5
  color INTEGER NOT NULL DEFAULT 0,      -- 0 (aucune) .. 8 (label)
  width INTEGER, height INTEGER, orientation INTEGER,
  format TEXT,                 -- jpeg, png, tiff, heic, raw…
  camera_make TEXT, camera_model TEXT, lens TEXT,
  focal_length REAL, aperture REAL, shutter TEXT, iso INTEGER,
  gps_lat REAL, gps_lon REAL, gps_alt REAL,
  author TEXT, copyright TEXT,
  keywords_text TEXT,          -- mots-clés aplatys (recherche plein texte)
  sha256 TEXT,                 -- empreinte de l'original (détection de doublons)
  perceptual_hash TEXT,        -- empreinte visuelle (photos similaires)
  missing INTEGER NOT NULL DEFAULT 0,    -- 1 si au moins un fichier source est indisponible
  data TEXT NOT NULL DEFAULT '{}'        -- métadonnées brutes (EXIF/IPTC/XMP) non exposées en colonnes
);
CREATE INDEX IF NOT EXISTS ix_photos_captured ON photos(captured_at);
CREATE INDEX IF NOT EXISTS ix_photos_sha ON photos(sha256);
CREATE INDEX IF NOT EXISTS ix_photos_rating ON photos(rating);
CREATE INDEX IF NOT EXISTS ix_photos_missing ON photos(missing);
CREATE INDEX IF NOT EXISTS ix_photos_camera ON photos(camera_make, camera_model);

-- ---------- Fichiers physiques (une photo peut en avoir plusieurs) ----------
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  support_id TEXT REFERENCES supports(id) ON DELETE SET NULL,
  path TEXT NOT NULL, rel_path TEXT,
  file_name TEXT, extension TEXT,
  size_bytes INTEGER, sha256 TEXT,
  kind TEXT NOT NULL DEFAULT 'original',   -- original | variant | derived | copy
  status TEXT NOT NULL DEFAULT 'available', -- available | missing | error
  indexed_at TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_files_photo ON files(photo_id);
CREATE INDEX IF NOT EXISTS ix_files_support ON files(support_id);
CREATE INDEX IF NOT EXISTS ix_files_sha ON files(sha256);
CREATE INDEX IF NOT EXISTS ix_files_path ON files(path);

-- ---------- Mots-clés ----------
CREATE TABLE IF NOT EXISTS keywords (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES keywords(id) ON DELETE SET NULL,
  normalized TEXT NOT NULL, photo_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_keywords_norm ON keywords(normalized);
CREATE TABLE IF NOT EXISTS photo_keywords (
  photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
  keyword_id TEXT REFERENCES keywords(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, keyword_id)
);
CREATE INDEX IF NOT EXISTS ix_pk_keyword ON photo_keywords(keyword_id);

-- ---------- Personnes, sujets, lieux ----------
CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, photo_count INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, photo_count INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL, lon REAL, photo_count INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');

-- ---------- Albums ----------
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  format TEXT NOT NULL DEFAULT 'square', orientation TEXT NOT NULL DEFAULT 'landscape',
  created_at TEXT, updated_at TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS album_photos (
  album_id TEXT REFERENCES albums(id) ON DELETE CASCADE,
  photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, page INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (album_id, photo_id)
);
CREATE TABLE IF NOT EXISTS album_pages (
  album_id TEXT REFERENCES albums(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  layout TEXT, background TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (album_id, page)
);

-- ---------- Collections (sélections statiques ou dynamiques) ----------
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'static',    -- static | dynamic
  query TEXT,                             -- JSON de requête pour les dynamiques
  created_at TEXT, updated_at TEXT, photo_count INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS collection_photos (
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, photo_id)
);

-- ---------- Retouches non destructives ----------
CREATE TABLE IF NOT EXISTS edits (
  id TEXT PRIMARY KEY,
  photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
  name TEXT, params TEXT,               -- réglages JSON (rotation, exposition…)
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, applied_at TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_edits_photo ON edits(photo_id);

-- ---------- Imports / exports ----------
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY, source TEXT, dest TEXT, mode TEXT,   -- copy | index
  total INTEGER, done INTEGER, skipped INTEGER, errors INTEGER,
  status TEXT, started_at TEXT, finished_at TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY, kind TEXT, target TEXT, profile TEXT,
  count INTEGER, status TEXT, created_at TEXT, data TEXT NOT NULL DEFAULT '{}'
);

-- ---------- Historique des opérations (audit) ----------
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, detail TEXT, data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_history_ts ON history(ts);
`;

/** Ouvre (et crée au besoin) la base, applique le schéma et les migrations. */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  db.file = file;
  migrate(db);
  return db;
}

export const getMeta = (db, k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
export const setMeta = (db, k, v) => db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

// ---------- Recherche plein texte (FTS5) ----------
// Index de contenu externe : la table `photos` reste la seule source de vérité, `photos_fts`
// ne stocke que l'index. tokenize='unicode61 remove_diacritics 2' gère la casse ET les accents
// (« Été » trouve « ete »), ce que LIKE ne fait pas pour les caractères non ASCII.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
  title, description, notes, keywords_text, camera_make, camera_model, lens, author,
  content='photos', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
`;
// Les déclencheurs maintiennent l'index à jour à chaque écriture de photos.
// Pour la mise à jour/suppression, les valeurs ANCIENNES sont passées explicitement :
// avec un contenu externe, FTS5 ne peut plus les relire une fois la ligne modifiée.
const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS photos_fts_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, title, description, notes, keywords_text, camera_make, camera_model, lens, author)
  VALUES (new.rowid, new.title, new.description, new.notes, new.keywords_text, new.camera_make, new.camera_model, new.lens, new.author);
END;
CREATE TRIGGER IF NOT EXISTS photos_fts_ad AFTER DELETE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, title, description, notes, keywords_text, camera_make, camera_model, lens, author)
  VALUES ('delete', old.rowid, old.title, old.description, old.notes, old.keywords_text, old.camera_make, old.camera_model, old.lens, old.author);
END;
CREATE TRIGGER IF NOT EXISTS photos_fts_au AFTER UPDATE OF
  title, description, notes, keywords_text, camera_make, camera_model, lens, author ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, title, description, notes, keywords_text, camera_make, camera_model, lens, author)
  VALUES ('delete', old.rowid, old.title, old.description, old.notes, old.keywords_text, old.camera_make, old.camera_model, old.lens, old.author);
  INSERT INTO photos_fts(rowid, title, description, notes, keywords_text, camera_make, camera_model, lens, author)
  VALUES (new.rowid, new.title, new.description, new.notes, new.keywords_text, new.camera_make, new.camera_model, new.lens, new.author);
END;
`;

/** L'index plein texte est-il réellement utilisable ? (ne jamais promettre FTS5 sans le tester) */
export function ftsAvailable(db) {
  try { db.exec("SELECT 1 FROM pragma_compile_options WHERE compile_options LIKE '%FTS5%'"); return true; }
  catch { return false; }
}
/** État de l'index plein texte (affiché dans l'administration). */
export function ftsStatus(db) {
  try {
    const rows = db.prepare('SELECT COUNT(*) n FROM photos_fts').get().n;
    return { available: true, indexed: rows };
  } catch (e) { return { available: false, indexed: 0, error: String(e.message || e) }; }
}

/** Migrations : liste ordonnée de fonctions appliquées une seule fois chacune. */
const MIGRATIONS = [
  // v1 : schéma initial (déjà créé par SCHEMA) — sert de gabarit pour les suivants.
  db => { /* rien */ },
  // v2 : index de recherche plein texte FTS5 + déclencheurs + reconstruction de l'existant.
  db => {
    db.exec(FTS_SCHEMA);
    db.exec(FTS_TRIGGERS);
    db.exec(`INSERT INTO photos_fts(photos_fts) VALUES('rebuild')`);
  },
];
function migrate(db) {
  const from = +(getMeta(db, 'schema_version') ?? 0);
  if (!getMeta(db, 'schema_version')) setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  if (!getMeta(db, 'created_at')) setMeta(db, 'created_at', new Date().toISOString());
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (!fn) continue;
    db.exec('BEGIN IMMEDIATE');
    try { fn(db); setMeta(db, 'schema_version', String(v + 1)); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* déjà annulée */ } throw e; }
  }
}

export const tx = (db, fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* déjà annulée */ } throw e; } };

/** Journalise une opération dans l'historique (audit). */
export function logHistory(db, kind, detail, extra = {}) {
  db.prepare('INSERT INTO history(ts, kind, detail, data) VALUES(?, ?, ?, ?)')
    .run(new Date().toISOString(), String(kind), String(detail).slice(0, 1000), JSON.stringify(extra));
}

// ---------- État de la base (administration) ----------
export const TABLES = ['supports', 'folders', 'photos', 'files', 'keywords', 'photo_keywords', 'people', 'subjects', 'places',
  'albums', 'album_photos', 'album_pages', 'collections', 'collection_photos', 'edits', 'imports', 'exports', 'history',
  'config', 'prompt_journal', 'meta'];
export const isTable = t => TABLES.includes(t) || t === 'photos_fts';
const fileSize = db => { let size = 0; for (const f of [db.file, db.file + '-wal', db.file + '-shm']) { try { size += fs.statSync(f).size; } catch { /* absent */ } } return size; };

export function dbStatus(db) {
  return {
    engine: 'SQLite ' + db.prepare('SELECT sqlite_version() v').get().v, driver: 'node:sqlite', file: db.file, size: fileSize(db),
    schema: +(getMeta(db, 'schema_version') ?? 0), created: getMeta(db, 'created_at'), updated: getMeta(db, 'updated_at'), origin: getMeta(db, 'origin'),
    tables: TABLES.map(t => ({ name: t, rows: db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, columns: db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name) })),
  };
}
export const markInitialized = (db, origin) => { setMeta(db, 'initialized', '1'); if (origin) setMeta(db, 'origin', origin); setMeta(db, 'updated_at', new Date().toISOString()); };

/** Lignes d'une table, en lecture seule et par pages (textes longs tronqués à 300 caractères). */
export function tableRows(db, name, limit = 100, offset = 0) {
  if (!isTable(name)) throw new Error('Table inconnue');
  const lim = Math.min(500, Math.max(1, Math.floor(limit) || 100)), off = Math.max(0, Math.floor(offset) || 0);
  const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
  const cut = v => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v);
  const rows = db.prepare(`SELECT * FROM ${name} LIMIT ? OFFSET ?`).all(lim, off).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cut(v)])));
  return { name, columns, rows, offset: off, limit: lim, total: db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n };
}
export const integrity = db => db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
export function vacuum(db) { const before = fileSize(db); db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); return { before, after: fileSize(db) }; }
export function snapshot(db, dest) { fs.rmSync(dest, { force: true }); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); return dest; }

// ---------- Sections d'administration (config / prompt_journal) ----------
// Réglages, licence, menus : stockés en JSON dans config (une ligne par clé), journal des prompts en table.
const J = JSON.stringify, P = s => { try { return JSON.parse(s); } catch { return null; } };
const HANDLED = new Set(['prompts']);
export function saveAdminToDb(db, store) {
  db.exec("DELETE FROM config WHERE key NOT LIKE '@%'");
  for (const [k, v] of Object.entries(store)) if (!HANDLED.has(k) && v !== undefined) {
    db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(k, J(v));
  }
  const pr = store.prompts ?? {};
  const { journal = [], ...rest } = pr;
  db.exec('DELETE FROM prompt_journal');
  const st = db.prepare('INSERT INTO prompt_journal(pos, id, date, source, status, version, text, notes, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
  journal.forEach((e, i) => st.run(i, e.id ?? null, e.date ?? null, e.source ?? null, e.status ?? null, e.version ?? null, e.text ?? null, e.notes ?? null, J(e)));
  if (store.prompts) db.prepare("INSERT INTO config(key, data) VALUES('@prompts', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(J(rest));
  setMeta(db, 'updated_at', new Date().toISOString());
}
export function loadAdminFromDb(db) {
  const st = {};
  for (const r of db.prepare("SELECT key, data FROM config WHERE key NOT LIKE '@%'").all()) st[r.key] = P(r.data);
  const rest = P(db.prepare("SELECT data FROM config WHERE key = '@prompts'").get()?.data);
  const journal = db.prepare('SELECT data FROM prompt_journal ORDER BY pos').all().map(r => P(r.data));
  st.prompts = { ...(rest ?? {}), journal };
  return st;
}
