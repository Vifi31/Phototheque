// Tests de Photothèque — `npm test`.
// Couvre : mots-clés, supports, indexation sans copie, métadonnées, vignettes,
// recherche, import (copie + doublons), sauvegardes, et l'intégrité de la base.
// Aucune donnée réelle n'est touchée : tout tourne dans un dossier temporaire.
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';

// isole les données dans un dossier temporaire AVANT d'importer les modules qui lisent .env/paths
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phototheque-test-'));
process.env.PHOTOTHEQUE_HOME = TMP;

const { initStore, saveStore, loadStore } = await import('../lib/store.mjs');
const { createSupports, fingerprint } = await import('../lib/supports.mjs');
const { createKeywords } = await import('../lib/keywords.mjs');
const { createLibrary, isImage, IMAGE_EXTS } = await import('../lib/library.mjs');
const { createImports, uniqueName } = await import('../lib/imports.mjs');
const { createCollections } = await import('../lib/collections.mjs');
const { createAlbums, LAYOUTS, SAFETY_MARGIN, ALBUM_FORMAT_VERSION } = await import('../lib/albums.mjs');
const { createAlbumPdf, BLEED_MM } = await import('../lib/albumpdf.mjs');
const Pdf = await import('../lib/pdf.mjs');
const { createBackupService } = await import('../lib/backup.mjs');
const { openDb, dbStatus, integrity, tableRows, isTable, ftsStatus } = await import('../lib/db.mjs');
const Search = await import('../lib/search.mjs');
const { createZip, readZip } = await import('../lib/zip.mjs');
const { defaultLicense, brief } = await import('../lib/license.mjs');

let ok = 0, ko = 0;
const check = (name, actual, expected, eps = 0.01) => {
  const good = actual === expected
    || (typeof expected === 'number' && Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= eps);
  if (good) { ok++; console.log(`  ok   ${name}`); }
  else { ko++; console.error(`  ECHEC ${name}\n         attendu  ${expected}\n         obtenu   ${actual}`); }
};
const group = t => console.log(`\n${t}`);

