// Persistance du « store » (réglages, licence, menus, journal des prompts).
// La base SQLite (config / prompt_journal) est la référence ; data/store.json est un miroir lisible
// écrit pour les sauvegardes « données » et pour rester compatible avec le modèle des applications voisines.
import fs from 'fs';
import path from 'path';
import { openDb, saveAdminToDb, loadAdminFromDb } from './db.mjs';
import { defaultLicense } from './license.mjs';
import { backupSettings } from './backup.mjs';
import { DEFAULT_PROMPT_TEMPLATES } from './seed-prompts.mjs';
import { DATA_DIR } from './paths.mjs';
import { METADATA_DEFAULTS, cleanMetadataSettings } from './metadata.mjs';
import { EXTERNAL_DEFAULTS, cleanExternalSettings } from './external.mjs';

export const DB_FILE = path.join(DATA_DIR, 'phototheque.db');
export const STORE_FILE = path.join(DATA_DIR, 'store.json');

export const DEFAULT_SETTINGS = () => ({
  menu: [],
  scan: { hash: true, thumb: true, thumbSize: 320, previewSize: 1600, followSymlinks: false },
  import: { dest: '', onCollision: 'rename', keepFolders: true },
  backup: backupSettings(),
  metadata: METADATA_DEFAULTS(),
  external: EXTERNAL_DEFAULTS(),
});

function normalizeStore(store) {
  const s = { ...DEFAULT_SETTINGS(), ...store };
  s.license = { ...defaultLicense(), ...(store.license ?? {}) };
  s.scan = { ...DEFAULT_SETTINGS().scan, ...(store.scan ?? {}) };
  s.import = { ...DEFAULT_SETTINGS().import, ...(store.import ?? {}) };
  s.backup = backupSettings(store.backup);
  s.metadata = cleanMetadataSettings(store.metadata ?? {});
  s.external = cleanExternalSettings(store.external ?? {});
  s.prompts = { templates: { ...DEFAULT_PROMPT_TEMPLATES, ...(store.prompts?.templates ?? {}) }, journal: store.prompts?.journal ?? [], seq: store.prompts?.seq ?? 1000 };
  return s;
}

export function storeFile() { return STORE_FILE; }
export function dbFile() { return DB_FILE; }

export function loadStore(db) {
  // Miroir JSON (source secondaire) si présent, sinon les valeurs par défaut.
  let mirror = {};
  try { mirror = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { /* pas encore de miroir */ }
  const fromDb = db ? loadAdminFromDb(db) : {};
  return normalizeStore({ ...mirror, ...fromDb });
}

export function saveStore(db, store) {
  const clean = normalizeStore(store);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(clean, null, 2), 'utf8'); // miroir lisible
  if (db) saveAdminToDb(db, clean); // référence
  return clean;
}

export function initStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(DB_FILE);
  const store = loadStore(db);
  saveStore(db, store);
  return { db, store };
}
