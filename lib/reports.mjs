// Inventaires et rapports (cahier des charges §14) : inventaire par support, fichiers manquants,
// intégrité des fichiers et de la base, état des sauvegardes. Chaque rapport est d'abord calculé en un
// modèle commun (indicateurs, sections, lignes CSV), puis rendu en PDF (lib/reportdoc.mjs) ou en CSV.
// Lecture seule : aucun statut n'est réécrit en base, aucun fichier n'est touché (le contrôle relit les
// originaux pour en recalculer l'empreinte, sans les ouvrir en écriture).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logHistory, integrity as dbIntegrity } from './db.mjs';
import { SUPPORT_KINDS, SUPPORT_ROLES } from './supports.mjs';
import { csvCell, fmtDate } from './catalog.mjs';
import { renderTableDoc } from './reportdoc.mjs';
import { BACKED_UP } from './search.mjs';

export const REPORTS = {
  inventory: { label: 'Inventaire par support', desc: 'Identité de chaque support (type, rôle, marque, n° de série, capacité, emplacement), puis ses dossiers : nombre de fichiers, volume, fichiers indisponibles.' },
  missing: { label: 'Fichiers manquants', desc: 'Fichiers introuvables au moment du rapport, regroupés par support, avec la raison et l’existence d’une autre copie disponible de la même photo.' },
  integrity: { label: 'Rapport d’intégrité', desc: 'Contrôle de la base (SQLite) et des fichiers : présence, taille et, en contrôle complet, empreinte SHA-256 recalculée. Photos sans fichier ou sans seconde copie.' },
  backups: { label: 'Rapport de sauvegardes', desc: 'Sauvegardes présentes, leur date, leur contenu et la vérification de chaque archive ; tests de restauration, copies vers les destinations, journal des erreurs, programmation.' },
  coverage: { label: 'Originaux non couverts', desc: 'Photos dont aucun fichier ne se trouve sur un support de rôle « Sauvegarde » ou « Archive » : les sauvegardes du catalogue ne contiennent pas les originaux. Synthèse par support, puis liste des photos à copier.' },
};
export const SUPPORT_STATUS = { available: 'connecté', absent: 'non connecté', unknown: 'inconnu' };
const FILE_KIND = { original: 'original', copy: 'copie', variant: 'variante', derived: 'dérivé' };

