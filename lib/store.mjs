// Persistance du « store » (réglages, licence, menus, journal des prompts).
// La base SQLite (config / prompt_journal) est la référence ; data/store.json est un miroir lisible
// écrit pour les sauvegardes « données » et pour rester compatible avec le modèle des applications voisines.
import fs from 'fs';
import path from 'path';
import { openDb, saveAdminToDb, loadAdminFromDb } from './db.mjs';
import { defaultLicense } from './license.mjs';
import { backupSettings, STAGED_DB } from './backup.mjs';
import { DEFAULT_PROMPT_TEMPLATES } from './seed-prompts.mjs';
import { DATA_DIR } from './paths.mjs';
import { METADATA_DEFAULTS, cleanMetadataSettings } from './metadata.mjs';
import { EXTERNAL_DEFAULTS, cleanExternalSettings } from './external.mjs';

/** Verrouillage : seuls un sel et une empreinte scrypt du mot de passe sont conservés. */
export function cleanLock(l = {}) {
  const ok = l && /^[0-9a-f]{32}$/.test(l.salt ?? '') && /^[0-9a-f]{64}$/.test(l.hash ?? '');
  const idle = Number.isFinite(+l?.idleMinutes) ? Math.round(Math.min(480, Math.max(1, +l.idleMinutes))) : 30;
  return { enabled: !!l?.enabled && ok, salt: ok ? l.salt : null, hash: ok ? l.hash : null, idleMinutes: idle };
}

export const DB_FILE = path.join(DATA_DIR, 'phototheque.db');
export const STORE_FILE = path.join(DATA_DIR, 'store.json');

export const DEFAULT_SETTINGS = () => ({
  menu: [],
  scan: { hash: true, thumb: true, thumbSize: 320, previewSize: 1600, followSymlinks: false },
  import: { dest: '', onCollision: 'rename', keepFolders: true },
  backup: backupSettings(),
  security: { lock: { enabled: false, salt: null, hash: null, idleMinutes: 30 } },
  metadata: METADATA_DEFAULTS(),
  external: EXTERNAL_DEFAULTS(),
});

function normalizeStore(store) {
  const s = { ...DEFAULT_SETTINGS(), ...store };
  for (const k of Object.keys(s)) if (k.includes('.')) delete s[k]; // clés des modules : table config seulement (lib/db.mjs)
  s.license = { ...defaultLicense(), ...(store.license ?? {}) };
  s.scan = { ...DEFAULT_SETTINGS().scan, ...(store.scan ?? {}) };
  s.import = { ...DEFAULT_SETTINGS().import, ...(store.import ?? {}) };
  s.backup = backupSettings(store.backup);
  s.security = { lock: cleanLock(store.security?.lock) };
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

/**
 * Restauration complète en attente (lib/backup.mjs) : la base restaurée remplace la base AVANT son
 * ouverture ; les fichiers -wal / -shm de l'ancienne base sont écartés (sinon SQLite les rejouerait).
 */
export function applyStagedRestore() {
  if (!fs.existsSync(STAGED_DB)) return false;
  for (const x of ['-wal', '-shm']) fs.rmSync(DB_FILE + x, { force: true });
  fs.renameSync(STAGED_DB, DB_FILE);
  return true;
}

export function initStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const restored = applyStagedRestore();
  const db = openDb(DB_FILE);
  if (restored) console.log('Catalogue restauré depuis une sauvegarde (appliqué au démarrage).');
  const store = loadStore(db);
  saveStore(db, store);
  return { db, store };
}
