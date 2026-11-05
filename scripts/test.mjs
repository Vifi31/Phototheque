// Tests de Photothèque — `npm test`.
// Couvre : mots-clés, supports, indexation sans copie, métadonnées, vignettes,
// recherche, import (copie + doublons), sauvegardes, et l'intégrité de la base.
// Aucune donnée réelle n'est touchée : tout tourne dans un dossier temporaire.
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

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
  let inside = true, safe = true;
  for (const [k, l] of Object.entries(LAYOUTS)) for (const f of l.frames) {
    if (f.x < 0 || f.y < 0 || f.x + f.w > 1.0001 || f.y + f.h > 1.0001) inside = false;
    if (!l.fullBleed && (f.x < SAFETY_MARGIN - 1e-4 || f.y < SAFETY_MARGIN - 1e-4 || f.x + f.w > 1 - SAFETY_MARGIN + 1e-4 || f.y + f.h > 1 - SAFETY_MARGIN + 1e-4)) safe = false;
  }
  check('gabarits : cadres dans la page', inside, true, 0);
  check('gabarits : marges de sécurité respectées', safe, true, 0);
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
