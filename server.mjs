// Serveur local : API JSON + fichiers statiques (node:sqlite, sharp, exifr).
// L'indexation, la recherche et la gestion des supports sont faites ici (lib/library.mjs,
// lib/supports.mjs, lib/keywords.mjs, lib/imports.mjs) ; l'interface (public/) ne fait qu'afficher
// et appeler l'API. Aucune opération n'écrit jamais dans un fichier original.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ROOT, DATA_DIR, THUMBS_DIR, EXPORT_DIR, PORT, INSTALLED } from './lib/paths.mjs';
import { setupExtra } from './lib/extra.mjs';
import { setupAdmin, licenseBrief } from './lib/admin.mjs';
import { setupDbAdmin } from './lib/dbadmin.mjs';
import { APP } from './lib/appinfo.mjs';
import { initStore, saveStore, STORE_FILE, DB_FILE } from './lib/store.mjs';
import { dbStatus, logHistory } from './lib/db.mjs';
import { createSupports, SUPPORT_KINDS, SUPPORT_ROLES } from './lib/supports.mjs';
import { createKeywords } from './lib/keywords.mjs';
import { createLibrary } from './lib/library.mjs';
import { createImports } from './lib/imports.mjs';
import { createCollections, COLLECTION_KINDS } from './lib/collections.mjs';
import { createAlbums, FORMATS, LAYOUTS, ALBUM_FORMAT_VERSION, DPI_WARN, ALIGNS, BORDER_MAX } from './lib/albums.mjs';
import { createAlbumPdf, PDF_PROFILES, BLEED_MM, SERVICE_OUTPUTS, SERVICE_LAYOUTS } from './lib/albumpdf.mjs';
import { createEdits, EDIT_FIELDS, PRESETS, DEFAULT_PARAMS, EDIT_PARAMS_VERSION, CURVES, TONE_KEYS } from './lib/edits.mjs';
import { createExports, EXPORT_FORMATS, METADATA_MODES, WATERMARK_POSITIONS, COLOR_PROFILES, PROFILES_DIR, iccFiles, PRINT_FITS, PRINT_DPI_LOW } from './lib/exports.mjs';
import { createExternal, cleanExternalSettings, checkEditor, EXTERNAL_DIR, EXTERNAL_SOURCES } from './lib/external.mjs';
import { createDuplicates, LEVELS as DUP_LEVELS, DEFAULT_THRESHOLD, DEFAULT_BURST_SECONDS, MAX_THRESHOLD } from './lib/duplicates.mjs';
import { createContactSheets, SHEET_PAGES, SHEET_FIELDS, SHEET_QUALITIES, SHEET_DEFAULTS, SHEET_LAYOUTS, SHEET_BACKGROUNDS, MAX_SHEET_PHOTOS } from './lib/contactsheet.mjs';
import { createCatalog, CSV_COLUMNS, GROUP_BY } from './lib/catalog.mjs';
import { createReports, REPORTS } from './lib/reports.mjs';
import { createSelectiveRestore } from './lib/restore.mjs';
import { createLock } from './lib/lock.mjs';
import { BACKED_UP } from './lib/search.mjs';
import { createDashboard } from './lib/dashboard.mjs';
import { renderTableDoc } from './lib/reportdoc.mjs';
import { createMetadata, cleanMetadataSettings, DESTINATIONS, NAMINGS, MODES as META_MODES, MAX_BATCH as META_MAX } from './lib/metadata.mjs';
import { DOC_FIELDS, LABELS_FR } from './lib/xmp.mjs';
import { XMP_DIR } from './lib/paths.mjs';
import { createAi, aiRoutes } from './lib/ai.mjs';
import { installInfo, verifyDist, keyId, PUBLIC_KEY_FILE, SUMS_FILE, SIG_FILE } from './lib/dist.mjs';

const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

const { db, store } = initStore();
const supports = createSupports(db);
const keywords = createKeywords(db);
const library = createLibrary(db, store, supports, keywords);
const imports = createImports(db, store, library, keywords, supports);
const collections = createCollections(db, library);
const edits = createEdits(db, library);
const albums = createAlbums(db, library, edits); // edits : recréer les retouches d'un projet réimporté
const albumPdf = createAlbumPdf(db, library, albums);
const exportsSvc = createExports(db, edits);
const external = createExternal(db, { edits, library, settings: () => store.external });
const duplicates = createDuplicates(db, library);
const contactSheets = createContactSheets(db, library, edits);
const catalog = createCatalog(db);
const metadata = createMetadata(db, { keywords, library, settings: () => store.metadata, version: currentVersion() });
// IA facultative et locale (lib/ai.mjs) : extension retirable, avec ses propres tables, réglages et routes
const ai = createAi(db, { keywords, library, metadata, collections, enginesDir: path.join(DATA_DIR, 'ia', 'moteurs') });

const reloadStore = () => { /* la base est la référence ; le miroir JSON est déjà réécrit par saveStore */ };
const getStats = () => { const s = library.stats(); return { photos: s.photos, supports: s.supports?.total ?? 0, keywords: s.keywords, albums: s.albums }; };
// couverture des originaux par une copie sur un support de sauvegarde ou d'archive
const getCoverage = () => db.prepare(`SELECT COUNT(*) photos, COALESCE(SUM(${BACKED_UP}), 0) covered,
  COALESCE(SUM((SELECT COUNT(DISTINCT COALESCE(support_id, '-')) FROM files WHERE photo_id = p.id) <= 1), 0) single FROM photos p`).get();
const extra = setupExtra({ root: ROOT, getStore: () => store, saveStore: () => saveStore(db, store), reloadStore, getStats, getDb: () => db, reimport: async () => {}, getCoverage });
// rapports : même service de sauvegarde (liste, vérification, tests, destinations), réglages du store
const reports = createReports(db, { backups: extra.backups, backupSettings: () => store.backup });
// tableau de bord (lib/dashboard.mjs) : calculé à l'ouverture de la vue Statistiques, mis en cache
const dashboard = createDashboard(db, { backups: extra.backups, importDir: () => store.import?.dest || null });
const selective = createSelectiveRestore(db, { backups: extra.backups, albums, collections });
// verrouillage facultatif (lib/lock.mjs) : empreinte du mot de passe dans store.security.lock
const lock = createLock({ getLock: () => store.security?.lock, setLock: l => { store.security = { ...(store.security ?? {}), lock: l }; saveStore(db, store); } });
const admin = setupAdmin({ root: ROOT, getStore: () => store, saveStore: () => saveStore(db, store) });
const dbAdmin = setupDbAdmin({ getDb: () => db, getError: () => null, getStore: () => store, mirrorFile: STORE_FILE, dbFile: DB_FILE });

function currentVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; } }
const buildState = () => ({
  app: { name: APP.name, slug: APP.slug, icon: APP.icon, tagline: APP.tagline },
  license: licenseBrief(store), menu: store.menu ?? null, version: currentVersion(), installed: INSTALLED,
  scan: store.scan, import: store.import, stats: getStats(),
  supportKinds: SUPPORT_KINDS, supportRoles: SUPPORT_ROLES,
  ai: (() => { try { return { enabled: ai.settings().enabled }; } catch { return { enabled: false }; } })(),
  backupAlerts: (() => { try { return extra.backups.alerts().filter(x => x.level !== 'info').length; } catch { return 0; } })(),
});

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

