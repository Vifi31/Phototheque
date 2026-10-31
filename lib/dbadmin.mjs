// Administration › Base de données : état, contenu des tables (lecture seule), contrôle, compactage, téléchargement.
//   GET  /api/db/status                        moteur, fichier, taille, dates, origine, tables (lignes, colonnes)
//   GET  /api/db/table?name=&limit=&offset=    lignes d'une table, par pages (lecture seule)
//   POST /api/db/check                         contrôle d'intégrité (PRAGMA integrity_check)
//   POST /api/db/vacuum                        compactage du fichier (VACUUM)
//   GET  /api/db/file                          copie cohérente du fichier SQLite (VACUUM INTO) à télécharger
//   GET  /api/db/export                        catalogue en JSON (photos + supports + mots-clés)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbStatus, tableRows, integrity, vacuum, snapshot, isTable } from './db.mjs';
import { APP } from './appinfo.mjs';

const slug = APP.slug;

export function setupDbAdmin({ getDb, getError, getStore, mirrorFile, dbFile }) {
  return async function handle(req, res, url, { json }) {
    const p = url.pathname, m = req.method;
    if (!p.startsWith('/api/db/')) return false;
    const err = (msg, code = 400) => { json(res, code, { error: msg }); return true; };
    const day = () => new Date().toISOString().slice(0, 10);
    try {
      if (p === '/api/db/export' && m === 'GET') {
        // Export du catalogue (données utiles) en JSON — indépendant de la base si indisponible.
        const db = getDb();
        const out = { schema: slug + '-export/1', exportedAt: new Date().toISOString(), settings: getStore(), catalog: {} };
        if (db) for (const t of ['supports', 'folders', 'photos', 'files', 'keywords', 'albums', 'collections']) out.catalog[t] = db.prepare(`SELECT * FROM ${t}`).all();
        const body = JSON.stringify(out, null, 1);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Content-Disposition': `attachment; filename="${slug}-catalogue-${day()}.json"` });
        res.end(body); return true;
      }
      const db = getDb();
      if (!db) return err(getError() || 'Base de données indisponible', 503);
      if (p === '/api/db/status' && m === 'GET') {
        const mf = fs.existsSync(mirrorFile) ? fs.statSync(mirrorFile) : null;
        return json(res, 200, { ...dbStatus(db), mirror: mf ? { file: mirrorFile, size: mf.size, at: mf.mtime.toISOString() } : null }), true;
      }
      if (p === '/api/db/table' && m === 'GET') {
        const name = url.searchParams.get('name') || '';
        if (!isTable(name)) return err('Table inconnue', 404);
        return json(res, 200, tableRows(db, name, Number(url.searchParams.get('limit')) || 100, Number(url.searchParams.get('offset')) || 0)), true;
      }
      if (p === '/api/db/check' && m === 'POST') { const r = integrity(db); return json(res, 200, { ok: r.length === 1 && r[0] === 'ok', result: r, at: new Date().toISOString() }), true; }
      if (p === '/api/db/vacuum' && m === 'POST') return json(res, 200, vacuum(db)), true;
      if (p === '/api/db/file' && m === 'GET') {
        const tmp = path.join(os.tmpdir(), `${slug}-${Date.now()}-${process.pid}.db`); snapshot(db, tmp);
        res.writeHead(200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': fs.statSync(tmp).size, 'Content-Disposition': `attachment; filename="${slug}-${day()}.db"` });
        fs.createReadStream(tmp).on('close', () => fs.rm(tmp, { force: true }, () => {})).pipe(res); return true;
      }
      void dbFile;
      return err('Route inconnue', 404);
    } catch (e) { return err(String(e.message || e), 500); }
  };
}
