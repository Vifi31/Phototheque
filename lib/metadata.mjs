// Métadonnées documentaires (§8) : modification en masse avec aperçu, relecture des fichiers,
// écriture des XMP annexes, annulation. Politique de priorité : voir lib/xmp.mjs et
// docs/ARCHITECTURE.md §20. Les originaux ne sont jamais écrits.
import fs from 'fs';
import path from 'path';
import { logHistory, tx } from './db.mjs';
import { syncPhotoKeywordsText } from './keywords.mjs';
import { XMP_DIR } from './paths.mjs';
import { DOC_FIELDS, PLACE_KEYS, cleanDoc, buildXmp, parseXmp, sidecarPath, sha, showValue, sameValue, isEmpty } from './xmp.mjs';

const P = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const J = v => JSON.stringify(v ?? {});

/** Réglages par défaut (store.metadata). */
export const METADATA_DEFAULTS = () => ({ readOnIndex: true, destination: 'folder', naming: 'adobe' });
export const DESTINATIONS = { folder: 'Dossier « Metadonnees » de Photothèque (les dossiers des photos restent intacts)', beside: 'À côté de chaque photo (lu par Lightroom, Bridge, darktable, digiKam…)' };
export const NAMINGS = { adobe: 'IMG_0001.xmp (Adobe, Capture One)', full: 'IMG_0001.jpg.xmp (darktable, digiKam)' };
export function cleanMetadataSettings(b = {}, cur = METADATA_DEFAULTS()) {
  const o = { ...METADATA_DEFAULTS(), ...cur };
  if (b.readOnIndex !== undefined) o.readOnIndex = b.readOnIndex === true || b.readOnIndex === 'true';
  if (DESTINATIONS[b.destination]) o.destination = b.destination;
  if (NAMINGS[b.naming]) o.naming = b.naming;
  return o;
}
/** Modes de modification d'un champ. */
export const MODES = { set: 'Remplacer', fill: 'Remplir si vide', clear: 'Effacer' };
export const MAX_BATCH = 20000;