// vignettes de photos dans l'ordre demandé (réponses de l'IA)
const cardsOf = ids => { const order = [...new Set(ids.filter(Boolean))].slice(0, 300); if (!order.length) return []; const m = new Map(library.search({ ids: order }, { limit: 300 }).rows.map(c => [c.id, c])); return order.map(i => m.get(i)).filter(Boolean); };
const aiHandle = aiRoutes(ai, { json, readBody, cards: cardsOf });

/** Critères de recherche lus dans des paramètres d'URL (Photothèque, planche-contact : mêmes clés que lib/search.mjs). */
function filtersFrom(sp) {
  const f = {};
  // chaînes
  for (const k of ['q', 'camera', 'lens', 'format', 'from', 'to', 'year', 'keywordId', 'supportId', 'folderId', 'albumId', 'collectionId', 'author', 'orientation', 'integrity', 'variantsOf', 'place', 'backup', 'keywordCategory']) if (sp.get(k)) f[k] = sp.get(k);
  // nombres / booléens « marqués » (la présence du paramètre compte, même vide)
  for (const k of ['rating', 'color', 'missing', 'hasGps', 'hasPlace', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight']) if (sp.get(k) != null && sp.get(k) !== '') f[k] = sp.get(k);
  // drapeaux présents/absents : la valeur « true » (ou sans valeur) active le critère
  for (const k of ['noKeyword', 'hasKeyword', 'hasCaption', 'noCaption', 'noDate', 'duplicate', 'hideVariants', 'variants']) if (sp.get(k) != null && sp.get(k) !== 'false' && sp.get(k) !== '0') f[k] = true;
  f.prefix = sp.get('prefix') !== 'false';
  // listes séparées par des virgules (ET / OU / NON)
  const list = k => { const v = sp.get(k); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : null; };
  for (const k of ['keywords', 'anyKeywords', 'excludeKeywords', 'anyText', 'excludeText']) if (list(k)) f[k] = list(k);
  if (sp.get('ids') != null) f.ids = list('ids') ?? [];
  return f;
}

/**
 * Photos d'un document (planche, fiches, CSV) : `ids` explicites (sélection, dans l'ordre), sinon toutes
 * celles de la recherche `query` (paramètres de /api/photos, tri compris). `null` si la collection est inconnue.
 */
const MAX_CSV_PHOTOS = 100000;
function photoIdsFrom(b, max) {
  if (Array.isArray(b?.ids)) return b.ids.filter(x => typeof x === 'string').slice(0, max);
  const sp = new URLSearchParams(typeof b?.query === 'string' ? b.query.slice(0, 4000) : '');
  const f = filtersFrom(sp);
  if (f.collectionId && !collections.get(f.collectionId)) return null;
  const crit = collections.resolveFilters(f), ids = [];
  for (let off = 0; ids.length < max; off += 300) {
    const r = library.search(crit, { limit: 300, offset: off, sort: sp.get('sort') });
    ids.push(...r.rows.map(x => x.id)); if (r.rows.length < 300) break; // search() plafonne à 300 par page
  }
  return ids.slice(0, max);
}

// Charge utile bornée (sécurité) : nombres, booléens, chaînes, objets/arrays de profondeur limitée.
function sanitize(value, depth = 0) {
  if (depth > 5) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 400);
  if (Array.isArray(value)) return value.slice(0, 500).map(v => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 60) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return null;
}

// Rejets de chemins : doit rester dans `base` (protection contre .. et liens hors périmètre).
// Travaux d'indexation en cours ou terminés (durée de vie du serveur), suivis par /api/jobs/<id>.
const JOBS = new Map();

function inside(base, target) { return path.resolve(target).startsWith(path.resolve(base) + path.sep) || path.resolve(target) === path.resolve(base); }

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const id = decodeURIComponent(p.split('/')[3] ?? '');

  // ---- verrouillage (accessibles verrouillé : état et déverrouillage ; le reste exige une session ouverte)
  if (p.startsWith('/api/lock')) {
    const send = (code, body, cookie) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(cookie ? { 'Set-Cookie': cookie } : {}) }); res.end(JSON.stringify(body)); };
    try {
      if (p === '/api/lock' && m === 'GET') return send(200, lock.status(req));
      if (p === '/api/lock/unlock' && m === 'POST') { const b = await readBody(req); const r = lock.unlock(String(b.password ?? '')); logHistory(db, 'lock.unlock', 'Application déverrouillée'); return send(200, { ok: true }, r.cookie); }
      if (p === '/api/lock/lock' && m === 'POST') { const r = lock.lockNow(); return send(200, { ok: true }, r.cookie); }
      if (!lock.allowed(req)) return send(401, { error: 'Application verrouillée', locked: true });
      const b = await readBody(req);
      if (p === '/api/lock/password' && m === 'POST') { const r = lock.setPassword({ current: String(b.current ?? ''), password: String(b.password ?? ''), idleMinutes: b.idleMinutes }); logHistory(db, 'lock.password', 'Verrouillage activé ou mot de passe changé'); return send(200, lock.status({ headers: { cookie: r.cookie } }), r.cookie); }
      if (p === '/api/lock/idle' && m === 'POST') return send(200, lock.setIdle({ current: String(b.current ?? ''), idleMinutes: b.idleMinutes }));
      if (p === '/api/lock/disable' && m === 'POST') { const r = lock.disable({ current: String(b.current ?? '') }); logHistory(db, 'lock.disable', 'Verrouillage désactivé'); return send(200, { enabled: false }, r.cookie); }
    } catch (e) { return send(400, { error: e.message }); }
    return send(404, { error: 'Not found' });
  }
  // restauration sélective (albums, collections, documents) : nouveaux éléments, sauvegarde de sécurité d'abord
  if (p === '/api/backups/selective' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await selective.restoreSelection(String(b.name ?? ''), { albums: b.albums, collections: b.collections, documents: b.documents, password: b.password || null })); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (await extra(req, res, url, { json, readBody })) return;
  if (await admin(req, res, url, { json, readBody })) return;
  if (await dbAdmin(req, res, url, { json })) return;

  // ---- Ping / état ----
  if (p === '/api/ping' && m === 'GET') return json(res, 200, { ok: true, app: APP.name, version: currentVersion(), installed: INSTALLED });
  if (p === '/api/state' && m === 'GET') return json(res, 200, buildState());
  if (p === '/api/shutdown' && m === 'POST') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return; }
  if (p === '/api/db' && m === 'GET') return json(res, 200, { ok: true, ...dbStatus(db), mirror: STORE_FILE });

  // ---- Vignettes servies depuis le cache data/thumbs (jamais hors de ce dossier) ----
  if (p.startsWith('/api/thumb/') && m === 'GET') {
    const rel = decodeURIComponent(p.slice('/api/thumb/'.length));
    const abs = path.join(THUMBS_DIR, rel);
    if (!inside(THUMBS_DIR, abs) || !fs.existsSync(abs)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(abs).pipe(res);
  }

  // ---- Réglages (indexation / import) ----
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (b.scan) store.scan = { ...store.scan, ...sanitize(b.scan) };
    if (b.import) store.import = { ...store.import, ...sanitize(b.import) };
    if (b.menu) store.menu = sanitize(b.menu);
    saveStore(db, store); return json(res, 200, buildState());
  }

  // ---- installation (lib/dist.mjs) : version installée, dossiers, vérification des empreintes et de la signature
  if (p === '/api/install' && m === 'GET') {
    const pub = path.join(ROOT, ...PUBLIC_KEY_FILE.split('/'));
    return json(res, 200, { installed: INSTALLED, info: installInfo(ROOT), program: ROOT, data: path.dirname(DATA_DIR), version: currentVersion(), node: process.version,
      distributable: fs.existsSync(path.join(ROOT, SUMS_FILE)), signedFile: fs.existsSync(path.join(ROOT, SIG_FILE)), keyId: fs.existsSync(pub) ? keyId(fs.readFileSync(pub, 'utf8')) : null });
  }
  if (p === '/api/install/verify' && m === 'POST') {
    if (!fs.existsSync(path.join(ROOT, SUMS_FILE))) return json(res, 200, { ok: false, dev: true, error: 'Version de développement : aucune empreinte de distribution à vérifier (voir Manifeste).' });
    const r = verifyDist(ROOT); logHistory(db, 'install.verify', `Vérification de l’installation : ${r.ok ? 'conforme' : r.error}`, { ok: r.ok, signed: r.signed });
    return json(res, 200, r);
  }

  // ---- IA facultative (lib/ai.mjs) ----
  if (p.startsWith('/api/ai') && await aiHandle(req, res, p, m, url)) return;

  // ---- Supports ----
  if (p === '/api/supports' && m === 'GET') { supports.refresh(); return json(res, 200, { list: supports.list(), stats: supports.stats(), kinds: SUPPORT_KINDS, roles: SUPPORT_ROLES }); }
  if (p === '/api/supports' && m === 'POST') { const b = await readBody(req); const s = supports.upsert(b); return json(res, 200, { support: s }); }
  if (p === '/api/supports/refresh' && m === 'POST') { const r = supports.refresh(); library.recountMissing(); return json(res, 200, { refreshed: r, list: supports.list(), stats: supports.stats() }); }
  if (p.startsWith('/api/supports/')) {
    if (m === 'GET') { const s = supports.get(id); return s ? json(res, 200, { support: s, files: supports.files(id) }) : json(res, 404, { error: 'Support inconnu' }); }
    if (m === 'PUT') { const b = await readBody(req); const s = supports.upsert({ ...supports.get(id), ...b, id }); return json(res, 200, { support: s }); }
    if (m === 'DELETE') { const s = supports.remove(id); return json(res, 200, { removed: s }); }
  }

  // ---- Dossiers + indexation (sans copie) ----
  if (p === '/api/folders' && m === 'GET') return json(res, 200, { list: db.prepare('SELECT * FROM folders ORDER BY path').all() });
  if (p === '/api/folders' && m === 'POST') {
    const b = await readBody(req); const folderPath = String(b.path || '').trim();
    if (!folderPath) return json(res, 400, { error: 'Chemin du dossier manquant' });
    if (!fs.existsSync(folderPath)) return json(res, 400, { error: 'Chemin introuvable : ' + folderPath });
    const fid = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    db.prepare('INSERT INTO folders(id,support_id,path,rel_path,photo_count,indexed_at,status,data) VALUES(?,?,?,NULL,0,NULL,?,?)')
      .run(fid, b.supportId || null, folderPath, 'pending', '{}');
    return json(res, 200, { folder: db.prepare('SELECT * FROM folders WHERE id=?').get(fid) });
  }
  // Indexation d'un dossier (asynchrone, progression consultable via /api/jobs/<id>)
  if (p.startsWith('/api/folders/') && p.endsWith('/index') && m === 'POST') {
    const fid = id;
    const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(fid);
    if (!folder) return json(res, 404, { error: 'Dossier inconnu' });
    const jobId = 'j' + Date.now().toString(36);
    const job = { id: jobId, folder: fid, done: 0, total: 0, current: null, status: 'running', result: null, error: null };
    JOBS.set(jobId, job);
    library.indexFolder(fid, {
      onProgress: pr => Object.assign(job, pr),
      onError: (f, e) => { job.lastError = { file: f, error: String(e.message || e) }; },
    }).then(r => { job.status = 'done'; job.result = r; }).catch(e => { job.status = 'error'; job.error = String(e.message || e); });
    return json(res, 200, { jobId, job });
  }
  if (p.startsWith('/api/jobs/') && m === 'GET') { const j = JOBS.get(id); return j ? json(res, 200, { job: j }) : json(res, 404, { error: 'Travail inconnu' }); }
  if (p.startsWith('/api/folders/') && m === 'DELETE') { db.prepare('DELETE FROM folders WHERE id=?').run(id); return json(res, 200, { removed: id }); }

  // ---- Recherche / liste des photos (critères de la §9 du cahier des charges) ----
  if (p === '/api/photos' && m === 'GET') {
    const sp = url.searchParams, f = filtersFrom(sp);
    if (f.collectionId && !collections.get(f.collectionId)) return json(res, 404, { error: 'Collection inconnue' });
    const r = library.search(collections.resolveFilters(f), { limit: sp.get('limit'), offset: sp.get('offset'), sort: sp.get('sort') });
    return json(res, 200, r);
  }
  // ---- Planche-contact (lib/contactsheet.mjs) : photos choisies, ou toutes celles d'une recherche ----
  if (p === '/api/contactsheet' && m === 'GET') return json(res, 200, { layouts: SHEET_LAYOUTS, backgrounds: SHEET_BACKGROUNDS, groupBy: GROUP_BY, pages: SHEET_PAGES, fields: SHEET_FIELDS, qualities: SHEET_QUALITIES, defaults: SHEET_DEFAULTS, maxPhotos: MAX_SHEET_PHOTOS, csvColumns: CSV_COLUMNS.map(c => c[1]) });
  if (p === '/api/contactsheet' && m === 'POST') {
    const b = await readBody(req);
    const ids = photoIdsFrom(b, MAX_SHEET_PHOTOS); if (!ids) return json(res, 404, { error: 'Collection inconnue' });
    const opts = sanitize(b?.options) ?? {};
    const tmp = path.join(os.tmpdir(), `phototheque-planche-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    const fd = fs.openSync(tmp, 'w');
    let report;
    try { report = await contactSheets.render(ids, opts, { write: buf => fs.writeSync(fd, buf), label: typeof b?.label === 'string' ? b.label.slice(0, 120) : '' }); }
    catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); return json(res, 400, { error: e.message }); }
    fs.closeSync(fd);
    const file = ((opts.title || b?.label || 'planche-contact').replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim() || 'planche-contact') + '.pdf';
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': report.bytes,
      'Content-Disposition': `${b?.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file)}`,
      'X-Pdf-Report': Buffer.from(JSON.stringify(report)).toString('base64') });
    const rs = fs.createReadStream(tmp); rs.on('close', () => fs.rmSync(tmp, { force: true }));
    return rs.pipe(res);
  }
  // ---- Inventaires et rapports (lib/reports.mjs) : PDF ou CSV, compte rendu dans X-Report ----
  if (p === '/api/reports' && m === 'GET') return json(res, 200, { reports: REPORTS, supports: db.prepare('SELECT id, name, status FROM supports ORDER BY name COLLATE NOCASE').all() });
  if (p.startsWith('/api/reports/') && m === 'POST') {
    const [, , , kind, format] = p.split('/');
    if (!REPORTS[kind] || !['pdf', 'csv'].includes(format)) return json(res, 404, { error: 'Rapport inconnu' });
    const b = await readBody(req), opts = sanitize(b?.options) ?? {};
    const name = REPORTS[kind].label.replace(/’/g, "'").replace(/[^\p{L}\p{N}' _-]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ' + new Date().toISOString().slice(0, 10);
    const report = r => Buffer.from(JSON.stringify(r)).toString('base64');
    if (format === 'csv') {
      let out; try { out = await reports.csv(kind, opts); } catch (e) { return json(res, 400, { error: e.message }); }
      const buf = Buffer.from(out.text, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': buf.length, 'X-Report': report({ title: out.title, rows: out.rows, summary: out.summary }),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + '.csv').replace(/'/g, '%27')}` });
      return res.end(buf);
    }
    const tmp = path.join(os.tmpdir(), `phototheque-rapport-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    const fd = fs.openSync(tmp, 'w');
    let out;
    try { out = await reports.pdf(kind, opts, buf => fs.writeSync(fd, buf)); }
    catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); return json(res, 400, { error: e.message }); }
    fs.closeSync(fd);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': out.bytes, 'X-Report': report(out),
      'Content-Disposition': `${b?.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name + '.pdf').replace(/'/g, '%27')}` });
    const rs = fs.createReadStream(tmp); rs.on('close', () => fs.rmSync(tmp, { force: true }));
    return rs.pipe(res);
  }
  // ---- Catalogue CSV (lib/catalog.mjs) : mêmes photos que la planche-contact, une ligne par photo ----
  if (p === '/api/catalog/csv' && m === 'POST') {
    const b = await readBody(req);
    const ids = photoIdsFrom(b, MAX_CSV_PHOTOS); if (!ids) return json(res, 404, { error: 'Collection inconnue' });
    let out; try { out = catalog.csv(ids, { label: typeof b?.label === 'string' ? b.label.slice(0, 120) : '' }); } catch (e) { return json(res, 400, { error: e.message }); }
    const file = ((typeof b?.label === 'string' && b.label ? b.label : 'catalogue').replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim() || 'catalogue') + '.csv';
    const buf = Buffer.from(out.text, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': buf.length, 'X-Csv-Photos': String(out.photos),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}` });
    return res.end(buf);
  }
  if (p === '/api/photos' && m === 'PUT') { const b = await readBody(req); const d = library.update(b.id, sanitize(b) ?? {}); if (b.keywords) { db.prepare('DELETE FROM photo_keywords WHERE photo_id=?').run(b.id); keywords.attachNames(b.id, b.keywords); library.syncKeywordsText(b.id); keywords.recount(); } return json(res, 200, { photo: d }); }
  if (p === '/api/photos/remove' && m === 'POST') { const b = await readBody(req); return json(res, 200, library.removeFromIndex(b.ids)); } // retire de l'index, jamais des originaux
  if (p.startsWith('/api/photos/')) {
    const sub = p.split('/')[4];
    // ---- Retouche non destructive : versions, rendu ----
    if (sub === 'edits' && m === 'GET') return json(res, 200, { versions: edits.list(id), capability: edits.capability(id), fields: EDIT_FIELDS, presets: PRESETS, curves: CURVES, toneKeys: TONE_KEYS, defaults: DEFAULT_PARAMS, paramsVersion: EDIT_PARAMS_VERSION });
    if (sub === 'edits' && m === 'POST') return json(res, 200, { version: edits.create(id, sanitize(await readBody(req)) ?? {}) });
    if (sub === 'render' && m === 'GET') {
      // aperçu retouché : réglages d'une version (?edit=) ou à l'essai (?params= JSON), taille ?size=
      const sp = url.searchParams;
      let params = {};
      if (sp.get('edit')) { const v = edits.get(sp.get('edit')); if (!v || v.photo_id !== id) return json(res, 404, { error: 'Version inconnue' }); params = v.params; }
      else if (sp.get('params')) { try { params = JSON.parse(sp.get('params')); } catch { return json(res, 400, { error: 'Réglages illisibles' }); } }
      const file = await edits.preview(id, params, { size: sp.get('size'), noCrop: sp.get('nocrop') === '1' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    // ---- ouverture dans un logiciel externe : toujours sur une copie (lib/external.mjs) ----
    if (sub === 'external' && m === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, await external.open(id, { source: b.source === 'version' ? 'version' : 'original' })); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (sub === 'full' && m === 'GET') {
      const file = await library.fullImage(id); if (!file) return json(res, 404, { error: 'Aucune image lisible pour cette photo' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
      return fs.createReadStream(file).pipe(res);
    }
    if (!sub && m === 'GET') { const d = library.detail(id); return d ? json(res, 200, { photo: d }) : json(res, 404, { error: 'Photo inconnue' }); }
  }
  if (p.startsWith('/api/edits/')) {
    const action = p.split('/')[4];
    if (!edits.get(id)) return json(res, 404, { error: 'Version inconnue' });
    if (!action && m === 'GET') return json(res, 200, { version: edits.get(id) });
    if (!action && m === 'PUT') return json(res, 200, { version: edits.update(id, sanitize(await readBody(req)) ?? {}) });
    if (!action && m === 'DELETE') return json(res, 200, edits.remove(id));
    if (action === 'undo' && m === 'POST') return json(res, 200, { version: edits.undo(id) });
    if (action === 'redo' && m === 'POST') return json(res, 200, { version: edits.redo(id) });
    if (action === 'reset' && m === 'POST') return json(res, 200, { version: edits.reset(id) });
  }

  // ---- Doublons et photos similaires (lib/duplicates.mjs) : rien n'est jamais supprimé ----
  if (p === '/api/duplicates/summary' && m === 'GET') return json(res, 200, { ...duplicates.summary({ threshold: url.searchParams.get('threshold'), seconds: url.searchParams.get('seconds') }), levels: DUP_LEVELS, defaults: { threshold: DEFAULT_THRESHOLD, seconds: DEFAULT_BURST_SECONDS, maxThreshold: MAX_THRESHOLD } });
  if (p === '/api/duplicates' && m === 'GET') {
    const sp = url.searchParams;
    return json(res, 200, duplicates.groups(sp.get('level') || 'exact', { threshold: sp.get('threshold'), seconds: sp.get('seconds'), offset: sp.get('offset'), limit: sp.get('limit') }));
  }
  if (p === '/api/duplicates/hashes' && m === 'POST') {
    const b = sanitize(await readBody(req)) ?? {};
    const jobId = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = { id: jobId, kind: 'hashes', done: 0, total: 0, current: null, status: 'running', result: null, error: null };
    JOBS.set(jobId, job);
    duplicates.computeHashes({ all: !!b.all, onProgress: pr => Object.assign(job, pr) })
      .then(r => { job.status = 'done'; job.result = r; }).catch(e => { job.status = 'error'; job.error = String(e.message || e); });
    return json(res, 200, { jobId, job });
  }
  if (p === '/api/duplicates/reference' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, b.clear ? duplicates.clearReference(b.photoIds) : duplicates.setReference(b.photoIds, b.reference)); }
  if (p === '/api/duplicates/ignore' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, b.reset ? duplicates.resetIgnored() : duplicates.ignore(b.photoIds)); }
  if (p === '/api/duplicates/reference-file' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, duplicates.setReferenceFile(b.fileId)); }
  // Suppression d'une fiche en double : index seulement, le fichier reste sur le disque (écarté de l'indexation)
  if (p === '/api/duplicates/remove' && m === 'POST') {
    const b = sanitize(await readBody(req)) ?? {};
    try {
      if (b.reset) return json(res, 200, duplicates.resetExcluded());
      if (b.fileId) return json(res, 200, duplicates.removeFile(b.fileId));
      if (b.photoId) return json(res, 200, duplicates.removePhoto(b.photoId));
      return json(res, 400, { error: 'fileId ou photoId attendu' });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---- Exports de photos (travail en arrière-plan, suivi par /api/jobs/<id>) ----
  if (p === '/api/exports/profiles' && m === 'GET') return json(res, 200, { ...exportsSvc.profiles(), formats: EXPORT_FORMATS, metadata: METADATA_MODES, positions: WATERMARK_POSITIONS, dir: EXPORT_DIR, colorProfiles: { ...COLOR_PROFILES, ...Object.fromEntries(iccFiles().map(n => ['file:' + n, `${n} (dossier Profils)`])) }, profilesDir: PROFILES_DIR, printFits: PRINT_FITS, printDpiLow: PRINT_DPI_LOW });
  if (p === '/api/exports/profiles' && m === 'POST') return json(res, 200, exportsSvc.saveProfile(sanitize(await readBody(req)) ?? {}));
  if (p.startsWith('/api/exports/profiles/') && m === 'DELETE') return json(res, 200, exportsSvc.removeProfile(decodeURIComponent(p.split('/')[4] ?? '')));
  if (p === '/api/exports' && m === 'GET') return json(res, 200, { list: db.prepare("SELECT id, kind, target, profile, count, status, created_at FROM exports ORDER BY created_at DESC LIMIT 30").all() });
  if (p === '/api/exports' && m === 'POST') {
    const b = sanitize(await readBody(req)) ?? {};
    const jobId = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = { id: jobId, kind: 'export', done: 0, total: 0, current: null, status: 'running', result: null, error: null };
    JOBS.set(jobId, job);
    exportsSvc.run(b.photoIds, b.profile, { onProgress: pr => Object.assign(job, pr) })
      .then(r => { job.status = 'done'; job.result = r; }).catch(e => { job.status = 'error'; job.error = String(e.message || e); });
    return json(res, 200, { jobId, job });
  }

  // ---- Navigation : années, appareils, formats ----
  if (p === '/api/facets' && m === 'GET') return json(res, 200, { years: library.years(), cameras: library.cameras(), formats: library.formats(), keywords: library.keywordFacets() });
  if (p === '/api/stats' && m === 'GET') return json(res, 200, library.stats());
  if (p.startsWith('/api/dashboard') && m === 'GET') {
    const sp = url.searchParams, f = { year: sp.get('year'), supportId: sp.get('supportId'), format: sp.get('format') };
    const d = dashboard.compute(f, { refresh: sp.get('refresh') === '1' });
    if (p === '/api/dashboard') return json(res, 200, { dashboard: d, supports: db.prepare('SELECT id, name FROM supports ORDER BY name COLLATE NOCASE').all(), years: library.years(), formats: library.formats() });
    const stamp = new Date().toISOString().slice(0, 10);
    if (p === '/api/dashboard/csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tableau-de-bord-${stamp}.csv"` }); return res.end(dashboard.csv(d)); }
    if (p === '/api/dashboard/pdf') {
      const chunks = []; renderTableDoc(dashboardDoc(d), b => chunks.push(b));
      const buf = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Content-Disposition': `${sp.get('inline') === '1' ? 'inline' : 'attachment'}; filename="tableau-de-bord-${stamp}.pdf"` });
      logHistory(db, 'dashboard.pdf', 'Tableau de bord exporté en PDF', d.filters);
      return res.end(buf);
    }
  }

  // ---- Mots-clés ----
  if (p === '/api/keywords' && m === 'GET') return json(res, 200, { list: keywords.list(), tree: keywords.tree(), categories: keywords.categories(), suggest: keywords.suggest(url.searchParams.get('q') || '') });
  // ---- logiciel externe : réglage, indexation des copies modifiées ----
  if (p === '/api/external' && m === 'GET') return json(res, 200, { settings: store.external, check: checkEditor(store.external?.editor), dir: EXTERNAL_DIR, sources: EXTERNAL_SOURCES });
  if (p === '/api/external' && m === 'PUT') {
    const b = await readBody(req); const next = cleanExternalSettings(b, store.external);
    const chk = checkEditor(next.editor); if (!chk.ok) return json(res, 400, { error: chk.label });
    store.external = next; saveStore(db, store); return json(res, 200, { settings: store.external, check: chk });
  }
  if (p === '/api/external/index' && m === 'POST') { try { return json(res, 200, await external.index()); } catch (e) { return json(res, 400, { error: e.message }); } }
  // ---- métadonnées documentaires : aperçu puis application (lib/metadata.mjs) ----
  if (p === '/api/metadata' && m === 'GET') return json(res, 200, { settings: store.metadata, destinations: DESTINATIONS, namings: NAMINGS, modes: META_MODES, fields: DOC_FIELDS, labels: LABELS_FR, dir: XMP_DIR, max: META_MAX, batches: metadata.batches() });
  if (p === '/api/metadata/settings' && m === 'PUT') { const b = await readBody(req); store.metadata = cleanMetadataSettings(b, store.metadata); saveStore(db, store); return json(res, 200, { settings: store.metadata }); }
  if (p === '/api/metadata/doc' && m === 'GET') { const d = metadata.docOf(url.searchParams.get('id') || ''); return d ? json(res, 200, { doc: d }) : json(res, 404, { error: 'Photo inconnue' }); }
  if (p.startsWith('/api/metadata/') && m === 'POST') {
    const b = await readBody(req); const what = p.slice('/api/metadata/'.length);
    if (what === 'undo') { try { return json(res, 200, metadata.undo(b.batchId)); } catch (e) { return json(res, 400, { error: e.message }); } }
    const ids = photoIdsFrom(b, META_MAX); if (!ids) return json(res, 404, { error: 'Collection inconnue' });
    const apply = b.apply === true;
    const trim = r => ({ ...r, rows: r.rows.slice(0, 300).map(({ content, ...x }) => x), more: Math.max(0, r.rows.length - 300) });
    if (what === 'edit') return json(res, 200, apply ? metadata.applyEdit(ids, sanitize(b.changes) ?? {}) : trim(metadata.planEdit(ids, sanitize(b.changes) ?? {})));
    if (what === 'read') { const o = { mode: b.mode === 'replace' ? 'replace' : 'fill', fields: Array.isArray(b.fields) ? b.fields : null }; if (apply) return json(res, 200, await metadata.applyRead(ids, o)); const r = await metadata.planRead(ids, o); return json(res, 200, { ...trim(r), issues: r.issues.slice(0, 50), issueCount: r.issues.length }); }
    if (what === 'write') { if (apply) return json(res, 200, metadata.applyWrite(ids, { conflicts: b.conflicts === 'replace' ? 'replace' : 'skip' })); const r = metadata.planWrite(ids); return json(res, 200, { ...trim(r), count: r.count, statuses: r.statuses, settings: r.settings }); }
    return json(res, 404, { error: 'Action inconnue' });
  }
  if (p === '/api/keywords/duplicates' && m === 'GET') return json(res, 200, { groups: keywords.vocabularyDuplicates() });
  if (p === '/api/keywords/usage' && m === 'GET') return json(res, 200, keywords.usage());
  if (p === '/api/keywords' && m === 'POST') { const b = await readBody(req); return json(res, 200, { keyword: (() => { const k = keywords.ensure(b.name, b.parentId || null); return ['category', 'synonyms', 'description'].some(x => b[x] != null) ? keywords.update(k.id, { category: b.category, synonyms: b.synonyms, description: b.description }) : k; })() }); }
  if (p === '/api/keywords/suggest' && m === 'GET') return json(res, 200, { suggest: keywords.suggest(url.searchParams.get('q') || '') });
  if (p === '/api/keywords/export' && m === 'GET') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mots-cles.csv"' }); return res.end('﻿' + keywords.exportCsv()); }
  if (p === '/api/keywords/import' && m === 'POST') { const b = await readBody(req); return json(res, 200, keywords.importList(b.names)); }
  if (p === '/api/keywords/merge' && m === 'POST') { const b = await readBody(req); return json(res, 200, { keyword: keywords.merge(b.sourceIds, b.targetId) }); }
  if (p === '/api/keywords/recount' && m === 'POST') { keywords.recount(); return json(res, 200, { ok: true }); }
  if (p.startsWith('/api/keywords/')) {
    if (m === 'PUT') { const b = await readBody(req); return json(res, 200, { keyword: keywords.update(id, b) }); }
    if (m === 'DELETE') { keywords.remove(id); return json(res, 200, { removed: id }); }
  }

  // ---- Collections (sélections statiques et recherches enregistrées) ----
  if (p === '/api/collections' && m === 'GET') return json(res, 200, { list: collections.list(), kinds: COLLECTION_KINDS });
  if (p === '/api/collections' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, { collection: collections.create(b) }); }
  if (p.startsWith('/api/collections/')) {
    const sub = p.split('/').slice(4).join('/');
    if (!collections.get(id)) return json(res, 404, { error: 'Collection inconnue' });
    if (sub === 'photos' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, collections.addPhotos(id, b.ids)); }
    if (sub === 'photos/remove' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, collections.removePhotos(id, b.ids)); }
    if (!sub && m === 'GET') return json(res, 200, { collection: collections.get(id) });
    if (!sub && m === 'PUT') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, { collection: collections.update(id, b) }); }
    if (!sub && m === 'DELETE') return json(res, 200, collections.remove(id));
  }

  // ---- Albums (références aux photos, pages à gabarits) ----
  if (p === '/api/albums' && m === 'GET') return json(res, 200, { list: albums.list(), formats: FORMATS, layouts: LAYOUTS, formatVersion: ALBUM_FORMAT_VERSION, dpiAdvised: DPI_WARN, pdfProfiles: PDF_PROFILES, bleedMm: BLEED_MM,
    aligns: ALIGNS, borderMax: BORDER_MAX, styles: albums.styles(), services: albumPdf.services(), serviceOutputs: SERVICE_OUTPUTS, serviceLayouts: SERVICE_LAYOUTS,
    colorProfiles: { srgb: 'sRGB', ...Object.fromEntries(iccFiles().map(n => ['file:' + n, `${n} (dossier Profils)`])) }, exportDir: EXPORT_DIR });
  // modèles graphiques et profils de prestataire (avant les routes /api/albums/<id>)
  if (p === '/api/albums/styles' && m === 'POST') { try { return json(res, 200, albums.saveStyle(sanitize(await readBody(req)) ?? {})); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p.startsWith('/api/albums/styles/') && m === 'DELETE') { try { return json(res, 200, albums.removeStyle(decodeURIComponent(p.split('/')[4] ?? ''))); } catch (e) { return json(res, 404, { error: e.message }); } }
  if (p === '/api/albums/services' && m === 'POST') { try { return json(res, 200, albumPdf.saveService(sanitize(await readBody(req)) ?? {})); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p.startsWith('/api/albums/services/') && m === 'DELETE') { try { return json(res, 200, albumPdf.removeService(decodeURIComponent(p.split('/')[4] ?? ''))); } catch (e) { return json(res, 404, { error: e.message }); } }
  if (p === '/api/albums' && m === 'POST') { const b = sanitize(await readBody(req)) ?? {}; return json(res, 200, { album: albums.create(b) }); }
  // Réimport d'un projet exporté : analyse (sans écriture) puis import en nouvel album. Le projet n'est pas
  // passé par sanitize() (qui tronquerait un album de plus de 200 photos) : albums.importProject le
  // relit champ par champ avec ses propres nettoyages.
  if ((p === '/api/albums/import/analyse' || p === '/api/albums/import') && m === 'POST') {
    const b = await readBody(req);
    try {
      if (p.endsWith('/analyse')) return json(res, 200, { analysis: albums.analyseProject(b?.project) });
      return json(res, 200, albums.importProject(b?.project, { name: typeof b?.name === 'string' ? b.name : undefined, withEdits: b?.withEdits !== false }));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p.startsWith('/api/albums/')) {
    if (!albums.get(id)) return json(res, 404, { error: 'Album inconnu' });
    const [sub, n, action] = p.split('/').slice(4);
    const body = async () => sanitize(await readBody(req)) ?? {};
    if (!sub) {
      if (m === 'GET') return json(res, 200, { album: albums.get(id) });
      if (m === 'PUT') return json(res, 200, { album: albums.update(id, await body()) });
      if (m === 'DELETE') return json(res, 200, albums.remove(id));
    }
    if (sub === 'export' && m === 'GET') {
      const proj = albums.exportProject(id);
      const file = (proj.album.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'album') + '.album.json';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}` });
      return res.end(JSON.stringify(proj, null, 2));
    }
    if (sub === 'pdf' && m === 'GET') {
      // PDF produit dans un fichier temporaire (les images ne restent pas en mémoire), puis envoyé et effacé.
      const quality = PDF_PROFILES[url.searchParams.get('quality')] ? url.searchParams.get('quality') : 'print';
      const bleed = url.searchParams.get('bleed') === '1';
      const layout = url.searchParams.get('layout') === 'spreads' ? 'spreads' : 'pages';
      const tmp = path.join(os.tmpdir(), `phototheque-album-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
      const fd = fs.openSync(tmp, 'w');
      let report;
      try { report = await albumPdf.render(id, { quality, bleed, layout, write: buf => fs.writeSync(fd, buf) }); }
      catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
      fs.closeSync(fd);
      const file = (albums.get(id).name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'album') + '.pdf';
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Content-Length': report.bytes,
        'Content-Disposition': `${url.searchParams.get('inline') === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file)}`,
        'X-Pdf-Report': Buffer.from(JSON.stringify(report)).toString('base64'),
      });
      const rs = fs.createReadStream(tmp);
      rs.on('close', () => fs.rmSync(tmp, { force: true }));
      return rs.pipe(res);
    }
    if (sub === 'style' && m === 'POST') { const b = await body(); try { return json(res, 200, { album: albums.applyStyle(id, b.model && typeof b.model === 'object' ? b.model : String(b.key ?? ''), { page: b.page ?? null }) }); } catch (e) { return json(res, 400, { error: e.message }); } }
    // dossier prêt à envoyer : contrôles (sans écriture), puis préparation en arrière-plan (/api/jobs/<id>)
    if (sub === 'send' && n === 'check' && m === 'POST') { const b = await body(); try { return json(res, 200, albumPdf.check(id, b.service)); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (sub === 'send' && !n && m === 'POST') {
      const b = await body();
      try { albumPdf.check(id, b.service); } catch (e) { return json(res, 400, { error: e.message }); }
      const jobId = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const job = { id: jobId, kind: 'album-send', done: 0, total: 0, status: 'running', result: null, error: null };
      JOBS.set(jobId, job);
      albumPdf.sendFolder(id, b.service, { onProgress: pr => Object.assign(job, pr), version: currentVersion() })
        .then(r => { job.status = 'done'; job.result = r; }).catch(e => { job.status = 'error'; job.error = String(e.message || e); });
      return json(res, 200, { jobId, job });
    }
    if (sub === 'undo' && m === 'POST') return json(res, 200, albums.undo(id));
    if (sub === 'redo' && m === 'POST') return json(res, 200, albums.redo(id));
    if (sub === 'move-photo' && m === 'POST') { const b = await body(); return json(res, 200, { album: albums.movePhoto(id, b.from, b.to) }); }
    if (sub === 'fill' && m === 'POST') {
      const b = await body();
      let ids = b.photoIds;
      if (b.collectionId) {
        if (!collections.get(b.collectionId)) return json(res, 404, { error: 'Collection inconnue' });
        ids = library.search(collections.resolveFilters({ collectionId: b.collectionId }), { limit: 300, sort: b.sort || 'captured_asc' }).rows.map(r => r.id);
      }
      return json(res, 200, albums.fill(id, ids, b.layout));
    }
    if (sub === 'pages') {
      if (!n && m === 'POST') { const b = await body(); return json(res, 200, { album: albums.addPage(id, b) }); }
      if (n && !action && m === 'PUT') return json(res, 200, { album: albums.updatePage(id, n, await body()) });
      if (n && !action && m === 'DELETE') return json(res, 200, { album: albums.removePage(id, n) });
      if (n && action === 'move' && m === 'POST') { const b = await body(); return json(res, 200, { album: albums.movePage(id, n, b.to) }); }
      if (n && action === 'duplicate' && m === 'POST') return json(res, 200, { album: albums.duplicatePage(id, n) });
    }
  }

  // ---- Importation physique : supports détectés, choix des photos, copie ou déplacement ----
  const importErr = (e, code = 400) => json(res, e.status || code, { error: String(e.message || e) });
  if (p === '/api/import/drives' && m === 'GET') {
    try { return json(res, 200, { drives: await imports.drives({ fresh: url.searchParams.get('fresh') === '1' }), platform: process.platform, dest: imports.destRoot() }); }
    catch (e) { return importErr(e, 500); }
  }
  // enregistre un lecteur détecté comme support (rôle « Transfert » : à modifier dans l'écran Supports)
  if (p === '/api/import/drives/register' && m === 'POST') {
    const b = await readBody(req);
    const d = (await imports.drives()).find(x => x.root === String(b.root ?? ''));
    if (!d) return json(res, 404, { error: 'Lecteur introuvable (débranché ?)' });
    if (d.support) return json(res, 200, { support: supports.get(d.support.id), already: true });
    const kind = { sd: 'sd', usb: 'usb', disk: 'disk', nas: 'nas' }[d.kind] ?? 'other';
    const name = String(b.name || d.label || (d.letter ? `Lecteur ${d.letter}` : path.basename(d.root))).trim().slice(0, 120);
    return json(res, 200, { support: supports.upsert({ name, kind, role: 'transfer', mount_path: d.root, serial: d.serial ?? '' }) });
  }
  if (p === '/api/import/scan' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await imports.scan(b.path, { limit: Math.min(50000, Math.max(1, +b.limit || 20000)) })); }
    catch (e) { return importErr(e); }
  }
  if (p === '/api/import/preview' && m === 'GET') {
    try {
      const buf = await imports.preview(url.searchParams.get('path'), url.searchParams.get('size'));
      if (!buf) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' });
      return res.end(buf);
    } catch (e) { return importErr(e, 404); }
  }
  // import asynchrone (progression : /api/jobs/<id>) ; un seul import à la fois
  if (p === '/api/import/start' && m === 'POST') {
    const b = await readBody(req);
    const sources = Array.isArray(b.sources) ? b.sources.map(String).filter(Boolean) : [];
    if (!sources.length) return json(res, 400, { error: 'Aucune photo choisie' });
    if (sources.length > 100000) return json(res, 400, { error: 'Sélection trop grande' });
    const mode = b.mode === 'move' ? 'move' : 'copy';
    if ([...JOBS.values()].some(j => j.kind === 'import' && j.status === 'running')) return json(res, 409, { error: 'Un import est déjà en cours' });
    if (mode === 'move') { // pas de suppression sans analyse préalable du dossier : refus global avant de commencer
      const bad = sources.find(s => imports.checkMovable(s));
      if (bad) return json(res, 400, { error: `Déplacement refusé pour « ${bad} » : ${imports.checkMovable(bad)}` });
    }
    const sup = b.supportId ? supports.get(String(b.supportId)) : null;
    const jobId = 'j' + Date.now().toString(36);
    const job = { id: jobId, kind: 'import', mode, done: 0, total: sources.length, current: null, status: 'running', result: null, error: null, cancel: false };
    JOBS.set(jobId, job);
    imports.importFiles(sources, {
      mode, verify: b.verify !== false, removeDuplicateSources: !!b.removeDuplicateSources, supportId: sup?.id ?? null, supportName: sup?.name ?? null, root: b.root ? String(b.root) : null,
      // seuls done / total / current : le champ `status` du travail ne doit pas être écrasé par l'étape en cours
      onProgress: pr => { job.done = pr.done; job.total = pr.total; job.current = pr.current; job.phase = pr.status; }, shouldStop: () => job.cancel,
    }).then(r => { job.status = r.stopped ? 'stopped' : 'done'; job.result = r; job.done = r.total; }).catch(e => { job.status = 'error'; job.error = String(e.message || e); });
    return json(res, 200, { jobId, job });
  }
  if (p === '/api/import/cancel' && m === 'POST') {
    const b = await readBody(req); const j = JOBS.get(String(b.jobId ?? ''));
    if (!j || j.kind !== 'import') return json(res, 404, { error: 'Import inconnu' });
    j.cancel = true; return json(res, 200, { job: j });
  }
  // import synchrone (liste de chemins) : même moteur ; le mode « move » exige des fichiers d'un dossier analysé
  if (p === '/api/import' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 200, await imports.importFiles(b.sources, { dryRun: !!b.dryRun, force: !!b.force, mode: b.mode === 'move' ? 'move' : 'copy', verify: !!b.verify, removeDuplicateSources: !!b.removeDuplicateSources })); }
    catch (e) { return importErr(e); }
  }
  if (p === '/api/import/index' && m === 'POST') { const b = await readBody(req); const r = await imports.importIndexOnly(String(b.path || '').trim(), { supportId: b.supportId }); return json(res, 200, r); }
  if (p === '/api/imports' && m === 'GET') return json(res, 200, { list: imports.list() });

  json(res, 404, { error: 'Not found' });
}

