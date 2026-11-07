// Restauration sélective depuis une sauvegarde : albums, collections, documents, sans toucher au reste
// du catalogue. La base de l'archive est ouverte en lecture seule dans un dossier temporaire
// (lib/backup.mjs, withArchiveDb) ; chaque élément est recréé comme NOUVEL élément (« … (restauré) »),
// jamais par écrasement, après une sauvegarde de sécurité. Les photos sont retrouvées par identifiant,
// sinon par empreinte SHA-256, sinon par chemin (même règle que le réimport d'un projet d'album).
import { logHistory } from './db.mjs';

const P = s => { try { return JSON.parse(s); } catch { return null; } };

export function createSelectiveRestore(db, { backups, albums, collections }) {
  async function restoreSelection(name, { albums: albumIds = [], collections: collIds = [], documents = [], password = null } = {}) {
    const A = [].concat(albumIds ?? []).map(String).slice(0, 500), C = [].concat(collIds ?? []).map(String).slice(0, 500), D = [].concat(documents ?? []).map(String).slice(0, 5000);
    if (!A.length && !C.length && !D.length) throw new Error('Rien n’est sélectionné');
    const report = { albums: [], collections: [], documents: 0, safety: null };
    report.safety = backups.create('data', { label: 'Avant restauration sélective', allowPlain: true, copy: false }).name;
    if (A.length || C.length) await backups.withArchiveDb(name, password, async file => {
      const { DatabaseSync } = await import('node:sqlite');
      const d = new DatabaseSync(file, { readOnly: true });
      try {
        for (const id of A) {
          const a = d.prepare('SELECT * FROM albums WHERE id = ?').get(id); if (!a) continue;
          const data = P(a.data) ?? {};
          const pages = d.prepare('SELECT * FROM album_pages WHERE album_id = ? ORDER BY page').all(id).map(p => ({ layout: p.layout, background: p.background, ...(P(p.data) ?? {}) }));
          const photos = {};
          for (const pid of new Set(pages.flatMap(p => (Array.isArray(p.slots) ? p.slots : [])).filter(Boolean))) {
            const r = d.prepare('SELECT sha256, title FROM photos WHERE id = ?').get(pid);
            const f = d.prepare("SELECT path FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END LIMIT 1").get(pid);
            photos[pid] = { sha256: r?.sha256 ?? null, title: r?.title ?? null, path: f?.path ?? null };
          }
          const project = { format: 'phototheque-album', formatVersion: 1, album: { id: a.id, name: a.name, description: a.description, format: a.format, width_mm: data.width_mm, height_mm: data.height_mm, spreads: !!data.spreads }, pages, photos };
          const r = albums.importProject(project, { name: `${a.name} (restauré)`.slice(0, 120), withEdits: false });
          report.albums.push({ id: r.album.id, name: r.name, found: r.photos.found, total: r.photos.total });
        }
        const byId = db.prepare('SELECT id FROM photos WHERE id = ?'), bySha = db.prepare('SELECT id FROM photos WHERE sha256 = ? ORDER BY id LIMIT 1');
        for (const id of C) {
          const c = d.prepare('SELECT * FROM collections WHERE id = ?').get(id); if (!c) continue;
          const nm = `${c.name} (restaurée)`.slice(0, 120);
          if (c.kind === 'dynamic') {
            const r = collections.create({ name: nm, kind: 'dynamic', query: P(c.query) ?? {} });
            report.collections.push({ id: r.id, name: r.name, kind: 'dynamic', photos: null, missing: 0 });
          } else {
            const rows = d.prepare('SELECT cp.photo_id, p.sha256 FROM collection_photos cp LEFT JOIN photos p ON p.id = cp.photo_id WHERE cp.collection_id = ? ORDER BY cp.position').all(id);
            const ids = []; let missing = 0;
            for (const row of rows) { const hit = byId.get(row.photo_id) ?? (row.sha256 ? bySha.get(row.sha256) : null); if (hit) ids.push(hit.id); else missing++; }
            const r = collections.create({ name: nm, kind: 'static', photoIds: ids });
            report.collections.push({ id: r.id, name: r.name, kind: 'static', photos: ids.length, missing });
          }
        }
      } finally { d.close(); }
    });
    if (D.length) report.documents = backups.restoreDocuments(name, D, password, { safety: false }).restored;
    const msg = `Restauration sélective depuis ${name} : ${report.albums.length} album(s), ${report.collections.length} collection(s), ${report.documents} document(s)`;
    backups.logEvent('restauration', true, msg);
    logHistory(db, 'backup.selective', msg, { name, safety: report.safety });
    return report;
  }
  return { restoreSelection };
}