const P = s => { try { return JSON.parse(s); } catch { return null; } };
export const fmtBytes = n => {
  if (!Number.isFinite(+n) || +n <= 0) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let v = +n, i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${String(+v.toFixed(i ? 1 : 0)).replace('.', ',')} ${u[i]}`;
};
const DEST_KIND_LABEL = { local: 'Autre disque interne', external: 'Disque externe', nas: 'NAS / partage réseau', offsite: 'Support conservé dans un autre lieu', other: 'Autre emplacement' };
const nf = n => Number(n ?? 0).toLocaleString('fr-FR').replace(/ | /g, ' ');
const stampNow = () => fmtDate(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString());
const sha256 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const dirOf = p => String(p ?? '').replace(/[\\/][^\\/]*$/, '');
const relTo = (p, root) => {
  if (!root) return p;
  // « C:/x » et « C:\x » désignent le même dossier sous Windows : comparaison sans tenir compte des séparateurs
  const norm = s => String(s).replace(/[\\/]+/g, '/').toLowerCase();
  const r = root.replace(/[\\/]+$/, '');
  return norm(p).startsWith(norm(r) + '/') || norm(p) === norm(r) ? (p.slice(r.length).replace(/^[\\/]+/, '') || '(racine du support)') : p;
};

/**
 * `backups` : service de lib/backup.mjs (list, verify, DIR) ; `backupSettings()` : programmation des
 * sauvegardes automatiques (store.backup). Les deux sont facultatifs (rapport de sauvegardes vide).
 */
export function createReports(db, { backups = null, backupSettings = () => ({}) } = {}) {
  const supportsAll = () => db.prepare('SELECT * FROM supports ORDER BY name COLLATE NOCASE').all();
  const filesAll = db.prepare(`SELECT f.*, p.captured_at, p.title, p.sha256 AS photo_sha FROM files f LEFT JOIN photos p ON p.id = f.photo_id ORDER BY f.path`);

  // ---------------------------------------------------------------- inventaire par support
  function inventory({ supportId = '' } = {}) {
    const sups = supportsAll().filter(s => !supportId || s.id === supportId);
    if (supportId && !sups.length) throw new Error('Support inconnu');
    const files = filesAll.all().filter(f => !supportId || f.support_id === supportId);
    const bySup = new Map(sups.map(s => [s.id, []])); const orphan = [];
    for (const f of files) (bySup.get(f.support_id) ?? (supportId ? [] : orphan)).push(f);
    const statOf = list => ({ files: list.length, photos: new Set(list.map(f => f.photo_id)).size, bytes: list.reduce((a, f) => a + (+f.size_bytes || 0), 0), missing: list.filter(f => f.status !== 'available').length });
    const all = statOf(files);
    const sections = [{
      kpis: [['Supports', nf(sups.length)], ['Fichiers', nf(all.files)], ['Volume', fmtBytes(all.bytes)], ['Fichiers indisponibles', nf(all.missing), all.missing ? 'warn' : 'ok']],
      heading: 'Vue d’ensemble',
      columns: [{ label: 'Support', w: 2.2 }, { label: 'Type', w: 1.2 }, { label: 'Rôle', w: 1 }, { label: 'État', w: 1 }, { label: 'Fichiers', w: 0.8, align: 'right' }, { label: 'Volume', w: 0.9, align: 'right' }, { label: 'Emplacement', w: 1.6 }],
      rows: sups.map(s => { const st = statOf(bySup.get(s.id)); return { cells: [s.name, SUPPORT_KINDS[s.kind] ?? s.kind, SUPPORT_ROLES[s.role] ?? s.role, SUPPORT_STATUS[s.status] ?? s.status, nf(st.files), fmtBytes(st.bytes), s.location ?? ''], tone: s.status === 'absent' ? 'warn' : null }; }),
      empty: 'Aucun support enregistré.',
    }];
    const summary = { supports: [] };
    for (const s of sups) {
      const list = bySup.get(s.id), st = statOf(list);
      summary.supports.push({ id: s.id, name: s.name, status: s.status, ...st });
      const folders = new Map();
      for (const f of list) { const d = relTo(dirOf(f.path), s.mount_path); const g = folders.get(d) ?? { files: 0, bytes: 0, missing: 0 }; g.files++; g.bytes += +f.size_bytes || 0; if (f.status !== 'available') g.missing++; folders.set(d, g); }
      sections.push({
        newPage: true, heading: `Support « ${s.name} »`,
        info: [
          ['Type', SUPPORT_KINDS[s.kind] ?? s.kind], ['Rôle', SUPPORT_ROLES[s.role] ?? s.role], ['État', `${SUPPORT_STATUS[s.status] ?? s.status}${s.checked_at ? ` (vérifié le ${fmtDate(s.checked_at)})` : ''}`],
          ['Marque / modèle', [s.brand, s.model].filter(Boolean).join(' ')], ['N° de série', s.serial], ['Nom de volume', s.drive_label],
          ['Système de fichiers', s.filesystem], ['Capacité', s.total_bytes ? `${fmtBytes(s.total_bytes)}${s.free_bytes != null ? ` · ${fmtBytes(s.free_bytes)} libres` : ''}` : ''],
          ['Chemin', s.mount_path], ['Emplacement physique', s.location], ['Commentaires', s.comments], ['Enregistré le', fmtDate(s.added_at)],
        ],
        kpis: [['Fichiers', nf(st.files)], ['Photos', nf(st.photos)], ['Volume', fmtBytes(st.bytes)], ['Indisponibles', nf(st.missing), st.missing ? 'warn' : 'ok']],
        columns: [{ label: 'Dossier', w: 4.2 }, { label: 'Fichiers', w: 0.8, align: 'right' }, { label: 'Volume', w: 0.9, align: 'right' }, { label: 'Indisponibles', w: 1, align: 'right' }],
        rows: [...folders].sort((a, b) => a[0].localeCompare(b[0], 'fr', { numeric: true })).map(([d, g]) => ({ cells: [d, nf(g.files), fmtBytes(g.bytes), g.missing ? nf(g.missing) : ''], tone: g.missing ? 'warn' : null })),
        empty: 'Aucun fichier indexé sur ce support.',
      });
    }
    if (orphan.length) {
      const st = statOf(orphan);
      sections.push({ newPage: true, heading: 'Fichiers sans support', note: 'Fichiers indexés hors de tout support enregistré (support retiré, ou dossier ajouté avant la création du support).',
        kpis: [['Fichiers', nf(st.files)], ['Volume', fmtBytes(st.bytes)]],
        columns: [{ label: 'Dossier', w: 4.2 }, { label: 'Fichiers', w: 0.8, align: 'right' }],
        rows: Object.entries(orphan.reduce((a, f) => ((a[dirOf(f.path)] = (a[dirOf(f.path)] ?? 0) + 1), a), {})).map(([d, n]) => [d, nf(n)]) });
    }
    const supName = new Map(sups.map(s => [s.id, s]));
    return {
      title: supportId ? `Inventaire du support « ${sups[0].name} »` : 'Inventaire par support',
      subtitle: `${nf(sups.length)} support(s), ${nf(all.files)} fichier(s) indexé(s), ${fmtBytes(all.bytes)}. État des supports au dernier contrôle de connexion ; aucun fichier n’est ouvert pour cet inventaire.`,
      sections, summary: { ...summary, files: all.files, bytes: all.bytes, missing: all.missing, orphans: orphan.length },
      csv: {
        columns: ['support', 'etat_support', 'emplacement_support', 'dossier', 'fichier', 'chemin', 'taille_octets', 'statut', 'type', 'date_prise_de_vue', 'indexe_le', 'sha256', 'photo_id'],
        numeric: ['taille_octets'],
        rows: files.map(f => { const s = supName.get(f.support_id); return [s?.name ?? '', s ? SUPPORT_STATUS[s.status] ?? s.status : '', s?.location ?? '', relTo(dirOf(f.path), s?.mount_path), f.file_name ?? path.basename(f.path), f.path, f.size_bytes ?? '', f.status === 'available' ? 'disponible' : f.status === 'missing' ? 'indisponible' : 'en erreur', FILE_KIND[f.kind] ?? f.kind, fmtDate(f.captured_at), fmtDate(f.indexed_at), f.sha256 ?? '', f.photo_id ?? '']; }),
      },
    };
  }

  // ---------------------------------------------------------------- fichiers manquants (constat immédiat)
  /** État de chaque fichier maintenant, sans écrire en base : présent, support non connecté, introuvable, en erreur. */
  function liveState(files, sups) {
    const supById = new Map(sups.map(s => [s.id, s]));
    return files.map(f => {
      const s = supById.get(f.support_id);
      let exists = false; try { exists = fs.existsSync(f.path); } catch { exists = false; }
      const reason = exists ? (f.status === 'error' ? 'Erreur de lecture à l’indexation' : null)
        : s && s.status === 'absent' ? 'Support non connecté' : 'Fichier introuvable';
      return { ...f, support: s ?? null, exists, reason, back: exists && f.status === 'missing' };
    });
  }

  function missing() {
    const sups = supportsAll(), state = liveState(filesAll.all(), sups);
    const okByPhoto = new Map();
    for (const f of state) if (!f.reason) { if (!okByPhoto.has(f.photo_id)) okByPhoto.set(f.photo_id, f.path); }
    const bad = state.filter(f => f.reason), back = state.filter(f => f.back);
    const photos = new Set(bad.map(f => f.photo_id)), lost = [...photos].filter(id => !okByPhoto.has(id));
    const groups = new Map();
    for (const f of bad) { const k = f.support?.id ?? ''; (groups.get(k) ?? groups.set(k, []).get(k)).push(f); }
    const sections = [{
      kpis: [['Fichiers manquants', nf(bad.length), bad.length ? 'warn' : 'ok'], ['Photos concernées', nf(photos.size)],
        ['Photos sans aucune copie disponible', nf(lost.length), lost.length ? 'bad' : 'ok'], ['Supports à reconnecter', nf(new Set(bad.filter(f => f.reason === 'Support non connecté').map(f => f.support_id)).size)]],
      note: bad.length ? 'Une photo dont une autre copie est disponible reste consultable ; celles « sans aucune copie » ne le sont plus tant que leur support n’est pas reconnecté ou le fichier retrouvé.' : 'Tous les fichiers indexés sont présents.',
    }];
    for (const [k, list] of [...groups].sort((a, b) => (a[1][0].support?.name ?? '￿').localeCompare(b[1][0].support?.name ?? '￿', 'fr'))) {
      const s = list[0].support;
      sections.push({
        heading: s ? `Support « ${s.name} » — ${SUPPORT_STATUS[s.status] ?? s.status}` : 'Fichiers sans support',
        note: s ? [s.location ? `Rangement : ${s.location}.` : '', s.mount_path ? `Chemin attendu : ${s.mount_path}.` : '', [s.brand, s.model, s.serial ? `n° ${s.serial}` : ''].filter(Boolean).join(' ')].filter(Boolean).join(' ') : '',
        columns: [{ label: 'Fichier', w: 1.6 }, { label: 'Dossier', w: 2.6 }, { label: 'Taille', w: 0.7, align: 'right' }, { label: 'Constat', w: 1.3 }, { label: 'Autre copie disponible', w: 2.2 }],
        rows: list.map(f => ({ cells: [f.file_name ?? path.basename(f.path), relTo(dirOf(f.path), s?.mount_path), fmtBytes(f.size_bytes), f.reason, okByPhoto.get(f.photo_id) ?? 'aucune'], tone: okByPhoto.has(f.photo_id) ? null : 'bad' })),
        newPage: k !== [...groups.keys()][0] && list.length > 25,
      });
    }
    if (back.length) sections.push({ heading: 'Fichiers retrouvés', note: 'Marqués indisponibles dans le catalogue, mais présents maintenant : rafraîchir les supports ou réindexer leur dossier mettra le catalogue à jour.',
      columns: [{ label: 'Chemin', w: 1 }], rows: back.map(f => [f.path]) });
    return {
      title: 'Rapport des fichiers manquants',
      subtitle: `Constat du ${stampNow()} : existence de chaque fichier vérifiée sur le disque (le catalogue n’est pas modifié). ${nf(state.length)} fichier(s) indexé(s).`,
      sections, summary: { files: state.length, missing: bad.length, photos: photos.size, lost: lost.length, found: back.length },
      csv: {
        columns: ['support', 'etat_support', 'emplacement_support', 'chemin', 'fichier', 'taille_octets', 'constat', 'autre_copie_disponible', 'photo_id', 'date_prise_de_vue'],
        numeric: ['taille_octets'],
        rows: bad.map(f => [f.support?.name ?? '', f.support ? SUPPORT_STATUS[f.support.status] ?? f.support.status : '', f.support?.location ?? '', f.path, f.file_name ?? path.basename(f.path), f.size_bytes ?? '', f.reason, okByPhoto.get(f.photo_id) ?? '', f.photo_id ?? '', fmtDate(f.captured_at)]),
      },
    };
  }

  // ---------------------------------------------------------------- intégrité
  /** `mode` : quick (présence + taille) ou full (empreinte SHA-256 recalculée). `onProgress(i, n)` facultatif. */
  async function integrity({ mode = 'quick', onProgress = null } = {}) {
    const full = mode === 'full';
    const t0 = Date.now();
    const dbCheck = dbIntegrity(db), dbOk = dbCheck.length === 1 && dbCheck[0] === 'ok';
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    const sups = supportsAll(), state = liveState(filesAll.all(), sups);
    const res = { ok: 0, size: [], hash: [], unreadable: [], absent: [], offline: [], nohash: 0, hashed: 0, bytes: 0 };
    let i = 0;
    for (const f of state) {
      onProgress?.(++i, state.length);
      if (!f.exists) { (f.reason === 'Support non connecté' ? res.offline : res.absent).push(f); continue; }
      let st; try { st = fs.statSync(f.path); } catch { res.unreadable.push({ ...f, detail: 'lecture impossible' }); continue; }
      if (f.size_bytes != null && +st.size !== +f.size_bytes) { res.size.push({ ...f, detail: `${fmtBytes(f.size_bytes)} au catalogue, ${fmtBytes(st.size)} sur le disque` }); continue; }
      if (full) {
        const ref = f.sha256 || f.photo_sha;
        if (!ref) { res.nohash++; res.ok++; continue; }
        try { const h = await sha256(f.path); res.hashed++; res.bytes += st.size; if (h !== ref) { res.hash.push({ ...f, detail: `empreinte ${h.slice(0, 12)}… au lieu de ${ref.slice(0, 12)}…` }); continue; } }
        catch (e) { res.unreadable.push({ ...f, detail: String(e.code ?? e.message) }); continue; }
      }
      res.ok++;
    }
    const noFile = db.prepare('SELECT id, title, captured_at FROM photos WHERE id NOT IN (SELECT DISTINCT photo_id FROM files WHERE photo_id IS NOT NULL)').all();
    const single = db.prepare(`SELECT COUNT(*) n FROM (SELECT photo_id FROM files WHERE photo_id IS NOT NULL GROUP BY photo_id HAVING COUNT(*) = 1)`).get().n;
    const oneSupport = db.prepare(`SELECT COUNT(*) n FROM (SELECT photo_id FROM files WHERE photo_id IS NOT NULL GROUP BY photo_id HAVING COUNT(*) > 1 AND COUNT(DISTINCT IFNULL(support_id, '')) = 1)`).get().n;
    const photos = db.prepare('SELECT COUNT(*) n FROM photos').get().n;
    const anomalies = [
      ...res.hash.map(f => ({ f, kind: 'Empreinte différente (fichier modifié ou altéré)', tone: 'bad' })),
      ...res.size.map(f => ({ f, kind: 'Taille différente', tone: 'bad' })),
      ...res.unreadable.map(f => ({ f, kind: 'Illisible', tone: 'bad' })),
      ...res.absent.map(f => ({ f, kind: 'Fichier introuvable', tone: 'warn' })),
      ...res.offline.map(f => ({ f, kind: 'Support non connecté (non vérifié)', tone: 'dim' })),
    ];
    const serious = res.hash.length + res.size.length + res.unreadable.length;
    const sections = [
      { kpis: [['Fichiers conformes', nf(res.ok), 'ok'], ['Altérés, modifiés ou illisibles', nf(serious), serious ? 'bad' : 'ok'], ['Introuvables', nf(res.absent.length), res.absent.length ? 'warn' : 'ok'], ['Non vérifiés (support non connecté)', nf(res.offline.length), res.offline.length ? 'warn' : null]] },
      { heading: 'Base de données', info: [
        ['Contrôle SQLite', dbOk ? 'intègre (PRAGMA integrity_check : ok)' : `ANOMALIES : ${dbCheck.slice(0, 5).join(' ; ')}`],
        ['Références', fk.length ? `${fk.length} référence(s) orpheline(s) (PRAGMA foreign_key_check)` : 'cohérentes (PRAGMA foreign_key_check : aucune anomalie)'],
        ['Photos au catalogue', nf(photos)], ['Fichiers au catalogue', nf(state.length)],
      ] },
      { heading: 'Fichiers', info: [
        ['Méthode', full ? `contrôle complet : présence, taille et empreinte SHA-256 recalculée (${nf(res.hashed)} fichier(s), ${fmtBytes(res.bytes)} relus)` : 'contrôle rapide : présence et taille de chaque fichier (empreintes non recalculées)'],
        ['Sans empreinte de référence', full && res.nohash ? `${nf(res.nohash)} fichier(s) indexés sans empreinte : seules la présence et la taille ont été vérifiées` : ''],
        ['Durée', `${String(((Date.now() - t0) / 1000).toFixed(1)).replace('.', ',')} s`],
      ] },
      { heading: 'Redondance', info: [
        ['Photos sans fichier', noFile.length ? `${nf(noFile.length)} (fiche sans aucun fichier rattaché)` : 'aucune'],
        ['Photos en un seul exemplaire', `${nf(single)} (aucune copie connue du catalogue)`],
        ['Copies sur un même support', `${nf(oneSupport)} photo(s) dont toutes les copies sont sur le même support`],
      ] },
      { heading: 'Anomalies', columns: [{ label: 'Constat', w: 1.6 }, { label: 'Fichier', w: 2.8 }, { label: 'Support', w: 1.1 }, { label: 'Détail', w: 1.8 }],
        rows: anomalies.slice(0, 3000).map(({ f, kind, tone }) => ({ cells: [kind, f.path, f.support?.name ?? '', f.detail ?? ''], tone })),
        empty: 'Aucune anomalie : tous les fichiers vérifiés sont conformes.',
        note: anomalies.length > 3000 ? `Les ${nf(anomalies.length - 3000)} dernières anomalies ne figurent que dans le CSV.` : '' },
    ];
    return {
      title: full ? 'Rapport d’intégrité (contrôle complet)' : 'Rapport d’intégrité (contrôle rapide)',
      subtitle: `Contrôle du ${stampNow()}. Les originaux sont relus sans être modifiés ; le catalogue n’est pas mis à jour par ce rapport.`,
      sections,
      summary: { mode: full ? 'full' : 'quick', db: dbOk, foreignKeys: fk.length, files: state.length, ok: res.ok, hash: res.hash.length, size: res.size.length, unreadable: res.unreadable.length, absent: res.absent.length, offline: res.offline.length, noFile: noFile.length, single, hashed: res.hashed },
      csv: {
        columns: ['constat', 'chemin', 'support', 'detail', 'taille_octets', 'photo_id'], numeric: ['taille_octets'],
        rows: anomalies.map(({ f, kind }) => [kind, f.path, f.support?.name ?? '', f.detail ?? '', f.size_bytes ?? '', f.photo_id ?? '']),
      },
    };
  }

  // ---------------------------------------------------------------- sauvegardes
  function backupReport({ verify = true } = {}) {
    const list = backups ? backups.list() : [];
    const set = backupSettings() ?? {};
    const TYPE = { data: 'Données', program: 'Programme', full: 'Complète' };
    const rows = list.map(b => {
      let check = '';
      if (b.error) check = `illisible : ${b.error}`;
      else if (verify) { try { const v = backups.verify(b.name); check = v.ok ? `intègre (${v.entries} élément(s))` : `ALTÉRÉE : ${v.bad.slice(0, 3).join(', ')}`; } catch (e) { check = `illisible : ${e.message}`; } }
      return { b, check, bad: !!b.error || /^ALTÉRÉE|^illisible/.test(check) };
    });
    const dataOnes = list.filter(b => !b.error && b.manifest?.type !== 'program');
    const last = dataOnes[0]?.manifest?.createdAt ?? null;
    const age = last ? Math.floor((Date.now() - new Date(last)) / 864e5) : null;
    const limit = Math.max(1, +set.maxAgeDays || 7);
    const bad = rows.filter(r => r.bad).length;
    const sections = [
      { kpis: [['Sauvegardes', nf(list.length)], ['Dernière sauvegarde des données', age === null ? 'aucune' : age === 0 ? 'aujourd’hui' : `il y a ${age} j`, age === null ? 'bad' : age > limit ? 'warn' : 'ok'],
        ['Volume total', fmtBytes(list.reduce((a, b) => a + b.size, 0))], ['Archives altérées', verify ? nf(bad) : 'non vérifiées', verify ? (bad ? 'bad' : 'ok') : 'warn']] },
      { heading: 'Programmation', info: [
        ['Sauvegarde automatique', set.auto ? `activée : ${set.every === 'weekly' ? 'chaque semaine' : 'chaque jour'} à ${set.time ?? '?'}, type ${TYPE[set.type] ?? set.type}, ${set.keep ?? '?'} conservée(s)` : 'désactivée'],
        ['Chiffrement', set.encrypt ? 'activé pour les nouvelles sauvegardes (AES-256-GCM) — la base et les originaux en service ne sont pas chiffrés' : 'désactivé'],
        ['Dossier', backups?.DIR ?? ''],
        ['Conseil', age === null ? 'Aucune sauvegarde des données : en créer une depuis Administration → Sauvegardes, puis la copier sur un autre support.' : age > limit ? `La dernière sauvegarde des données date de ${age} jours.` : 'Copier régulièrement le dossier des sauvegardes sur un autre support que celui de l’application.'],
      ] },
      { heading: 'Sauvegardes présentes', columns: [{ label: 'Date', w: 1.1 }, { label: 'Type', w: 0.8 }, { label: 'Libellé', w: 1.3 }, { label: 'Version', w: 0.6 }, { label: 'Photos', w: 0.6, align: 'right' }, { label: 'Taille', w: 0.7, align: 'right' }, { label: 'Vérification', w: 1.3 }, { label: 'Test de restauration', w: 1.3 }],
        rows: rows.map(({ b, check, bad: x }) => ({ cells: [fmtDate(b.manifest?.createdAt ?? b.mtime), (TYPE[b.manifest?.type] ?? b.manifest?.type ?? '?') + (b.manifest?.encrypted ? ' (chiffrée)' : ''), [b.manifest?.label, b.manifest?.auto ? '(automatique)' : ''].filter(Boolean).join(' '), b.manifest?.version ?? '', b.manifest?.counts?.photos != null ? nf(b.manifest.counts.photos) : '', fmtBytes(b.size), check || 'non vérifiée', b.test ? `${fmtDate(b.test.at)} : ${b.test.ok ? 'réussi' : 'ÉCHEC'}` : 'jamais'], tone: x || b.test?.ok === false ? 'bad' : null })),
        empty: 'Aucune sauvegarde.' },
      { heading: 'Destinations', columns: [{ label: 'Destination', w: 1.4 }, { label: 'Type', w: 1.2 }, { label: 'Chemin', w: 2 }, { label: 'Dernière copie', w: 2 }],
        rows: (set.destinations ?? []).map(d => ({ cells: [d.name + (d.enabled ? '' : ' (désactivée)'), DEST_KIND_LABEL[d.kind] ?? d.kind, d.path, d.last ? `${fmtDate(d.last.at)} : ${d.last.ok ? 'vérifiée' : 'ÉCHEC — ' + d.last.message}` : 'aucune'], tone: d.last && !d.last.ok ? 'bad' : null })),
        empty: 'Aucune destination : les archives ne sont que dans le dossier Sauvegardes de l’application.' },
      { heading: 'Journal (100 dernières opérations)', columns: [{ label: 'Date', w: 1.1 }, { label: 'Opération', w: 0.9 }, { label: 'Résultat', w: 0.6 }, { label: 'Détail', w: 4 }],
        rows: (set.events ?? []).map(e => ({ cells: [fmtDate(e.at), e.kind, e.ok ? 'réussi' : 'ÉCHEC', e.message], tone: e.ok ? null : 'bad' })),
        empty: 'Journal vide.' },
    ];
    return {
      title: 'Rapport de sauvegardes', subtitle: `État au ${stampNow()}${verify ? ' ; chaque archive est relue et ses contrôles CRC vérifiés' : ''}.`,
      sections, summary: { count: list.length, lastAt: last, ageDays: age, bad: verify ? bad : null, auto: !!set.auto },
      csv: {
        columns: ['fichier', 'date', 'type', 'libelle', 'automatique', 'version', 'photos', 'taille_octets', 'verification'], numeric: ['photos', 'taille_octets'],
        rows: rows.map(({ b, check }) => [b.name, fmtDate(b.manifest?.createdAt ?? b.mtime), TYPE[b.manifest?.type] ?? b.manifest?.type ?? '', b.manifest?.label ?? '', b.manifest?.auto ? 'oui' : 'non', b.manifest?.version ?? '', b.manifest?.counts?.photos ?? '', b.size, check || 'non vérifiée']),
      },
    };
  }

  // ---------------------------------------------------------------- originaux non couverts
  function coverage() {
    const rows = db.prepare(`SELECT p.id, p.captured_at, p.title,
        (SELECT f.path FROM files f WHERE f.photo_id = p.id ORDER BY CASE f.kind WHEN 'original' THEN 0 ELSE 1 END, f.indexed_at LIMIT 1) path,
        (SELECT f.support_id FROM files f WHERE f.photo_id = p.id ORDER BY CASE f.kind WHEN 'original' THEN 0 ELSE 1 END, f.indexed_at LIMIT 1) support_id,
        (SELECT COUNT(DISTINCT COALESCE(f.support_id, '-')) FROM files f WHERE f.photo_id = p.id) supports,
        (SELECT COUNT(*) FROM files f WHERE f.photo_id = p.id AND f.status = 'available') available,
        ${BACKED_UP} covered
      FROM photos p ORDER BY path`).all();
    const sups = new Map(supportsAll().map(x => [x.id, x]));
    const total = rows.length, covered = rows.filter(r => r.covered).length, un = rows.filter(r => !r.covered);
    const single = rows.filter(r => r.supports <= 1).length;
    const bySup = new Map();
    for (const r of rows) { const k = r.support_id ?? '-'; const g = bySup.get(k) ?? { photos: 0, covered: 0 }; g.photos++; if (r.covered) g.covered++; bySup.set(k, g); }
    const pct = (a, b) => (b ? Math.round(a * 100 / b) + ' %' : '—');
    const MAX = 3000;
    const supName = id => (id ? sups.get(id)?.name ?? '(support supprimé)' : '(sans support)');
    const backupSups = [...sups.values()].filter(x => ['backup', 'archive'].includes(x.role));
    const sections = [
      { kpis: [['Photos', nf(total)], ['Couvertes', `${nf(covered)} (${pct(covered, total)})`, covered === total ? 'ok' : 'warn'], ['Non couvertes', nf(un.length), un.length ? 'bad' : 'ok'], ['Un seul support', nf(single), single ? 'warn' : 'ok']] },
      { heading: 'Comment lire ce rapport', info: [
        ['Couverte', 'Au moins un fichier de la photo est sur un support de rôle « Sauvegarde » ou « Archive » (même non connecté).'],
        ['Supports de sauvegarde', backupSups.length ? backupSups.map(x => `${x.name} (${SUPPORT_ROLES[x.role]})`).join(', ') : 'aucun : déclarez le rôle des disques de sauvegarde dans Supports, puis indexez-les.'],
        ['Rappel', 'Les sauvegardes du catalogue (Administration → Sauvegardes) ne contiennent pas les photos elles-mêmes.'],
      ] },
      { heading: 'Par support d’origine', columns: [{ label: 'Support', w: 2 }, { label: 'Rôle', w: 1 }, { label: 'Photos', w: 0.7, align: 'right' }, { label: 'Couvertes', w: 0.8, align: 'right' }, { label: 'Non couvertes', w: 0.9, align: 'right' }, { label: 'Taux', w: 0.6, align: 'right' }],
        rows: [...bySup.entries()].map(([id, g]) => ({ cells: [supName(id === '-' ? null : id), SUPPORT_ROLES[sups.get(id)?.role] ?? '', nf(g.photos), nf(g.covered), nf(g.photos - g.covered), pct(g.covered, g.photos)], tone: g.covered < g.photos ? 'warn' : null })),
        empty: 'Aucune photo.' },
      { newPage: un.length > 20, heading: `Photos sans copie de sauvegarde${un.length > MAX ? ` (${nf(MAX)} premières sur ${nf(un.length)} ; liste complète en CSV)` : ''}`,
        columns: [{ label: 'Fichier', w: 3.2 }, { label: 'Support', w: 1.2 }, { label: 'Date', w: 0.8 }, { label: 'Exemplaires', w: 0.8, align: 'right' }],
        rows: un.slice(0, MAX).map(r => ({ cells: [r.path ?? r.id, supName(r.support_id), fmtDate(r.captured_at), nf(r.available)], tone: r.available <= 1 ? 'warn' : null })),
        empty: 'Toutes les photos ont une copie sur un support de sauvegarde.' },
    ];
    return {
      title: 'Originaux non couverts par une sauvegarde', subtitle: `État au ${stampNow()}.`,
      sections, summary: { photos: total, covered, uncovered: un.length, single, backupSupports: backupSups.length },
      csv: { columns: ['photo_id', 'fichier', 'support', 'date', 'exemplaires_disponibles', 'supports', 'couverte'], numeric: ['exemplaires_disponibles', 'supports'],
        rows: rows.map(r => [r.id, r.path ?? '', supName(r.support_id), fmtDate(r.captured_at), r.available, r.supports, r.covered ? 'oui' : 'non']) },
    };
  }

  /** Modèle d'un rapport (indicateurs, sections, CSV). */
  async function build(kind, options = {}) {
    const o = options ?? {};
    if (kind === 'inventory') return inventory({ supportId: typeof o.supportId === 'string' ? o.supportId : '' });
    if (kind === 'missing') return missing();
    if (kind === 'integrity') return integrity({ mode: o.mode === 'full' ? 'full' : 'quick', onProgress: o.onProgress });
    if (kind === 'backups') return backupReport({ verify: o.verify !== false && o.verify !== 'false' });
    if (kind === 'coverage') return coverage();
    throw new Error('Rapport inconnu');
  }
  const record = (kind, format, r) => {
    db.prepare('INSERT INTO exports(id, kind, target, profile, count, status, created_at, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), `report-${kind}`, r.title, format, r.csv.rows.length, 'ok', new Date().toISOString(), JSON.stringify(r.summary));
    logHistory(db, `report.${kind}`, `${r.title} (${format.toUpperCase()})`, r.summary);
  };

  /** PDF d'un rapport : `write(buffer)` reçoit le document. Renvoie { title, pages, bytes, summary }. */
  async function pdf(kind, options, write) {
    const r = await build(kind, options);
    const out = renderTableDoc({ title: r.title, subtitle: r.subtitle, sections: r.sections, stamp: stampNow() }, write);
    record(kind, 'pdf', r);
    return { title: r.title, pages: out.pages, bytes: out.bytes, summary: r.summary };
  }
  /** CSV d'un rapport (UTF-8 avec BOM, « ; », CRLF). */
  async function csv(kind, options) {
    const r = await build(kind, options), num = new Set(r.csv.numeric ?? []);
    const lines = [r.csv.columns.join(';'), ...r.csv.rows.map(row => row.map((v, k) => csvCell(v, num.has(r.csv.columns[k]))).join(';'))];
    record(kind, 'csv', r);
    return { title: r.title, text: '﻿' + lines.join('\r\n') + '\r\n', rows: r.csv.rows.length, summary: r.summary };
  }

  return { build, pdf, csv };
}
