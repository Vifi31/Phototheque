// Contrôleur principal de l'interface Photothèque. Scripts classiques (globaux), aucune dépendance.
// La logique métier vit côté serveur (lib/*.mjs) ; ici on appelle l'API /api/* et on affiche.
'use strict';
const { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog, lightboxOpen } = UI;

const App = (() => {
  const state = {
    version: '', stats: {}, scan: {}, import: {},
    view: 'photos', facet: {}, q: '', sort: 'captured_desc',
    page: 0, pageSize: 60, total: 0, rows: [],
    selection: new Set(),
    supports: [], keywords: [], facets: { years: [], cameras: [], formats: [] },
  };

  const api = async (p, method = 'GET', body) => {
    const r = await fetch('/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Erreur ' + r.status));
    return j;
  };

  // ---------- navigation ----------
  const NAV = [
    { group: 'Bibliothèque' },
    { id: 'photos', label: 'Photothèque', icon: '🖼️' },
    { id: 'import', label: 'Importation', icon: '📥' },
    { id: 'supports', label: 'Supports', icon: '💾' },
    { id: 'keywords', label: 'Mots-clés', icon: '🏷️' },
    { id: 'collections', label: 'Collections', icon: '🗂️' },
    { id: 'albums', label: 'Albums', icon: '📖' },
    { group: 'Analyse' },
    { id: 'duplicates', label: 'Doublons', icon: '🧬' },
    { id: 'stats', label: 'Statistiques', icon: '📊' },
    { group: 'Administration' },
    { id: 'admin', label: 'Administration', icon: '⚙️' },
    { id: 'settings', label: 'Paramètres', icon: '🛠️' },
  ];

  function renderNav() {
    const nav = document.getElementById('nav');
    clear(nav);
    for (const item of NAV) {
      if (item.group) { nav.appendChild(h('div.nav-group', item.group)); continue; }
      const active = state.view === item.id || (item.id === 'admin' && state.view.startsWith('admin-')) || (item.id === 'albums' && state.view === 'album');
      nav.appendChild(h('button.nav-item' + (active ? '.active' : ''), { onclick: () => go(item.id), title: item.label },
        h('span.ico', item.icon), h('span', item.label), badgeFor(item.id)));
    }
  }
  function badgeFor(id) {
    if (id === 'photos' && state.stats.photos) return h('span.badge', fmtNum(state.stats.photos));
    if (id === 'supports' && state.supports.filter(s => s.status === 'absent').length) return h('span.badge', String(state.supports.filter(s => s.status === 'absent').length));
    return null;
  }

  async function go(view) {
    state.view = view; state.selection.clear();
    renderNav();
    const v = document.getElementById('view');
    clear(v); v.appendChild(h('div.loading', 'Chargement…'));
    try {
      if (view === 'photos') await viewPhotos(v);
      else if (view === 'import') await viewImport(v);
      else if (view === 'supports') await viewSupports(v);
      else if (view === 'keywords') await viewKeywords(v);
      else if (view === 'collections') await viewCollections(v);
      else if (view === 'albums') await viewAlbums(v);
      else if (view === 'album') await viewAlbum(v);
      else if (view === 'duplicates') await viewDuplicates(v);
      else if (view === 'stats') await viewStats(v);
      else if (view === 'settings') await viewSettings(v);
      else if (view === 'admin') await Admin.view(v, 'backups', nav => (state._adminNav = nav));
      else if (view.startsWith('admin-')) await Admin.view(v, view.slice(6));
      renderStatus();
    } catch (e) { clear(v); v.appendChild(h('div.empty', h('div.big', '⚠️'), e.message)); }
  }

  function renderStatus() {
    const s = state.stats;
    mount(document.getElementById('statusbar'),
      h('span', `${fmtNum(s.photos ?? 0)} photo(s)`),
      h('span', `${fmtNum(s.files ?? 0)} fichier(s)`),
      h('span', fmtBytes(s.bytes ?? 0)),
      h('span', `${fmtNum(s.keywords ?? 0)} mot(s)-clé(s)`),
      s.missing ? h('span', { style: { color: 'var(--warn)' } }, `${fmtNum(s.missing)} indisponible(s)`) : h('span', 'tous les fichiers présents'),
    );
  }

  // ---------- vue Photothèque (grille + recherche + filtres) ----------
  async function viewPhotos(v) {
    clear(v);
    const facets = await api('/facets'); state.facets = facets;
    // consultation d'une collection : la grille est filtrée par collectionId (voir viewCollections)
    const coll = state.facet.collectionId ? (await api('/collections/' + encodeURIComponent(state.facet.collectionId)).catch(() => ({}))).collection : null;
    if (state.facet.collectionId && !coll) delete state.facet.collectionId;
    const toolbar = h('div.grid-toolbar');
    const filterBar = h('div.row');
    const grid = h('div.grid-photos');
    const info = h('div.dim');

    // filtres
    const sortSel = h('select', { onchange: () => { state.sort = sortSel.value; state.page = 0; refresh(); } },
      ...[['captured_desc', 'Plus récentes'], ['captured_asc', 'Plus anciennes'], ['rating_desc', 'Mieux notées'], ['added_desc', 'Ajoutées récemment'], ['size_desc', 'Plus grandes']].map(([v2, l]) => h('option', { value: v2, selected: state.sort === v2 }, l)));
    const yearSel = h('select', { onchange: () => { state.facet.year = yearSel.value; state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Toutes les années'),
      ...facets.years.map(y => h('option', { value: y.y, selected: state.facet.year === y.y }, `${y.y} (${y.n})`)));
    const camSel = h('select', { onchange: () => { state.facet.camera = camSel.value; state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Tous les appareils'),
      ...facets.cameras.map(c => h('option', { value: c.camera_model, selected: state.facet.camera === c.camera_model }, `${c.camera_model || c.camera_make} (${c.n})`)));
    const fmtSel = h('select', { onchange: () => { state.facet.format = fmtSel.value; state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Tous les formats'),
      ...facets.formats.map(f => h('option', { value: f.format, selected: state.facet.format === f.format }, `${f.format} (${f.n})`)));
    const ratingSel = h('select', { onchange: () => { state.facet.rating = ratingSel.value; state.page = 0; refresh(); } },
      ...[['', 'Toutes notes'], ['1', '★ et +'], ['3', '★★★ et +'], ['5', '★★★★★']].map(([v2, l]) => h('option', { value: v2, selected: state.facet.rating === v2 }, l)));
    const missSel = h('select', { onchange: () => { state.facet.missing = missSel.value; state.page = 0; refresh(); } },
      ...[['', 'Toutes disponibilités'], ['0', 'Présentes'], ['1', 'Indisponibles']].map(([v2, l]) => h('option', { value: v2, selected: state.facet.missing === v2 }, l)));

    // recherche avancée : critères ET / OU / NON et filtres fins (mêmes clés que lib/search.mjs)
    const advanced = advancedPanel(() => { state.page = 0; refresh(); });

    mount(filterBar, yearSel, camSel, fmtSel, ratingSel, missSel, h('button.ghost.small', { onclick: () => { state.facet = {}; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); } }, 'Réinitialiser'));

    // sélection multiple
    const selInfo = h('span.sel-count');
    const batchBar = h('div.row');
    function refreshSelection() {
      selInfo.textContent = state.selection.size ? `${state.selection.size} sélectionnée(s)` : '';
      clear(batchBar);
      if (state.selection.size) {
        batchBar.append(
          h('button.small', { onclick: batchRate }, 'Noter…'),
          h('button.small.ghost', { onclick: batchKeyword }, 'Mot-clé…'),
          h('button.small.ghost', { onclick: batchCollection }, 'Ajouter à une collection…'),
          h('button.small.ghost', { onclick: batchAlbum }, 'Ajouter à un album…'),
          coll?.kind === 'static' ? h('button.small.ghost', { onclick: batchUncollect }, 'Retirer de la collection') : null,
          h('button.small.danger', { onclick: batchRemoveIndex }, "Retirer de l'index"),
          h('button.small.ghost', { onclick: () => { state.selection.clear(); renderGrid(); } }, 'Tout désélectionner'),
        );
      }
    }
    // critères courants (texte + filtres), tels qu'enregistrés dans une recherche sauvegardée
    const currentCriteria = () => { const c = { ...state.facet }; delete c.collectionId; if (state.q) c.q = state.q; return Object.fromEntries(Object.entries(c).filter(([, val]) => val !== '' && val != null)); };
    const saveBtn = h('button.ghost.small', { onclick: saveSearch, title: 'Enregistrer le texte et les filtres actuels comme collection dynamique' }, 'Enregistrer la recherche…');
    const refreshSaveBtn = () => { saveBtn.hidden = !!coll || !Object.keys(currentCriteria()).length; };
    mount(toolbar, h('span', { class: 'dim' }, 'Tri :'), sortSel, saveBtn, h('div.spacer'), selInfo, batchBar);

    function renderGrid() {
      clear(grid);
      if (!state.rows.length) { grid.appendChild(h('div.empty', h('div.big', '📷'), 'Aucune photo ne correspond. Indexez un dossier depuis Importation.')); return; }
      state.rows.forEach((p, i) => {
        const cell = h('div.photo-cell' + (state.selection.has(p.id) ? '.selected' : ''), {
          onclick: () => openViewer(i),
        });
        if (p.thumb) cell.appendChild(h('img', { src: p.thumb, loading: 'lazy', alt: p.title || '' }));
        else cell.appendChild(h('div.ph-placeholder', '🖼️'));
        cell.appendChild(h('div.ph-sel', { onclick: e => { e.stopPropagation(); toggleSel(p.id); } }, state.selection.has(p.id) ? '✓' : ''));
        if (p.missing) cell.appendChild(h('div.ph-miss', 'indisponible'));
        if (p.rating) cell.appendChild(h('div.ph-rating', '★'.repeat(p.rating)));
        grid.appendChild(cell);
      });
    }
    function toggleSel(id) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); renderGrid(); refreshSelection(); }
    function openViewer(i) {
      lightboxOpen(state.rows, i, () => {});
    }

    async function refresh() {
      const params = new URLSearchParams({ limit: state.pageSize, offset: state.page * state.pageSize, sort: state.sort });
      if (state.q) params.set('q', state.q);
      for (const [k, val] of Object.entries(state.facet)) if (val) params.set(k, val);
      const r = await api('/photos?' + params.toString());
      state.rows = r.rows; state.total = r.total;
      info.textContent = `${fmtNum(r.total)} photo(s)`;
      renderGrid(); refreshSelection(); renderPager(); refreshSaveBtn();
    }

    const pager = h('div.row');
    function renderPager() {
      const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
      clear(pager);
      pager.append(h('span.dim', `Page ${state.page + 1} / ${pages}`),
        h('button.ghost.small', { disabled: state.page === 0, onclick: () => { state.page--; refresh(); } }, '‹ Précédent'),
        h('button.ghost.small', { disabled: state.page >= pages - 1, onclick: () => { state.page++; refresh(); } }, 'Suivant ›'));
    }

    // actions sur la sélection
    async function batchRate() {
      const input = h('input', { type: 'number', min: 0, max: 5, value: 3 });
      modal({ title: 'Noter la sélection', body: field('Note (0 à 5)', input), actions: [
        h('button.ghost', { onclick: () => UI.modal && document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { for (const id of state.selection) await api('/photos', 'PUT', { id, rating: +input.value }); document.getElementById('modalRoot').replaceChildren(); toast('Note appliquée à ' + state.selection.size + ' photo(s)'); state.selection.clear(); refresh(); } }, 'Appliquer'),
      ] });
    }
    async function batchKeyword() {
      const input = h('input', { type: 'text', placeholder: 'Mot-clé (ex: Vacances)' });
      modal({ title: 'Ajouter un mot-clé à la sélection', body: field('Mot-clé', input), actions: [
        h('button.ghost', { onclick: () => document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { const kw = input.value.trim(); if (!kw) return; for (const id of state.selection) { const d = await api('/photos/' + id); const names = [...(d.photo.keywords || []).map(k => k.name), kw]; await api('/photos', 'PUT', { id, keywords: names }); } document.getElementById('modalRoot').replaceChildren(); toast('Mot-clé ajouté'); state.selection.clear(); refresh(); } }, 'Appliquer'),
      ] });
    }
    async function batchCollection() {
      const { list } = await api('/collections');
      const statics = list.filter(c => c.kind === 'static');
      const sel = h('select', {}, ...statics.map(c => h('option', { value: c.id }, `${c.name} (${c.photo_count})`)), h('option', { value: '' }, '➕ Nouvelle sélection…'));
      const name = h('input', { type: 'text', placeholder: 'Nom de la nouvelle sélection' });
      const nameField = field('Nom', name);
      const sync = () => { nameField.hidden = !!sel.value; };
      sel.addEventListener('change', sync); sync();
      const m = modal({ title: `Ajouter ${state.selection.size} photo(s) à une collection`, body: h('div.form', field('Collection', sel), nameField), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try {
            const ids = [...state.selection];
            if (sel.value) { const r = await api(`/collections/${encodeURIComponent(sel.value)}/photos`, 'POST', { ids }); toast(`${r.added} photo(s) ajoutée(s) à « ${r.collection.name} »`); }
            else { const r = await api('/collections', 'POST', { name: name.value, kind: 'static', photoIds: ids }); toast(`Sélection « ${r.collection.name} » créée (${r.collection.photo_count} photo(s))`); }
            m.close(); state.selection.clear(); renderGrid(); refreshSelection();
          } catch (e) { toast(e.message, 'bad'); }
        } }, 'Ajouter'),
      ] });
    }
    async function batchAlbum() {
      await loadAlbumMeta();
      const { list } = await api('/albums');
      const sel = h('select', {}, ...list.map(a => h('option', { value: a.id }, `${a.name} (${a.pageCount} p.)`)), h('option', { value: '' }, '➕ Nouvel album…'));
      const name = h('input', { type: 'text', placeholder: "Nom du nouvel album" });
      const fmt = formatFields();
      const fresh = h('div', field('Nom', name), fmt.el);
      const lay = layoutSelect('quatre', { withTitle: false });
      const sync = () => { fresh.hidden = !!sel.value; };
      sel.addEventListener('change', sync); sync();
      const ids = [...state.selection]; // ordre de sélection
      const m = modal({ title: `Placer ${ids.length} photo(s) dans un album`, body: h('div', field('Album', sel), fresh, field('Gabarit des nouvelles pages', lay),
        h('p.dim', "Les photos sont placées dans l'ordre de sélection, sur de nouvelles pages ajoutées à la fin. Aucun original n'est copié.")), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try {
            const albumId = sel.value || (await api('/albums', 'POST', { name: name.value, ...fmt.value() })).album.id;
            const r = await api(`/albums/${encodeURIComponent(albumId)}/fill`, 'POST', { photoIds: ids, layout: lay.value });
            m.close(); state.selection.clear();
            toast(`${r.added} photo(s) placée(s) dans « ${r.album.name} » (${r.pagesAdded} page(s))`);
            openAlbum(albumId);
          } catch (e) { toast(e.message, 'bad'); }
        } }, 'Placer'),
      ] });
    }
    async function batchUncollect() {
      const r = await api(`/collections/${encodeURIComponent(coll.id)}/photos/remove`, 'POST', { ids: [...state.selection] });
      toast(`${r.removed} photo(s) retirée(s) de « ${coll.name} ». Elles restent dans la photothèque.`); state.selection.clear(); refresh();
    }
    function saveSearch() {
      const query = currentCriteria();
      const name = h('input', { type: 'text', placeholder: 'Ex. : Vacances bien notées' });
      const m = modal({ title: 'Enregistrer la recherche', body: h('div.form', field('Nom', name), h('p.dim', 'Critères : ' + describeQuery(query)), h('p.dim', 'Le contenu se met à jour seul : les photos indexées plus tard y apparaîtront si elles correspondent.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try { const r = await api('/collections', 'POST', { name: name.value, kind: 'dynamic', query }); m.close(); toast(`Recherche « ${r.collection.name} » enregistrée (${r.collection.photo_count} photo(s))`); }
          catch (e) { toast(e.message, 'bad'); }
        } }, 'Enregistrer'),
      ] });
      name.focus();
    }
    async function batchRemoveIndex() {
      const ok2 = await confirmDialog("Retirer de l'index", `${state.selection.size} photo(s) seront retirée(s) de l'index. Les fichiers originaux ne seront JAMAIS supprimés. Continuer ?`);
      if (!ok2) return;
      const r = await api('/photos/remove', 'POST', { ids: [...state.selection] });
      toast(`${r.removed} photo(s) retirée(s). Originaux intacts.`); state.selection.clear(); refresh();
    }

    const title = coll ? h('h2.page-title', `Collection « ${coll.name} »`) : h('h2.page-title', 'Photothèque');
    const collBar = coll ? h('div.row', h('span.dim', coll.kind === 'dynamic' ? 'Recherche enregistrée — ' + describeQuery(coll.query) : 'Sélection'),
      h('button.ghost.small', { onclick: () => { delete state.facet.collectionId; state.page = 0; go('photos'); } }, 'Quitter la collection'),
      h('button.ghost.small', { onclick: () => go('collections') }, 'Toutes les collections')) : null;
    mount(v, title, collBar, filterBar, advanced, toolbar, info, grid, pager);
    await refresh();
  }

  // ---------- recherche avancée (panneau repliable de la Photothèque) ----------
  // Chaque contrôle écrit une clé de state.facet ; refresh() la transmet telle quelle à /api/photos,
  // et « Enregistrer la recherche… » l'emporte dans les critères de la collection.
  const ADV_KEYS = ['anyText', 'excludeText', 'keywords', 'anyKeywords', 'excludeKeywords', 'hasKeyword', 'noKeyword', 'hasCaption', 'noCaption',
    'orientation', 'hasGps', 'from', 'to', 'minWidth', 'minHeight', 'lens', 'author', 'duplicate'];
  function advancedPanel(onApply) {
    const f = state.facet;
    const text = (key, placeholder) => h('input', { type: 'text', value: f[key] ?? '', placeholder, dataset: { key } });
    const num = key => h('input', { type: 'number', min: 0, step: 100, value: f[key] ?? '', placeholder: 'px', dataset: { key } });
    const date = key => h('input', { type: 'date', value: (f[key] ?? '').slice(0, 10), dataset: { key } });
    const choice = (options, current) => h('select', {}, ...options.map(([val, label]) => h('option', { value: val, selected: current === val }, label)));
    const LIST = 'séparés par des virgules';

    const inputs = [
      text('anyText', LIST), text('excludeText', LIST),
      text('keywords', LIST), text('anyKeywords', LIST), text('excludeKeywords', LIST),
      text('lens', 'ex. : 50mm'), text('author', 'nom du photographe'),
      date('from'), date('to'), num('minWidth'), num('minHeight'),
    ];
    const byKey = Object.fromEntries(inputs.map(i => [i.dataset.key, i]));
    const kwSel = choice([['', 'Indifférent'], ['hasKeyword', 'Avec au moins un mot-clé'], ['noKeyword', 'Sans aucun mot-clé']], f.hasKeyword ? 'hasKeyword' : f.noKeyword ? 'noKeyword' : '');
    const capSel = choice([['', 'Indifférent'], ['hasCaption', 'Avec légende'], ['noCaption', 'Sans légende']], f.hasCaption ? 'hasCaption' : f.noCaption ? 'noCaption' : '');
    const oriSel = choice([['', 'Toutes'], ['landscape', 'Paysage'], ['portrait', 'Portrait'], ['square', 'Carré']], f.orientation ?? '');
    const gpsSel = choice([['', 'Indifférent'], ['1', 'Avec position GPS'], ['0', 'Sans position GPS']], f.hasGps ?? '');
    const dupSel = choice([['', 'Indifférent'], ['true', 'Seulement les doublons']], f.duplicate ? 'true' : '');

    const active = () => ADV_KEYS.filter(k => f[k] != null && f[k] !== '').length;
    const count = h('span.badge');
    const showCount = () => { const n = active(); count.textContent = n ? String(n) : ''; count.hidden = !n; };

    function apply() {
      for (const k of ADV_KEYS) delete f[k];
      for (const [k, el] of Object.entries(byKey)) {
        let val = el.value.trim();
        if (!val) continue;
        if (k === 'to') val += 'T23:59:59'; // la date de fin inclut toute la journée
        f[k] = val;
      }
      if (kwSel.value) f[kwSel.value] = 'true';
      if (capSel.value) f[capSel.value] = 'true';
      if (oriSel.value) f.orientation = oriSel.value;
      if (gpsSel.value) f.hasGps = gpsSel.value;
      if (dupSel.value) f.duplicate = 'true';
      showCount(); onApply();
    }
    function reset() {
      for (const el of inputs) el.value = '';
      for (const s of [kwSel, capSel, oriSel, gpsSel, dupSel]) s.value = '';
      apply();
    }
    for (const el of inputs) el.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    showCount();

    const group = (label, ...fields) => h('div.adv-group', h('div.adv-label', label), h('div.form', ...fields));
    return h('details.card.adv', { open: state.advOpen || null, ontoggle: e => { state.advOpen = e.target.open; } },
      h('summary', 'Recherche avancée ', count),
      group('Texte (titre, légende, notes, mots-clés, appareil)',
        field('Au moins un de ces mots', byKey.anyText), field('Aucun de ces mots', byKey.excludeText)),
      group('Mots-clés',
        field('Tous ces mots-clés', byKey.keywords), field('Au moins un de ces mots-clés', byKey.anyKeywords),
        field('Aucun de ces mots-clés', byKey.excludeKeywords), field('Présence', kwSel)),
      group('Prise de vue',
        field('Du', byKey.from), field('Au', byKey.to), field('Objectif', byKey.lens), field('Auteur', byKey.author)),
      group('Image',
        field('Orientation', oriSel), field('Largeur minimale', byKey.minWidth), field('Hauteur minimale', byKey.minHeight),
        field('Légende', capSel), field('GPS', gpsSel), field('Fichiers en double', dupSel, 'même contenu à plusieurs endroits')),
      h('div.row', h('div.spacer'), h('button.ghost.small', { onclick: reset }, 'Effacer ces critères'), h('button.small', { onclick: apply }, 'Rechercher')),
      h('p.dim.adv-hint', 'Le texte de la barre du haut exige tous ses mots ; il se combine avec ces critères. Les listes se séparent par des virgules.'));
  }

  // ---------- vue Importation ----------
  async function viewImport(v) {
    clear(v);
    const folders = await api('/folders');
    const pathInput = h('input', { type: 'text', placeholder: 'Chemin absolu du dossier à indexer (ex: E:\\\\Carte SD\\\\DCIM)' });
    const supportSel = h('select', {}, h('option', { value: '' }, 'Sans support'));
    const sup = await api('/supports');
    for (const s of sup.list) supportSel.appendChild(h('option', { value: s.id }, s.name));

    const folderList = h('div');
    function renderFolders(list) {
      clear(folderList);
      if (!list.length) { folderList.appendChild(h('p.dim', 'Aucun dossier indexé pour le moment.')); return; }
      for (const f of list) {
        const item = h('div.folder-item');
        const count = h('span.badge', fmtNum(f.photo_count));
        item.append(h('div.grow', h('div', f.path), h('small.dim', `Indexé : ${f.indexed_at ? fmtDateTime(f.indexed_at) : 'jamais'} · ${f.photo_count} photo(s)`)),
          count,
          h('button.small', { onclick: () => startIndex(f.id, count) }, 'Indexer'),
          h('button.ghost.small', { onclick: async () => { await api('/folders/' + f.id, 'DELETE'); renderFolders((await api('/folders')).list); } }, 'Retirer'));
        folderList.appendChild(item);
      }
    }
    async function startIndex(fid, countEl) {
      const { jobId } = await api(`/folders/${fid}/index`, 'POST');
      toast('Indexation lancée (sans copie des originaux)…');
      const poll = setInterval(async () => {
        try {
          const { job } = await api('/jobs/' + jobId);
          if (job.total) countEl.textContent = `${job.done}/${job.total}`;
          if (job.status !== 'running') {
            clearInterval(poll);
            if (job.status === 'done') { toast(`Indexation terminée : ${job.result.added} ajoutée(s), ${job.result.errors} erreur(s)`); state.stats = (await api('/stats')); renderFolders((await api('/folders')).list); renderNav(); }
            else toast(job.error || 'Indexation en erreur', 'bad');
          }
        } catch { clearInterval(poll); }
      }, 500);
    }

    mount(v,
      h('h2.page-title', 'Importation'),
      card(h('div.sect', 'Ajouter et indexer un dossier (sans copie)'),
        h('p.dim', "L'indexation lit les fichiers, extrait les métadonnées et génère les vignettes. Vos originaux ne sont ni copiés, ni modifiés, ni déplacés."),
        h('div.form',
          field('Chemin du dossier', pathInput),
          field('Support rattaché', supportSel),
          h('div.field', h('label', ' '), h('button', { onclick: addFolder }, 'Ajouter le dossier')),
        )),
      card(h('div.sect', 'Dossiers indexés'), folderList),
      card(h('div.sect', 'Importer des fichiers (copie vers la bibliothèque)'),
        h('p.dim', "Transfère physiquement des fichiers vers le dossier d'import, avec détection de doublons (empreinte) et renommage en cas de collision. La source n'est jamais supprimée."),
        h('div.form', field('Fichiers source (séparés par ;)', h('input#importSources', { type: 'text', placeholder: 'E:\\\\photo1.jpg ; E:\\\\photo2.jpg' })),
          h('div.field', h('label', ' '), h('button', { onclick: doImport }, 'Importer (copie)'))),
      ),
    );
    renderFolders(folders.list);

    async function addFolder() {
      const p = pathInput.value.trim(); if (!p) return toast('Chemin manquant', 'warn');
      try { await api('/folders', 'POST', { path: p, supportId: supportSel.value || null }); toast('Dossier ajouté'); pathInput.value = ''; renderFolders((await api('/folders')).list); }
      catch (e) { toast(e.message, 'bad'); }
    }
    async function doImport() {
      const sources = document.getElementById('importSources').value.split(';').map(s => s.trim()).filter(Boolean);
      if (!sources.length) return toast('Indiquez au moins un fichier source', 'warn');
      const r = await api('/import', 'POST', { sources });
      toast(`Import : ${r.copied} copiée(s), ${r.duplicates} doublon(s), ${r.errors} erreur(s)`);
      state.stats = await api('/stats'); renderNav();
    }
  }

  // ---------- vue Supports ----------
  async function viewSupports(v) {
    clear(v);
    const wrap = h('div');
    async function refresh() {
      const { list, stats } = await api('/supports');
      state.supports = list; renderNav();
      clear(wrap);
      if (!list.length) wrap.appendChild(h('p.dim', 'Aucun support enregistré. Ajoutez un disque, une carte mémoire ou un NAS pour suivre vos originaux.'));
      for (const s of list) {
        wrap.appendChild(h('div.support-card',
          h('div', { style: { fontSize: '24px' } }, s.status === 'available' ? '🟢' : s.status === 'absent' ? '🔴' : '⚪'),
          h('div.grow', h('b', s.name), h('div.dim', `${s.mount_path || '—'} · ${s.kind} · rôle ${s.role}`),
            h('small.dim', `Statut : ${s.status === 'available' ? 'disponible' : s.status === 'absent' ? 'absent (déconnecté)' : 'inconnu'}${s.drive_label ? ' · ' + s.drive_label : ''}`)),
          h('div.row-actions',
            h('button.ghost.small', { onclick: () => editSupport(s) }, 'Modifier'),
            h('button.ghost.small', { onclick: async () => { const r = await api('/support/refresh' in {} ? '/supports/refresh' : '/supports/refresh', 'POST'); toast('Supports rafraîchis'); refresh(); } }, 'Actualiser'),
            h('button.danger.small', { onclick: async () => { if (await confirmDialog('Retirer le support', `Retirer « ${s.name} » de l'inventaire ? Les fichiers ne sont pas supprimés.`)) { await api('/supports/' + s.id, 'DELETE'); refresh(); } } }, 'Retirer'))));
      }
      mount(v, h('h2.page-title', 'Supports'),
        card(h('div.sect', 'Inventaire des supports de stockage'),
          h('p.dim', 'Un support absent (déconnecté) rend ses photos « indisponibles », jamais supprimées. La reconnexion est détectée par empreinte.'),
          h('div.kpis', kpi('Supports', stats.total), kpi('Disponibles', stats.available, { tone: 'ok' }), kpi('Absents', stats.absent, { tone: 'warn' })),
          h('div.spacer'), wrap),
        card(h('div.sect', 'Ajouter un support'), addForm()));
    }
    function addForm() {
      const name = h('input', { type: 'text', placeholder: 'Nom (ex: Carte SD Nikon)' });
      const path = h('input', { type: 'text', placeholder: 'Chemin monté (ex: E:\\\\)' });
      const kind = h('select', {}, ...Object.entries(supKinds).map(([k, l]) => h('option', { value: k }, l)));
      const role = h('select', {}, ...Object.entries(supRoles).map(([k, l]) => h('option', { value: k }, l)));
      return h('div.form', field('Nom', name), field('Chemin', path), field('Type', kind), field('Rôle', role),
        h('div.field', h('label', ' '), h('button', { onclick: async () => { try { await api('/supports', 'POST', { name: name.value, mount_path: path.value, kind: kind.value, role: role.value }); toast('Support ajouté'); refresh(); } catch (e) { toast(e.message, 'bad'); } } }, 'Ajouter')));
    }
    function editSupport(s) {
      const name = h('input', { type: 'text', value: s.name });
      const path = h('input', { type: 'text', value: s.mount_path || '' });
      const loc = h('input', { type: 'text', value: s.location || '' });
      modal({ title: 'Modifier le support', body: h('div.form', field('Nom', name), field('Chemin', path), field('Emplacement physique', loc)), actions: [
        h('button.ghost', { onclick: () => document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { await api('/supports/' + s.id, 'PUT', { name: name.value, mount_path: path.value, location: loc.value }); document.getElementById('modalRoot').replaceChildren(); toast('Support modifié'); refresh(); } }, 'Enregistrer'),
      ] });
    }
    await refresh();
  }
  let supKinds = {}, supRoles = {};

  // ---------- vue Mots-clés ----------
  async function viewKeywords(v) {
    clear(v);
    const wrap = h('div');
    async function refresh() {
      const { list } = await api('/keywords');
      state.keywords = list;
      clear(wrap);
      if (!list.length) wrap.appendChild(h('p.dim', 'Aucun mot-clé. Créez-en depuis une photo ou ajoutez-en ci-dessous.'));
      const t = table({ columns: [
        { label: 'Mot-clé', format: r => h('b', r.name) },
        { label: 'Photos', key: 'photo_count', align: 'right' },
        { label: 'Créé', format: r => fmtDate(r.created_at) },
        { label: '', align: 'right', format: r => h('div.row-actions',
          h('button.ghost.small', { onclick: () => App.searchKeyword(r) }, 'Voir'),
          h('button.ghost.small', { onclick: () => renameKw(r) }, 'Renommer'),
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer le mot-clé', `Supprimer « ${r.name} » et ses affectations ?`)) { await api('/keywords/' + r.id, 'DELETE'); refresh(); } } }, 'Supprimer')) },
      ], rows: list });
      wrap.appendChild(t);
    }
    const newName = h('input', { type: 'text', placeholder: 'Nouveau mot-clé' });
    function renameKw(r) {
      const input = h('input', { type: 'text', value: r.name });
      modal({ title: 'Renommer', body: field('Nom', input), actions: [
        h('button.ghost', { onclick: () => document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { await api('/keywords/' + r.id, 'PUT', { name: input.value }); document.getElementById('modalRoot').replaceChildren(); refresh(); } }, 'Enregistrer'),
      ] });
    }
    mount(v, h('h2.page-title', 'Mots-clés'),
      card(h('div.sect', 'Ajouter un mot-clé'), h('div.form', field('Nom', newName), h('div.field', h('label', ' '), h('button', { onclick: async () => { if (!newName.value.trim()) return; await api('/keywords', 'POST', { name: newName.value.trim() }); newName.value = ''; refresh(); } }, 'Créer')))),
      card(h('div.sect', 'Tous les mots-clés'), wrap));
    await refresh();
  }

  // ---------- vues simples (Collections, Albums, Doublons) ----------
  async function viewCollections(v) {
    clear(v);
    const wrap = h('div');
    async function refresh() {
      const { list, kinds } = await api('/collections');
      if (!state.keywords.length) state.keywords = (await api('/keywords')).list; // noms des mots-clés dans les critères
      clear(wrap);
      if (!list.length) { wrap.appendChild(h('p.dim', 'Aucune collection. Créez une sélection ci-dessous, ou depuis la Photothèque : sélectionnez des photos puis « Ajouter à une collection… », ou cherchez puis « Enregistrer la recherche… ».')); return; }
      wrap.appendChild(table({ columns: [
        { label: 'Collection', format: r => h('div', h('b', r.name), r.kind === 'dynamic' ? h('div', h('small.dim', describeQuery(r.query))) : null) },
        { label: 'Type', format: r => kinds[r.kind] ?? r.kind },
        { label: 'Photos', key: 'photo_count', align: 'right' },
        { label: 'Modifiée', format: r => fmtDate(r.updated_at) },
        { label: '', align: 'right', format: r => h('div.row-actions',
          h('button.ghost.small', { onclick: () => openCollection(r) }, 'Voir'),
          h('button.ghost.small', { onclick: () => renameColl(r) }, 'Renommer'),
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer la collection', `Supprimer « ${r.name} » ? Les photos restent dans la photothèque ; seule la collection disparaît.`)) { await api('/collections/' + encodeURIComponent(r.id), 'DELETE'); toast('Collection supprimée (photos conservées)'); refresh(); } } }, 'Supprimer')) },
      ], rows: list }));
    }
    function renameColl(r) {
      const input = h('input', { type: 'text', value: r.name });
      const m = modal({ title: 'Renommer la collection', body: field('Nom', input), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { try { await api('/collections/' + encodeURIComponent(r.id), 'PUT', { name: input.value }); m.close(); refresh(); } catch (e) { toast(e.message, 'bad'); } } }, 'Enregistrer'),
      ] });
    }
    const newName = h('input', { type: 'text', placeholder: 'Nom de la sélection' });
    const create = async () => { try { await api('/collections', 'POST', { name: newName.value, kind: 'static' }); newName.value = ''; refresh(); } catch (e) { toast(e.message, 'bad'); } };
    mount(v, h('h2.page-title', 'Collections'),
      card(h('div.sect', 'Nouvelle sélection'),
        h('p.dim', 'Une sélection contient les photos que vous y ajoutez (depuis la Photothèque). Une recherche enregistrée se crée depuis la Photothèque et se met à jour seule.'),
        h('div.form', field('Nom', newName), h('div.field', h('label', ' '), h('button', { onclick: create }, 'Créer')))),
      card(h('div.sect', 'Sélections et recherches enregistrées'), wrap));
    await refresh();
  }
  function openCollection(c) { state.q = ''; document.getElementById('search').value = ''; state.facet = { collectionId: c.id }; state.page = 0; go('photos'); }

  // Résumé lisible des critères d'une recherche enregistrée (mêmes clés que lib/search.mjs).
  const CRITERIA = {
    q: 'texte', anyText: 'un des textes', excludeText: 'sans le texte', keywords: 'mots-clés', anyKeywords: 'un des mots-clés', excludeKeywords: 'sans les mots-clés',
    keywordId: 'mot-clé', year: 'année', from: 'depuis', to: "jusqu'au", camera: 'appareil', lens: 'objectif', author: 'auteur', format: 'format',
    rating: 'note ≥', color: 'couleur', missing: 'disponibilité', orientation: 'orientation', minWidth: 'largeur ≥', maxWidth: 'largeur ≤', minHeight: 'hauteur ≥', maxHeight: 'hauteur ≤',
    supportId: 'support', folderId: 'dossier', albumId: 'album', integrity: 'intégrité', hasGps: 'GPS',
    noKeyword: 'sans mot-clé', hasKeyword: 'avec mot-clé', hasCaption: 'avec légende', noCaption: 'sans légende', duplicate: 'doublons',
  };
  function describeQuery(q) {
    const kwName = id => state.keywords.find(k => k.id === id)?.name ?? id;
    const parts = Object.entries(q ?? {}).filter(([k]) => CRITERIA[k]).map(([k, val]) => {
      if (val === true) return CRITERIA[k];
      if (k === 'missing') return +val ? 'indisponibles' : 'présentes';
      if (k === 'hasGps') return [false, 0, '0', 'false'].includes(val) ? 'sans GPS' : 'avec GPS';
      if (k === 'keywordId') return `${CRITERIA[k]} « ${kwName(val)} »`;
      if (k === 'from' || k === 'to') return `${CRITERIA[k]} ${fmtDate(String(val).slice(0, 10))}`;
      if (k === 'orientation') return { landscape: 'paysage', portrait: 'portrait', square: 'carré' }[val] ?? val;
      return `${CRITERIA[k]} « ${[].concat(val).join(', ')} »`;
    });
    return parts.length ? parts.join(' · ') : 'aucun critère';
  }
  // ---------- Albums : liste + éditeur de pages ----------
  // Formats et gabarits viennent du serveur (lib/albums.mjs) : l'interface ne fait que les dessiner.
  let albumMeta = null;
  // même règle que le PDF (lib/pdf.mjs, textColorOn) : texte foncé sur fond clair, blanc sur fond foncé
  const inkOn = bg => { const v = parseInt(String(bg).slice(1), 16) || 0xffffff; const l = [v >> 16, (v >> 8) & 255, v & 255].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] > 0.25 ? '#1e293b' : '#ffffff'; };
  const loadAlbumMeta = async () => (albumMeta ??= await api('/albums'));
  const formatSelect = (current = 'carre-30') => h('select', {}, ...Object.entries(albumMeta.formats).map(([k, f]) => h('option', { value: k, selected: k === current }, f.label)));
  const layoutSelect = (current = 'une', { withTitle = true } = {}) => h('select', {},
    ...Object.entries(albumMeta.layouts).filter(([k]) => withTitle || k !== 'titre').map(([k, l]) => h('option', { value: k, selected: k === current }, l.label)));
  /** Champs format (+ largeur/hauteur si personnalisé). */
  function formatFields(a = {}) {
    const sel = formatSelect(a.format);
    const w = h('input', { type: 'number', min: 50, max: 1000, value: a.width_mm ?? 250 }), hh = h('input', { type: 'number', min: 50, max: 1000, value: a.height_mm ?? 250 });
    const custom = h('div.form', field('Largeur (mm)', w), field('Hauteur (mm)', hh));
    const sync = () => { custom.hidden = sel.value !== 'custom'; };
    sel.addEventListener('change', sync); sync();
    return { el: h('div', field('Format de page', sel), custom), value: () => ({ format: sel.value, width_mm: +w.value, height_mm: +hh.value }) };
  }

  async function viewAlbums(v) {
    clear(v);
    await loadAlbumMeta();
    const wrap = h('div.album-list');
    async function refresh() {
      const { list } = await api('/albums');
      clear(wrap);
      if (!list.length) { wrap.appendChild(h('p.dim', 'Aucun album. Créez-en un ci-dessus, ou depuis la Photothèque : sélectionnez des photos puis « Ajouter à un album… ».')); return; }
      for (const a of list) {
        wrap.appendChild(h('button.album-card', { onclick: () => openAlbum(a.id) },
          h('div.album-cover', { style: { aspectRatio: `${a.width_mm} / ${a.height_mm}` } }, a.cover ? h('img', { src: a.cover, alt: '' }) : h('span', '📖')),
          h('div.album-info', h('b', a.name), h('small.dim', `${a.formatLabel} · ${a.pageCount} page(s) · ${a.photoCount} photo(s)`),
            a.alerts ? h('small', { style: { color: 'var(--warn)' } }, `⚠ ${a.alerts} alerte(s)`) : null)));
      }
    }
    const name = h('input', { type: 'text', placeholder: 'Ex. : Vacances 2024' });
    const fmt = formatFields();
    const create = async () => { try { const r = await api('/albums', 'POST', { name: name.value, ...fmt.value() }); openAlbum(r.album.id); } catch (e) { toast(e.message, 'bad'); } };
    mount(v, h('h2.page-title', 'Albums'),
      card(h('div.sect', 'Nouvel album'),
        h('p.dim', "Un album ne contient que des références à vos photos : aucun original n'est copié ni modifié."),
        h('div.form', field('Nom', name), fmt.el, h('div.field', h('label', ' '), h('button', { onclick: create }, 'Créer')))),
      card(h('div.sect', 'Mes albums'), wrap));
    await refresh();
  }
  function openAlbum(id) { state.albumId = id; go('album'); }

  async function viewAlbum(v) {
    await loadAlbumMeta();
    let album = (await api('/albums/' + encodeURIComponent(state.albumId))).album;
    const L = albumMeta.layouts;
    const body = h('div.album-editor');
    const base = '/albums/' + encodeURIComponent(album.id);
    let drag = null; // { page, slot } du cadre dont on déplace la photo

    // Toute modification renvoie l'album complet : on redessine en gardant la position de défilement.
    async function change(path, method, payload) {
      try { const r = await api(base + path, method, payload); album = r.album ?? album; render(); return r; }
      catch (e) { toast(e.message, 'bad'); }
    }
    const pageUrl = n => `/pages/${n}`;
    const slotsOf = n => [...album.pages[n - 1].slots];
    const setSlot = (n, s, id) => { const sl = slotsOf(n); while (sl.length <= s) sl.push(null); sl[s] = id; return sl; };

    async function dropOn(n, s) {
      if (!drag || (drag.page === n && drag.slot === s)) return;
      const from = drag; drag = null;
      const moving = album.pages[from.page - 1].slots[from.slot], target = album.pages[n - 1].slots[s] ?? null;
      if (from.page === n) { const sl = setSlot(n, s, moving); sl[from.slot] = target; await change(pageUrl(n), 'PUT', { slots: sl }); return; }
      await api(base + pageUrl(n), 'PUT', { slots: setSlot(n, s, moving) }).catch(e => toast(e.message, 'bad'));
      await change(pageUrl(from.page), 'PUT', { slots: setSlot(from.page, from.slot, target) });
    }

    function pageView(pg, n) {
      const issues = album.issues.filter(i => i.page === n && i.level !== 'info');
      const lay = L[pg.layout];
      // largeur bornée pour qu'une page en hauteur ne dépasse pas 420 px sans être déformée
      const sheet = h('div.album-page' + (state.albumGuides ? '.guides' : ''), { style: { aspectRatio: `${album.width_mm} / ${album.height_mm}`, width: `min(100%, ${Math.round(420 * album.width_mm / album.height_mm)}px)`, background: pg.background, color: inkOn(pg.background) } });
      lay.frames.forEach((fr, s) => {
        const id = pg.slots[s], ph = id ? album.photos[id] : null;
        const bad = album.issues.find(i => i.page === n && i.slot === s && i.level !== 'info');
        const cell = h('div.album-frame' + (id ? '' : '.empty') + (bad ? '.' + bad.level : ''), {
          style: { left: fr.x * 100 + '%', top: fr.y * 100 + '%', width: fr.w * 100 + '%', height: fr.h * 100 + '%' },
          title: bad ? bad.message : id ? 'Cliquer pour changer, glisser pour déplacer' : 'Cliquer pour placer une photo',
          onclick: () => pickPhoto(n, s),
          ondragover: e => { if (drag) { e.preventDefault(); cell.classList.add('over'); } },
          ondragleave: () => cell.classList.remove('over'),
          ondrop: e => { e.preventDefault(); cell.classList.remove('over'); dropOn(n, s); },
        });
        if (ph) {
          const src = ph.preview || ph.thumb;
          cell.appendChild(src ? h('img', { src, alt: ph.title || '', draggable: 'true', ondragstart: () => { drag = { page: n, slot: s }; } }) : h('span', '🖼️'));
          cell.appendChild(h('button.frame-clear', { title: 'Retirer la photo du cadre', onclick: e => { e.stopPropagation(); change(pageUrl(n), 'PUT', { slots: setSlot(n, s, null) }); } }, '×'));
        } else cell.appendChild(h('span', id ? '⚠' : '+'));
        sheet.appendChild(cell);
      });
      if (pg.layout === 'titre') sheet.appendChild(h('div.album-title', h('div.t1', pg.title || 'Titre'), pg.caption ? h('div.t2', pg.caption) : null));
      else if (pg.caption && !lay.fullBleed) sheet.appendChild(h('div.album-caption', pg.caption));
      if (!lay.fullBleed) sheet.appendChild(h('div.album-folio', String(n)));

      const laySel = layoutSelect(pg.layout); laySel.addEventListener('change', () => change(pageUrl(n), 'PUT', { layout: laySel.value }));
      const color = h('input', { type: 'color', value: pg.background, title: 'Couleur de fond', onchange: e => change(pageUrl(n), 'PUT', { background: e.target.value }) });
      const text = (key, ph2) => h('input', { type: 'text', value: pg[key], placeholder: ph2, onchange: e => change(pageUrl(n), 'PUT', { [key]: e.target.value }) });
      const last = album.pages.length;
      return h('div.album-page-wrap',
        sheet,
        h('div.album-page-tools',
          h('div.row', h('b', `Page ${n}`), h('div.spacer'),
            h('button.ghost.small', { disabled: n === 1, title: 'Avancer la page', onclick: () => change(pageUrl(n) + '/move', 'POST', { to: n - 1 }) }, '↑'),
            h('button.ghost.small', { disabled: n === last, title: 'Reculer la page', onclick: () => change(pageUrl(n) + '/move', 'POST', { to: n + 1 }) }, '↓'),
            h('button.ghost.small', { title: 'Dupliquer la page', onclick: () => change(pageUrl(n) + '/duplicate', 'POST') }, '⧉'),
            h('button.ghost.small', { title: 'Supprimer la page', onclick: async () => { if (await confirmDialog('Supprimer la page', `Supprimer la page ${n} ? Les photos restent dans la photothèque.`)) change(pageUrl(n), 'DELETE'); } }, '🗑')),
          h('div.row', laySel, color),
          pg.layout === 'titre' ? text('title', 'Titre') : null,
          text('caption', pg.layout === 'titre' ? 'Sous-titre' : 'Légende de la page'),
          issues.length ? h('div.album-issues', ...issues.map(i => h('small.' + i.level, i.message.replace(/^Page \d+ : /, '')))) : null));
    }

    function render() {
      const sc = document.getElementById('main'), top = sc.scrollTop;
      const used = new Set(album.pages.flatMap(p => p.slots).filter(Boolean)).size;
      const alerts = album.issues.filter(i => i.level !== 'info');
      const empties = album.issues.filter(i => i.level === 'info').length;
      const addSel = layoutSelect('une');
      const guides = h('input', { type: 'checkbox', checked: !!state.albumGuides, onchange: e => { state.albumGuides = e.target.checked; render(); } });
      mount(body,
        h('div.row', h('span.dim', `${album.formatLabel} · ${album.width_mm} × ${album.height_mm} mm · ${album.pages.length} page(s) · ${used} photo(s)`), h('div.spacer'),
          h('label.row', { style: { gap: '6px' } }, guides, 'Marges de sécurité')),
        alerts.length || empties ? card(h('div.sect', alerts.length ? `⚠ ${alerts.length} alerte(s)` : 'Contrôles'),
          ...alerts.map(i => h('div.album-alert.' + i.level, i.message)),
          empties ? h('p.dim', `${empties} cadre(s) vide(s).`) : null) : null,
        h('div.album-pages', ...album.pages.map((pg, i) => pageView(pg, i + 1)),
          h('div.album-page-wrap.add', h('div.form', field('Nouvelle page', addSel), h('div.field', h('label', ' '), h('button', { onclick: () => change('/pages', 'POST', { layout: addSel.value }) }, 'Ajouter une page'))))));
      sc.scrollTop = top;
    }

    // Choix d'une photo pour un cadre : recherche texte ou collection, vignettes cliquables.
    async function pickPhoto(n, s) {
      const q = h('input', { type: 'search', placeholder: 'Rechercher (titre, mots-clés, appareil…)' });
      const { list: colls } = await api('/collections');
      const coll = h('select', {}, h('option', { value: '' }, 'Toute la photothèque'), ...colls.map(c => h('option', { value: c.id }, c.name)));
      const gridEl = h('div.picker-grid'), count = h('small.dim');
      async function load() {
        const params = new URLSearchParams({ limit: 60, sort: 'captured_desc' });
        if (q.value.trim()) params.set('q', q.value.trim());
        if (coll.value) params.set('collectionId', coll.value);
        const r = await api('/photos?' + params);
        count.textContent = r.total > r.rows.length ? `${r.rows.length} premières sur ${r.total} — affinez la recherche` : `${r.total} photo(s)`;
        mount(gridEl, ...r.rows.map(p => h('button.picker-cell', { title: p.title || p.path || '', onclick: async () => { m.close(); await change(pageUrl(n), 'PUT', { slots: setSlot(n, s, p.id) }); } },
          p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('span', '🖼️'))));
        if (!r.rows.length) gridEl.appendChild(h('p.dim', 'Aucune photo.'));
      }
      let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
      coll.addEventListener('change', load);
      const m = modal({ title: `Page ${n} — cadre ${s + 1}`, wide: true, body: h('div', h('div.form', field('Recherche', q), field('Collection', coll)), count, gridEl) });
      await load(); q.focus();
    }

    function editProps() {
      const name = h('input', { type: 'text', value: album.name });
      const desc = h('textarea', { rows: 3 }, album.description || '');
      const fmt = formatFields(album);
      const m = modal({ title: "Propriétés de l'album", body: h('div', field('Nom', name), field('Description', desc), fmt.el,
        h('p.dim', 'Les gabarits sont proportionnels : changer de format conserve la mise en page.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { const r = await change('', 'PUT', { name: name.value, description: desc.value, ...fmt.value() }); if (r) { m.close(); title.textContent = album.name; } } }, 'Enregistrer'),
      ] });
    }
    async function fillFromCollection() {
      const { list: colls } = await api('/collections');
      if (!colls.length) { toast("Aucune collection : créez-en une depuis la Photothèque.", 'bad'); return; }
      const coll = h('select', {}, ...colls.map(c => h('option', { value: c.id }, `${c.name} (${c.photo_count})`)));
      const lay = layoutSelect('quatre', { withTitle: false });
      const m = modal({ title: 'Remplir depuis une collection', body: h('div.form', field('Collection', coll), field('Gabarit des nouvelles pages', lay),
        h('p.dim', 'Les photos (300 au plus, de la plus ancienne à la plus récente) sont placées sur de nouvelles pages ajoutées à la fin.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { const r = await change('/fill', 'POST', { collectionId: coll.value, layout: lay.value }); if (r) { m.close(); toast(`${r.added} photo(s) placée(s) sur ${r.pagesAdded} page(s)`); } } }, 'Remplir'),
      ] });
    }

    // ---- PDF : aperçu (150 ppp, dans la page) et export d'impression (téléchargement) ----
    async function fetchPdf(params) {
      const res = await fetch('/api' + base + '/pdf?' + new URLSearchParams(params));
      if (!res.ok) { let msg = 'Échec de la production du PDF'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
      let report = null;
      try { report = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(res.headers.get('X-Pdf-Report') || ''), c => c.charCodeAt(0)))); } catch { /* compte rendu absent */ }
      return { blob: await res.blob(), report };
    }
    function pdfSummary(r) {
      if (!r) return [];
      const out = [h('p', `${r.pages} page(s), ${r.images} image(s), ${fmtBytes(r.bytes)} · ${r.width_mm} × ${r.height_mm} mm${r.bleed ? ` + fonds perdus ${albumMeta.bleedMm} mm` : ''}`)];
      const where = l => l.slice(0, 6).map(x => `p. ${x.page}`).join(', ') + (l.length > 6 ? '…' : '');
      const lost = r.unfilled.filter(u => u.reason !== 'cadre vide'), empty = r.unfilled.length - lost.length;
      if (lost.length) out.push(h('div.album-alert.bad', `${lost.length} cadre(s) sans photo lisible (${where(lost)})`));
      if (r.fromPreview.length) out.push(h('div.album-alert.warn', `${r.fromPreview.length} photo(s) prise(s) sur l'aperçu en cache, original indisponible : qualité réduite (${where(r.fromPreview)})`));
      if (r.fromCopy.length) out.push(h('div.album-alert', `${r.fromCopy.length} photo(s) prise(s) sur une copie identique, original indisponible (${where(r.fromCopy)})`));
      if (r.lowDpi.length) out.push(h('div.album-alert.warn', `${r.lowDpi.length} photo(s) sous la résolution visée (${where(r.lowDpi)})`));
      if (empty) out.push(h('p.dim', `${empty} cadre(s) vide(s)${r.quality === 'screen' ? ', grisés dans l’aperçu' : ', laissés au fond de page'}.`));
      return out;
    }
    async function previewPdf() {
      toast('Préparation de l’aperçu…');
      try {
        const { blob, report } = await fetchPdf({ quality: 'screen', inline: 1 });
        const src = URL.createObjectURL(blob);
        const m = modal({ title: `Aperçu — ${album.name}`, wide: true, body: h('div', ...pdfSummary(report), h('iframe.pdf-frame', { src, title: 'Aperçu PDF' })),
          actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), h('button', { onclick: () => { m.close(); exportPdf(); } }, 'Exporter pour l’impression…')] });
        new MutationObserver((_, o) => { if (!m.box.isConnected) { URL.revokeObjectURL(src); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
      } catch (e) { toast(e.message, 'bad'); }
    }
    function exportPdf() {
      const prof = h('select', {}, ...Object.entries(albumMeta.pdfProfiles).map(([k, p]) => h('option', { value: k }, p.label)));
      const bleed = h('input', { type: 'checkbox' });
      const bad = album.issues.filter(i => i.level === 'bad');
      const status = h('div');
      const go2 = h('button', { onclick: async () => {
        go2.disabled = true; mount(status, h('p.dim', 'Production du PDF… (les photos sont rééchantillonnées depuis les originaux)'));
        try {
          const { blob, report } = await fetchPdf({ quality: prof.value, bleed: bleed.checked ? 1 : 0 });
          const a = h('a', { href: URL.createObjectURL(blob), download: (album.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'album') + '.pdf' });
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          mount(status, h('p', '✓ PDF enregistré dans le dossier de téléchargement du navigateur.'), ...pdfSummary(report));
          toast('PDF produit');
        } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
        go2.disabled = false;
      } }, 'Produire le PDF');
      const m = modal({ title: 'Exporter en PDF', body: h('div',
        h('div.form', field('Qualité', prof)),
        h('label.row', { style: { gap: '6px' } }, bleed, `Ajouter des fonds perdus de ${albumMeta.bleedMm} mm (imprimeur : la page est agrandie, les photos pleine page débordent, la coupe se fait au format)`),
        bad.length ? h('div.album-alert.bad', `${bad.length} alerte(s) bloquante(s) dans l’album : ${bad[0].message}${bad.length > 1 ? '…' : ''}`) : null,
        h('p.dim', 'Les originaux sont lus sans être modifiés. Une photo n’est jamais agrandie au-delà de sa résolution réelle.'),
        status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), go2] });
    }

    const title = h('h2.page-title', album.name);
    mount(v,
      h('div.row', title, h('div.spacer'),
        h('button.ghost.small', { onclick: () => go('albums') }, '← Albums'),
        h('button.ghost.small', { onclick: editProps }, 'Propriétés…'),
        h('button.ghost.small', { onclick: fillFromCollection }, 'Remplir depuis une collection…'),
        h('button.ghost.small', { onclick: () => { state.q = ''; state.facet = { albumId: album.id }; state.page = 0; go('photos'); } }, 'Voir ses photos'),
        h('button.ghost.small', { onclick: previewPdf }, 'Aperçu'),
        h('button.small', { onclick: exportPdf }, 'Exporter en PDF…'),
        h('a.btn.ghost.small', { href: '/api' + base + '/export', download: '' }, 'Exporter le projet'),
        h('button.danger.small', { onclick: async () => { if (await confirmDialog("Supprimer l'album", `Supprimer « ${album.name} » ? Les photos restent dans la photothèque ; seul l'album disparaît.`)) { await api(base, 'DELETE'); toast('Album supprimé (photos conservées)'); go('albums'); } } }, 'Supprimer')),
      body);
    render();
  }
  async function viewDuplicates(v) {
    clear(v);
    // doublons exacts par empreinte
    const dups = await api('/photos?limit=1'); // juste pour la stats
    // interrogation directe via une recherche dédiée : on liste les empreintes partagées
    const body = h('div');
    // On interroge le serveur via /api/db n'est pas adapté ; on passe par une recherche par empreinte.
    // Pour ce socle, on affiche les photos groupées par empreinte via /api/photos + regroupement côté client (limité).
    mount(v, h('h2.page-title', 'Doublons'),
      card(h('div.sect', 'Doublons exacts (empreinte SHA-256)'),
        h('p.dim', "L'indexation détecte les fichiers de contenu identique (même empreinte) et les rattache à la même fiche photo. Un outil dédié de listage/groupement sera affiné à l'étape 3."),
        body));
    void dups;
  }

  // ---------- vue Statistiques ----------
  async function viewStats(v) {
    clear(v);
    const s = await api('/stats');
    const facets = await api('/facets');
    mount(v, h('h2.page-title', 'Statistiques'),
      h('div.kpis',
        kpi('Photos', fmtNum(s.photos)),
        kpi('Fichiers', fmtNum(s.files)),
        kpi('Volume', fmtBytes(s.bytes)),
        kpi('Mots-clés', fmtNum(s.keywords)),
        kpi('Albums', fmtNum(s.albums)),
        kpi('Avec GPS', fmtNum(s.gps)),
        kpi('Notées', fmtNum(s.rated)),
        kpi('Indisponibles', fmtNum(s.missing), { tone: s.missing ? 'warn' : '' })),
      card(h('div.sect', 'Répartition par année'),
        facets.years.length ? table({ columns: [{ label: 'Année', key: 'y' }, { label: 'Photos', key: 'n', align: 'right' }], rows: facets.years }) : h('p.dim', 'Aucune donnée.')),
      card(h('div.sect', 'Appareils utilisés'),
        facets.cameras.length ? table({ columns: [{ label: 'Marque', key: 'camera_make' }, { label: 'Modèle', key: 'camera_model' }, { label: 'Photos', key: 'n', align: 'right' }], rows: facets.cameras }) : h('p.dim', 'Aucune donnée.')),
      card(h('div.sect', 'Formats'),
        facets.formats.length ? table({ columns: [{ label: 'Format', key: 'format' }, { label: 'Photos', key: 'n', align: 'right' }], rows: facets.formats }) : h('p.dim', 'Aucune donnée.')));
  }

  // ---------- vue Paramètres ----------
  async function viewSettings(v) {
    clear(v);
    const scan = { ...state.scan };
    const thumbSize = h('input', { type: 'number', value: scan.thumbSize ?? 320 });
    const previewSize = h('input', { type: 'number', value: scan.previewSize ?? 1600 });
    const hashCb = h('input', { type: 'checkbox', checked: scan.hash !== false });
    const thumbCb = h('input', { type: 'checkbox', checked: scan.thumb !== false });
    const symCb = h('input', { type: 'checkbox', checked: !!scan.followSymlinks });
    const destInput = h('input', { type: 'text', value: state.import.dest || '', placeholder: 'Dossier de destination des imports copiés' });
    const keepCb = h('input', { type: 'checkbox', checked: state.import.keepFolders !== false });

    mount(v, h('h2.page-title', 'Paramètres'),
      card(h('div.sect', "Indexation"),
        h('div.form',
          field('Taille vignette (px)', thumbSize),
          field('Taille aperçu (px)', previewSize),
          h('label.check', hashCb, h('span', 'Calculer les empreintes SHA-256 (détection de doublons)')),
          h('label.check', thumbCb, h('span', 'Générer les vignettes')),
          h('label.check', symCb, h('span', 'Suivre les liens symboliques')))),
      card(h('div.sect', 'Importation'),
        h('div.form', field('Dossier de destination', destInput), h('label.check', keepCb, h('span', 'Classer par année de prise de vue')))),
      h('div.row', h('button', { onclick: save }, 'Enregistrer les paramètres')));

    async function save() {
      const r = await api('/settings', 'PUT', {
        scan: { thumbSize: +thumbSize.value, previewSize: +previewSize.value, hash: hashCb.checked, thumb: thumbCb.checked, followSymlinks: symCb.checked },
        import: { dest: destInput.value, keepFolders: keepCb.checked },
      });
      state.scan = r.scan; state.import = r.import; toast('Paramètres enregistrés');
    }
  }

  // ---------- recherche ----------
  function searchKeyword(k) { state.q = ''; state.facet = { keywordId: k.id }; go('photos'); }
  function setQuery(q) { state.q = q; state.page = 0; if (state.view !== 'photos') go('photos'); else refreshSearch(); }
  async function refreshSearch() { const v = document.getElementById('view'); clear(v); await viewPhotos(v); }

  // ---------- amorçage ----------
  async function boot() {
    // thème sombre par défaut
    document.documentElement.setAttribute('data-theme', 'dark');
    const st = await api('/state');
    state.version = st.version; state.scan = st.scan; state.import = st.import; state.stats = st.stats;
    supKinds = st.supportKinds; supRoles = st.supportRoles;
    document.getElementById('sidebarFoot').appendChild(h('small', `v${st.version}`));
    // recherche
    const searchEl = document.getElementById('search');
    let tId; searchEl.addEventListener('input', () => { clearTimeout(tId); tId = setTimeout(() => setQuery(searchEl.value.trim()), 300); });
    // menu admin
    document.getElementById('topbarActions').appendChild(h('button.ghost.small', { onclick: () => go('admin') }, 'Administration'));
    renderNav(); await go('photos');
  }

  return { boot, go, api, searchKeyword, state, refreshNav: renderNav };
})();

document.addEventListener('DOMContentLoaded', () => App.boot().catch(e => toast('Erreur : ' + e.message, 'bad')));
