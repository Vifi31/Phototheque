// Tableau de bord (cahier des charges §20) : chiffres clés, répartitions, manques documentaires, doublons,
// volumes par catégorie (originaux, copies, aperçus, exports, sauvegardes…), sauvegardes, état du catalogue,
// historique des importations. Les calculs sont regroupés en quelques requêtes et mis en cache : un tableau
// de bord n'est recalculé que si le catalogue a changé (signature), ou au plus tard après CACHE_MS ; la
// taille des dossiers (parcours du disque) a son propre cache, plus long. La navigation n'attend jamais
// ces calculs : ils ne sont faits qu'à l'ouverture de la vue Statistiques.
// Filtres : année, support, format (mêmes clés que lib/search.mjs) ; les dossiers ne sont pas filtrés.
import fs from 'fs';
import path from 'path';
import { BACKED_UP, VARIANT_OF } from './search.mjs';
import { THUMBS_DIR, EXPORT_DIR, BACKUP_DIR, VERSIONS_DIR, XMP_DIR, IMPORT_DIR, DOCS_DIR, REPORTS_DIR, DATA_DIR, HOME } from './paths.mjs';

export const CACHE_MS = 5 * 60000;
const DIR_CACHE_MS = 15 * 60000;
const P = s => { try { return JSON.parse(s); } catch { return null; } };

/** Taille et nombre de fichiers d'un dossier (récursif, liens symboliques ignorés). */
export function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = d => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { try { bytes += fs.statSync(f).size; files++; } catch { /* fichier disparu */ } }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes, files };
}

/** Filtres admis : année (AAAA), support, format. */
export function cleanDashFilters(f = {}) {
  const o = {};
  if (/^\d{4}$/.test(String(f.year ?? ''))) o.year = String(f.year);
  if (typeof f.supportId === 'string' && f.supportId.length <= 100 && f.supportId) o.supportId = f.supportId;
  if (typeof f.format === 'string' && /^[\w.+-]{1,20}$/.test(f.format)) o.format = f.format;
  return o;
}