/** Tableau de bord → document tabulaire (lib/reportdoc.mjs). */
function dashboardDoc(d) {
  const nf = n => Number(n ?? 0).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');
  const by = n => { const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0, x = +n || 0; while (x >= 1024 && i < 4) { x /= 1024; i++; } return (i ? x.toFixed(1).replace('.', ',') : x) + ' ' + u[i]; };
  const T = d.totals, G = d.gaps, pc = x => String(x).replace('.', ',') + ' %';
  const filt = [d.filters.year && 'année ' + d.filters.year, d.filters.supportId && 'support ' + (d.supports.find(s => s.id === d.filters.supportId)?.name ?? '?'), d.filters.format && 'format ' + d.filters.format].filter(Boolean).join(', ');
  const tab = (heading, label, rows, max = 40) => ({ heading, columns: [{ label, w: 3 }, { label: 'Photos', w: 1, align: 'right' }, { label: 'Part', w: 1, align: 'right' }],
    rows: rows.slice(0, max).map(r => [r.k === '' || r.k == null ? '(inconnu)' : String(r.k), nf(r.n), T.photos ? pc(Math.round(r.n * 1000 / T.photos) / 10) : '']), empty: 'Aucune donnée.' });
  const MOIS = ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return {
    title: 'Tableau de bord de la photothèque', subtitle: `État au ${new Date(d.computedAt).toLocaleString('fr-FR')}${filt ? ' — filtré : ' + filt : ''}.`, stamp: new Date().toLocaleString('fr-FR'),
    sections: [
      { kpis: [['Photos', nf(T.photos)], ['Fichiers', nf(T.files)], ['Volume référencé', by(T.bytes)], ['Fichiers indisponibles', nf(T.unavailable), T.unavailable ? 'warn' : 'ok'],
        ['Supports', nf(T.supports)], ['Supports absents', nf(T.supportsAbsent), T.supportsAbsent ? 'warn' : 'ok'], ['État du catalogue', { ok: 'bon', warn: 'à surveiller', bad: 'à corriger' }[d.health.level], d.health.level],
        ['Originaux couverts', d.coverage.photos ? pc(Math.round(d.coverage.covered * 1000 / d.coverage.photos) / 10) : '—', d.coverage.covered === d.coverage.photos ? 'ok' : 'warn']] },
      { heading: 'État général', info: d.health.notes.map((x, i) => [i ? '' : 'Constats', x]) },
      { heading: 'Manques documentaires', columns: [{ label: 'Manque', w: 3 }, { label: 'Photos', w: 1, align: 'right' }, { label: 'Part', w: 1, align: 'right' }],
        rows: [['Sans mot-clé', 'noKeyword'], ['Sans légende', 'noCaption'], ['Sans titre', 'noTitle'], ['Sans date de prise de vue', 'noDate'], ['Sans coordonnées GPS', 'noGps'], ['Sans note', 'noRating']].map(([l, k]) => [l, nf(G[k]), pc(G.pct[k])]) },
      { heading: 'Volumes', columns: [{ label: 'Catégorie', w: 2.4 }, { label: 'Emplacement', w: 3 }, { label: 'Fichiers', w: 0.8, align: 'right' }, { label: 'Volume', w: 0.9, align: 'right' }],
        rows: Object.values(d.volumes).map(x => [x.label, x.path ?? '(supports indexés)', nf(x.files), by(x.bytes)]) },
      { heading: 'Doublons', info: [['Photos présentes en plusieurs fichiers', nf(d.duplicates.photosWithCopies)], ['Fichiers en surplus', nf(d.duplicates.extraFiles)], ['Variantes rattachées à une référence', nf(d.duplicates.variants)]] },
      { newPage: true, ...tab('Répartition par année', 'Année', d.dist.year) },
      tab('Répartition par mois de l’année', 'Mois', d.dist.monthOfYear.map(r => ({ k: MOIS[r.k] ?? r.k, n: r.n }))),
      tab('Répartition par format', 'Format', d.dist.format),
      { newPage: true, ...tab('Répartition par appareil', 'Appareil', d.dist.camera, 30) },
      tab('Répartition par objectif', 'Objectif', d.dist.lens, 30),
      { heading: 'Supports', columns: [{ label: 'Support', w: 2.4 }, { label: 'Rôle', w: 1 }, { label: 'État', w: 1 }, { label: 'Photos', w: 0.8, align: 'right' }, { label: 'Volume', w: 0.9, align: 'right' }],
        rows: d.supports.map(s => ({ cells: [s.name, SUPPORT_ROLES[s.role] ?? s.role, s.status === 'absent' ? 'non connecté' : s.status === 'available' ? 'connecté' : s.status, nf(s.photos), by(s.bytes)], tone: s.status === 'absent' ? 'warn' : null })), empty: 'Aucun support.' },
      { heading: 'Sauvegardes récentes', columns: [{ label: 'Date', w: 1.3 }, { label: 'Archive', w: 3 }, { label: 'Volume', w: 0.8, align: 'right' }, { label: 'Test', w: 1.2 }],
        rows: (d.backups?.recent ?? []).map(b => ({ cells: [new Date(b.at).toLocaleString('fr-FR'), b.name, by(b.size), b.test ? (b.test.ok ? 'réussi' : 'ÉCHEC') : 'jamais'], tone: b.test?.ok === false ? 'bad' : null })), empty: 'Aucune sauvegarde.' },
      { heading: 'Échecs de sauvegarde (30 derniers jours)', columns: [{ label: 'Date', w: 1.3 }, { label: 'Détail', w: 5 }],
        rows: (d.backups?.failures ?? []).map(e => ({ cells: [new Date(e.at).toLocaleString('fr-FR'), e.message], tone: 'bad' })), empty: 'Aucun échec.' },
      { heading: 'Historique des importations', columns: [{ label: 'Date', w: 1.3 }, { label: 'Source', w: 3 }, { label: 'Mode', w: 0.7 }, { label: 'Traités', w: 0.7, align: 'right' }, { label: 'Erreurs', w: 0.7, align: 'right' }],
        rows: d.imports.map(i => ({ cells: [i.started_at ? new Date(i.started_at).toLocaleString('fr-FR') : '', i.source ?? '', i.mode === 'copy' ? 'copie' : 'index', nf(i.done), nf(i.errors)], tone: i.errors ? 'warn' : null })), empty: 'Aucune importation.' },
    ],
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.pdf': 'application/pdf' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // application verrouillée : seules l'état du verrou, le déverrouillage et /api/ping répondent
      if (!url.pathname.startsWith('/api/lock') && url.pathname !== '/api/ping' && !lock.allowed(req)) return json(res, 401, { error: 'Application verrouillée', locked: true });
      return await api(req, res, url);
    }
    let file = path.join(PUBLIC, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    // dossier : sa page index.html (guide utilisateur sous /aide/)
    if (inside(PUBLIC, file) && fs.existsSync(file) && fs.statSync(file).isDirectory() && fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
    if (!inside(PUBLIC, file)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); json(res, 500, { error: String(e.message || e) }); }
});

// Le serveur n'écoute que cet ordinateur (aucun accès réseau non contrôlé).
const HOST = '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`${APP.name} → http://localhost:${PORT}  (${library.stats().photos} photo(s) dans le catalogue)`));
