// Service de sauvegarde : création, liste, vérification, aperçu du contenu, test de restauration,
// restauration (complète ou sélective via lib/restore.mjs), copies vers plusieurs destinations,
// chiffrement facultatif, journal des opérations et alertes, purge, planification (lib/extra.mjs).
// Les sauvegardes « données » emportent la base SQLite du catalogue (phototheque.db), le store.json
// et le dossier Documents. Les vignettes (data/thumbs) sont un cache régénérable et ne sont pas incluses.
// Les ORIGINAUX ne sont pas dans ces archives : leur protection passe par des copies sur des supports
// de rôle « Sauvegarde » ou « Archive » (rapport « Originaux non couverts »).
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { createZip, readZip } from './zip.mjs';
import { BACKUP_DIR, DATA_DIR, DOCS_DIR, REPORTS_DIR } from './paths.mjs';
import { APP } from './appinfo.mjs';

export const BACKUP_TYPES = {
  data: { label: 'Données', desc: "Catalogue (base phototheque.db), réglages (store.json) et dossier Documents" },
  program: { label: 'Programme', desc: "Code de l'application (sans les données personnelles)" },
  full: { label: 'Complète', desc: 'Données + programme + rapports' },
};
/** Types de destination (pour la règle 3-2-1 : deux types de supports, une copie ailleurs). */
export const DEST_KINDS = { local: 'Autre disque interne', external: 'Disque externe', nas: 'NAS / partage réseau', offsite: 'Support conservé dans un autre lieu', other: 'Autre emplacement' };
/** Sous-dossier créé dans chaque destination. */
export const DEST_SUBDIR = 'Phototheque - sauvegardes';
const PROGRAM_FILES = ['server.mjs', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'app.config.json', '.env.example', '.gitignore'];
const PROGRAM_DIRS = ['lib', 'public', 'scripts', 'docs'];
const DB_FILE = path.join(DATA_DIR, 'phototheque.db');
const STORE = path.join(DATA_DIR, 'store.json');
/** Base restaurée en attente : appliquée au prochain démarrage, avant l'ouverture de la base (lib/store.mjs). */
export const STAGED_DB = DB_FILE + '.restauration';

export function listProgramFiles(root) {
  const walk = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  return [...PROGRAM_FILES.map(f => path.join(root, f)).filter(fs.existsSync), ...PROGRAM_DIRS.flatMap(d => walk(path.join(root, d)))];
}
export const PROGRAM_PATHS = { files: PROGRAM_FILES, dirs: PROGRAM_DIRS };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? +v : d);
const text = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function cleanDestination(d) {
  if (!d || typeof d !== 'object') return null;
  const p = String(d.path ?? '').trim();
  if (!p || !path.isAbsolute(p) || p.length > 400) return null;
  const last = d.last && typeof d.last === 'object' ? { at: String(d.last.at ?? ''), ok: !!d.last.ok, name: text(d.last.name, 200), message: text(d.last.message, 300) } : null;
  return { id: /^[\w-]{1,40}$/.test(String(d.id ?? '')) ? d.id : crypto.randomUUID(), name: text(d.name, 80) || path.basename(p) || p, path: p,
    kind: DEST_KINDS[d.kind] ? d.kind : 'other', enabled: d.enabled !== false, last };
}
/** Réglages de sauvegarde nettoyés (le mot de passe de chiffrement n'y figure jamais : seulement un vérificateur scrypt). */
export const backupSettings = (s = {}) => ({
  auto: !!s.auto, every: s.every === 'weekly' ? 'weekly' : 'daily', weekday: clamp(Math.round(num(s.weekday, 1)), 0, 6),
  time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time ?? '') ? s.time : '20:00', type: BACKUP_TYPES[s.type] ? s.type : 'data',
  keep: clamp(Math.round(num(s.keep, 10)), 1, 200), since: typeof s.since === 'string' ? s.since : null,
  encrypt: !!s.encrypt && !!s.verifier?.hash, verifier: s.verifier && /^[0-9a-f]{32}$/.test(s.verifier.salt ?? '') && /^[0-9a-f]{64}$/.test(s.verifier.hash ?? '') ? { salt: s.verifier.salt, hash: s.verifier.hash } : null,
  verifyEvery: clamp(Math.round(num(s.verifyEvery, 7)), 0, 90), maxAgeDays: clamp(Math.round(num(s.maxAgeDays, 7)), 1, 365),
  destinations: (Array.isArray(s.destinations) ? s.destinations : []).map(cleanDestination).filter(Boolean).slice(0, 10),
  events: (Array.isArray(s.events) ? s.events : []).filter(e => e && typeof e === 'object').slice(0, 100)
    .map(e => ({ at: String(e.at ?? ''), kind: text(e.kind, 20), ok: !!e.ok, message: text(e.message, 400), ack: !!e.ack })),
  tests: Object.fromEntries(Object.entries(s.tests && typeof s.tests === 'object' ? s.tests : {}).slice(-200)
    .map(([k, v]) => [k, { at: String(v?.at ?? ''), ok: !!v?.ok, message: text(v?.message, 400) }])),
});

