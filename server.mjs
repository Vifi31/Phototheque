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
import { createAlbums, FORMATS, LAYOUTS, ALBUM_FORMAT_VERSION, DPI_WARN } from './lib/albums.mjs';
import { createAlbumPdf, PDF_PROFILES, BLEED_MM } from './lib/albumpdf.mjs';
import { createEdits, EDIT_FIELDS, PRESETS, DEFAULT_PARAMS, EDIT_PARAMS_VERSION } from './lib/edits.mjs';
import { createExports, EXPORT_FORMATS, METADATA_MODES, WATERMARK_POSITIONS } from './lib/exports.mjs';
import { createDuplicates, LEVELS as DUP_LEVELS, DEFAULT_THRESHOLD, DEFAULT_BURST_SECONDS, MAX_THRESHOLD } from './lib/duplicates.mjs';

const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

const { db, store } = initStore();
const supports = createSupports(db);
const keywords = createKeywords(db);
const library = createLibrary(db, store, supports, keywords);
const imports = createImports(db, store, library, keywords);
const collections = createCollections(db, library);
const edits = createEdits(db, library);
const albums = createAlbums(db, library, edits); // edits : recréer les retouches d'un projet réimporté
const albumPdf = createAlbumPdf(db, library, albums);
const exportsSvc = createExports(db, edits);
const duplicates = createDuplicates(db, library);

const reloadStore = () => { /* la base est la référence ; le miroir JSON est déjà réécrit par saveStore */ };
const getStats = () => { const s = library.stats(); return { photos: s.photos, supports: s.supports?.total ?? 0, keywords: s.keywords, albums: s.albums }; };
const extra = setupExtra({ root: ROOT, getStore: () => store, saveStore: () => saveStore(db, store), reloadStore, getStats, getDb: () => db, reimport: async () => {} });
const admin = setupAdmin({ root: ROOT, getStore: () => store, saveStore: () => saveStore(db, store) });
const dbAdmin = setupDbAdmin({ getDb: () => db, getError: () => null, getStore: () => store, mirrorFile: STORE_FILE, dbFile: DB_FILE });

function currentVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; } }
const buildState = () => ({
  app: { name: APP.name, slug: APP.slug, icon: APP.icon, tagline: APP.tagline },
  license: licenseBrief(store), menu: store.menu ?? null, version: currentVersion(), installed: INSTALLED,
  scan: store.scan, import: store.import, stats: getStats(),
  supportKinds: SUPPORT_KINDS, supportRoles: SUPPORT_ROLES,
});

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

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
    const sp = url.searchParams;
    const f = {};
    // chaînes
    for (const k of ['q', 'camera', 'lens', 'format', 'from', 'to', 'year', 'keywordId', 'supportId', 'folderId', 'albumId', 'collectionId', 'author', 'orientation', 'integrity', 'variantsOf']) if (sp.get(k)) f[k] = sp.get(k);
    // nombres / booléens « marqués » (la présence du paramètre compte, même vide)
    for (const k of ['rating', 'color', 'missing', 'hasGps', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight']) if (sp.get(k) != null && sp.get(k) !== '') f[k] = sp.get(k);
    // drapeaux présents/absents : la valeur « true » (ou sans valeur) active le critère
    for (const k of ['noKeyword', 'hasKeyword', 'hasCaption', 'noCaption', 'duplicate', 'hideVariants', 'variants']) if (sp.get(k) != null && sp.get(k) !== 'false' && sp.get(k) !== '0') f[k] = true;
    f.prefix = sp.get('prefix') !== 'false';
    // listes séparées par des virgules (ET / OU / NON)
    const list = k => { const v = sp.get(k); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : null; };
    if (list('keywords')) f.keywords = list('keywords');
    if (list('anyKeywords')) f.anyKeywords = list('anyKeywords');
    if (list('excludeKeywords')) f.excludeKeywords = list('excludeKeywords');
    if (list('anyText')) f.anyText = list('anyText');
    if (list('excludeText')) f.excludeText = list('excludeText');
    if (f.collectionId && !collections.get(f.collectionId)) return json(res, 404, { error: 'Collection inconnue' });
    const r = library.search(collections.resolveFilters(f), { limit: sp.get('limit'), offset: sp.get('offset'), sort: sp.get('sort') });
    return json(res, 200, r);
  }
  if (p === '/api/photos' && m === 'PUT') { const b = await readBody(req); const d = library.update(b.id, sanitize(b) ?? {}); if (b.keywords) { db.prepare('DELETE FROM photo_keywords WHERE photo_id=?').run(b.id); keywords.attachNames(b.id, b.keywords); library.syncKeywordsText(b.id); } return json(res, 200, { photo: d }); }
  if (p === '/api/photos/remove' && m === 'POST') { const b = await readBody(req); return json(res, 200, library.removeFromIndex(b.ids)); } // retire de l'index, jamais des originaux
  if (p.startsWith('/api/photos/')) {
    const sub = p.split('/')[4];
    // ---- Retouche non destructive : versions, rendu ----
    if (sub === 'edits' && m === 'GET') return json(res, 200, { versions: edits.list(id), capability: edits.capability(id), fields: EDIT_FIELDS, presets: PRESETS, defaults: DEFAULT_PARAMS, paramsVersion: EDIT_PARAMS_VERSION });
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

  // ---- Exports de photos (travail en arrière-plan, suivi par /api/jobs/<id>) ----
  if (p === '/api/exports/profiles' && m === 'GET') return json(res, 200, { ...exportsSvc.profiles(), formats: EXPORT_FORMATS, metadata: METADATA_MODES, positions: WATERMARK_POSITIONS, dir: EXPORT_DIR });
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
  if (p === '/api/facets' && m === 'GET') return json(res, 200, { years: library.years(), cameras: library.cameras(), formats: library.formats() });
  if (p === '/api/stats' && m === 'GET') return json(res, 200, library.stats());

  // ---- Mots-clés ----
  if (p === '/api/keywords' && m === 'GET') return json(res, 200, { list: keywords.list(), tree: keywords.tree(), suggest: keywords.suggest(url.searchParams.get('q') || '') });
  if (p === '/api/keywords' && m === 'POST') { const b = await readBody(req); return json(res, 200, { keyword: keywords.ensure(b.name, b.parentId || null) }); }
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
  if (p === '/api/albums' && m === 'GET') return json(res, 200, { list: albums.list(), formats: FORMATS, layouts: LAYOUTS, formatVersion: ALBUM_FORMAT_VERSION, dpiAdvised: DPI_WARN, pdfProfiles: PDF_PROFILES, bleedMm: BLEED_MM });
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

  // ---- Importation physique (copie) ----
  if (p === '/api/import' && m === 'POST') {
    const b = await readBody(req);
    const r = await imports.importFiles(b.sources, { dryRun: !!b.dryRun, force: !!b.force });
    return json(res, 200, r);
  }
  if (p === '/api/import/index' && m === 'POST') { const b = await readBody(req); const r = await imports.importIndexOnly(String(b.path || '').trim(), { supportId: b.supportId }); return json(res, 200, r); }
  if (p === '/api/imports' && m === 'GET') return json(res, 200, { list: imports.list() });

  json(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = path.join(PUBLIC, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!inside(PUBLIC, file)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); json(res, 500, { error: String(e.message || e) }); }
});

// Le serveur n'écoute que cet ordinateur (aucun accès réseau non contrôlé).
const HOST = '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`${APP.name} → http://localhost:${PORT}  (${library.stats().photos} photo(s) dans le catalogue)`));