export function createMetadata(db, { keywords, library, settings = () => METADATA_DEFAULTS(), version = '' } = {}) {
  const cfg = () => ({ ...METADATA_DEFAULTS(), ...(settings() ?? {}) });

  /** Champs documentaires d'une fiche (mots-clés en chemins « Parent|Enfant »). */
  function docOf(id) {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(id); if (!p) return null;
    const data = P(p.data);
    const place = Object.fromEntries(Object.entries(PLACE_KEYS).map(([k, key]) => [k, Array.isArray(data[key]) ? data[key][0] : data[key]]));
    return cleanDoc({ title: p.title, description: p.description, author: p.author, copyright: p.copyright, rating: p.rating, color: p.color, keywords: keywords.pathsOfPhoto(id), ...place });
  }
  const nameOf = id => db.prepare(`SELECT COALESCE(f.file_name, NULLIF(p.title, ''), p.id) n FROM photos p LEFT JOIN files f ON f.photo_id = p.id WHERE p.id = ? ORDER BY f.kind = 'original' DESC LIMIT 1`).get(id)?.n ?? id;
  /** Fichier de référence d'une photo (original disponible d'abord). */
  const fileOf = id => db.prepare(`SELECT * FROM files WHERE photo_id = ? ORDER BY status = 'available' DESC, kind = 'original' DESC, path LIMIT 1`).get(id) ?? null;

  /** Écrit une valeur dans la fiche (sans historique : appelé par apply / undo). */
  function setField(id, field, value) {
    if (field === 'keywords') {
      db.prepare('DELETE FROM photo_keywords WHERE photo_id = ?').run(id);
      for (const kp of value ?? []) keywords.attach(id, keywords.resolvePath(kp).id);
      syncPhotoKeywordsText(db, id);
      return;
    }
    if (PLACE_KEYS[field]) {
      const data = P(db.prepare('SELECT data FROM photos WHERE id = ?').get(id)?.data);
      if (isEmpty(field, value)) delete data[PLACE_KEYS[field]]; else data[PLACE_KEYS[field]] = value;
      db.prepare('UPDATE photos SET data = ? WHERE id = ?').run(J(data), id);
      return;
    }
    db.prepare(`UPDATE photos SET ${field} = ? WHERE id = ?`).run(field === 'rating' || field === 'color' ? (+value || 0) : (isEmpty(field, value) ? null : value), id);
  }

  // ------------------------------------------------------------ modification en masse
  /** Nettoie la demande : { field: { mode, value } }, keywordsAdd, keywordsRemove. */
  function cleanChanges(c = {}) {
    const out = { fields: {}, keywordsAdd: [], keywordsRemove: [] };
    for (const f of Object.keys(DOC_FIELDS)) {
      if (f === 'keywords') continue;
      const ch = c[f]; if (!ch || !MODES[ch.mode]) continue;
      out.fields[f] = { mode: ch.mode, value: ch.mode === 'clear' ? cleanDoc({})[f] : cleanDoc({ [f]: ch.value })[f] };
      if (ch.mode !== 'clear' && isEmpty(f, out.fields[f].value)) delete out.fields[f]; // « remplacer par rien » = effacer, à demander explicitement
    }
    out.keywordsAdd = cleanDoc({ keywords: c.keywordsAdd }).keywords;
    out.keywordsRemove = cleanDoc({ keywords: c.keywordsRemove }).keywords.map(k => k.toLowerCase());
    if (c.keywords && MODES[c.keywords.mode]) out.keywordsMode = { mode: c.keywords.mode, value: cleanDoc({ keywords: c.keywords.value }).keywords };
    return out;
  }
  /** Valeurs après modification d'une fiche (`doc`) selon `ch` (cleanChanges). */
  function after(doc, ch) {
    const out = {};
    for (const [f, { mode, value }] of Object.entries(ch.fields)) {
      if (mode === 'fill' && !isEmpty(f, doc[f])) continue;
      out[f] = value;
    }
    let kw = doc.keywords;
    if (ch.keywordsMode) { const { mode, value } = ch.keywordsMode; if (mode === 'clear') kw = []; else if (mode === 'set' || isEmpty('keywords', kw)) kw = value; }
    if (ch.keywordsRemove.length) {
      // retirer « Montagne » retire aussi « Lieux|Montagne »
      kw = kw.filter(k => !ch.keywordsRemove.includes(k.toLowerCase()) && !ch.keywordsRemove.includes(k.split('|').pop().toLowerCase()));
    }
    if (ch.keywordsAdd.length) {
      const has = new Set(kw.map(k => k.toLowerCase()));
      kw = [...kw, ...ch.keywordsAdd.filter(k => !has.has(k.toLowerCase()))];
    }
    if (!sameValue('keywords', kw, doc.keywords)) out.keywords = kw;
    return out;
  }
  /** Lignes d'aperçu : [{ id, name, changes: [{ field, label, before, after, overwrite }] }] et bilan. */
  function summarize(rows, total) {
    const values = rows.reduce((a, r) => a + r.changes.length, 0);
    const overwrites = rows.reduce((a, r) => a + r.changes.filter(c => c.overwrite).length, 0);
    const byField = {};
    for (const r of rows) for (const c of r.changes) { const e = byField[c.field] ??= { field: c.field, label: DOC_FIELDS[c.field], photos: 0, overwrites: 0 }; e.photos++; if (c.overwrite) e.overwrites++; }
    return { photos: total, changed: rows.length, unchanged: total - rows.length, values, overwrites, byField: Object.values(byField) };
  }
  function diffRow(id, doc, next, extra = {}) {
    const changes = [];
    for (const f of Object.keys(DOC_FIELDS)) {
      if (!(f in next) || sameValue(f, doc[f], next[f])) continue;
      changes.push({ field: f, label: DOC_FIELDS[f], before: doc[f], after: next[f], beforeText: showValue(f, doc[f]), afterText: showValue(f, next[f]), overwrite: !isEmpty(f, doc[f]) });
    }
    return changes.length ? { id, name: nameOf(id), changes, ...extra } : null;
  }

  /** Aperçu d'une modification en masse (n'écrit rien). */
  function planEdit(ids, changes) {
    const ch = cleanChanges(changes); const rows = [];
    for (const id of ids.slice(0, MAX_BATCH)) { const doc = docOf(id); if (!doc) continue; const r = diffRow(id, doc, after(doc, ch)); if (r) rows.push(r); }
    return { rows, summary: summarize(rows, Math.min(ids.length, MAX_BATCH)) };
  }

  /** Applique des lignes d'aperçu recalculées côté serveur ; enregistre un lot annulable. */
  function applyRows(rows, { kind, label }) {
    if (!rows.length) return { batchId: null, photos: 0, values: 0 };
    const changes = [];
    tx(db, () => {
      for (const r of rows) for (const c of r.changes) { setField(r.id, c.field, c.after); changes.push({ id: r.id, field: c.field, before: c.before, after: c.after }); }
    });
    if (changes.some(c => c.field === 'keywords')) keywords.recount();
    db.prepare('INSERT INTO history(ts, kind, detail, data) VALUES(?, ?, ?, ?)').run(new Date().toISOString(), 'metadata.batch',
      `${label} : ${rows.length} photo(s), ${changes.length} valeur(s)`, JSON.stringify({ kind, label, changes }));
    const batchId = db.prepare('SELECT last_insert_rowid() id').get().id;
    return { batchId, photos: rows.length, values: changes.length };
  }
  function applyEdit(ids, changes) {
    const { rows } = planEdit(ids, changes);
    return applyRows(rows, { kind: 'edit', label: 'Modification des métadonnées' });
  }

  // ------------------------------------------------------------ relecture des fichiers (XMP annexe > embarqué)
  /**
   * Compare les champs lus dans les fichiers (XMP annexe d'abord, puis métadonnées embarquées) avec la fiche.
   * mode `fill` : seulement les champs vides de la fiche ; `replace` : aussi les champs différents (à confirmer).
   */
  async function planRead(ids, { mode = 'fill', fields = null } = {}) {
    const keep = fields ? new Set([].concat(fields).filter(f => DOC_FIELDS[f])) : null;
    const rows = []; const issues = [];
    for (const id of ids.slice(0, MAX_BATCH)) {
      const doc = docOf(id); if (!doc) continue;
      const file = fileOf(id);
      if (!file || file.status !== 'available' || !fs.existsSync(file.path)) { issues.push({ id, name: nameOf(id), issue: 'fichier indisponible' }); continue; }
      let src;
      try { src = await library.fileDoc(file.path); } catch (e) { issues.push({ id, name: nameOf(id), issue: 'lecture impossible : ' + e.message }); continue; }
      const next = {};
      for (const f of Object.keys(DOC_FIELDS)) {
        if (keep && !keep.has(f)) continue;
        if (isEmpty(f, src.doc[f]) || sameValue(f, doc[f], src.doc[f])) continue;
        if (mode === 'fill' && !isEmpty(f, doc[f])) continue;
        next[f] = src.doc[f];
      }
      const r = diffRow(id, doc, next, { sidecar: src.sidecar, origin: src.origin });
      if (r) { for (const c of r.changes) c.source = src.origin[c.field] === 'xmp' ? 'XMP annexe' : 'fichier'; rows.push(r); }
    }
    return { rows, issues, summary: summarize(rows, Math.min(ids.length, MAX_BATCH)) };
  }
  async function applyRead(ids, opts) {
    const { rows, issues } = await planRead(ids, opts);
    return { ...applyRows(rows, { kind: 'read', label: 'Relecture des métadonnées des fichiers' }), issues: issues.length };
  }

  // ------------------------------------------------------------ écriture des XMP annexes
  const STATUS = { create: 'à créer', update: 'à mettre à jour', same: 'déjà à jour', conflict: 'modifié par un autre logiciel', unavailable: 'original indisponible', collision: 'même nom qu’un autre fichier' };
  /**
   * Plan d'écriture : pour chaque photo, l'annexe visée et son état. Une annexe existante n'est mise à jour
   * que si Photothèque l'a écrite et qu'elle n'a pas changé depuis (empreinte gardée dans photos.data.xmp).
   */
  function planWrite(ids) {
    const s = cfg(); const rows = []; const targets = new Map();
    for (const id of ids.slice(0, MAX_BATCH)) {
      const p = db.prepare('SELECT captured_at, data FROM photos WHERE id = ?').get(id); if (!p) continue;
      const file = fileOf(id);
      if (!file) { rows.push({ id, name: nameOf(id), status: 'unavailable', target: '' }); continue; }
      const target = sidecarPath(file.path, { destination: s.destination, naming: s.naming, dir: XMP_DIR });
      const content = buildXmp(docOf(id), { captured_at: p.captured_at, tool: `Photothèque ${version}`.trim() });
      let status;
      if (targets.has(target.toLowerCase())) status = 'collision';
      else if (s.destination === 'beside' && (file.status !== 'available' || !fs.existsSync(path.dirname(file.path)))) status = 'unavailable';
      else {
        let cur = null; try { cur = fs.readFileSync(target, 'utf8'); } catch { /* absente */ }
        const mine = P(p.data).xmp;
        if (cur === null) status = 'create';
        else if (cur === content) status = 'same';
        else if (mine?.path === target && mine.hash === sha(cur)) status = 'update';
        else status = 'conflict';
      }
      targets.set(target.toLowerCase(), id);
      rows.push({ id, name: nameOf(id), status, target, content });
    }
    const count = Object.fromEntries(Object.keys(STATUS).map(k => [k, rows.filter(r => r.status === k).length]));
    return { rows, count, statuses: STATUS, settings: s };
  }
  /** Écrit les annexes ; `conflicts: 'replace'` remplace aussi les annexes modifiées ailleurs, après en avoir gardé une copie. */
  function applyWrite(ids, { conflicts = 'skip' } = {}) {
    const { rows } = planWrite(ids); const done = { created: 0, updated: 0, replaced: 0, skipped: 0, errors: [] };
    for (const r of rows) {
      const go = r.status === 'create' || r.status === 'update' || (r.status === 'conflict' && conflicts === 'replace');
      if (!go) { done.skipped++; continue; }
      try {
        fs.mkdirSync(path.dirname(r.target), { recursive: true });
        if (r.status === 'conflict') {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fs.copyFileSync(r.target, r.target.replace(/\.xmp$/i, '') + `.${stamp}.xmp.bak`);
        }
        const tmp = r.target + '.tmp'; fs.writeFileSync(tmp, r.content, 'utf8'); fs.renameSync(tmp, r.target);
        const data = P(db.prepare('SELECT data FROM photos WHERE id = ?').get(r.id)?.data);
        data.xmp = { path: r.target, hash: sha(r.content), at: new Date().toISOString() };
        db.prepare('UPDATE photos SET data = ? WHERE id = ?').run(J(data), r.id);
        if (r.status === 'create') done.created++; else if (r.status === 'update') done.updated++; else done.replaced++;
      } catch (e) { done.errors.push({ id: r.id, name: r.name, error: e.message }); }
    }
    logHistory(db, 'metadata.xmp', `XMP annexes : ${done.created} créé(s), ${done.updated} mis à jour, ${done.replaced} remplacé(s), ${done.skipped} laissé(s)`, { ...done, destination: cfg().destination });
    return done;
  }

  // ------------------------------------------------------------ lots et annulation
  function batches(limit = 15) {
    return db.prepare("SELECT id, ts, detail, data FROM history WHERE kind = 'metadata.batch' ORDER BY id DESC LIMIT ?").all(limit).map(r => {
      const d = P(r.data);
      return { id: r.id, ts: r.ts, detail: r.detail, label: d.label, undone: !!d.undone, photos: new Set((d.changes ?? []).map(c => c.id)).size, values: (d.changes ?? []).length };
    });
  }
  /** Annule un lot : rétablit chaque valeur si la fiche porte encore la valeur posée par le lot. */
  function undo(batchId) {
    const row = db.prepare("SELECT id, data FROM history WHERE id = ? AND kind = 'metadata.batch'").get(+batchId);
    if (!row) throw new Error('Lot inconnu');
    const d = P(row.data); if (d.undone) throw new Error('Ce lot a déjà été annulé');
    let restored = 0, kept = 0;
    tx(db, () => {
      for (const c of d.changes ?? []) {
        const doc = docOf(c.id); if (!doc) { kept++; continue; }
        if (!sameValue(c.field, doc[c.field], c.after)) { kept++; continue; } // modifiée depuis : on n'y touche pas
        setField(c.id, c.field, c.before); restored++;
      }
      d.undone = new Date().toISOString();
      db.prepare('UPDATE history SET data = ? WHERE id = ?').run(JSON.stringify(d), row.id);
    });
    if ((d.changes ?? []).some(c => c.field === 'keywords')) keywords.recount();
    logHistory(db, 'metadata.undo', `Annulation du lot ${row.id} : ${restored} valeur(s) rétablie(s), ${kept} laissée(s)`, { batch: row.id, restored, kept });
    return { restored, kept };
  }

  return { docOf, planEdit, applyEdit, planRead, applyRead, planWrite, applyWrite, batches, undo };
}