// ---------- Chiffrement (AES-256-GCM, clé dérivée par scrypt) ----------
// Fichier .enc : « PHTQENC1 » | longueur (4 o) | en-tête JSON en clair (manifeste public) | sel (16) | iv (12)
// | étiquette GCM (16) | archive ZIP chiffrée. L'en-tête est authentifié (AAD) : le modifier rend le fichier illisible.
const MAGIC = Buffer.from('PHTQENC1');
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const deriveKey = (password, salt) => crypto.scryptSync(String(password), salt, 32, SCRYPT);
export function encryptArchive(zip, password, header) {
  if (!password) throw new Error('Mot de passe de chiffrement requis');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), head = Buffer.from(JSON.stringify(header));
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv); c.setAAD(head);
  const ct = Buffer.concat([c.update(zip), c.final()]);
  const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  return Buffer.concat([MAGIC, len, head, salt, iv, c.getAuthTag(), ct]);
}
export const isEncrypted = buf => buf.length > 12 && buf.subarray(0, 8).equals(MAGIC);
export function encryptedHeader(buf) {
  if (!isEncrypted(buf)) throw new Error('Archive chiffrée invalide');
  const n = buf.readUInt32LE(8); if (n > 1e6 || 12 + n + 44 > buf.length) throw new Error('Archive chiffrée tronquée');
  return { header: JSON.parse(buf.toString('utf8', 12, 12 + n)), start: 12 + n };
}
export function decryptArchive(buf, password) {
  const { start } = encryptedHeader(buf), head = buf.subarray(12, start);
  if (!password) throw new Error('Cette sauvegarde est chiffrée : mot de passe requis');
  const salt = buf.subarray(start, start + 16), iv = buf.subarray(start + 16, start + 28), tag = buf.subarray(start + 28, start + 44);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv); d.setAAD(head); d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.subarray(start + 44)), d.final()]);
  } catch { throw new Error('Mot de passe incorrect, ou archive altérée'); }
}
/** Vérificateur du mot de passe (scrypt, sel propre) : permet de contrôler une saisie sans garder le mot de passe. */
export function makeVerifier(password) { const salt = crypto.randomBytes(16); return { salt: salt.toString('hex'), hash: crypto.scryptSync(String(password), salt, 32, SCRYPT).toString('hex') }; }
export function checkVerifier(v, password) {
  if (!v?.salt || !v?.hash || !password) return false;
  const h = crypto.scryptSync(String(password), Buffer.from(v.salt, 'hex'), 32, SCRYPT);
  return crypto.timingSafeEqual(h, Buffer.from(v.hash, 'hex'));
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * `getDb()` : base ouverte (vidage du WAL avant copie). `getSettings()` / `saveSettings()` : réglages
 * `store.backup` (destinations, chiffrement, journal) ; sans eux, le service ne fait que lire.
 */
export function createBackupService({ root, getStats, onRestored, db = null, getDb = null, getSettings = null, saveSettings = null }) {
  const DIR = BACKUP_DIR;
  const RELEVES = DOCS_DIR;
  const RAPPORTS = REPORTS_DIR;
  fs.mkdirSync(DIR, { recursive: true });
  const dbOf = () => (getDb ? getDb() : db);
  const settings = () => (getSettings ? getSettings() : backupSettings());
  const persist = () => { try { saveSettings?.(); } catch { /* lecture seule */ } };
  const version = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return '0.1.0'; } };
  // mot de passe de chiffrement : en mémoire seulement, le temps de la session du serveur
  let sessionPassword = null;

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

  // La base doit être copiée de façon cohérente (WAL) : on vide d'abord le WAL dans le fichier principal.
  function checkpoint() { try { dbOf()?.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* pas de base ouverte */ } }

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

  // ---------- journal et alertes ----------
  function logEvent(kind, ok, message) {
    const s = getSettings?.(); if (!s) return;
    s.events = [{ at: new Date().toISOString(), kind, ok: !!ok, message: text(message, 400), ack: !!ok }, ...(s.events ?? [])].slice(0, 100);
    persist();
  }
  function ackAlerts() { const s = getSettings?.(); if (!s) return 0; let n = 0; for (const e of s.events ?? []) if (!e.ack) { e.ack = true; n++; } persist(); return n; }

  // ---------- mot de passe de chiffrement ----------
  /** Définit (ou change) le mot de passe et active le chiffrement ; `enabled: false` le désactive. */
  function setEncryption({ enabled = true, password = '', current = '' } = {}) {
    const s = settings();
    if (!enabled) {
      if (s.verifier && !checkVerifier(s.verifier, current) && current !== sessionPassword) throw new Error('Mot de passe actuel incorrect');
      s.encrypt = false; persist(); logEvent('chiffrement', true, 'Chiffrement des nouvelles sauvegardes désactivé'); return { encrypt: false };
    }
    if (String(password).length < 8) throw new Error('Mot de passe trop court (8 caractères au moins)');
    if (s.verifier && s.encrypt && !checkVerifier(s.verifier, current)) throw new Error('Mot de passe actuel incorrect');
    s.verifier = makeVerifier(password); s.encrypt = true; sessionPassword = String(password); persist();
    logEvent('chiffrement', true, 'Chiffrement des sauvegardes activé (nouveau mot de passe)');
    return { encrypt: true };
  }
  /** Saisie du mot de passe pour la session (sauvegardes programmées, ouverture des archives chiffrées). */
  function unlockEncryption(password) {
    const s = settings();
    if (!s.verifier || !checkVerifier(s.verifier, password)) throw new Error('Mot de passe incorrect');
    sessionPassword = String(password); return { unlocked: true };
  }
  const passwordFor = given => (given ? String(given) : sessionPassword);

  // ---------- création ----------
  /**
   * Crée une archive. Chiffrée si le chiffrement est activé (mot de passe donné, sinon celui de la session ;
   * à défaut erreur), sauf `allowPlain` (sauvegarde de sécurité locale avant une restauration).
   */
  function create(type, { label = '', auto = false, password = null, allowPlain = false, copy = true } = {}) {
    if (!BACKUP_TYPES[type]) throw new Error('Type de sauvegarde inconnu');
    const s = settings();
    let pw = null;
    if (s.encrypt) {
      pw = passwordFor(password);
      if (pw && !checkVerifier(s.verifier, pw)) throw new Error('Mot de passe de chiffrement incorrect');
      if (!pw && !allowPlain) throw new Error('Mot de passe de chiffrement requis (Administration → Sauvegardes)');
    }
    checkpoint();
    const files = sources(type);
    const entries = files.map(f => ({ name: rel(f), data: fs.readFileSync(f), mtime: fs.statSync(f).mtime }));
    const st = getStats ? getStats() : {};
    const manifest = {
      app: APP.name, version: version(), type, label: String(label).slice(0, 80), auto, createdAt: new Date().toISOString(),
      files: entries.length, rawSize: entries.reduce((n, e) => n + e.data.length, 0), encrypted: !!pw,
      counts: type === 'program' ? {} : { photos: st.photos ?? 0, supports: st.supports ?? 0, keywords: st.keywords ?? 0, albums: st.albums ?? 0, documents: files.filter(f => f.startsWith(RELEVES)).length },
      // empreintes des fichiers archivés (contrôle de chaque élément à la restauration)
      sha256: Object.fromEntries(entries.map(e => [e.name, crypto.createHash('sha256').update(e.data).digest('hex')])),
    };
    entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let name = `${APP.slug}_${type}_${stamp}${auto ? '_auto' : ''}${pw ? '.enc' : '.zip'}`;
    for (let k = 2; fs.existsSync(path.join(DIR, name)); k++) name = name.replace(/(_\d+)?\.(zip|enc)$/, `_${k}.$2`);
    const zip = createZip(entries);
    const { sha256: _, ...pub } = manifest; // en-tête en clair : sans les empreintes
    fs.writeFileSync(path.join(DIR, name), pw ? encryptArchive(zip, pw, pub) : zip);
    const out = { name, manifest, size: fs.statSync(path.join(DIR, name)).size };
    logEvent('création', true, `${auto ? 'Sauvegarde programmée' : 'Sauvegarde'} ${BACKUP_TYPES[type].label.toLowerCase()} créée : ${name}${pw ? ' (chiffrée)' : ''}`);
    if (copy && !allowPlain) out.copies = copyToDestinations(name);
    return out;
  }

  const safeName = n => {
    n = path.basename(String(n || ''));
    if (!/^[\w.\- ()]+\.(zip|enc)$/i.test(n)) throw new Error('Nom de sauvegarde invalide');
    return n;
  };
  /** Manifeste : celui de l'archive ZIP, ou l'en-tête en clair d'une archive chiffrée. */
  function readManifestBuf(buf) {
    if (isEncrypted(buf)) { const { header } = encryptedHeader(buf); if (header.app !== APP.name) throw new Error('Ce n’est pas une sauvegarde ' + APP.name); return { ...header, encrypted: true }; }
    const m = readZip(buf).find(e => e.name === 'manifest.json');
    if (!m) throw new Error('manifest absent');
    const mf = JSON.parse(m.read().toString('utf8'));
    if (mf.app !== APP.name) throw new Error('Ce n’est pas une sauvegarde ' + APP.name);
    return mf;
  }
  const readManifest = file => readManifestBuf(fs.readFileSync(file));
  /** Entrées ZIP d'une archive (déchiffrée au besoin). */
  function zipOf(name, password) {
    const buf = fs.readFileSync(path.join(DIR, safeName(name)));
    return readZip(isEncrypted(buf) ? decryptArchive(buf, passwordFor(password)) : buf);
  }

  const mcache = new Map();
  function list() {
    const tests = settings().tests ?? {};
    return fs.readdirSync(DIR).filter(f => /\.(zip|enc)$/i.test(f)).map(name => {
      const f = path.join(DIR, name), st = fs.statSync(f);
      try {
        // manifeste mis en cache (nom, taille, date) : la liste ne relit pas chaque archive à chaque appel
        const c = mcache.get(name), manifest = c && c.size === st.size && c.mtime === st.mtimeMs ? c.manifest : readManifest(f);
        mcache.set(name, { size: st.size, mtime: st.mtimeMs, manifest });
        return { name, size: st.size, mtime: st.mtime.toISOString(), manifest, test: tests[name] ?? null };
      }
      catch (e) { return { name, size: st.size, mtime: st.mtime.toISOString(), error: String(e.message || e), test: tests[name] ?? null }; }
    }).sort((a, b) => (b.manifest?.createdAt ?? b.mtime).localeCompare(a.manifest?.createdAt ?? a.mtime));
  }

  /** Contrôle des CRC de chaque élément (et de l'authentification pour une archive chiffrée). */
  function verify(name, password = null) {
    const buf = fs.readFileSync(path.join(DIR, safeName(name)));
    if (isEncrypted(buf) && !passwordFor(password)) {
      encryptedHeader(buf);
      return { ok: null, encrypted: true, entries: 0, bad: [], message: 'Archive chiffrée : saisissez le mot de passe pour la vérifier entièrement' };
    }
    let entries;
    try { entries = readZip(isEncrypted(buf) ? decryptArchive(buf, passwordFor(password)) : buf); }
    catch (e) { return { ok: false, entries: 0, bad: [], message: e.message, encrypted: isEncrypted(buf) }; }
    const bad = [];
    for (const e of entries) {
      try { if (zlib.crc32(e.read()) !== e.crc) bad.push(e.name); } catch { bad.push(e.name); }
    }
    return { ok: bad.length === 0, entries: entries.length, bad, encrypted: isEncrypted(buf) };
  }

  /** Extrait la base d'une archive dans un dossier temporaire privé ; `use(chemin)` ; nettoyage garanti. */
  async function withArchiveDb(name, password, use) {
    const entries = zipOf(name, password);
    const e = entries.find(x => x.name === 'data/phototheque.db');
    if (!e) throw new Error('Cette sauvegarde ne contient pas de catalogue');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phototheque-restau-'));
    const file = path.join(tmp, 'catalogue.db');
    try { fs.writeFileSync(file, e.read(), { mode: 0o600 }); return await use(file, entries); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const openRead = async file => { const { DatabaseSync } = await import('node:sqlite'); return new DatabaseSync(file, { readOnly: true }); };
  const count = (d, t) => { try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; } };

  /** Aperçu du contenu : fichiers, compteurs, albums, collections — comparés au catalogue actuel. */
  async function contents(name, password = null) {
    const mf = readManifest(path.join(DIR, safeName(name)));
    const entries = zipOf(name, password);
    const files = entries.filter(e => e.name !== 'manifest.json').map(e => ({ name: e.name, size: e.size }));
    let catalogue = null;
    if (entries.some(e => e.name === 'data/phototheque.db')) {
      catalogue = await withArchiveDb(name, password, async file => {
        const d = await openRead(file);
        try {
          const all = (sql) => { try { return d.prepare(sql).all(); } catch { return []; } };
          return {
            counts: { photos: count(d, 'photos'), files: count(d, 'files'), supports: count(d, 'supports'), keywords: count(d, 'keywords'), albums: count(d, 'albums'), collections: count(d, 'collections') },
            albums: all('SELECT a.id, a.name, a.updated_at, (SELECT COUNT(*) FROM album_pages WHERE album_id = a.id) pages FROM albums a ORDER BY a.name'),
            collections: all('SELECT c.id, c.name, c.kind, (SELECT COUNT(*) FROM collection_photos WHERE collection_id = c.id) photos FROM collections c ORDER BY c.name'),
          };
        } finally { d.close(); }
      });
    }
    return { name, manifest: mf, files, documents: files.filter(f => f.name.startsWith('Documents/')).map(f => f.name.slice(10)), catalogue };
  }

  /**
   * Test de restauration, sans rien remplacer : déchiffrement, CRC, empreintes SHA-256 du manifeste,
   * base extraite dans un dossier temporaire puis ouverte (intégrité SQLite, tables essentielles), store.json lisible.
   */
  async function testRestore(name, password = null) {
    const n = safeName(name), steps = [];
    const done = (ok, message) => {
      const s = getSettings?.(); if (s) { s.tests = { ...(s.tests ?? {}), [n]: { at: new Date().toISOString(), ok, message } }; persist(); }
      logEvent('test', ok, `Test de restauration de ${n} : ${message}`);
      return { name: n, ok, message, steps };
    };
    try {
      const v = verify(n, password);
      if (v.ok === null) throw new Error(v.message);
      if (!v.ok) throw new Error(v.message || 'éléments altérés : ' + v.bad.slice(0, 3).join(', '));
      steps.push(`${v.entries} élément(s), contrôle CRC correct${v.encrypted ? ', déchiffrement authentifié' : ''}`);
      const entries = zipOf(n, password);
      const mf = JSON.parse(entries.find(e => e.name === 'manifest.json').read().toString('utf8'));
      if (mf.sha256) {
        const badSha = entries.filter(e => mf.sha256[e.name] && crypto.createHash('sha256').update(e.read()).digest('hex') !== mf.sha256[e.name]).map(e => e.name);
        if (badSha.length) throw new Error('empreinte SHA-256 différente : ' + badSha.slice(0, 3).join(', '));
        steps.push(`${Object.keys(mf.sha256).length} empreinte(s) SHA-256 conformes`);
      }
      const store = entries.find(e => e.name === 'data/store.json');
      if (store) { JSON.parse(store.read().toString('utf8')); steps.push('réglages (store.json) lisibles'); }
      if (entries.some(e => e.name === 'data/phototheque.db')) {
        await withArchiveDb(n, password, async file => {
          const d = await openRead(file);
          try {
            const ic = d.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
            if (ic.length !== 1 || ic[0] !== 'ok') throw new Error('base : ' + ic.slice(0, 2).join(' ; '));
            const missing = ['photos', 'files', 'supports', 'keywords', 'albums'].filter(t => count(d, t) === null);
            if (missing.length) throw new Error('tables absentes : ' + missing.join(', '));
            steps.push(`catalogue ouvert : intégrité SQLite correcte, ${count(d, 'photos')} photo(s), ${count(d, 'albums')} album(s)`);
          } finally { d.close(); }
        });
      } else if (mf.type !== 'program') throw new Error('catalogue absent de l’archive');
      return done(true, 'réussi — ' + steps.join(' ; '));
    } catch (e) { return done(false, 'ÉCHEC — ' + e.message); }
  }

  /**
   * Restauration complète : sauvegarde de sécurité, puis la base est déposée à côté (STAGED_DB) et
   * remplacée au prochain démarrage (on ne réécrit jamais une base ouverte) ; store.json et Documents
   * sont remplacés tout de suite. Le serveur doit redémarrer (`restartRequired`).
   */
  function restore(name, password = null) {
    const file = path.join(DIR, safeName(name));
    const mf = readManifest(file);
    if (mf.type === 'program') throw new Error('Une sauvegarde « Programme » ne se restaure pas depuis l’application : téléchargez-la et décompressez-la dans le dossier du projet.');
    const v = verify(name, password);
    if (v.ok === null) throw new Error('Cette sauvegarde est chiffrée : mot de passe requis');
    if (!v.ok) throw new Error('Archive inutilisable : ' + (v.message || v.bad.slice(0, 3).join(', ')));
    const safety = create('data', { label: 'Avant restauration de ' + name, auto: false, allowPlain: true, copy: false });
    let restored = 0, staged = false;
    for (const e of zipOf(name, password)) {
      if (e.name === 'data/phototheque.db') { fs.writeFileSync(STAGED_DB, e.read()); staged = true; restored++; continue; }
      if (e.name === 'data/store.json') { fs.writeFileSync(STORE, e.read()); restored++; continue; }
      if (e.name.startsWith('Documents/')) {
        const dest = path.join(RELEVES, e.name.slice(10));
        if (!path.resolve(dest).startsWith(path.resolve(RELEVES) + path.sep)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.read()); restored++;
      }
    }
    logEvent('restauration', true, `Restauration complète de ${name} préparée (sauvegarde de sécurité ${safety.name})${staged ? ' : catalogue remplacé au redémarrage' : ''}`);
    onRestored?.();
    return { restored, safety: safety.name, restartRequired: staged };
  }
  /** Restaure quelques fichiers du dossier Documents (sauvegarde de sécurité d'abord). */
  function restoreDocuments(name, names, password = null, { safety: withSafety = true } = {}) {
    const want = new Set([].concat(names ?? []).map(String));
    if (!want.size) return { restored: 0 };
    const entries = zipOf(name, password).filter(e => e.name.startsWith('Documents/') && want.has(e.name.slice(10)));
    if (!entries.length) return { restored: 0 };
    const safety = withSafety ? create('data', { label: 'Avant restauration de documents', allowPlain: true, copy: false }) : null;
    let restored = 0;
    for (const e of entries) {
      const dest = path.join(RELEVES, e.name.slice(10));
      if (!path.resolve(dest).startsWith(path.resolve(RELEVES) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.read()); restored++;
    }
    return { restored, safety: safety?.name ?? null };
  }

  // ---------- destinations ----------
  const destDir = d => path.join(d.path, DEST_SUBDIR);
  /** Copie une archive vers les destinations actives ; contrôle par SHA-256 ; purge au-delà de `keep`. */
  function copyToDestinations(name, only = null) {
    const s = settings(), src = path.join(DIR, safeName(name)), out = [];
    const dests = (s.destinations ?? []).filter(d => d.enabled && (!only || d.id === only));
    if (!dests.length) return out;
    const ref = sha256(src);
    for (const d of dests) {
      const r = { id: d.id, name: d.name, ok: false, message: '' };
      try {
        if (path.resolve(d.path).startsWith(path.resolve(DIR))) throw new Error('la destination ne peut pas être le dossier Sauvegardes lui-même');
        if (!fs.existsSync(d.path)) throw new Error('emplacement inaccessible (support débranché ou réseau absent ?)');
        const dir = destDir(d); fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, name + '.copie'), dest = path.join(dir, name);
        fs.copyFileSync(src, tmp);
        if (sha256(tmp) !== ref) { fs.rmSync(tmp, { force: true }); throw new Error('copie différente de l’original (SHA-256)'); }
        fs.renameSync(tmp, dest);
        // rétention : seulement les sauvegardes programmées de cette application, les plus anciennes
        const autos = fs.readdirSync(dir).filter(f => /_auto(_\d+)?\.(zip|enc)$/i.test(f) && f.startsWith(APP.slug + '_')).sort().reverse();
        for (const f of autos.slice(s.keep)) fs.rmSync(path.join(dir, f), { force: true });
        r.ok = true; r.message = 'copie vérifiée (SHA-256)'; r.file = dest;
      } catch (e) { r.message = e.message; }
      d.last = { at: new Date().toISOString(), ok: r.ok, name, message: r.message };
      logEvent('copie', r.ok, `Copie de ${name} vers « ${d.name} » : ${r.message}`);
      out.push(r);
    }
    persist();
    return out;
  }
  /** État des destinations : accessibilité, archives présentes, dernière copie. */
  function destinations() {
    return (settings().destinations ?? []).map(d => {
      const reachable = fs.existsSync(d.path); let archives = 0;
      try { archives = reachable && fs.existsSync(destDir(d)) ? fs.readdirSync(destDir(d)).filter(f => /\.(zip|enc)$/i.test(f)).length : 0; } catch { /* illisible */ }
      return { ...d, reachable, archives, folder: destDir(d) };
    });
  }
  function saveDestination(d) {
    const s = settings(), c = cleanDestination({ ...d, enabled: d?.enabled !== false });
    if (!c) throw new Error('Chemin absolu attendu (ex. E:\\ ou \\\\NAS\\photos)');
    if (path.resolve(c.path).startsWith(path.resolve(DIR))) throw new Error('Choisissez un autre emplacement que le dossier Sauvegardes de l’application');
    const i = (s.destinations ?? []).findIndex(x => x.id === d?.id);
    if (i >= 0) s.destinations[i] = { ...c, last: s.destinations[i].last }; else { if ((s.destinations ?? []).length >= 10) throw new Error('10 destinations au plus'); s.destinations = [...(s.destinations ?? []), c]; }
    persist(); return destinations();
  }
  function removeDestination(id) { const s = settings(); s.destinations = (s.destinations ?? []).filter(d => d.id !== id); persist(); return destinations(); }

  /** Alertes : échecs non acquittés, sauvegarde ancienne, destination en défaut, test absent ou ancien, mot de passe attendu. */
  function alerts() {
    const s = settings(), out = [], now = Date.now(), day = 864e5;
    for (const e of (s.events ?? []).filter(x => !x.ok && !x.ack).slice(0, 10)) out.push({ level: 'bad', message: `${new Date(e.at).toLocaleString('fr-FR')} — ${e.message}` });
    const data = list().filter(b => b.manifest && b.manifest.type !== 'program');
    const last = data[0];
    if (!last) out.push({ level: 'bad', message: 'Aucune sauvegarde du catalogue.' });
    else {
      const age = Math.floor((now - Date.parse(last.manifest.createdAt)) / day);
      if (age > s.maxAgeDays) out.push({ level: 'warn', message: `Dernière sauvegarde du catalogue il y a ${age} jours (seuil : ${s.maxAgeDays}).` });
      const t = last.test;
      if (!t) out.push({ level: 'info', message: `La dernière sauvegarde (${last.name}) n’a jamais été testée : lancez un test de restauration.` });
      else if (!t.ok) out.push({ level: 'bad', message: `Le test de restauration de ${last.name} a échoué.` });
    }
    for (const d of s.destinations ?? []) {
      if (!d.enabled) continue;
      if (!d.last) out.push({ level: 'info', message: `Destination « ${d.name} » : aucune copie encore.` });
      else if (!d.last.ok) out.push({ level: 'warn', message: `Destination « ${d.name} » : dernière copie en échec (${d.last.message}).` });
      else if ((now - Date.parse(d.last.at)) / day > s.maxAgeDays * 2) out.push({ level: 'warn', message: `Destination « ${d.name} » : dernière copie il y a ${Math.floor((now - Date.parse(d.last.at)) / day)} jours.` });
    }
    if (s.encrypt && s.auto && !sessionPassword) out.push({ level: 'warn', message: 'Chiffrement activé : les sauvegardes programmées attendent le mot de passe (à saisir une fois par démarrage).' });
    return out;
  }

  /** Règle 3-2-1 appliquée au catalogue : copies, types de supports, copie ailleurs. */
  function rule321() {
    const s = settings(), ok = (s.destinations ?? []).filter(d => d.enabled && d.last?.ok);
    const hasLocal = list().some(b => b.manifest && b.manifest.type !== 'program');
    const copies = 1 + (hasLocal ? 1 : 0) + ok.length;
    const kinds = new Set(['app', ...ok.map(d => d.kind)]);
    return { copies, three: copies >= 3, two: kinds.size >= 2 && ok.some(d => d.kind !== 'local'), one: ok.some(d => d.kind === 'offsite') };
  }

  function remove(name) { fs.unlinkSync(path.join(DIR, safeName(name))); const s = getSettings?.(); if (s?.tests?.[name]) { delete s.tests[name]; persist(); } }
  function importZip(name, buf) {
    name = safeName(name);
    const tmp = path.join(DIR, '.import.tmp');
    fs.writeFileSync(tmp, buf);
    try {
      const mf = readManifest(tmp);
      if (mf.encrypted) name = name.replace(/\.zip$/i, '.enc');
      let final = name, i = 2;
      while (fs.existsSync(path.join(DIR, final))) final = name.replace(/\.(zip|enc)$/i, `_${i++}.$1`);
      fs.renameSync(tmp, path.join(DIR, final)); return final;
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  function prune(keep, onlyAuto = true) {
    const items = list().filter(b => b.manifest && (!onlyAuto || b.manifest.auto));
    const del = items.slice(Math.max(1, keep));
    del.forEach(b => remove(b.name)); return del.length;
  }

  const filePath = name => path.join(DIR, safeName(name));
  return {
    create, list, verify, restore, restoreDocuments, remove, importZip, prune, volumes, filePath, DIR, types: BACKUP_TYPES,
    contents, testRestore, withArchiveDb, copyToDestinations, destinations, saveDestination, removeDestination, alerts, ackAlerts, rule321, logEvent,
    setEncryption, unlockEncryption, encryptionUnlocked: () => !!sessionPassword, lockEncryption: () => { sessionPassword = null; },
  };
}