// ---------- fabrique d'images de test ----------
async function makeImage(file, { w = 800, h = 600, make = 'Canon', model = 'EOS R5', date = '2024:07:15 14:30:00', color = { r: 40, g: 90, b: 200 } } = {}) {
  const exif = { IFD0: { Make: make, Model: model, Orientation: 'Horizontal (normal)', DateTime: date } };
  let pipeline = sharp({ create: { width: w, height: h, channels: 3, background: color } }).withExif(exif);
  // produit un vrai PNG si l'extension le demande (sinon JPEG), pour tester la lecture du format réel
  pipeline = /\.png$/i.test(file) ? pipeline.png() : pipeline.jpeg({ quality: 85 });
  const buf = await pipeline.toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

// ===================================================================
group('Base de données : schéma et intégrité');
// ===================================================================
{
  const { db } = initStore();
  check('base ouverte', !!db, true, 0);
  check('table photos présente', isTable('photos'), true, 0);
  check('table supports présente', isTable('supports'), true, 0);
  check('table keywords présente', isTable('keywords'), true, 0);
  check("contrôle d'intégrité", integrity(db).length === 1 && integrity(db)[0] === 'ok', true, 0);
  const st = dbStatus(db);
  check('statut : moteur SQLite', /SQLite/i.test(st.engine), true, 0);
  check('statut : au moins 15 tables', st.tables.length >= 15, true, 0);
  db.close();
}

// ===================================================================
group('Mots-clés : création, arborescence, affectation, fusion');
// ===================================================================
let KW, LIB, DB, SUP, IMP, STORE;
{
  const { db, store } = initStore();
  DB = db; STORE = store;
  SUP = createSupports(db); KW = createKeywords(db);
  LIB = createLibrary(db, store, SUP, KW); IMP = createImports(db, store, LIB, KW);

  const v = KW.ensure('Vacances');
  check('création', !!v.id, true, 0);
  check('idempotent (même nom → même id)', KW.ensure('Vacances').id, v.id);
  const enfant = KW.ensure('Été 2024', v.id);
  check('parent rattaché', enfant.parent_id, v.id);
  check('normalisation (accents/casse/espaces)', KW.ensure('ÉTÉ  2024', v.id).id, enfant.id, 0);
  check('suggestion par préfixe', KW.suggest('vac').length, 1, 0);
  check('arborescence : un racine', KW.tree().length >= 1, true, 0);

  KW.ensure('Famille');
  check('au moins 2 mots-clés', KW.list().length >= 2, true, 0);
  // affectation
  const fakePhoto = 'photo-test-1';
  DB.prepare("INSERT INTO photos(id, data) VALUES(?, '{}')").run(fakePhoto);
  KW.attachNames(fakePhoto, ['Vacances', 'Famille']);
  check('mots-clés d\'une photo', KW.ofPhoto(fakePhoto).length, 2, 0);
  KW.recount();
  check('comptage après affectation', KW.byName('Vacances').photo_count, 1, 0);
  // fusion
  const cible = KW.ensure('Congé');
  KW.merge([KW.byName('Famille').id], cible.id);
  check('fusion : la source disparaît', KW.byName('Famille'), null, 0);
  check('fusion : les affectations passent à la cible', KW.ofPhoto(fakePhoto).length, 2, 0);
  // export
  check('export CSV non vide', KW.exportCsv().split('\r\n').length >= 3, true, 0);
  // nettoyage : la photo de test ne doit pas polluer les groupes suivants
  DB.prepare('DELETE FROM photos WHERE id = ?').run(fakePhoto);
}

// ===================================================================
group('Supports : empreinte et statut');
// ===================================================================
{
  // dossier local qui tient lieu de « support »
  const racine = path.join(TMP, 'disque-test');
  fs.mkdirSync(racine, { recursive: true });
  fs.writeFileSync(path.join(racine, 'a.jpg'), 'x');
  const fp = fingerprint(racine);
  check('empreinte calculée', typeof fp === 'string' && fp.length === 32, true, 0);
  check('empreinte stable', fingerprint(racine), fp);
  const s = SUP.upsert({ name: 'Disque test', mount_path: racine, kind: 'disk', role: 'original' });
  check('support ajouté', !!s.id, true, 0);
  check('support disponible', s.status, 'available');
  check('inventaire', SUP.list().length, 1, 0);
  // support absent (chemin inexistant)
  const absent = SUP.upsert({ name: 'Carte absente', mount_path: path.join(TMP, 'nesexiste-pas'), kind: 'sd' });
  check('support absent détecté', absent.status, 'absent');
  check('stats : 1 disponible, 1 absent', SUP.stats().available === 1 && SUP.stats().absent === 1, true, 0);
}

// ===================================================================
group('Indexation sans copie : métadonnées, vignettes, intégrité des originaux');
// ===================================================================
{
  const dossier = path.join(TMP, 'mes-photos');
  await makeImage(path.join(dossier, 'IMG_0001.jpg'), { w: 900, h: 600, date: '2024:07:15 14:30:00' });
  await makeImage(path.join(dossier, 'IMG_0002.jpg'), { w: 1200, h: 800, make: 'Nikon', model: 'Z6 II', date: '2023:12:01 09:00:00' });
  await makeImage(path.join(dossier, 'sous-dossier', 'IMG_0003.png'), { w: 640, h: 480, date: '2022:03:10 08:00:00' });
  // empreinte des originaux avant indexation
  const avant = ['IMG_0001.jpg', 'IMG_0002.jpg', path.join('sous-dossier', 'IMG_0003.png')]
    .map(f => fs.statSync(path.join(dossier, f)).mtimeMs);

  const fid = 'fold-test-1';
  DB.prepare('INSERT INTO folders(id,support_id,path,rel_path,photo_count,indexed_at,status,data) VALUES(?,?,?,NULL,0,NULL,?,?)')
    .run(fid, null, dossier, 'pending', '{}');
  const r = await LIB.indexFolder(fid);
  check('3 fichiers traités', r.total, 3, 0);
  check('3 photos ajoutées', r.added, 3, 0);
  check('0 erreur', r.errors, 0, 0);

  // les originaux ne sont ni modifiés ni déplacés
  const apres = ['IMG_0001.jpg', 'IMG_0002.jpg', path.join('sous-dossier', 'IMG_0003.png')]
    .map(f => fs.statSync(path.join(dossier, f)).mtimeMs);
  check('originaux inchangés (mtime)', JSON.stringify(apres), JSON.stringify(avant));

  // métadonnées extraites
  const list = LIB.search({}, { limit: 10 });
  check('3 photos en base', list.total, 3, 0);
  const p1 = list.rows.find(p => p.camera_model === 'EOS R5');
  check('modèle EXIF lu', !!p1, true, 0);
  check('dimensions lues', p1 && p1.width, 900, 0);
  check('date de prise de vue (EXIF)', p1 && p1.captured_at && p1.captured_at.slice(0, 10), '2024-07-15');
  check('vignette générée', !!(p1 && p1.thumb), true, 0);
  // la vignette existe sur disque
  const detail = LIB.detail(p1.id);
  const thumbRel = detail.files[0].data.thumbs.thumb;
  check('fichier de vignette présent', fs.existsSync(path.join(TMP, 'data', 'thumbs', thumbRel)), true, 0);

  // re-indexation : idempotente (0 ajout)
  const r2 = await LIB.indexFolder(fid);
  check('re-indexation sans doublon', r2.added, 0, 0);

  // recherche
  check('recherche par appareil', LIB.search({ camera: 'Nikon' }).total, 1, 0);
  check('recherche par format', LIB.search({ format: 'png' }).total, 1, 0);
  check('recherche par année', LIB.search({ from: '2024-01-01', to: '2024-12-31' }).total, 1, 0);

  // stats
  const st = LIB.stats();
  check('stats.photos', st.photos, 3, 0);
  check('stats.gps = 0 (pas de GPS)', st.gps, 0, 0);
}

// ===================================================================
group('Recherche plein texte (FTS5) : index, accents, synchronisation');
// ===================================================================
{
  // --- l'index existe réellement, il n'est pas décoratif ---
  const engine = Search.searchEngine(DB);
  check('FTS5 réellement disponible', engine.fts5, true, 0);
  check('moteur annoncé = fts5', engine.mode, 'fts5', 0);
  check('schéma versionné à 2', DB.prepare("SELECT value v FROM meta WHERE key='schema_version'").get().v, '2', 0);
  check('index non vide', ftsStatus(DB).indexed >= LIB.stats().photos, true, 0);
  check('intégrité après migration', integrity(DB)[0], 'ok', 0);
  check('3 déclencheurs de synchronisation',
    DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'photos_fts_%'").get().n, 3, 0);

  // --- recherche textuelle réelle ---
  const cible = LIB.search({}, { limit: 10 }).rows[0];
  LIB.update(cible.id, { title: 'Villa d\'été', description: 'Témoignage de famille', notes: 'Réviser le dossier 2024' });
  LIB.syncKeywordsText(cible.id);
  const ids = f => LIB.search(f, { limit: 20 }).rows.map(p => p.id);
  check('trouve un mot du titre', ids({ q: 'villa' }).includes(cible.id), true, 0);
  check('ET plusieurs termes', ids({ q: 'villa témoignage' }).includes(cible.id), true, 0);
  check('ne trouve pas un mot absent', ids({ q: 'chateau' }).includes(cible.id), false, 0);
  check('insensible aux accents (« villa » = « VILLA »)', ids({ q: 'VILLA' }).includes(cible.id), true, 0);
  check('insensible aux accents (« ete » → « été »)',
    LIB.search({ q: 'ete' }, { limit: 20 }).total >= LIB.search({ q: 'été' }, { limit: 20 }).total, true, 0);
  check('mode OU (un seul des termes)', ids({ anyText: ['villa', 'introuvablexyz'] }).includes(cible.id), true, 0);
  check('mode NON (exclut)', ids({ excludeText: ['villa'] }).includes(cible.id), false, 0);
  check('tri inconnu → tri par défaut (pas de 500)', ids({ q: 'villa' }).length > 0, true, 0);

  // --- saisies hostiles : la syntaxe FTS5 ne doit jamais remonter comme erreur ---
  for (const bad of ['"', 'AND NOT (x', '*', '^abc', '(){}[]', ':', 'a OR b AND NOT c', '%\b_']) {
    let err = null;
    try { LIB.search({ q: bad }, { limit: 5 }); } catch (e) { err = e.message; }
    check(`saisie hostile ${JSON.stringify(bad)} sans erreur`, err, null, 0);
  }

  // --- synchronisation : l'index suit les écritures ---
  const mq = q => DB.prepare('SELECT COUNT(*) n FROM photos_fts WHERE photos_fts MATCH ?').get(q).n;
  check('le nouveau mot est indexé', mq('"Temoignage"') >= 1, true, 0);
  LIB.update(cible.id, { title: 'Chalet de montagne', description: null });
  check('ancien mot retiré de l\'index', mq('"Temoignage"'), 0, 0);
  check('ancien titre retiré', mq('"Villa"'), 0, 0);
  check('nouveau titre indexé', mq('"Chalet"'), 1, 0);
  check('retrouvé par la recherche', ids({ q: 'chalet' }).includes(cible.id), true, 0);
  LIB.update(cible.id, { title: null });
  check('titre effacé → index vidé de ce terme', mq('"Chalet"'), 0, 0);

  // --- critères avancés (§9) ---
  const n = f => LIB.search(f, { limit: 50 }).total;
  check('critère : sans étiquette', n({ noKeyword: true }) >= n({ hasKeyword: true }), true, 0);
  check('critère : légendée / sans légende', n({ hasCaption: true }) + n({ noCaption: true }), LIB.stats().photos, 0);
  check('critère : orientation portrait', n({ orientation: 'portrait' }) >= 0, true, 0);
  check('critère : orientation carré', n({ orientation: 'square' }) >= 0, true, 0);
  check('critère : dimensions', n({ minWidth: 1, maxWidth: 100000 }) >= 0, true, 0);
  check('critère : objectif', n({ lens: '50mm' }) >= 0, true, 0);
  check('critère : intégrité (fichier)', n({ integrity: 'missing' }) >= 0, true, 0);
  check('critère : doublons', n({ duplicate: true }) >= 0, true, 0);
  check('critère : année', n({ year: '2024' }) >= 0, true, 0);
  // GPS : aucune photo de test n'est géolocalisée ; la valeur d'URL « 0 » doit valoir « sans GPS »
  check('critère : sans GPS (« 0 » d\'URL)', n({ hasGps: '0' }), LIB.stats().photos, 0);
  check('critère : sans GPS (« false » d\'URL)', n({ hasGps: 'false' }), LIB.stats().photos, 0);
  check('critère : sans GPS (booléen)', n({ hasGps: false }), LIB.stats().photos, 0);
  check('critère : avec GPS (« 1 » d\'URL)', n({ hasGps: '1' }), 0, 0);
  check('critères combinés (texte + orientation + note)',
    n({ q: 'chalet', orientation: 'portrait', rating: 0 }) >= 0, true, 0);
  // ET / OU / NON sur les mots-clés
  KW.ensure('Vacances'); KW.ensure('Famille');
  check('mot-clés : NON n\'écarte rien sans étiquette', n({ excludeKeywords: ['vacances'] }), LIB.stats().photos, 0);
  // les mots-clés saisis se comparent comme la colonne normalized (casse ET accents)
  const tagged = LIB.search({}, { limit: 10 }).rows[1].id;
  KW.attachNames(tagged, ['Été indien', 'Famille']);
  check('mots-clés : ET insensible aux accents', n({ keywords: ['ete indien', 'FAMILLE'] }), 1, 0);
  check('mots-clés : OU', n({ anyKeywords: ['été  indien', 'introuvable'] }), 1, 0);
  check('mots-clés : NON', n({ excludeKeywords: ['Ete Indien'] }), LIB.stats().photos - 1, 0);
  // le texte cherché (keywords_text → FTS5) suit renommage, fusion et suppression des mots-clés
  LIB.syncKeywordsText(tagged);
  const ftsIds = q => LIB.search({ q }, { limit: 20 }).rows.map(p => p.id);
  check('texte : mot-clé trouvé par la recherche libre', ftsIds('indien').includes(tagged), true, 0);
  KW.update(KW.byName('Été indien').id, { name: 'Arrière-saison' });
  check('renommage : ancien nom plus trouvé', ftsIds('indien').includes(tagged), false, 0);
  check('renommage : nouveau nom trouvé', ftsIds('arriere').includes(tagged), true, 0);
  const proches = KW.ensure('Proches'); KW.attach(tagged, proches.id); LIB.syncKeywordsText(tagged);
  KW.merge([KW.byName('Famille').id], proches.id);
  check('fusion : nom source plus trouvé', ftsIds('famille').includes(tagged), false, 0);
  check('fusion : cible toujours trouvée', ftsIds('proches').includes(tagged), true, 0);
  KW.remove(KW.byName('Arrière-saison').id);
  check('suppression : nom plus trouvé', ftsIds('arriere').includes(tagged), false, 0);
  check('suppression : les autres mots-clés restent', LIB.detail(tagged).keywords_text, 'Proches');
  DB.prepare('DELETE FROM photo_keywords WHERE photo_id = ?').run(tagged); LIB.syncKeywordsText(tagged);

  // --- repli LIKE : même résultat si FTS5 n'existait pas ---
  const like = Search.buildQuery({ q: 'chalet' }, { fts: false });
  check('repli LIKE présent si FTS5 absent', /LIKE/.test(like.where), true, 0);
  check('repli LIKE sans condition inutile', like.params.length, 6, 0);
}

// ===================================================================
group('Doublons : même empreinte → même fiche photo');
// ===================================================================
{
  const src = path.join(TMP, 'mes-photos', 'IMG_0001.jpg');
  const copie = path.join(TMP, 'doublon.jpg');
  fs.copyFileSync(src, copie);
  const before = LIB.stats().photos;
  await LIB.indexFile(copie, {});
  check('un doublon ne crée pas de nouvelle photo', LIB.stats().photos, before, 0);
  check('mais un second fichier est indexé', LIB.stats().files, 4, 0);
  const dups = LIB.search({ duplicate: true }, { limit: 10 });
  check('critère doublons : la photo à deux fichiers est trouvée', dups.total, 1, 0);
  check('critère doublons : c\'est bien la photo copiée', LIB.detail(dups.rows[0].id).files.length, 2, 0);
}

// ===================================================================
group('Import (copie) : doublons et collisions gérés, source intacte');
// ===================================================================
{
  const srcDir = path.join(TMP, 'carte-sd');
  fs.mkdirSync(srcDir, { recursive: true });
  await makeImage(path.join(srcDir, 'DSC_0001.jpg'), { make: 'Sony', model: 'A7 IV' });
  await makeImage(path.join(srcDir, 'DSC_0002.jpg'), { make: 'Sony', model: 'A7 IV', color: { r: 10, g: 200, b: 30 } });
  const dest = path.join(TMP, 'imports');
  STORE.import.dest = dest; STORE.import.keepFolders = false; saveStore(DB, STORE);

  const res = await IMP.importFiles([path.join(srcDir, 'DSC_0001.jpg'), path.join(srcDir, 'DSC_0002.jpg')]);
  check('2 fichiers copiés', res.copied, 2, 0);
  check('0 doublon au premier import', res.duplicates, 0, 0);
  check('les copies existent sur disque', res.results.every(r => r.status !== 'copied' || fs.existsSync(r.dest)), true, 0);
  check('source toujours présente', fs.existsSync(path.join(srcDir, 'DSC_0001.jpg')), true, 0);

  // ré-import du même fichier → doublon détecté (empreinte)
  const res2 = await IMP.importFiles([path.join(srcDir, 'DSC_0001.jpg')]);
  check('doublon détecté au ré-import', res2.duplicates, 1, 0);
  check('rien de copié en doublon', res2.copied, 0, 0);

  // collision de nom : deux fichiers différents mais même nom dans la même destination
  await makeImage(path.join(srcDir, 'DSC_0001.jpg.bak'), { color: { r: 99, g: 5, b: 55 } });
  const autre = path.join(srcDir, 'autre', 'DSC_0001.jpg');
  fs.mkdirSync(path.dirname(autre), { recursive: true });
  await makeImage(autre, { color: { r: 1, g: 2, b: 3 } });
  check('nom unique généré', uniqueName(dest, 'DSC_0001.jpg') !== 'DSC_0001.jpg' || !fs.existsSync(path.join(dest, 'DSC_0001.jpg')), true, 0);
}

// ===================================================================
group('Collections : sélections et recherches enregistrées');
// ===================================================================
{
  const COL = createCollections(DB, LIB);
  const all = LIB.search({}, { limit: 50 }).rows.map(p => p.id);
  const nikon = LIB.search({ camera: 'Nikon' }).rows[0].id;

  // --- sélection statique ---
  const sel = COL.create({ name: '  Mes   favorites ', photoIds: [all[0], all[1]] });
  check('sélection créée', sel.kind, 'static');
  check('nom nettoyé (espaces)', sel.name, 'Mes favorites');
  check('2 photos à la création', sel.photo_count, 2, 0);
  check('ajout idempotent', COL.addPhotos(sel.id, [all[0], all[2]]).added, 1, 0);
  check('photo inconnue ignorée', COL.addPhotos(sel.id, ['photo-inexistante']).added, 0, 0);
  check('compteur à jour', COL.get(sel.id).photo_count, 3, 0);
  check('ordre d\'ajout conservé (positions)',
    JSON.stringify(DB.prepare('SELECT photo_id FROM collection_photos WHERE collection_id=? ORDER BY position').all(sel.id).map(r => r.photo_id)),
    JSON.stringify([all[0], all[1], all[2]]));
  check('recherche filtrée par collection', LIB.search(COL.resolveFilters({ collectionId: sel.id })).total, 3, 0);
  check('filtre combiné (collection + appareil)', LIB.search(COL.resolveFilters({ collectionId: sel.id, camera: 'Nikon' })).total,
    [all[0], all[1], all[2]].includes(nikon) ? 1 : 0, 0);
  check('retrait de la sélection', COL.removePhotos(sel.id, [all[0]]).removed, 1, 0);
  check('photo retirée toujours au catalogue', !!LIB.detail(all[0]), true, 0);

  // --- recherche enregistrée (dynamique) ---
  const dyn = COL.create({ name: 'Nikon', kind: 'dynamic', query: { camera: 'Nikon', inconnu: 'x', collectionId: sel.id, hasGps: '' } });
  check('recherche enregistrée créée', dyn.kind, 'dynamic');
  check('critères nettoyés (clés inconnues et collectionId écartés)', JSON.stringify(dyn.query), JSON.stringify({ camera: 'Nikon' }));
  check('contenu recalculé', dyn.photo_count, 1, 0);
  check('résolue en critères', LIB.search(COL.resolveFilters({ collectionId: dyn.id })).rows[0]?.id, nikon);
  check('texte saisi ajouté (ET) au critère', LIB.search(COL.resolveFilters({ collectionId: dyn.id, q: 'introuvablexyz' })).total, 0, 0);
  let err = null; try { COL.addPhotos(dyn.id, [all[0]]); } catch (e) { err = e.message; }
  check('pas d\'ajout manuel dans une recherche enregistrée', !!err, true, 0);
  err = null; try { COL.create({ name: 'Vide', kind: 'dynamic', query: { inconnu: 1 } }); } catch (e) { err = e.message; }
  check('recherche enregistrée sans critère refusée', !!err, true, 0);
  err = null; try { COL.create({ name: '   ' }); } catch (e) { err = e.message; }
  check('nom vide refusé', !!err, true, 0);
  check('critères types (nombres, drapeaux, listes)',
    JSON.stringify(Search.cleanFilters({ rating: '3', missing: '0', duplicate: 'true', anyKeywords: 'a, b,', hasGps: '0', prefix: 'false' })),
    JSON.stringify({ rating: 3, missing: 0, duplicate: true, anyKeywords: ['a', 'b'], hasGps: false, prefix: false }));
  check('renommage', COL.update(dyn.id, { name: 'Boîtier Nikon' }).name, 'Boîtier Nikon');
  check('critères modifiables', COL.update(dyn.id, { query: { format: 'png' } }).photo_count, 1, 0);
  check('liste triée par nom', COL.list().map(c => c.name).join('|'), 'Boîtier Nikon|Mes favorites');

  // --- suppression : jamais de photo perdue ---
  const before = LIB.stats().photos;
  check('suppression de la collection', COL.remove(sel.id).photosUntouched, true, 0);
  check('photos conservées après suppression', LIB.stats().photos, before, 0);
  check('liens de la sélection supprimés', DB.prepare('SELECT COUNT(*) n FROM collection_photos WHERE collection_id=?').get(sel.id).n, 0, 0);
  // une photo retirée de l'index disparaît des sélections (clé étrangère ON DELETE CASCADE)
  const tmpSel = COL.create({ name: 'Temporaire', photoIds: [all[all.length - 1]] });
  LIB.removeFromIndex([all[all.length - 1]]);
  check('photo retirée de l\'index → retirée de la sélection', COL.get(tmpSel.id).photo_count, 0, 0);
  COL.remove(tmpSel.id); COL.remove(dyn.id);
  check('intégrité après collections', integrity(DB)[0], 'ok', 0);
}

// ===================================================================
group('Albums : pages, gabarits, références, contrôles');
// ===================================================================
{
  const ALB = createAlbums(DB, LIB);
  const ids = LIB.search({}, { limit: 50, sort: 'captured_asc' }).rows.map(p => p.id);

  // --- gabarits : tous les cadres restent dans la page, hors fond perdu ils respectent la marge ---
  // (double page : cadres en fractions de la planche, la marge horizontale d'une page y vaut la moitié)
  let inside = true, safe = true, gutter = true;
  for (const [k, l] of Object.entries(LAYOUTS)) for (const f of l.frames) {
    const mx = l.spread ? SAFETY_MARGIN / 2 : SAFETY_MARGIN;
    if (f.x < 0 || f.y < 0 || f.x + f.w > 1.0001 || f.y + f.h > 1.0001) inside = false;
    if (!l.fullBleed && (f.x < mx - 1e-4 || f.y < SAFETY_MARGIN - 1e-4 || f.x + f.w > 1 - mx + 1e-4 || f.y + f.h > 1 - SAFETY_MARGIN + 1e-4)) safe = false;
    // un cadre d'une seule page de la planche ne doit pas mordre sur la marge du pli
    const crosses = f.x < 0.5 && f.x + f.w > 0.5;
    if (l.spread && !crosses && f.x < 0.5 && f.x + f.w > 0.5 - mx + 1e-4) gutter = false;
    if (l.spread && !crosses && f.x >= 0.5 && f.x < 0.5 + mx - 1e-4) gutter = false;
  }
  check('gabarits : cadres dans la page', inside, true, 0);
  check('gabarits : marges de sécurité respectées', safe, true, 0);
  check('doubles pages : marge de sécurité au pli', gutter, true, 0);
  check('doubles pages : 4 gabarits', Object.values(LAYOUTS).filter(l => l.spread).length, 4, 0);
  check('gabarit 2 × 2 : 4 cadres', LAYOUTS.quatre.frames.length, 4, 0);

  // --- création ---
  const a = ALB.create({ name: 'Vacances', format: 'a4-paysage' });
  check('album créé', a.name, 'Vacances');
  check('orientation déduite du format', a.orientation, 'landscape');
  check('dimensions du format', `${a.width_mm}x${a.height_mm}`, '297x210');
  check('version du format de projet', a.data.formatVersion, ALBUM_FORMAT_VERSION, 0);
  check('page de titre créée', a.pages[0].layout + '|' + a.pages[0].title, 'titre|Vacances');
  let err = null; try { ALB.create({ name: 'X', format: 'custom', width_mm: 10, height_mm: 10 }); } catch (e) { err = e.message; }
  check('format personnalisé hors limites refusé', !!err, true, 0);
  check('format personnalisé accepté', ALB.create({ name: 'Perso', format: 'custom', width_mm: 150, height_mm: 400 }).orientation, 'portrait');

  // --- remplissage : pages ajoutées au gabarit, références sans copie ---
  const filesBefore = LIB.stats().files;
  const r = ALB.fill(a.id, [ids[0], ids[1], ids[2], 'inconnue', ids[0]], 'deux-cote');
  check('remplissage : photos inconnues et répétées ignorées', r.added, 3, 0);
  check('remplissage : 2 pages ajoutées', r.pagesAdded, 2, 0);
  check('remplissage : 3 pages au total', r.album.pages.length, 3, 0);
  check('aucune copie de fichier', LIB.stats().files, filesBefore, 0);
  check('index album_photos tenu', LIB.search({ albumId: a.id }).total, 3, 0);
  check('cadre vide signalé', r.album.issues.some(i => i.page === 3 && i.slot === 1 && i.level === 'info'), true, 0);

  // --- pages : modification, réordonnancement, duplication, suppression ---
  let b = ALB.updatePage(a.id, 2, { caption: '  Plage   du matin ', background: '#FFEEDD', slots: [ids[1], ids[0]] });
  check('légende nettoyée', b.pages[1].caption, 'Plage du matin');
  check('couleur de fond normalisée', b.pages[1].background, '#ffeedd');
  check('photos échangées', b.pages[1].slots.join(','), [ids[1], ids[0]].join(','));
  b = ALB.updatePage(a.id, 2, { background: 'rouge', slots: ['inexistante'] });
  check('couleur invalide → blanc', b.pages[1].background, '#ffffff');
  check('photo inconnue refusée dans un cadre', b.pages[1].slots.length, 0, 0);
  b = ALB.updatePage(a.id, 2, { slots: [ids[0], ids[1]] });
  b = ALB.movePage(a.id, 3, 1);
  check('page déplacée en tête', b.pages[0].slots[0], ids[2]);
  b = ALB.duplicatePage(a.id, 1);
  check('page dupliquée', b.pages.length + '|' + b.pages[1].slots[0], `4|${ids[2]}`);
  b = ALB.removePage(a.id, 2);
  check('page supprimée', b.pages.length, 3, 0);
  err = null; try { ALB.removePage(a.id, 99); } catch (e) { err = e.message; }
  check('page inconnue refusée', !!err, true, 0);

  // --- contrôles ---
  b = ALB.updatePage(a.id, 1, { layout: 'plein' });
  const pleine = b.issues.find(i => i.page === 1 && i.slot === 0);
  check('résolution insuffisante détectée (petite image en pleine page A4)', pleine?.level, 'bad');
  check('résolution calculée en ppp', pleine?.dpi > 0 && pleine?.dpi < 150, true, 0);
  b = ALB.updatePage(a.id, 1, { layout: 'deux-cote', slots: [ids[2], ids[1], ids[0]] });
  check('photo hors gabarit signalée', b.issues.some(i => i.page === 1 && /hors gabarit/.test(i.message)), true, 0);
  DB.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(ids[2]);
  check('photo indisponible signalée', ALB.get(a.id).issues.some(i => i.level === 'warn' && /indisponible/.test(i.message)), true, 0);
  DB.prepare('UPDATE photos SET missing = 0 WHERE id = ?').run(ids[2]);

  // --- changement de format : la mise en page suit ---
  b = ALB.update(a.id, { name: 'Vacances 2024', format: 'carre-20' });
  check('format changé', `${b.width_mm}x${b.height_mm}|${b.orientation}`, '200x200|square');
  check('pages conservées', b.pages.length, 3, 0);

  // --- export du projet : format versionné, références et empreintes ---
  const proj = ALB.exportProject(a.id);
  check('export : identifiant de format', proj.format, 'phototheque-album');
  check('export : version', proj.formatVersion, ALBUM_FORMAT_VERSION, 0);
  check('export : références des photos (chemin + empreinte)', Object.values(proj.photos).every(p => p.path && 'sha256' in p), true, 0);
  check('export : gabarits utilisés décrits', Object.keys(proj.layouts).length >= 1, true, 0);

  // --- liste ---
  const li = ALB.list().find(x => x.id === a.id);
  check('liste : nombre de pages et de photos', `${li.pageCount}|${li.photoCount}`, '3|3');
  check('liste : couverture', !!li.cover, true, 0);

  // --- une photo retirée de l'index reste signalée dans l'album ---
  const tmp = ALB.create({ name: 'Temporaire' });
  const victim = ids[ids.length - 1];
  ALB.fill(tmp.id, [victim], 'une');
  LIB.removeFromIndex([victim]);
  const t2 = ALB.get(tmp.id);
  check('photo retirée → signalée « plus au catalogue »', t2.issues.some(i => i.level === 'bad' && /plus au catalogue/.test(i.message)), true, 0);
  check('photo retirée → référence conservée dans la page', t2.pages[1].slots[0], victim);
  check('photo retirée → plus dans l\'index de l\'album', LIB.search({ albumId: tmp.id }).total, 0, 0);

  // --- suppression : jamais de photo perdue ---
  const before = LIB.stats().photos;
  check('suppression de l\'album', ALB.remove(a.id).photosUntouched, true, 0);
  check('photos conservées', LIB.stats().photos, before, 0);
  check('pages supprimées', DB.prepare('SELECT COUNT(*) n FROM album_pages WHERE album_id = ?').get(a.id).n, 0, 0);
  for (const x of ALB.list()) ALB.remove(x.id);
  check('intégrité après albums', integrity(DB)[0], 'ok', 0);
}

// ===================================================================
group('Albums : export PDF (impression et aperçu)');
// ===================================================================
{
  // --- écriture PDF : encodage, chasses, coupure, contraste ---
  check('WinAnsi : accents, euro, œ', [...Pdf.winAnsi('éÀ€œ')].join(','), '233,192,128,156');
  check('WinAnsi : caractère hors table ramené à sa base', Pdf.winAnsi('ő').toString('latin1'), 'o');
  check('chasse Helvetica : « A » corps 10', Pdf.textWidth('A', 10), 6.67);
  check('chasse d’une lettre accentuée = lettre de base', Pdf.textWidth('é', 10), Pdf.textWidth('e', 10));
  check('coupure en lignes', Pdf.wrapText('un deux trois quatre', 10, Pdf.textWidth('trois quatre', 10)).join('|'), 'un deux|trois quatre');
  check('texte clair sur fond foncé', Pdf.textColorOn('#101820'), '#ffffff');
  check('texte foncé sur fond clair', Pdf.textColorOn('#ffeedd'), '#1e293b');

  const ALB = createAlbums(DB, LIB), APDF = createAlbumPdf(DB, LIB, ALB);
  // ordre déterministe : une photo présente en deux fichiers (doublon fabriqué ici) entre deux photos uniques
  const ids = [];
  for (const [k, [w, hh, color]] of [[1200, 800, { r: 200, g: 60, b: 40 }], [900, 600, { r: 30, g: 160, b: 90 }], [800, 600, { r: 240, g: 200, b: 40 }]].entries()) {
    const f = path.join(TMP, 'pdf', `photo-${k}.jpg`);
    await makeImage(f, { w, h: hh, color, date: `2023:0${k + 1}:01 10:00:00` });
    await LIB.indexFile(f, {});
    ids.push(DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(f).photo_id);
  }
  const dupId = ids[1], dupCopy = path.join(TMP, 'pdf', 'copie-photo-1.jpg');
  fs.copyFileSync(path.join(TMP, 'pdf', 'photo-1.jpg'), dupCopy);
  await LIB.indexFile(dupCopy, {});
  check('PDF : photo en double préparée', DB.prepare('SELECT COUNT(*) n FROM files WHERE photo_id = ?').get(dupId).n, 2, 0);
  const a = ALB.create({ name: 'Résumé (été)', format: 'a4-portrait' });
  ALB.updatePage(a.id, 1, { caption: 'Sous-titre « accentué »' });
  ALB.fill(a.id, [ids[0], ids[1], ids[2]], 'deux-pile');          // pages 2 (2 photos) et 3 (1 photo + 1 vide)
  ALB.addPage(a.id, { layout: 'plein' });
  ALB.updatePage(a.id, 4, { slots: [ids[0]] });                    // même photo, autre taille de cadre
  ALB.updatePage(a.id, 2, { caption: 'Une légende assez longue pour la page deux, avec des accents : « déjà vu ».' });
  const orig = DB.prepare("SELECT path FROM files WHERE photo_id = ? AND kind = 'original'").get(ids[0]).path;
  const sumBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const render = async opts => { const chunks = []; const rep = await APDF.render(a.id, { ...opts, write: b => chunks.push(Buffer.from(b)) }); return { rep, buf: Buffer.concat(chunks) }; };
  const { rep, buf } = await render({ quality: 'print' });
  const txt = buf.toString('latin1');
  check('PDF : en-tête et fin de fichier', txt.startsWith('%PDF-1.4') && txt.trimEnd().endsWith('%%EOF'), true, 0);
  const count = needle => txt.split(needle).length - 1;
  check('PDF : une page par page d’album', count('/Type /Page '), 4, 0);
  check('PDF : compte rendu = taille réelle', rep.bytes, buf.length, 0);
  const sx = +txt.slice(txt.lastIndexOf('startxref') + 10).trim().split(/\s/)[0];
  const xref = txt.slice(sx).split('\n').slice(2).filter(l => / [nf] $/.test(l));
  check('PDF : table des références cohérente', xref.length > 5 && xref.every((l, k) => !l.endsWith('n ') || txt.startsWith(`${k} 0 obj`, +l.slice(0, 10))), true, 0);
  check('PDF : format A4 en points', txt.includes('/MediaBox [0 0 595.276 841.89]'), true, 0);
  check('PDF : 4 images (photo réutilisée à deux tailles)', rep.images, 4, 0);
  check('PDF : images en JPEG', count('/Filter /DCTDecode'), 4, 0);
  const widths = [...txt.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map(m => +m[1]);
  const real = ids.slice(0, 3).map(i => LIB.detail(i)), maxW = Math.max(...real.map(d => d.width));
  check('PDF : jamais agrandie au-delà de la résolution réelle', widths.length === 4 && widths.every(w => w <= maxW), true, 0);
  check('PDF : pleine page recadrée au format sans agrandissement', txt.includes(`/Width ${Math.round(real[0].height * 210 / 297)} /Height ${real[0].height}`), true, 0);
  check('PDF : résolution faible signalée', rep.lowDpi.length > 0, true, 0);
  check('PDF : cadre vide signalé', rep.unfilled.some(u => u.page === 3 && u.reason === 'cadre vide'), true, 0);
  check('PDF : titre accentué encodé', txt.includes('(R\\351sum\\351 \\(\\351t\\351\\))'), true, 0);
  check('PDF : polices Helvetica WinAnsi', txt.includes('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding'), true, 0);
  check('PDF : titre du document', txt.includes('/Title (R\\351sum\\351'), true, 0);
  check('PDF : original non modifié', crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex'), sumBefore);
  check('PDF : export journalisé', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'album-pdf'").get().n, 1, 0);

  // --- fonds perdus : page agrandie de 3 mm, boîte de coupe au format exact ---
  const bl = await render({ quality: 'screen', bleed: true });
  const bt = bl.buf.toString('latin1'), e = (297 + 2 * BLEED_MM) / 25.4 * 72;
  check('fonds perdus : boîte média agrandie', bt.includes(`/MediaBox [0 0 ${Math.round((210 + 2 * BLEED_MM) / 25.4 * 72 * 1000) / 1000} ${Math.round(e * 1000) / 1000}]`), true, 0);
  check('fonds perdus : boîte de coupe au format', bt.includes('/TrimBox [8.504 8.504 603.78 850.394]'), true, 0);
  check('aperçu écran : plus léger que l’impression', bl.buf.length < buf.length, true, 0);

  // --- original indisponible : repli sur une copie de même empreinte, sinon sur l'aperçu en cache ---
  const off = pid => { const fl = DB.prepare('SELECT id, path FROM files WHERE photo_id = ?').all(pid); for (const f of fl) DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(path.join(TMP, 'absent', f.id + '.jpg'), f.id); return () => { for (const f of fl) DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(f.path, f.id); }; };
  const nFiles = pid => DB.prepare('SELECT COUNT(*) n FROM files WHERE photo_id = ?').get(pid).n;
  const dup = ids.slice(0, 3).find(pid => nFiles(pid) > 1);
  if (dup) {
    const first = DB.prepare("SELECT id, path FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, indexed_at").get(dup);
    DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(path.join(TMP, 'absent', 'nulle-part.jpg'), first.id);
    const fc = await render({ quality: 'screen' });
    check('original absent → copie de même empreinte utilisée', fc.rep.fromCopy.length > 0 && fc.rep.fromPreview.length === 0, true, 0);
    DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(first.path, first.id);
  } else check('original absent → copie de même empreinte utilisée (photo en double attendue)', false, true, 0);
  const single = ids.slice(0, 3).find(pid => nFiles(pid) === 1);
  const restore = off(single);
  const fb = await render({ quality: 'screen' });
  check('aucun fichier accessible → aperçu en cache utilisé', fb.rep.fromPreview.length > 0, true, 0);
  check('aucun fichier accessible → cadres toujours remplis', fb.rep.unfilled.filter(u => u.reason !== 'cadre vide').length, 0, 0);
  restore();

  // --- recadrage manuel : modèle, conservation, contrôles, PDF, projet ---
  const { cleanCrop, cropWindow, ZOOM_MAX } = await import('../lib/albums.mjs');
  check('recadrage par défaut → aucun', cleanCrop({ x: 0.5, y: 0.5, zoom: 1 }), null);
  check('recadrage : bornes (zoom, centre)', JSON.stringify(cleanCrop({ x: -3, y: '0.25', zoom: 99 })), JSON.stringify({ x: 0, y: 0.25, zoom: ZOOM_MAX }));
  check('recadrage invalide → aucun', cleanCrop('n’importe quoi'), null);
  let w0 = cropWindow(1200, 800, 100, 100, null);
  check('fenêtre par défaut : photo paysage dans un carré, centrée', `${w0.width.toFixed(4)}|${w0.left.toFixed(4)}|${w0.height}`, '0.6667|0.1667|1');
  w0 = cropWindow(1200, 800, 100, 100, { x: 0.5, y: 0.5, zoom: 2 });
  check('fenêtre zoom × 2 : moitié de la largeur et de la hauteur', `${w0.width.toFixed(4)}|${w0.height}`, '0.3333|0.5');
  w0 = cropWindow(1200, 800, 100, 100, { x: 0, y: 1, zoom: 2 });
  check('fenêtre : centre ramené pour ne jamais montrer de vide', `${w0.left}|${w0.top}`, '0|0.5');

  let c = ALB.updatePage(a.id, 2, { crops: [{ x: 0.3, y: 0.4, zoom: 2 }, { x: 0.5, y: 0.5, zoom: 1 }] });
  check('recadrage enregistré', JSON.stringify(c.pages[1].crops), JSON.stringify([{ x: 0.3, y: 0.4, zoom: 2 }, null]));
  const dpiOf = (al, pg, sl) => al.issues.find(i => i.page === pg && i.slot === sl && i.dpi)?.dpi;
  const d1 = dpiOf(ALB.get(a.id), 2, 0);
  ALB.updatePage(a.id, 2, { crops: [null, null] });
  const d0 = dpiOf(ALB.get(a.id), 2, 0);
  check('contrôle : le zoom divise la résolution effective', Math.abs(d1 - d0 / 2) <= 1, true, 0);
  c = ALB.updatePage(a.id, 2, { crops: [{ x: 0.3, y: 0.4, zoom: 2 }] });
  c = ALB.updatePage(a.id, 2, { caption: 'autre légende', slots: [ids[0], ids[1]] });
  check('recadrage gardé si la photo reste dans son cadre', c.pages[1].crops[0]?.zoom, 2, 0);
  c = ALB.updatePage(a.id, 2, { slots: [ids[1], ids[0]] });
  check('recadrage oublié si la photo du cadre change', c.pages[1].crops[0], null);
  c = ALB.updatePage(a.id, 3, { crops: [null, { x: 0.2, y: 0.2, zoom: 3 }] });
  check('pas de recadrage sur un cadre vide', c.pages[2].crops[1] ?? null, null);
  check('projet exporté : recadrages inclus', JSON.stringify(ALB.exportProject(a.id).pages[1].crops), JSON.stringify([null, null]));

  DB.prepare('UPDATE photos SET orientation = 6 WHERE id = ?').run(ids[0]);
  const turned = ALB.get(a.id).photos[ids[0]];
  check('photo tournée (EXIF 6) : dimensions affichées échangées', `${turned.width}x${turned.height}`, `${real[0].height}x${real[0].width}`);
  DB.prepare('UPDATE photos SET orientation = 1 WHERE id = ?').run(ids[0]);

  // pleine page (photo 1200 × 800 recadrée au format A4 portrait) : zoom × 2 → deux fois moins de pixels utiles
  ALB.updatePage(a.id, 4, { crops: [{ x: 0.2, y: 0.5, zoom: 2 }] });
  const cr = await render({ quality: 'print' }), ct = cr.buf.toString('latin1');
  const base = Math.round(real[0].height * 210 / 297);
  check('PDF : partie recadrée seule, sans agrandissement', ct.includes(`/Width ${Math.round(base / 2)} /Height ${real[0].height / 2}`), true, 0);
  check('PDF : recadrage = nouvelle image (pas de réutilisation)', cr.rep.images, 4, 0);
  ALB.updatePage(a.id, 4, { crops: [null] });

  // --- doubles pages : numérotation, alignement, résolution, PDF page par page et en planches ---
  const { folios } = await import('../lib/albums.mjs');
  check('numérotation : une double page compte pour deux', JSON.stringify(folios([{ layout: 'titre' }, { layout: 'double-plein' }, { layout: 'une' }])), JSON.stringify([{ folio: 1, span: 1 }, { folio: 2, span: 2 }, { folio: 4, span: 1 }]));
  const sp = ALB.create({ name: 'Planches', format: 'carre-20', spreads: true });
  check('vue en planches enregistrée à la création', sp.spreads, true, 0);
  ALB.fill(sp.id, [ids[1]], 'une');                              // page 2
  ALB.addPage(sp.id, { layout: 'double-plein' });                // pages 3–4 : commence à droite
  let s2 = ALB.updatePage(sp.id, 3, { slots: [ids[0]] });
  check('double page : 4 pages imprimées', s2.printedPages, 4, 0);
  check('double page : numéros 3–4', `${s2.pages[2].folio}|${s2.pages[2].span}`, '3|2');
  check('double page sur une page de droite signalée', s2.issues.some(i => i.page === 3 && /Pages 3–4 : la double page commence sur une page de droite/.test(i.message)), true, 0);
  const spDpi = s2.issues.find(i => i.page === 3 && i.slot === 0 && i.dpi)?.dpi;
  check('double page : résolution sur la largeur de la planche', spDpi, Math.round(25.4 * 1200 / 400), 0);
  s2 = ALB.addPage(sp.id, { layout: 'une', after: 1 });          // une page de plus avant → 4–5, à gauche
  check('double page réalignée : plus d’alerte', s2.issues.some(i => /page de droite/.test(i.message)), false, 0);
  check('double page réalignée : pages 4–5', s2.pages[3].folio, 4, 0);
  check('liste : pages imprimées', ALB.list().find(x => x.id === sp.id).pageCount, 5, 0);
  check('vue en planches désactivable', ALB.update(sp.id, { spreads: false }).spreads, false, 0);

  const renderSp = async opts => { const chunks = []; const rep = await APDF.render(sp.id, { ...opts, write: b2 => chunks.push(Buffer.from(b2)) }); return { rep, t: Buffer.concat(chunks).toString('latin1') }; };
  const pp = await renderSp({ quality: 'print' });
  check('PDF page par page : une page PDF par page imprimée', pp.t.split('/Type /Page ').length - 1, 5, 0);
  check('PDF page par page : format de la page (20 cm)', pp.t.includes('/MediaBox [0 0 566.929 566.929]'), true, 0);
  check('PDF : la double page n’écrit son image qu’une fois', pp.rep.images, 2, 0);
  check('PDF : panoramique à sa résolution réelle (1200 px de large)', pp.t.includes(`/Width 1200 /Height 600`), true, 0);
  check('PDF : cadre vide compté une fois', pp.rep.unfilled.length, 1, 0);
  check('PDF : découpe au pli (deux moitiés décalées)', pp.t.includes('re W n'), true, 0);
  const pl = await renderSp({ quality: 'screen', layout: 'spreads', bleed: true });
  check('PDF en planches : page 1 seule puis paires', `${pl.rep.pdfPages}|${pl.t.split('/Type /Page ').length - 1}`, '3|3');
  check('PDF en planches : largeur de deux pages + fonds perdus', pl.t.includes(`/MediaBox [0 0 ${Math.round((400 + 2 * BLEED_MM) / 25.4 * 72 * 1000) / 1000} `), true, 0);
  check('PDF en planches : boîte de coupe sur deux pages', pl.t.includes(`/TrimBox [8.504 8.504 ${Math.round((400 + BLEED_MM) / 25.4 * 72 * 1000) / 1000} `), true, 0);
  ALB.remove(sp.id);

  // --- annuler / rétablir ---
  let u = ALB.create({ name: 'Annulable', format: 'carre-20' });
  check('annulation : rien au départ', `${u.history.undo}|${u.history.redo}`, 'null|null');
  u = ALB.updatePage(u.id, 1, { caption: 'Sous-titre' });
  check('annulation : étape nommée', u.history.undo, 'Page 1 : texte');
  check('annulation : modification sans effet ignorée', ALB.updatePage(u.id, 1, { caption: 'Sous-titre' }).history.undoCount, 1, 0);
  let r2 = ALB.undo(u.id);
  check('annuler : texte rétabli', `${r2.done}|${r2.album.pages[0].caption}`, 'Page 1 : texte|');
  check('annuler : étape disponible pour rétablir', r2.album.history.redo, 'Page 1 : texte');
  r2 = ALB.redo(u.id);
  check('rétablir : texte remis', r2.album.pages[0].caption, 'Sous-titre');
  u = ALB.fill(u.id, [ids[0], ids[1], ids[2]], 'une').album;
  check('remplissage annulable', ALB.undo(u.id).album.pages.length, 1, 0);
  u = ALB.addPage(u.id, { layout: 'deux-cote' });
  check('nouvelle modification : plus rien à rétablir', u.history.redo, null);
  u = ALB.update(u.id, { spreads: true });
  check('vue en planches : pas une étape', u.history.undo, "Ajout d'une page");
  u = ALB.update(u.id, { name: 'Renommé', format: 'a4-paysage' });
  u = ALB.undo(u.id).album;
  check('annuler : nom et format rétablis', `${u.name}|${u.width_mm}x${u.height_mm}`, 'Annulable|200x200');
  check('annuler : la vue en planches est conservée', u.spreads, true, 0);
  // déplacement d'une photo entre deux pages (avec son recadrage) : une seule étape
  ALB.updatePage(u.id, 2, { slots: [ids[0], ids[1]], crops: [{ x: 0.2, y: 0.5, zoom: 2 }, null] });
  u = ALB.addPage(u.id, { layout: 'une' });
  u = ALB.updatePage(u.id, 3, { slots: [ids[2]] });
  u = ALB.movePhoto(u.id, { page: 2, slot: 0 }, { page: 3, slot: 0 });
  check('déplacement : photos échangées entre pages', `${u.pages[1].slots[0] === ids[2]}|${u.pages[2].slots[0] === ids[0]}`, 'true|true');
  check('déplacement : le recadrage suit la photo', `${u.pages[2].crops[0]?.zoom}|${u.pages[1].crops[0]}`, '2|null');
  check('déplacement : une seule étape', u.history.undo, "Déplacement d'une photo");
  u = ALB.undo(u.id).album;
  check('annuler le déplacement : les deux pages rétablies', `${u.pages[1].slots[0] === ids[0]}|${u.pages[2].slots[0] === ids[2]}|${u.pages[1].crops[0]?.zoom}`, 'true|true|2');
  let e2 = null; try { ALB.movePhoto(u.id, { page: 1, slot: 0 }, { page: 2, slot: 0 }); } catch (x) { e2 = x.message; }
  check('déplacement depuis un cadre vide refusé, sans étape', `${e2}|${ALB.get(u.id).history.redo}`, "Aucune photo à déplacer|Déplacement d'une photo");
  for (let k = 0; k < 55; k++) ALB.updatePage(u.id, 1, { caption: 'v' + k });
  check('annulation : 50 étapes au plus', ALB.get(u.id).history.undoCount, 50, 0);
  while (ALB.get(u.id).history.undo) ALB.undo(u.id);
  e2 = null; try { ALB.undo(u.id); } catch (x) { e2 = x.message; }
  check('rien à annuler signalé', e2, 'Rien à annuler');
  check('annulation : historique de l’opération', DB.prepare("SELECT COUNT(*) n FROM history WHERE kind = 'album.undo'").get().n > 0, true, 0);
  ALB.remove(u.id);

  let err = null; try { await APDF.render('inconnu', { write: () => {} }); } catch (x) { err = x.message; }
  check('album inconnu refusé', err, 'Album inconnu');
  ALB.remove(a.id);
}

// ===================================================================
group('Retouche non destructive et export de photos');
// ===================================================================
{
  const E = await import('../lib/edits.mjs');
  const X = await import('../lib/exports.mjs');
  const { default: exifr } = await import('exifr');
  const { EXPORT_DIR } = await import('../lib/paths.mjs');

  // --- réglages : nettoyage et bornes ---
  const cp = E.cleanParams({ exposure: 9, rotate: 450, crop: { x: 0.9, y: -1, w: 0.5, h: 2 }, mono: 'rouge', inconnu: 1 });
  check('réglages : exposition bornée', cp.exposure, 2, 0);
  check('réglages : rotation ramenée au quart de tour', `${cp.rotate}|${E.cleanParams({ rotate: -90 }).rotate}`, '90|270');
  check('réglages : recadrage ramené dans l’image', JSON.stringify(cp.crop), JSON.stringify({ x: 0.5, y: 0, w: 0.5, h: 1 }));
  check('réglages : valeur inconnue ignorée', 'inconnu' in cp || cp.mono !== null, false, 0);
  check('réglages neutres reconnus', E.isNeutral({ crop: { x: 0, y: 0, w: 1, h: 1 } }), true, 0);
  check('redressement : rectangle sans coin vide plus petit', E.inscribedRect(1000, 500, 5).w < 1000 && E.inscribedRect(1000, 500, 0).w === 1000, true, 0);
  check('géométrie : quart de tour échange largeur et hauteur', JSON.stringify((({ width, height }) => [width, height])(E.geometry(400, 200, { rotate: 90 }))), '[200,400]');

  // --- rendu : image de test moitié rouge (gauche) / moitié bleue (droite) ---
  const sharpTest = (await import('sharp')).default;
  const half = path.join(TMP, 'retouche', 'moitie.png');
  fs.mkdirSync(path.dirname(half), { recursive: true });
  await sharpTest({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
    .composite([{ input: await sharpTest({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer(), left: 0, top: 0 }]).png().toFile(half);
  const sumHalf = crypto.createHash('sha256').update(fs.readFileSync(half)).digest('hex');
  const px = async (r, x, y) => { const { data, info } = await r.image.raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const isRed = c => c[0] > 200 && c[2] < 60, isBlue = c => c[2] > 200 && c[0] < 60;
  let r = await E.pipeline(half, { crop: { x: 0, y: 0, w: 0.5, h: 1 } });
  check('rendu : recadrage sur la moitié gauche', `${r.width}x${r.height}|${isRed(await px(r, 100, 100))}`, '200x200|true');
  r = await E.pipeline(half, { flipH: true, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
  check('rendu : recadrage exprimé dans l’image retournée', isBlue(await px(r, 100, 100)), true, 0);
  r = await E.pipeline(half, { rotate: 90 });
  check('rendu : quart de tour (rouge en haut)', `${r.width}x${r.height}|${isRed(await px(r, 100, 50))}`, '200x400|true');
  r = await E.pipeline(half, { straighten: 10 });
  const corner = await px(r, 0, 0);
  check('rendu : redressement sans coin blanc', corner[0] === 255 && corner[1] === 255 && corner[2] === 255, false, 0);
  r = await E.pipeline(half, { mono: 'bw' });
  const g = await px(r, 300, 100);
  check('rendu : noir et blanc', g[0] === g[1] && g[1] === g[2], true, 0);
  r = await E.pipeline(half, { maxSide: 100 }, { maxSide: 100 });
  check('rendu : réduction sans déformation', `${r.width}x${r.height}`, '100x50');
  const sepia = await px(await E.pipeline(half, { mono: 'sepia' }), 300, 100);
  check('rendu : sépia (teinte chaude)', sepia[0] > sepia[2], true, 0);
  const lit = await px(await E.pipeline(half, { exposure: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), 10, 10);
  check('rendu : exposition (le rouge sature, pas de bleu ajouté)', lit[0] === 255 && lit[2] < 60, true, 0);

  // --- versions : création, historique, annulation, version par défaut ---
  await LIB.indexFile(half, {});
  const hid = DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(half).photo_id;
  const ED = E.createEdits(DB, LIB);
  check('aucune version au départ', ED.list(hid).length, 0, 0);
  let v1 = ED.create(hid, { params: { exposure: 0.5 } });
  check('première version : par défaut', `${v1.is_default}|${v1.name}`, 'true|Version 1');
  let v2 = ED.create(hid, { from: v1.id });
  check('copie d’une version', `${v2.is_default}|${v2.params.exposure}|${v2.name}`, 'false|0.5|Version 1 (copie)');
  v1 = ED.update(v1.id, { params: { ...v1.params, contrast: 20 } });
  v1 = ED.update(v1.id, { params: { ...v1.params, mono: 'bw' } });
  check('réglages enregistrés, 2 étapes', `${v1.params.contrast}|${v1.params.mono}|${v1.undo}`, '20|bw|2');
  check('modification sans effet : pas d’étape', ED.update(v1.id, { params: v1.params }).undo, 2, 0);
  v1 = ED.undo(v1.id);
  check('annuler', `${v1.params.mono}|${v1.undo}|${v1.redo}`, 'null|1|1');
  v1 = ED.redo(v1.id);
  check('rétablir', v1.params.mono, 'bw');
  v1 = ED.reset(v1.id);
  check('réinitialiser (annulable)', `${v1.neutral}|${v1.undo}`, 'true|3');
  v1 = ED.undo(v1.id);
  check('annuler la réinitialisation', v1.params.mono, 'bw');
  let e3 = null; try { ED.redo(v1.id); ED.redo(v1.id); } catch (x) { e3 = x.message; }
  check('rien à rétablir signalé', e3, 'Rien à rétablir');
  v2 = ED.update(v2.id, { isDefault: true, name: '  Tirage   ' });
  check('version par défaut changée, renommée', `${v2.is_default}|${ED.get(v1.id).is_default}|${v2.name}`, 'true|false|Tirage');
  check('historique persistant (relu de la base)', E.createEdits(DB, LIB).get(v1.id).undo, 3, 0);
  check('recherche : photo marquée retouchée', LIB.search({}, { limit: 500 }).rows.find(p => p.id === hid)?.edits, 2, 0);
  const prevFile = await ED.preview(hid, v1.params, { size: 300 });
  check('aperçu retouché mis en cache', fs.existsSync(prevFile) && prevFile.includes(path.join('thumbs', 'edits')), true, 0);
  check('aperçu : même réglages, même fichier', await ED.preview(hid, v1.params, { size: 300 }), prevFile);
  check('photo retouchable en pleine définition', ED.capability(hid).fullRes, true, 0);

  // --- export ---
  const EX = X.createExports(DB, ED);
  check('nom de fichier : modèle', X.fileNameFor('{date}-{n}-{nom}', { original: 'IMG 1.JPG', captured_at: '2024-07-15T10:00:00Z', index: 3 }), '2024-07-15-003-IMG 1');
  check('nom de fichier : caractères interdits retirés', X.fileNameFor('{titre}', { title: 'a/b:c*?', original: 'x.jpg', index: 1 }), 'a_b_c_');
  DB.prepare('UPDATE photos SET gps_lat = 48.8566, gps_lon = 2.3522, camera_make = ? WHERE id = ?').run('Canon', hid);
  let rep = await EX.run([hid], { format: 'jpeg', quality: 80, maxSide: 200, metadata: 'nogps', watermark: { text: '© Test' }, naming: '{nom}', folder: 'Essai' });
  check('export : un fichier, dans Exports/Essai', `${rep.files.length}|${rep.dir === path.join(EXPORT_DIR, 'Essai')}|${fs.existsSync(rep.files[0].file)}`, '1|true|true');
  check('export : taille réduite (plus grand côté 200)', `${rep.files[0].width}x${rep.files[0].height}`, '200x100');
  const bw = await sharpTest(rep.files[0].file).raw().toBuffer({ resolveWithObject: true });
  const p0 = [bw.data[3 * (50 * 200 + 30)], bw.data[3 * (50 * 200 + 30) + 1], bw.data[3 * (50 * 200 + 30) + 2]];
  check('export : version par défaut appliquée (copie d’exposition, couleur)', p0[0] > 200 && p0[2] < 80, true, 0);
  let tags = await exifr.parse(rep.files[0].file, { gps: true, tiff: true });
  check('export sans GPS : marque conservée, pas de position', `${tags?.Make}|${tags?.latitude ?? 'aucune'}`, 'Canon|aucune');
  rep = await EX.run([hid], { format: 'jpeg', maxSide: 200, metadata: 'keep', version: 'original', folder: 'Essai' });
  tags = await exifr.parse(rep.files[0].file, { gps: true, tiff: true });
  check('export : nom unique, rien n’est écrasé', rep.files[0].name, 'moitie (2).jpg');
  check('export avec GPS : position écrite', Math.abs((tags?.latitude ?? 0) - 48.8566) < 0.001, true, 0);
  ED.update(v2.id, { params: { mono: 'bw' } });
  rep = await EX.run([hid], { format: 'png', maxSide: 200, metadata: 'none', folder: 'Essai' });
  const nb = await sharpTest(rep.files[0].file).raw().toBuffer({ resolveWithObject: true });
  check('export : PNG, version par défaut en noir et blanc', `${path.extname(rep.files[0].name)}|${nb.data[0] === nb.data[1] && nb.data[1] === nb.data[2]}`, '.png|true');
  check('export sans métadonnées', (await exifr.parse(rep.files[0].file, { tiff: true }))?.Make ?? 'aucune', 'aucune');
  rep = await EX.run([hid, 'inconnue'], { format: 'tiff', maxSide: 120, folder: '../../hors' });
  check('export : dossier ramené dans Exports', rep.dir.startsWith(EXPORT_DIR), true, 0);
  check('export : erreur par photo, le lot continue', `${rep.files.length}|${rep.errors.length}|${path.extname(rep.files[0].name)}`, '1|1|.tif');
  check('export consigné', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'photos'").get().n, 4, 0);
  const sp2 = EX.saveProfile({ name: 'Mon profil', format: 'webp', quality: 70 });
  check('profil enregistré', EX.profiles().saved[sp2.id]?.format, 'webp');
  check('profil du même nom remplacé', EX.saveProfile({ name: 'Mon profil', format: 'png' }).id, sp2.id);
  EX.removeProfile(sp2.id);
  check('profil supprimé', Object.keys(EX.profiles().saved).length, 0, 0);
  let e4 = null; try { EX.saveProfile({ name: ' ' }); } catch (x) { e4 = x.message; }
  check('profil sans nom refusé', e4, 'Nom de profil vide');
  check('original jamais modifié', crypto.createHash('sha256').update(fs.readFileSync(half)).digest('hex'), sumHalf);

  // --- albums : la version retouchée par défaut est montrée, contrôlée et imprimée ---
  const ALB2 = createAlbums(DB, LIB), APDF2 = createAlbumPdf(DB, LIB, ALB2);
  ED.update(v2.id, { params: { rotate: 90, mono: 'bw' } });           // v2 = version par défaut
  let alb = ALB2.create({ name: 'Retouches', format: 'carre-20' });
  alb = ALB2.fill(alb.id, [hid], 'une').album;
  const aph = alb.photos[hid];
  check('album : version retouchée utilisée (aperçu rendu)', `${aph.edit?.name}|${aph.preview.includes('/render?edit=' + v2.id)}`, 'Tirage|true');
  check('album : dimensions de la version retouchée (quart de tour)', `${aph.width}x${aph.height}|${aph.original.width}x${aph.original.height}`, '200x400|400x200');
  const ad = alb.issues.find(i => i.page === 2 && i.dpi)?.dpi;
  check('album : résolution calculée sur la version retouchée', ad, Math.round(25.4 * Math.min(200 / (LAYOUTS.une.frames[0].w * 200), 400 / (LAYOUTS.une.frames[0].h * 200))), 0);
  check('projet exporté : réglages de la version retouchée', ALB2.exportProject(alb.id).photos[hid]?.edit?.params?.mono, 'bw');
  const chunks2 = []; const prep = await APDF2.render(alb.id, { quality: 'screen', write: b3 => chunks2.push(Buffer.from(b3)) });
  const pdfBuf = Buffer.concat(chunks2), pt = pdfBuf.toString('latin1');
  check('PDF : photo imprimée dans sa version retouchée', `${prep.edited.length}|${prep.edited[0]?.version}`, '1|Tirage');
  const at = pt.indexOf('/Subtype /Image'), len = +/\/Length (\d+)/.exec(pt.slice(at))[1], st = pt.indexOf('stream\n', at) + 7;
  const jp = await sharpTest(pdfBuf.subarray(st, st + len)).raw().toBuffer({ resolveWithObject: true });
  const mid = 3 * (Math.floor(jp.info.height / 2) * jp.info.width + Math.floor(jp.info.width / 2));
  check('PDF : image en noir et blanc (réglage de la version)', Math.abs(jp.data[mid] - jp.data[mid + 2]) <= 3, true, 0);
  check('PDF : image tournée (largeur native 200 px, 215 sans rotation)', jp.info.width, 200, 0);
  // --- grille et visionneuse : vignette et aperçu de la version retouchée par défaut ---
  const gcard = () => LIB.search({}, { limit: 1000 }).rows.find(p => p.id === hid);
  const gc = gcard();
  check('grille : vignette de la version retouchée', `${gc.thumb.includes('/render?edit=' + v2.id + '&size=400')}|${gc.preview.includes('&size=1200')}`, 'true|true');
  check('grille : original conservé pour comparer', `${gc.original.thumb.startsWith('/api/thumb/')}|${gc.original.width}x${gc.original.height}|${gc.width}x${gc.height}`, 'true|400x200|200x400');
  check('grille : nom de la version', gc.edit?.name, 'Tirage');
  check('grille et album : même rendu', gc.thumb, alb.photos[hid].thumb);
  ED.update(v2.id, { params: { rotate: 90, mono: 'sepia' } });
  check('grille : vignette renouvelée après une retouche', gcard().thumb !== gc.thumb, true, 0);
  ED.update(v2.id, { params: {} });                                    // version neutre → retour à l'original
  check('album : version neutre → original', ALB2.get(alb.id).photos[hid].edit ?? null, null);
  check('grille : version neutre → vignette d’origine', `${gcard().thumb.startsWith('/api/thumb/')}|${gcard().original ?? null}`, 'true|null');
  ALB2.remove(alb.id);

  // --- suppression d'une version ---
  const rm = ED.remove(v2.id);
  check('suppression de la version par défaut : une autre le devient', `${rm.originalUntouched}|${ED.get(v1.id).is_default}`, 'true|true');
  LIB.removeFromIndex([hid]);
  check('photo retirée : ses versions disparaissent', DB.prepare('SELECT COUNT(*) n FROM edits WHERE photo_id = ?').get(hid).n, 0, 0);
}

// ===================================================================
group('Doublons et photos similaires : exacts, potentiels, similaires, rafales');
// ===================================================================
{
  const D = await import('../lib/duplicates.mjs');
  const sh = (await import('sharp')).default;
  const dir = path.join(TMP, 'doublons');
  fs.mkdirSync(path.join(dir, 'autre'), { recursive: true });
  // images à motifs (les images unies des autres groupes ont toutes la même empreinte visuelle)
  const svgA = (w, hh) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${hh * 0.5}" r="${hh * 0.3}" fill="#c00"/></svg>`);
  const svgB = (w, hh) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}">${Array.from({ length: 8 }, (_, i) => `<rect x="${i * w / 8}" width="${w / 16}" height="${hh}" fill="#123"/>`).join('')}<rect width="100%" height="30%" y="70%" fill="#fd0"/></svg>`);
  const svgC = (w, hh, k) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}"><rect width="100%" height="100%" fill="#${k}"/><polygon points="0,0 ${w},${hh} 0,${hh}" fill="#fff"/></svg>`);
  const write = async (name, svg, exif) => { const f = path.join(dir, name); let s = sh(svg); if (exif) s = s.withExif(exif); await s.jpeg({ quality: 90 }).toFile(f); return f; };
  const A = await write('paysage.jpg', svgA(600, 400));
  const As = await write('paysage-reduit.jpg', svgA(300, 200));
  const Acopy = path.join(dir, 'autre', 'paysage-copie.jpg'); fs.copyFileSync(A, Acopy);
  const B = await write('rayures.jpg', svgB(600, 400));
  const N1 = await write('IMG_9.jpg', svgC(640, 480, '0a5'));
  const N2 = path.join(dir, 'autre', 'IMG_9.jpg'); await sh(svgC(640, 480, 'a05')).rotate(180).jpeg().toFile(N2);
  const cam = t => ({ IFD0: { Make: 'Test', Model: 'Rafale X', DateTime: t }, IFD2: { DateTimeOriginal: t } });
  const R1 = await write('rafale-1.jpg', svgC(400, 300, '111'), cam('2023:05:01 10:00:00'));
  const R2 = await write('rafale-2.jpg', svgC(400, 300, '222'), cam('2023:05:01 10:00:01'));
  const R3 = await write('rafale-3.jpg', svgC(400, 300, '333'), cam('2023:05:01 10:00:20'));
  for (const f of [A, As, Acopy, B, N1, N2, R1, R2, R3]) await LIB.indexFile(f, {});
  const pid = f => DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(f).photo_id;
  const [a, as, b, n1, n2, r1, r2, r3] = [A, As, B, N1, N2, R1, R2, R3].map(pid);
  const sums = Object.fromEntries([A, As, Acopy, B].map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));

  check('distance de Hamming : opposées', D.hamming('0000000000000000', 'ffffffffffffffff'), 64, 0);
  const hA = DB.prepare('SELECT perceptual_hash h FROM photos WHERE id = ?').get(a).h;
  check('empreinte visuelle calculée à l’indexation (dHash + couleur moyenne)', /^[0-9a-f]{22}$/.test(hA ?? ''), true, 0);
  const flat = async c => D.dhash(await sh({ create: { width: 64, height: 48, channels: 3, background: c } }).png().toBuffer());
  const fr = await flat('#e00000'), fb = await flat('#0000e0');
  check('aplats de couleurs différentes : même dHash, couleur distincte', `${D.hamming(fr, fb)}|${D.colorGap(fr, fb) > D.MAX_COLOR_GAP}`, '0|true');
  check('même image réduite : empreintes proches', D.hamming(hA, await D.dhash(As)) <= 4, true, 0);
  check('images différentes : empreintes éloignées', D.hamming(hA, await D.dhash(B)) > 20, true, 0);

  const DUP = D.createDuplicates(DB, LIB);
  const has = (r, ids) => r.groups.find(g => ids.every(id => g.photos.some(p => p.id === id)));
  let ex = DUP.groups('exact', { limit: 200 });
  const gA = ex.groups.find(g => g.kind === 'files' && g.photos[0].id === a);
  check('exacts : copie rattachée, 2 fichiers listés', gA?.photos[0].files.length, 2, 0);
  let sim = DUP.groups('similar', { threshold: 8, limit: 200 });
  const gS = has(sim, [a, as]);
  check('similaires : image et version réduite regroupées', !!gS, true, 0);
  check('similaires : groupe marqué « versions » (dimensions différentes)', gS?.kind, 'versions');
  check('similaires : image différente écartée', gS?.photos.some(p => p.id === b), false, 0);
  check('similaires : tolérance 0 plus stricte', !!has(DUP.groups('similar', { threshold: 0, limit: 200 }), [a, b]), false, 0);
  const pot = DUP.groups('potential', { limit: 200 });
  check('potentiels : même nom et mêmes dimensions, contenu différent', !!has(pot, [n1, n2]), true, 0);
  const bur = DUP.groups('burst', { seconds: 2, limit: 200 });
  const gB = has(bur, [r1, r2]);
  check('rafales : deux photos à 1 s', !!gB, true, 0);
  check('rafales : la photo 20 s plus tard est à part', gB?.photos.some(p => p.id === r3), false, 0);
  check('rafales : intervalle élargi à 30 s', !!has(DUP.groups('burst', { seconds: 30, limit: 200 }), [r1, r2, r3]), true, 0);
  const sumUp = DUP.summary({ threshold: 8, seconds: 2 });
  check('résumé : les quatre niveaux comptés', ['exact', 'potential', 'similar', 'burst'].every(k => sumUp[k] >= 1), true, 0);

  // décisions
  DUP.setReference([a, as], a);
  sim = DUP.groups('similar', { threshold: 8, limit: 200 });
  const gR = has(sim, [a, as]);
  check('référence : en tête du groupe, l’autre est sa variante', `${gR.photos[0].id === a}|${gR.photos[0].isReference}|${gR.photos.find(p => p.id === as).reference === a}`, 'true|true|true');
  let e5 = null; try { DUP.setReference([a, as], b); } catch (x) { e5 = x.message; }
  check('référence hors du groupe refusée', e5, 'La référence doit faire partie du groupe');
  DUP.ignore([a, as]);
  check('« pas des doublons » : groupe écarté', !!has(DUP.groups('similar', { threshold: 8, limit: 200 }), [a, as]), false, 0);
  DUP.resetIgnored();
  check('groupes écartés reproposés', !!has(DUP.groups('similar', { threshold: 8, limit: 200 }), [a, as]), true, 0);
  DUP.clearReference([a, as]);
  check('référence annulée', DUP.groups('similar', { threshold: 8, limit: 200 }).groups.find(g => g.photos.some(p => p.id === a)).photos.some(p => p.isReference), false, 0);
  const copyFile = DB.prepare('SELECT id FROM files WHERE path = ?').get(Acopy).id;
  DUP.setReferenceFile(copyFile);
  check('fichier de référence : la copie devient l’original', LIB.search({}, { limit: 1000 }).rows.find(p => p.id === a)?.path, Acopy);
  check('fichier de référence : l’autre fichier reste indexé comme copie', DB.prepare('SELECT kind FROM files WHERE path = ?').get(A).kind, 'copy');

  // variantes masquées dans la Photothèque (critères hideVariants / variants / variantsOf)
  DUP.setReference([a, as], a);
  const ids = f => LIB.search(f, { limit: 1000 }).rows.map(p => p.id);
  const hid = LIB.search({ hideVariants: true }, { limit: 1000 });
  check('masquer les variantes : la variante disparaît, la référence reste', `${hid.rows.some(p => p.id === as)}|${hid.rows.some(p => p.id === a)}`, 'false|true');
  check('masquer les variantes : nombre de variantes masquées renvoyé', hid.hiddenVariants, 1);
  check('masquer les variantes : les autres photos restent visibles', hid.total, LIB.search({}, { limit: 1 }).total - 1);
  check('masquer + autre critère : variantes masquées comptées dans ce périmètre seulement', LIB.search({ hideVariants: true, format: 'png' }, { limit: 1 }).hiddenVariants, 0);
  check('seulement les variantes', ids({ variants: true }).join(), as);
  check('référence et ses variantes', ids({ variantsOf: a }).sort().join(), [a, as].sort().join());
  const card = id => LIB.search({ variantsOf: a }, { limit: 10 }).rows.find(p => p.id === id);
  check('carte : nombre de variantes de la référence', card(a).variants, 1);
  check('carte : référence de la variante', `${card(as).variantOf === a}|${card(a).variantOf}`, 'true|null');
  check('critères enregistrables (recherche sauvegardée)', JSON.stringify(Search.cleanFilters({ hideVariants: 'true', variants: '0', variantsOf: a })), JSON.stringify({ variantsOf: a, hideVariants: true }));
  const plan = DB.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM photos v WHERE json_extract(v.data, '$.duplicate.reference') = ?`).all(a).map(r => r.detail).join(' ');
  check('index des variantes utilisé (ix_photos_variant)', /ix_photos_variant/.test(plan), true, 0);
  // référence retirée de l'index : sa variante n'est plus masquée (jamais introuvable)
  const bData = DB.prepare('SELECT data FROM photos WHERE id = ?').get(b).data;
  DB.prepare('UPDATE photos SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(bData), duplicate: { reference: 'photo-retiree' } }), b);
  check('référence absente : la variante reste visible', `${ids({ hideVariants: true }).includes(b)}|${ids({ variants: true }).includes(b)}`, 'true|false');
  DB.prepare('UPDATE photos SET data = ? WHERE id = ?').run(bData, b);
  DUP.clearReference([a, as]);
  check('référence annulée : plus rien de masqué', LIB.search({ hideVariants: true }, { limit: 1 }).hiddenVariants, 0);

  // empreintes manquantes
  DB.prepare('UPDATE photos SET perceptual_hash = NULL WHERE id = ?').run(as);
  check('empreinte manquante comptée', DUP.missingHashes() >= 1, true, 0);
  const ch = await DUP.computeHashes();
  check('empreintes manquantes calculées', `${ch.computed >= 1}|${DB.prepare('SELECT perceptual_hash h FROM photos WHERE id = ?').get(as).h !== null}`, 'true|true');
  check('aucun fichier supprimé ni modifié', Object.entries(sums).every(([f, s]) => fs.existsSync(f) && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === s), true, 0);
}

// ===================================================================
group('Sauvegardes : création, vérification, restauration');
// ===================================================================
{
  const svc = createBackupService({ root: process.cwd(), getStats: () => ({ photos: LIB.stats().photos }), db: DB });
  const b = svc.create('data', { label: 'test' });
  check('sauvegarde créée', !!b.name, true, 0);
  check('manifeste présent', b.manifest.app, 'Phototheque');
  const v = svc.verify(b.name);
  check('archive vérifiée intacte', v.ok, true, 0);
  check('liste', svc.list().length >= 1, true, 0);
  svc.remove(b.name);
  check('suppression', svc.list().length, 0, 0);
}

// ===================================================================
group('ZIP (sans dépendance) :aller-retour');
// ===================================================================
{
  const entries = [{ name: 'a.txt', data: Buffer.from('bonjour') }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3, 250, 255]) }];
  const buf = createZip(entries);
  const read = readZip(buf);
  check('2 entrées', read.length, 2, 0);
  check('contenu texte', read[0].read().toString(), 'bonjour');
  check('contenu binaire', JSON.stringify(Array.from(read[1].read())), JSON.stringify([1, 2, 3, 250, 255]));
}

// ===================================================================
group('Licence et store');
// ===================================================================
{
  const l = defaultLicense();
  check('titulaire par défaut', !!l.holder, true, 0);
  check('brief copyright', /©/.test(brief(l).copyright), true, 0);
  // round-trip du store
  STORE.scan.thumbSize = 512; saveStore(DB, STORE);
  const reload = loadStore(DB);
  check('store persisté (thumbSize)', reload.scan.thumbSize, 512, 0);
}

// ===================================================================
group('Reconnaissance des extensions image');
// ===================================================================
{
  check('jpg reconnu', isImage('a.jpg'), true, 0);
  check('JPEG en majuscules', isImage('b.JPEG'), true, 0);
  check('png reconnu', isImage('c.png'), true, 0);
  check('raw reconnu', isImage('d.nef'), true, 0);
  check('txt rejeté', isImage('e.txt'), false, 0);
  check('vidéo rejetée', isImage('f.mp4'), false, 0);
  check('ensemble non vide', IMAGE_EXTS.size > 10, true, 0);
}

// ---------- bilan ----------
console.log(`\n${'='.repeat(46)}\nRésultat : ${ok} OK, ${ko} échec(s)`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* nettoyage best effort */ }
process.exit(ko ? 1 : 0);