export function createDashboard(db, { backups = null, importDir = () => null, extraDirs = {} } = {}) {
  let cache = null, dirCache = null;

  /** Signature bon marché du catalogue : un tableau de bord en cache reste valable tant qu'elle ne change pas. */
  const signature = () => JSON.stringify(db.prepare(`SELECT (SELECT COUNT(*) FROM photos) a, (SELECT COUNT(*) FROM files) b,
    (SELECT MAX(id) FROM history) c, (SELECT COUNT(*) FROM photo_keywords) d, (SELECT COALESCE(SUM(missing), 0) FROM photos) e`).get());

  function where(f) {
    const w = [], a = [];
    if (f.year) { w.push('substr(p.captured_at, 1, 4) = ?'); a.push(f.year); }
    if (f.supportId) { w.push('p.id IN (SELECT photo_id FROM files WHERE support_id = ?)'); a.push(f.supportId); }
    if (f.format) { w.push('p.format = ?'); a.push(f.format); }
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', and: w.length ? ' AND ' + w.join(' AND ') : '', args: a };
  }

  function folders() {
    if (dirCache && Date.now() - dirCache.at < DIR_CACHE_MS) return dirCache.data;
    const dest = importDir();
    const dirs = {
      previews: { label: 'Vignettes et aperçus (cache régénérable)', dir: THUMBS_DIR },
      exports: { label: 'Exports', dir: EXPORT_DIR },
      backups: { label: 'Sauvegardes (dossier de l’application)', dir: BACKUP_DIR },
      versions: { label: 'Instantanés de version', dir: VERSIONS_DIR },
      xmp: { label: 'XMP annexes écrits', dir: XMP_DIR },
      documents: { label: 'Documents et rapports', dir: DOCS_DIR, also: [REPORTS_DIR] },
      catalog: { label: 'Catalogue (base de données)', dir: null, files: ['phototheque.db', 'phototheque.db-wal', 'store.json'].map(n => path.join(DATA_DIR, n)) },
      ...extraDirs,
    };
    const data = {};
    for (const [k, d] of Object.entries(dirs)) {
      let s = d.dir ? dirSize(d.dir) : { bytes: 0, files: 0 };
      for (const x of d.also ?? []) { const t = dirSize(x); s = { bytes: s.bytes + t.bytes, files: s.files + t.files }; }
      for (const f of d.files ?? []) { try { s.bytes += fs.statSync(f).size; s.files++; } catch { /* absent */ } }
      data[k] = { label: d.label, path: d.dir ?? DATA_DIR, ...s };
    }
    // copies faites par l'importation : dossier de destination géré par l'application
    const imp = dest || IMPORT_DIR;
    data.managed = { label: 'Photos copiées par l’importation (emplacement géré)', path: imp, ...dirSize(imp) };
    dirCache = { at: Date.now(), data };
    return data;
  }

  /** Calcule le tableau de bord (ou le reprend du cache). `refresh` force le recalcul, dossiers compris. */
  function compute(filters = {}, { refresh = false } = {}) {
    const f = cleanDashFilters(filters), key = JSON.stringify(f), sig = signature();
    if (refresh) dirCache = null;
    if (!refresh && cache && cache.key === key && cache.sig === sig && Date.now() - cache.at < CACHE_MS) return { ...cache.data, cached: true };
    const t0 = Date.now();
    const W = where(f), one = (sql, ...a) => db.prepare(sql).get(...W.args, ...a), all = (sql, ...a) => db.prepare(sql).all(...W.args, ...a);
    const pf = `FROM photos p ${W.sql}`;
    const ph = one(`SELECT COUNT(*) photos,
        SUM(p.id NOT IN (SELECT photo_id FROM photo_keywords)) noKeyword,
        SUM(p.description IS NULL OR TRIM(p.description) = '') noCaption,
        SUM(p.title IS NULL OR TRIM(p.title) = '') noTitle,
        SUM(p.captured_at IS NULL) noDate,
        SUM(p.gps_lat IS NULL) noGps,
        SUM(COALESCE(p.rating, 0) = 0) noRating,
        SUM(p.missing = 1) missing,
        SUM(${BACKED_UP}) covered,
        SUM(${VARIANT_OF} IS NOT NULL) variants
      ${pf}`);
    // fichiers des photos retenues
    const fileWhere = W.sql ? `WHERE f.photo_id IN (SELECT p.id ${pf})` : '';
    const fl = one(`SELECT COUNT(*) files, COALESCE(SUM(f.size_bytes), 0) bytes,
        COALESCE(SUM(CASE WHEN f.kind = 'original' THEN f.size_bytes END), 0) originals,
        SUM(f.kind = 'original') originalFiles,
        COALESCE(SUM(CASE WHEN f.kind <> 'original' THEN f.size_bytes END), 0) copies,
        SUM(f.kind <> 'original') copyFiles,
        SUM(f.status <> 'available') unavailable
      FROM files f ${fileWhere}`);
    const dup = one(`SELECT SUM(n > 1) photosWithCopies, COALESCE(SUM(CASE WHEN n > 1 THEN n - 1 END), 0) extraFiles FROM (SELECT p.id, (SELECT COUNT(*) FROM files WHERE photo_id = p.id) n ${pf})`);
    const sups = db.prepare(`SELECT s.id, s.name, s.kind, s.role, s.status, COUNT(f.id) files, COALESCE(SUM(f.size_bytes), 0) bytes, COUNT(DISTINCT f.photo_id) photos
      FROM supports s LEFT JOIN files f ON f.support_id = s.id ${W.sql ? `AND f.photo_id IN (SELECT p.id ${pf})` : ''} GROUP BY s.id ORDER BY s.name COLLATE NOCASE`).all(...W.args);

    const dist = {
      year: all(`SELECT COALESCE(substr(p.captured_at, 1, 4), '') k, COUNT(*) n ${pf} GROUP BY k ORDER BY k`),
      month: all(`SELECT substr(p.captured_at, 1, 7) k, COUNT(*) n ${pf} ${W.sql ? 'AND' : 'WHERE'} p.captured_at IS NOT NULL GROUP BY k ORDER BY k`),
      monthOfYear: all(`SELECT CAST(substr(p.captured_at, 6, 2) AS INTEGER) k, COUNT(*) n ${pf} ${W.sql ? 'AND' : 'WHERE'} p.captured_at IS NOT NULL GROUP BY k ORDER BY k`),
      format: all(`SELECT COALESCE(p.format, '') k, COUNT(*) n ${pf} GROUP BY k ORDER BY n DESC`),
      camera: all(`SELECT TRIM(COALESCE(p.camera_model, '')) k, MAX(p.camera_make) make, COUNT(*) n ${pf} GROUP BY k ORDER BY n DESC LIMIT 30`),
      lens: all(`SELECT TRIM(COALESCE(p.lens, '')) k, COUNT(*) n ${pf} GROUP BY k ORDER BY n DESC LIMIT 30`),
      rating: all(`SELECT COALESCE(p.rating, 0) k, COUNT(*) n ${pf} GROUP BY k ORDER BY k`),
    };

    // sauvegardes : récentes, échecs (journal), alertes, couverture
    let bk = null;
    if (backups) {
      const list = backups.list();
      const ev = (backups.settings?.() ?? null);
      const events = ev?.events ?? [];
      const since = Date.now() - 30 * 864e5;
      bk = {
        recent: list.slice(0, 5).map(b => ({ name: b.name, at: b.manifest?.createdAt ?? b.mtime, type: b.manifest?.type ?? null, size: b.size, encrypted: !!b.manifest?.encrypted, test: b.test ?? null, error: b.error ?? null })),
        count: list.length, bytes: list.reduce((s, b) => s + b.size, 0),
        failures: events.filter(e => !e.ok && Date.parse(e.at) >= since).slice(0, 10),
        alerts: (() => { try { return backups.alerts(); } catch { return []; } })(),
        destinations: (() => { try { return backups.destinations().map(d => ({ name: d.name, kind: d.kind, enabled: d.enabled, reachable: d.reachable, last: d.last })); } catch { return []; } })(),
      };
    }

    // état du catalogue : contrôle rapide de la base, cohérence des compteurs
    const quick = (() => { try { return db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]); } catch (e) { return [String(e.message)]; } })();
    const orphanFiles = db.prepare('SELECT COUNT(*) n FROM files WHERE photo_id NOT IN (SELECT id FROM photos)').get().n;
    const noFile = db.prepare('SELECT COUNT(*) n FROM photos WHERE id NOT IN (SELECT photo_id FROM files)').get().n;
    const health = {
      db: quick.length === 1 && quick[0] === 'ok', dbMessage: quick.slice(0, 3).join(' ; '), orphanFiles, photosWithoutFile: noFile,
      level: 'ok', notes: [],
    };
    const n = ph.photos || 0, pct = x => (n ? Math.round((x || 0) * 1000 / n) / 10 : 0);
    if (!health.db) { health.level = 'bad'; health.notes.push('La base signale une anomalie : lancez le rapport d’intégrité.'); }
    if (orphanFiles || noFile) { health.level = health.level === 'bad' ? 'bad' : 'warn'; health.notes.push(`${orphanFiles} fichier(s) sans photo, ${noFile} photo(s) sans fichier.`); }
    if (fl.unavailable) { health.level = health.level === 'bad' ? 'bad' : 'warn'; health.notes.push(`${fl.unavailable} fichier(s) indisponible(s) (support absent ou fichier déplacé).`); }
    if (bk && bk.alerts.some(a => a.level === 'bad')) { health.level = 'bad'; health.notes.push('Sauvegardes : au moins une alerte grave.'); }
    if (n && (ph.covered || 0) < n) { health.level = health.level === 'bad' ? 'bad' : 'warn'; health.notes.push(`${n - (ph.covered || 0)} photo(s) sans copie sur un support de sauvegarde.`); }
    if (!health.notes.length) health.notes.push('Aucune anomalie relevée.');

    const imports = db.prepare('SELECT id, source, dest, mode, total, done, skipped, errors, status, started_at, finished_at FROM imports ORDER BY started_at DESC LIMIT 20').all();
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM keywords) keywords, (SELECT COUNT(*) FROM albums) albums, (SELECT COUNT(*) FROM collections) collections,
      (SELECT COUNT(*) FROM edits) edits, (SELECT COUNT(*) FROM supports) supports, (SELECT COUNT(*) FROM supports WHERE status = 'absent') supportsAbsent`).get();

    const data = {
      filters: f, computedAt: new Date().toISOString(), ms: 0,
      totals: { photos: n, files: fl.files ?? 0, bytes: fl.bytes ?? 0, unavailable: fl.unavailable ?? 0, missingPhotos: ph.missing ?? 0, ...counts },
      gaps: { noKeyword: ph.noKeyword ?? 0, noCaption: ph.noCaption ?? 0, noTitle: ph.noTitle ?? 0, noDate: ph.noDate ?? 0, noGps: ph.noGps ?? 0, noRating: ph.noRating ?? 0,
        pct: { noKeyword: pct(ph.noKeyword), noCaption: pct(ph.noCaption), noTitle: pct(ph.noTitle), noDate: pct(ph.noDate), noGps: pct(ph.noGps), noRating: pct(ph.noRating) } },
      duplicates: { photosWithCopies: dup.photosWithCopies ?? 0, extraFiles: dup.extraFiles ?? 0, variants: ph.variants ?? 0 },
      coverage: { photos: n, covered: ph.covered ?? 0 },
      volumes: {
        originals: { label: 'Originaux référencés', bytes: fl.originals ?? 0, files: fl.originalFiles ?? 0 },
        copies: { label: 'Copies identiques référencées (autres supports)', bytes: fl.copies ?? 0, files: fl.copyFiles ?? 0 },
        ...folders(),
      },
      supports: sups, dist, backups: bk, health, imports,
    };
    data.ms = Date.now() - t0;
    cache = { key, sig, at: Date.now(), data };
    return data;
  }

  /** CSV : une section par tableau (séparateur « ; », UTF-8 avec BOM, CRLF). */
  function csv(d) {
    const cell = v => { const s = String(v ?? ''); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const L = [];
    const sec = (title, head, rows) => { L.push(cell(title)); L.push(head.map(cell).join(';')); for (const r of rows) L.push(r.map(cell).join(';')); L.push(''); };
    sec('Chiffres clés', ['indicateur', 'valeur'], [['photos', d.totals.photos], ['fichiers', d.totals.files], ['volume référencé (octets)', d.totals.bytes], ['fichiers indisponibles', d.totals.unavailable],
      ['supports', d.totals.supports], ['supports absents', d.totals.supportsAbsent], ['mots-clés', d.totals.keywords], ['albums', d.totals.albums], ['collections', d.totals.collections]]);
    sec('Manques', ['manque', 'photos', 'pourcentage'], Object.entries({ noKeyword: 'sans mot-clé', noCaption: 'sans légende', noTitle: 'sans titre', noDate: 'sans date', noGps: 'sans GPS', noRating: 'sans note' }).map(([k, l]) => [l, d.gaps[k], String(d.gaps.pct[k]).replace('.', ',')]));
    sec('Volumes', ['catégorie', 'emplacement', 'fichiers', 'octets'], Object.values(d.volumes).map(v => [v.label, v.path ?? '', v.files, v.bytes]));
    for (const [k, t] of Object.entries({ year: 'Par année', month: 'Par mois', format: 'Par format', camera: 'Par appareil', lens: 'Par objectif', rating: 'Par note' })) sec(t, ['valeur', 'photos'], d.dist[k].map(r => [r.k === '' ? '(inconnu)' : r.k, r.n]));
    sec('Supports', ['support', 'rôle', 'état', 'photos', 'fichiers', 'octets'], d.supports.map(s => [s.name, s.role, s.status, s.photos, s.files, s.bytes]));
    sec('Importations', ['début', 'source', 'mode', 'total', 'traités', 'ignorés', 'erreurs', 'état'], d.imports.map(i => [i.started_at, i.source, i.mode, i.total, i.done, i.skipped, i.errors, i.status]));
    return '﻿' + L.join('\r\n');
  }

  return { compute, csv, invalidate: () => { cache = null; dirCache = null; } };
}
