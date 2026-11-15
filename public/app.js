// Contrôleur principal de l'interface Photothèque. Scripts classiques (globaux), aucune dépendance.
// La logique métier vit côté serveur (lib/*.mjs) ; ici on appelle l'API /api/* et on affiche.
'use strict';
const { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog, lightboxOpen, lightboxClose, lightboxUpdate, keywordInput } = UI;

const App = (() => {
  const state = {
    version: '', stats: {}, scan: {}, import: {},
    view: 'photos', facet: {}, q: '', sort: 'captured_desc',
    page: 0, total: 0, rows: [],
    // grille : taille des vignettes, cadrage (carré rogné ou image entière), photos par page — préférences locales
    grid: (() => { try { return { size: 'm', fit: 'cover', pageSize: 60, ...JSON.parse(localStorage.getItem('phototheque.grid') || '{}') }; } catch { return { size: 'm', fit: 'cover', pageSize: 60 }; } })(),
    get pageSize() { return [60, 120, 240].includes(+this.grid.pageSize) ? +this.grid.pageSize : 60; },
    // variantes désignées dans l'outil Doublons : 'hide' (défaut) | 'show' | 'only' — préférence d'affichage locale
    variants: (() => { try { return localStorage.getItem('phototheque.variants') || 'hide'; } catch { return 'hide'; } })(),
    selection: new Set(),
    supports: [], keywords: [], facets: { years: [], cameras: [], formats: [] },
  };

  const api = async (p, method = 'GET', body) => {
    const r = await fetch('/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    // application verrouillée (lib/lock.mjs) : écran de mot de passe, puis la requête est rejouée
    if (r.status === 401 && j.locked) { await lockScreen(); return api(p, method, body); }
    if (!r.ok) throw new Error(j.error || ('Erreur ' + r.status));
    return j;
  };
  // liste des mots-clés pour les propositions de saisie (relue à chaque prise de focus : un mot créé entre-temps y figure)
  const kwSource = async () => (state.keywords = (await api('/keywords')).list);
  // champ de saisie d'un ou plusieurs mots-clés avec propositions au fil de la frappe (UI.keywordInput)
  const kwField = (input, multi = true) => keywordInput(input, { source: kwSource, multi });

  // ---------- verrouillage ----------
  let lockWait = null;
  /** Écran de verrouillage plein écran (hors des modales) ; une seule attente partagée par toutes les requêtes. */
  function lockScreen() {
    if (lockWait) return lockWait;
    lockWait = new Promise(resolve => {
      const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Mot de passe' });
      const msg = h('small.bad');
      const go2 = async () => {
        const r = await fetch('/api/lock/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = j.error || 'Mot de passe incorrect'; pw.select(); return; }
        el.remove(); lockWait = null; resolve();
        if (state.view) go(state.view, { replace: true }).catch(() => {}); // vignettes refusées pendant le verrouillage : on redessine
      };
      pw.addEventListener('keydown', e => { if (e.key === 'Enter') go2(); });
      const el = h('div', { id: 'lockScreen' }, h('div.lock-box', h('div.lock-icon', '🔒'), h('h2', 'Photothèque verrouillée'), h('p.dim', 'Saisissez le mot de passe pour continuer.'), pw, msg,
        h('button', { onclick: go2 }, 'Déverrouiller'),
        h('p.dim.small', 'Mot de passe oublié : arrêtez l’application puis lancez « node scripts/deverrouiller.mjs » dans son dossier.')));
      document.body.appendChild(el); setTimeout(() => pw.focus(), 50);
    });
    return lockWait;
  }
  async function lockNow() { await fetch('/api/lock/lock', { method: 'POST' }); clear(document.getElementById('view')); lockScreen(); }

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
    { id: 'stats', label: 'Tableau de bord', icon: '📊' },
    { id: 'reports', label: 'Rapports', icon: '📋' },
    { id: 'ia', label: 'Assistant IA', icon: '🤖' },
    { group: 'Administration' },
    { id: 'admin', label: 'Administration', icon: '⚙️' },
    { id: 'settings', label: 'Paramètres', icon: '🛠️' },
    { id: 'help', label: 'Aide', icon: '❓' },
  ];

  function renderNav() {
    const nav = document.getElementById('nav');
    clear(nav);
    for (const item of NAV) {
      if (item.group) { nav.appendChild(h('div.nav-group', item.group)); continue; }
      const active = state.view === item.id || (item.id === 'admin' && state.view.startsWith('admin-')) || (item.id === 'albums' && state.view === 'album') || (item.id === 'photos' && state.view === 'retouche');
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
    // guide de l'utilisateur (public/aide/) : page à part, dans un nouvel onglet
    if (view === 'help') { window.open('/aide/', '_blank', 'noopener'); return; }
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
      else if (view === 'retouche') await viewRetouche(v);
      else if (view === 'duplicates') await viewDuplicates(v);
      else if (view === 'stats') await viewStats(v);
      else if (view === 'reports') await viewReports(v);
      else if (view === 'ia') { if (typeof IA === 'undefined') throw new Error('Extension IA absente'); await IA.view(v); }
      else if (view === 'settings') await viewSettings(v);
      else if (view === 'admin') await Admin.view(v, 'backups', nav => (state._adminNav = nav));
      else if (view.startsWith('admin-')) await Admin.view(v, view.slice(6));
      renderStatus(); pushNav();
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
    const [facets, kwr] = await Promise.all([api('/facets'), api('/keywords')]); state.facets = facets; state.keywords = kwr.list;
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
    const advanced = advancedPanel(() => { kwFilterSel.value = kwCurrent(); state.page = 0; refresh(); });

    // filtre « Mots-clés » : sans mot-clé, avec au moins un, ou un mot-clé précis (la recherche inclut ceux rangés dessous).
    // Mêmes clés que la recherche avancée (noKeyword, hasKeyword, keywordId) : les deux contrôles restent synchronisés.
    const kwFacet = facets.keywords ?? { none: 0, any: 0, branch: {} };
    const kwById = new Map(state.keywords.map(k => [k.id, k]));
    const kwKids = new Map();
    for (const k of state.keywords) { const p = kwById.has(k.parent_id) ? k.parent_id : null; kwKids.set(p, [...(kwKids.get(p) ?? []), k]); }
    const kwByName = (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
    const kwOptions = [];
    const kwWalk = (k, depth) => {
      if (depth > 31) return;
      kwOptions.push(h('option', { value: 'id:' + k.id }, `${'  '.repeat(depth)}${depth ? '› ' : ''}${k.name} (${fmtNum(kwFacet.branch?.[k.id] ?? kwFacet.counts?.[k.id] ?? 0)})`));
      for (const c of (kwKids.get(k.id) ?? []).sort(kwByName)) kwWalk(c, depth + 1);
    };
    for (const k of (kwKids.get(null) ?? []).sort(kwByName)) kwWalk(k, 0);
    const kwCurrent = () => state.facet.noKeyword ? 'none' : state.facet.hasKeyword ? 'any' : state.facet.keywordId ? 'id:' + state.facet.keywordId : '';
    const kwFilterSel = h('select', { title: 'Filtrer par mot-clé : sans mot-clé, avec au moins un, ou un mot-clé précis (avec ceux rangés dessous)', onchange: () => {
      const val = kwFilterSel.value;
      delete state.facet.noKeyword; delete state.facet.hasKeyword; delete state.facet.keywordId;
      if (val === 'none') state.facet.noKeyword = 'true';
      else if (val === 'any') state.facet.hasKeyword = 'true';
      else if (val.startsWith('id:')) state.facet.keywordId = val.slice(3);
      advanced.syncKeyword(); state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Tous les mots-clés'),
      h('option', { value: 'none' }, `Sans mot-clé (${fmtNum(kwFacet.none)})`),
      h('option', { value: 'any' }, `Avec au moins un mot-clé (${fmtNum(kwFacet.any)})`),
      ...(kwOptions.length ? [h('optgroup', { label: 'Un mot-clé' }, ...kwOptions)] : []));
    kwFilterSel.value = kwCurrent();

    // variantes (outil Doublons) : préférence d'affichage, hors critères enregistrés ; sans effet dans une collection
    // (une sélection montre ce qu'on y a mis) ni pendant « référence et variantes »
    const varSel = h('select', { title: 'Variantes désignées dans l’outil Doublons (rien n’est supprimé)', onchange: () => {
      state.variants = varSel.value; try { localStorage.setItem('phototheque.variants', state.variants); } catch {}
      state.page = 0; refresh(); } },
      ...[['hide', 'Masquer les variantes'], ['show', 'Afficher les variantes'], ['only', 'Seulement les variantes']].map(([v2, l]) => h('option', { value: v2, selected: state.variants === v2 }, l)));
    varSel.hidden = !!coll;
    mount(filterBar, yearSel, camSel, fmtSel, kwFilterSel, ratingSel, missSel, varSel, h('button.ghost.small', { onclick: () => { state.facet = {}; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); } }, 'Réinitialiser'));

    // sélection multiple
    const selInfo = h('span.sel-count');
    const batchBar = h('div.row');
    function refreshSelection() {
      selInfo.textContent = state.selection.size ? `${state.selection.size} sélectionnée(s)` : '';
      clear(batchBar);
      if (state.selection.size) {
        batchBar.append(...[ // null filtré : append(null) écrirait « null »
          h('button.small', { onclick: batchRate }, 'Noter…'),
          h('button.small.ghost', { onclick: batchKeyword }, 'Mot-clé…'),
          h('button.small.ghost', { onclick: batchCollection }, 'Ajouter à une collection…'),
          h('button.small.ghost', { onclick: batchAlbum }, 'Ajouter à un album…'),
          h('button.small.ghost', { onclick: () => exportDialog([...state.selection]) }, 'Exporter…'),
          state.selection.size >= 2 && state.selection.size <= 4 ? h('button.small.ghost', { title: 'Afficher ces photos côte à côte (2 à 4)', onclick: () => compareView([...state.selection]) }, 'Comparer') : null,
          coll?.kind === 'static' ? h('button.small.ghost', { onclick: batchUncollect }, 'Retirer de la collection') : null,
          h('button.small.danger', { onclick: batchRemoveIndex }, "Retirer de l'index"),
          h('button.small.ghost', { onclick: () => { state.selection.clear(); renderGrid(); } }, 'Tout désélectionner'),
        ].filter(Boolean));
      }
    }
    // critères courants (texte + filtres), tels qu'enregistrés dans une recherche sauvegardée
    const currentCriteria = () => { const c = { ...state.facet }; delete c.collectionId; if (state.q) c.q = state.q; return Object.fromEntries(Object.entries(c).filter(([, val]) => val !== '' && val != null)); };
    const saveBtn = h('button.ghost.small', { onclick: saveSearch, title: 'Enregistrer le texte et les filtres actuels comme collection dynamique' }, 'Enregistrer la recherche…');
    const refreshSaveBtn = () => { saveBtn.hidden = !!coll || !!state.facet.ids || !Object.keys(currentCriteria()).length; };
    // planche-contact : la sélection si elle existe, sinon toutes les photos de la recherche affichée
    const sheetBtn = h('button.ghost.small', { title: 'Planche-contact, fiches détaillées, catalogue thématique ou portfolio en PDF, export CSV : la sélection, ou toutes les photos affichées par la recherche', onclick: () => {
      const label = coll ? coll.name : state.facet.variantsOf ? 'Référence et variantes' : 'Photothèque';
      if (state.selection.size) contactSheetDialog({ ids: [...state.selection], label, count: state.selection.size });
      else contactSheetDialog({ query: searchParams().toString(), label, count: state.total });
    } }, 'Planches, catalogues, portfolio…');
    // métadonnées : la sélection si elle existe, sinon toutes les photos de la recherche affichée
    const metaBtn = h('button.ghost.small', { title: 'Modifier les métadonnées en masse (avec aperçu), relire celles des fichiers, écrire des XMP annexes : la sélection, ou toutes les photos affichées', onclick: () => {
      const label = coll ? coll.name : 'Photothèque';
      const onDone = () => refresh();
      if (state.selection.size) metadataDialog({ ids: [...state.selection], label, count: state.selection.size, onDone });
      else metadataDialog({ query: searchParams().toString(), label, count: state.total, onDone });
    } }, 'Métadonnées…');
    // affichage de la grille : taille des vignettes, carré rogné / image entière, photos par page
    const SIZES = { s: ['Petites', 120], m: ['Moyennes', 190], l: ['Grandes', 260], xl: ['Très grandes', 340] };
    const saveGrid = () => { try { localStorage.setItem('phototheque.grid', JSON.stringify(state.grid)); } catch { /* préférence non gardée */ } };
    const applyGrid = () => { grid.style.setProperty('--thumb', (SIZES[state.grid.size] ?? SIZES.m)[1] + 'px'); grid.classList.toggle('fit-contain', state.grid.fit === 'contain'); };
    const sizeBar = h('div.tabs.grid-size', { title: 'Taille des vignettes' }, ...Object.entries(SIZES).map(([k, [l]]) => h('button' + (state.grid.size === k ? '.active' : ''), { title: l, onclick: e => {
      state.grid.size = k; saveGrid(); applyGrid(); for (const b of sizeBar.children) b.classList.toggle('active', b === e.currentTarget); } }, k.toUpperCase())));
    const fitBtn = h('button.ghost.small', { title: 'Vignettes carrées (rognées) ou image entière', onclick: () => { state.grid.fit = state.grid.fit === 'contain' ? 'cover' : 'contain'; saveGrid(); applyGrid(); fitBtn.textContent = state.grid.fit === 'contain' ? '▣ Entières' : '■ Carrées'; } }, state.grid.fit === 'contain' ? '▣ Entières' : '■ Carrées');
    const perPage = h('select', { title: 'Photos par page', onchange: () => { state.grid.pageSize = +perPage.value; saveGrid(); state.page = 0; refresh(); } }, ...[60, 120, 240].map(n => h('option', { value: n, selected: state.pageSize === n }, `${n} par page`)));
    const recentBtn = h('button.ghost.small', { title: 'Les dernières photos ouvertes dans la visionneuse', onclick: () => { const ids = recentIds(); if (!ids.length) return toast('Aucune photo consultée pour le moment'); state.facet = { ids: ids.join(',') }; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); } }, '🕘 Récemment vues');
    applyGrid();
    mount(toolbar, h('span', { class: 'dim' }, 'Tri :'), sortSel, saveBtn, sheetBtn, metaBtn, recentBtn, h('div.spacer'), sizeBar, fitBtn, perPage, selInfo, batchBar);

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
        if (p.edits) cell.appendChild(h('div.ph-edit', { title: `${p.edits} version(s) retouchée(s)` }, '✎'));
        if (p.variants) cell.appendChild(h('div.ph-variants', { title: `Photo de référence : ${p.variants} variante(s) conservée(s). Cliquer pour les voir.`,
          onclick: e => { e.stopPropagation(); showVariants(p.id); } }, `⧉ ${p.variants}`));
        else if (p.variantOf) cell.appendChild(h('div.ph-variants.is-variant', { title: 'Variante d’une autre photo (outil Doublons). Cliquer pour voir la référence et ses variantes.',
          onclick: e => { e.stopPropagation(); showVariants(p.variantOf); } }, 'variante'));
        grid.appendChild(cell);
      });
    }
    function showVariants(refId) { state.facet = { variantsOf: refId }; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); }
    function toggleSel(id) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); renderGrid(); refreshSelection(); }
    function openViewer(i) {
      let changed = false;
      pushRecent(state.rows[i]?.id);
      lightboxOpen(state.rows, i, n => pushRecent(state.rows[n]?.id), p => [
        h('button.small', { onclick: () => { lightboxClose(); openRetouche(p.id); } }, '✎ Retoucher'),
        h('button.small.ghost', { onclick: () => { lightboxClose(); exportDialog([p.id]); } }, 'Exporter…'),
        state.selection.size >= 2 && state.selection.size <= 4 ? h('button.small.ghost', { onclick: () => { lightboxClose(); compareView([...state.selection]); } }, 'Comparer la sélection') : null,
        state.aiEnabled && typeof IA !== 'undefined' ? h('button.small.ghost', { title: 'Assistant IA : photos visuellement proches et suggestions', onclick: () => { lightboxClose(); IA.open('search', p.id); } }, '🤖 Photos proches') : null].filter(Boolean),
        viewerOpts({ onChange: () => { changed = true; }, onClose: () => { if (changed) refresh(); } }));
    }

    // critères de la grille (texte, filtres, tri, variantes), sans la pagination : servent aussi à la planche-contact
    function searchParams() {
      const params = new URLSearchParams({ sort: state.sort });
      if (state.q) params.set('q', state.q);
      for (const [k, val] of Object.entries(state.facet)) if (val) params.set(k, val);
      if (!coll && !state.facet.variantsOf) { if (state.variants === 'hide') params.set('hideVariants', 'true'); else if (state.variants === 'only') params.set('variants', 'true'); }
      return params;
    }
    async function refresh() {
      const params = searchParams();
      params.set('limit', state.pageSize); params.set('offset', state.page * state.pageSize);
      const r = await api('/photos?' + params.toString());
      state.rows = r.rows; state.total = r.total;
      // « récemment vues » : ordre de consultation plutôt que le tri choisi
      if (state.facet.ids) { const order = String(state.facet.ids).split(','); state.rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); }
      pushNav();
      info.textContent = `${fmtNum(r.total)} photo(s)` + (r.hiddenVariants ? ` · ${fmtNum(r.hiddenVariants)} variante(s) masquée(s)` : '');
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
      modal({ title: 'Ajouter un mot-clé à la sélection', body: field('Mot-clé', kwField(input, false), 'Les mots-clés existants sont proposés pendant la frappe.'), actions: [
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
    const varBar = state.facet.variantsOf ? h('div.row', h('span.dim', 'Photo de référence et ses variantes (outil Doublons) — rien n’est supprimé'),
      h('button.ghost.small', { onclick: () => { delete state.facet.variantsOf; state.page = 0; go('photos'); } }, 'Revenir à la Photothèque'),
      h('button.ghost.small', { onclick: () => go('duplicates') }, 'Ouvrir l’outil Doublons')) : null;
    const recentBar = state.facet.ids ? h('div.row', h('span.dim', 'Photos récemment consultées, de la plus récente à la plus ancienne'),
      h('button.ghost.small', { onclick: () => { delete state.facet.ids; state.page = 0; go('photos'); } }, 'Revenir à la Photothèque'),
      h('button.ghost.small', { onclick: () => { try { localStorage.removeItem(RECENT_KEY); } catch { /* rien à effacer */ } delete state.facet.ids; go('photos'); } }, 'Effacer cet historique')) : null;
    mount(v, title, collBar, varBar, recentBar, filterBar, advanced, toolbar, info, grid, pager);
    await refresh();
  }

  // ---------- recherche avancée (panneau repliable de la Photothèque) ----------
  // Chaque contrôle écrit une clé de state.facet ; refresh() la transmet telle quelle à /api/photos,
  // et « Enregistrer la recherche… » l'emporte dans les critères de la collection.
  const ADV_KEYS = ['anyText', 'excludeText', 'keywords', 'anyKeywords', 'excludeKeywords', 'hasKeyword', 'noKeyword', 'hasCaption', 'noCaption',
    'orientation', 'hasGps', 'from', 'to', 'minWidth', 'minHeight', 'lens', 'author', 'duplicate', 'place', 'hasPlace', 'backup', 'keywordCategory'];
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
      text('lens', 'ex. : 50mm'), text('author', 'nom du photographe'), text('place', 'ville, région, pays…'),
      date('from'), date('to'), num('minWidth'), num('minHeight'),
    ];
    const byKey = Object.fromEntries(inputs.map(i => [i.dataset.key, i]));
    const kwSel = choice([['', 'Indifférent'], ['hasKeyword', 'Avec au moins un mot-clé'], ['noKeyword', 'Sans aucun mot-clé']], f.hasKeyword ? 'hasKeyword' : f.noKeyword ? 'noKeyword' : '');
    const capSel = choice([['', 'Indifférent'], ['hasCaption', 'Avec légende'], ['noCaption', 'Sans légende']], f.hasCaption ? 'hasCaption' : f.noCaption ? 'noCaption' : '');
    const oriSel = choice([['', 'Toutes'], ['landscape', 'Paysage'], ['portrait', 'Portrait'], ['square', 'Carré']], f.orientation ?? '');
    const gpsSel = choice([['', 'Indifférent'], ['1', 'Avec position GPS'], ['0', 'Sans position GPS']], f.hasGps ?? '');
    const dupSel = choice([['', 'Indifférent'], ['true', 'Seulement les doublons']], f.duplicate ? 'true' : '');
    const placeSel = choice([['', 'Indifférent'], ['1', 'Lieu renseigné'], ['0', 'Lieu non renseigné']], f.hasPlace ?? '');
    const backupSel = choice([['', 'Indifférent'], ['covered', 'Copie sur un support de sauvegarde ou d’archive'], ['uncovered', 'Aucune copie sur un support de sauvegarde'], ['single', 'Un seul exemplaire disponible']], f.backup ?? '');
    const catSel = choice([['', 'Toutes'], ...[...new Set(state.keywords.map(k => k.data?.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')).map(c => [c, c])], f.keywordCategory ?? '');

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
      if (placeSel.value) f.hasPlace = placeSel.value;
      if (backupSel.value) f.backup = backupSel.value;
      if (catSel.value) f.keywordCategory = catSel.value;
      showCount(); onApply();
    }
    function reset() {
      for (const el of inputs) el.value = '';
      for (const s of [kwSel, capSel, oriSel, gpsSel, dupSel, placeSel, backupSel, catSel]) s.value = '';
      apply();
    }
    for (const el of inputs) el.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    showCount();

    const group = (label, ...fields) => h('div.adv-group', h('div.adv-label', label), h('div.form', ...fields));
    const panel = h('details.card.adv', { open: state.advOpen || null, ontoggle: e => { state.advOpen = e.target.open; } },
      h('summary', 'Recherche avancée ', count),
      group('Texte (titre, légende, notes, mots-clés, appareil)',
        field('Au moins un de ces mots', byKey.anyText), field('Aucun de ces mots', byKey.excludeText)),
      group('Mots-clés',
        field('Tous ces mots-clés', byKey.keywords), field('Au moins un de ces mots-clés', byKey.anyKeywords),
        field('Aucun de ces mots-clés', byKey.excludeKeywords), field('Présence', kwSel), field('Catégorie de mot-clé', catSel)),
      group('Lieu et sauvegarde',
        field('Lieu', byKey.place, 'IPTC / XMP : lieu, ville, région, pays'), field('Lieu renseigné', placeSel),
        field('Sauvegarde des originaux', backupSel, 'selon le rôle des supports (Supports → rôle « Sauvegarde » ou « Archive »)')),
      group('Prise de vue',
        field('Du', byKey.from), field('Au', byKey.to), field('Objectif', byKey.lens), field('Auteur', byKey.author)),
      group('Image',
        field('Orientation', oriSel), field('Largeur minimale', byKey.minWidth), field('Hauteur minimale', byKey.minHeight),
        field('Légende', capSel), field('GPS', gpsSel), field('Fichiers en double', dupSel, 'même contenu à plusieurs endroits')),
      h('div.row', h('div.spacer'), h('button.ghost.small', { onclick: reset }, 'Effacer ces critères'), h('button.small', { onclick: apply }, 'Rechercher')),
      h('p.dim.adv-hint', 'Le texte de la barre du haut exige tous ses mots ; il se combine avec ces critères. Les listes se séparent par des virgules. Un mot-clé inclut ses synonymes et les mots-clés rangés dessous.'));
    // le filtre « Mots-clés » de la barre du haut écrit les mêmes clés : il resynchronise la liste « Présence »
    panel.syncKeyword = () => { kwSel.value = f.hasKeyword ? 'hasKeyword' : f.noKeyword ? 'noKeyword' : ''; showCount(); };
    return panel;
  }

  // ---------- vue Importation ----------
  // 1. Supports détectés (cartes, clés, disques) → 2. choix des photos (vignettes) → 3. copie ou déplacement vérifié.
  // Le déplacement ne supprime une source qu'après une copie vérifiée par empreinte (lib/imports.mjs).
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
    async function addFolder() {
      const p = pathInput.value.trim(); if (!p) return toast('Chemin manquant', 'warn');
      try { await api('/folders', 'POST', { path: p, supportId: supportSel.value || null }); toast('Dossier ajouté'); pathInput.value = ''; renderFolders((await api('/folders')).list); }
      catch (e) { toast(e.message, 'bad'); }
    }

    // ----- 1. supports détectés -----
    const drivesWrap = h('div', h('p.dim', 'Recherche des supports branchés…'));
    const picker = h('div');
    const manualInput = h('input', { type: 'text', placeholder: 'Ou tapez un dossier : E:\\DCIM, \\\\NAS\\photos…', onkeydown: e => { if (e.key === 'Enter') openPicker(manualInput.value.trim(), null); } });
    let seen = null, destDir = '';
    const DRIVE_ICON = { sd: '🗂️', usb: '🔌', disk: '💽', nas: '🌐', optical: '💿', phone: '📱', camera: '📷', other: '📁' };
    async function loadDrives(fresh) {
      try {
        const r = await api('/import/drives' + (fresh ? '?fresh=1' : ''));
        destDir = r.dest;
        const roots = new Set(r.drives.map(d => d.root));
        if (seen) for (const d of r.drives) if (!seen.has(d.root) && d.likelyImport) toast(d.phone ? `${d.kindLabel} détecté : ${d.label}` : `Support détecté : ${d.label || 'sans nom'} (${d.letter || d.root})`);
        seen = roots;
        renderDrives(r.drives);
      } catch (e) { mount(drivesWrap, h('p.dim', 'Détection impossible : ' + e.message)); }
    }
    function phoneTile(d) {
      const ok = d.phone.ready;
      return h('div.drive.hot',
        h('div.drive-ico', DRIVE_ICON[d.kind] ?? '📱'),
        h('div.grow',
          h('div', h('b', d.label), ' ', h('span.dim', d.kindLabel)),
          h('div', ok ? h('span.pill.ok', 'Prêt : transfert de fichiers autorisé') : h('span.pill.warn', 'Verrouillé ou transfert non autorisé')),
          ok ? h('small.dim', 'Photos lues dans DCIM et Pictures. En mode Déplacer, chaque photo est supprimée du téléphone après copie vérifiée.')
            : h('small.dim', 'Déverrouillez l’appareil, puis choisissez « Transfert de fichiers » (Android) ou « Faire confiance » (iPhone). Cliquez ensuite sur Actualiser.')),
        h('div.drive-actions',
          ok ? h('button.small', { onclick: () => openPicker(null, d) }, 'Choisir les photos…') : h('button.ghost.small', { onclick: () => loadDrives(true) }, '↻ Actualiser')));
    }
    function driveTile(d) {
      if (d.phone) return phoneTile(d);
      return h('div.drive' + (d.likelyImport ? '.hot' : ''),
        h('div.drive-ico', DRIVE_ICON[d.kind] ?? '📁'),
        h('div.grow',
          h('div', h('b', d.label || 'Sans nom'), ' ', h('span.dim', d.letter || d.root)),
          h('small.dim', [d.kindLabel, d.total ? fmtBytes(d.total) : null, d.total ? `${fmtBytes(d.free)} libres` : null, d.filesystem].filter(Boolean).join(' · ')),
          h('div', d.dcim ? h('span.pill.ok', 'Photos d’appareil (DCIM)') : null, ' ', d.support ? h('span.pill.accent', 'Support : ' + d.support.name) : null, ' ', d.system ? h('span.pill', 'Disque système') : null)),
        h('div.drive-actions',
          h('button.small', { onclick: () => openPicker(d.dcim || d.root, d) }, 'Choisir les photos…'),
          !d.support && !d.system ? h('button.ghost.small', { title: 'Mémorise ce lecteur dans l’écran Supports (suivi des originaux)', onclick: async () => {
            try { await api('/import/drives/register', 'POST', { root: d.root }); toast('Support enregistré'); loadDrives(true); } catch (e) { toast(e.message, 'bad'); } } }, 'Enregistrer comme support') : null));
    }
    function renderDrives(list) {
      const hot = list.filter(d => d.likelyImport), other = list.filter(d => !d.likelyImport);
      mount(drivesWrap,
        hot.length ? h('div.drives', ...hot.map(driveTile)) : h('p.dim', 'Aucune carte mémoire, clé USB ni téléphone détecté. Branchez-en un : il apparaît ici tout seul (vérification toutes les 10 secondes).'),
        other.length ? h('details.drives-other', h('summary', `Autres lecteurs (${other.length})`), h('div.drives', ...other.map(driveTile))) : null);
    }
    loadDrives(false);
    const driveTimer = setInterval(() => { if (!document.body.contains(drivesWrap)) return clearInterval(driveTimer); if (!document.hidden && !picker.dataset.busy) loadDrives(false); }, 10000);

    // ----- 2. choix des photos -----
    // demande d'analyse : un téléphone se lit par son identifiant (MTP, sans chemin), le reste par son chemin
    const scanRequest = (root, drive) => drive?.phone ? { phone: drive.phone.id } : { path: root };
    async function openPicker(root, drive) {
      if (!root && !drive?.phone) return toast('Indiquez un dossier ou choisissez un lecteur', 'warn');
      mount(picker, card(h('p.dim', drive?.phone ? `Lecture des photos de « ${drive.label} »… cela peut durer une minute selon le nombre de photos.` : `Analyse de ${root}…`)));
      picker.scrollIntoView({ behavior: 'smooth', block: 'start' });
      let sc;
      try { sc = await api('/import/scan', 'POST', scanRequest(root, drive)); }
      catch (e) { mount(picker, card(h('p', { style: { color: 'var(--bad)' } }, e.message))); return; }
      renderPicker(sc, drive);
    }

    function renderPicker(sc, drive, summary = null) {
      const files = sc.files;
      const sel = new Set(files.filter(f => !f.known).map(f => f.path));       // par défaut : les photos pas encore importées
      let mode = 'copy', verify = true, removeDup = false, last = -1;
      const title = drive?.phone ? drive.label : drive ? `${drive.label || 'Sans nom'} (${drive.letter || drive.root})` : sc.root;
      const phoneId = sc.phone?.id ?? null;                                  // téléphone : « Déplacer » supprime sur l'appareil, après copie vérifiée
      const countEl = h('b'), sizeEl = h('span.dim');
      const cells = new Map();
      const sizeOf = () => files.reduce((a, f) => a + (sel.has(f.path) ? f.size : 0), 0);
      const sync = () => {
        countEl.textContent = `${fmtNum(sel.size)} photo(s) choisie(s) sur ${fmtNum(files.length)}`;
        sizeEl.textContent = ' · ' + fmtBytes(sizeOf());
        for (const [p, c] of cells) c.classList.toggle('on', sel.has(p));
        for (const g of groupBoxes) g.cb.checked = g.items.every(f => sel.has(f.path)) && g.items.length > 0;
        runBtn.textContent = mode === 'move' ? `Déplacer ${fmtNum(sel.size)} photo(s)` : `Copier ${fmtNum(sel.size)} photo(s)`;
        runBtn.className = mode === 'move' ? 'danger' : '';
        runBtn.disabled = !sel.size;
      };
      const toggle = (f, e, i) => {
        if (e?.shiftKey && last >= 0) { const [a, b] = [Math.min(last, i), Math.max(last, i)]; const on = !sel.has(f.path); for (let k = a; k <= b; k++) on ? sel.add(files[k].path) : sel.delete(files[k].path); }
        else if (sel.has(f.path)) sel.delete(f.path); else sel.add(f.path);
        last = i; sync();
      };
      // groupes par dossier de la carte
      const byDir = new Map();
      files.forEach((f, i) => { const k = f.dir || '.'; (byDir.get(k) ?? byDir.set(k, []).get(k)).push({ ...f, i }); });
      const groupBoxes = [];
      const groupsEl = h('div');
      for (const [dir, items] of byDir) {
        const cb = h('input', { type: 'checkbox', onchange: () => { for (const f of items) cb.checked ? sel.add(f.path) : sel.delete(f.path); sync(); } });
        groupBoxes.push({ cb, items });
        const grid = h('div.imp-grid', ...items.map(f => {
          const c = h('div.imp-cell', { title: `${f.name}\n${fmtBytes(f.size)} · ${fmtDateTime(new Date(f.mtime).toISOString())}${f.known ? '\nProbablement déjà dans la photothèque (même nom et même taille)' : ''}`, onclick: e => toggle(f, e, f.i) },
            h('img', { loading: 'lazy', alt: '', src: `/api/import/preview?size=220${phoneId ? '&phone=' + encodeURIComponent(phoneId) : ''}&path=${encodeURIComponent(f.path)}`, draggable: 'false', onerror: e => { e.target.replaceWith(h('div.imp-noimg', '🖼️')); } }),
            h('span.imp-check', '✓'),
            f.known ? h('span.imp-known', 'déjà importée ?') : null,
            h('div.imp-name', f.name));
          cells.set(f.path, c);
          return c;
        }));
        groupsEl.append(h('div.imp-group', h('label.imp-group-h', cb, h('b', dir === '.' ? 'Racine du dossier' : dir), h('span.dim', ` · ${items.length} photo(s)`)), grid));
      }

      const modeBox = h('div.imp-mode',
        ...[['copy', 'Copier', 'Les photos restent aussi sur le support d’origine.'], ['move', 'Déplacer', 'Les photos sont effacées du support d’origine, après copie vérifiée.']].map(([val, label, hint]) =>
          h('label.imp-opt', h('input', { type: 'radio', name: 'impMode', value: val, checked: val === mode, onchange: () => { mode = val; verifyCb.checked = verify = mode === 'move' ? true : verify; verifyCb.disabled = mode === 'move'; warn.hidden = dupLabel.hidden = mode !== 'move'; sync(); } }), h('span', h('b', label), h('small.dim', ' ' + hint)))));
      const verifyCb = h('input', { type: 'checkbox', checked: true, onchange: () => { verify = verifyCb.checked; } });
      const dupCb = h('input', { type: 'checkbox', onchange: () => { removeDup = dupCb.checked; } });
      const dupLabel = h('label.check', { hidden: true }, dupCb, ' Retirer aussi de la source les photos déjà présentes dans la photothèque (l’exemplaire de la photothèque est revérifié avant)');
      const warn = h('div.imp-warn', { hidden: true }, h('b', 'Déplacer efface les fichiers du support d’origine. '), 'Chaque photo est d’abord copiée dans la photothèque, puis comparée à l’original par empreinte SHA-256 et indexée ; l’original n’est supprimé qu’ensuite. En cas de doute, il est conservé. Ne débranchez pas le support pendant l’opération. Ensuite, la photothèque détient le seul exemplaire : pensez à la sauvegarder (Administration, Sauvegardes).');
      const bar = h('div.imp-bar'), barText = h('div.dim'), progress = h('div.imp-progress', { hidden: true }, bar, barText);
      const cancelBtn = h('button.ghost.small', { hidden: true }, 'Arrêter');
      const runBtn = h('button', { onclick: run }, 'Copier');
      const result = h('div');

      async function run() {
        const sources = files.filter(f => sel.has(f.path)).map(f => f.path);
        if (!sources.length) return toast('Aucune photo choisie', 'warn');
        if (mode === 'move' && !(await confirmDialog('Déplacer les photos',
          `${fmtNum(sources.length)} photo(s) (${fmtBytes(sizeOf())}) seront copiées dans la photothèque, vérifiées, puis SUPPRIMÉES de « ${sc.root} ».${removeDup ? '\n\nLes photos déjà présentes dans la photothèque seront aussi supprimées du support.' : ''}\n\nChaque original n’est effacé qu’après vérification de sa copie.${phoneId ? '

Sur le téléphone, Windows peut demander une confirmation de suppression à l’écran : acceptez-la, sinon la photo reste sur le téléphone.' : ''}`))) return;
        let jobId;
        try { ({ jobId } = await api('/import/start', 'POST', { sources, mode, verify, removeDuplicateSources: mode === 'move' && removeDup, supportId: drive?.support?.id ?? null, root: sc.root, phone: phoneId })); }
        catch (e) { return toast(e.message, 'bad'); }
        picker.dataset.busy = '1'; runBtn.disabled = true; progress.hidden = false; cancelBtn.hidden = false; clear(result);
        cancelBtn.onclick = async () => { cancelBtn.disabled = true; try { await api('/import/cancel', 'POST', { jobId }); } catch { /* terminé entre-temps */ } };
        const tick = async () => {
          let job; try { job = (await api('/jobs/' + jobId)).job; } catch { return setTimeout(tick, 800); }
          const pct = job.total ? Math.round(100 * job.done / job.total) : 0;
          bar.style.setProperty('--p', pct + '%'); barText.textContent = `${fmtNum(job.done)} / ${fmtNum(job.total)} · ${job.status === 'running' ? (job.current ? String(job.current).split(/[\\/]/).pop() : '…') : ''}`;
          if (job.status === 'running') return setTimeout(tick, 400);
          delete picker.dataset.busy; progress.hidden = true; cancelBtn.hidden = true; cancelBtn.disabled = false;
          if (job.status === 'error') { toast(job.error || 'Import en erreur', 'bad'); runBtn.disabled = false; return; }
          state.stats = await api('/stats'); renderNav(); loadDrives(true);
          // la source a changé (photos déplacées) : on réanalyse et on affiche le bilan au-dessus
          try { renderPicker(await api('/import/scan', 'POST', phoneId ? { phone: phoneId } : { path: sc.root }), drive, job.result); } catch { showSummary(job.result); }
        };
        tick();
      }
      function showSummary(r) {
        if (!r) return;
        const bad = r.results.filter(x => x.status === 'error' || x.reason);
        mount(result, h('div.imp-summary',
          h('b', r.stopped ? 'Import interrompu' : (r.errors ? 'Import terminé avec des erreurs' : 'Import terminé')),
          h('ul',
            h('li', `${fmtNum(r.copied)} photo(s) importée(s)` + (r.mode === 'move' ? `, dont ${fmtNum(r.moved)} déplacée(s) (source supprimée)` : '')),
            r.duplicates ? h('li', `${fmtNum(r.duplicates)} déjà présente(s) dans la photothèque` + (r.removedDuplicates ? ` — ${fmtNum(r.removedDuplicates)} retirée(s) de la source` : ' — source conservée')) : null,
            r.keptSources ? h('li', { style: { color: 'var(--warn)' } }, `${fmtNum(r.keptSources)} source(s) conservée(s) (copie faite, suppression impossible ou non prouvée)`) : null,
            r.skipped ? h('li', `${fmtNum(r.skipped)} ignorée(s)`) : null,
            r.errors ? h('li', { style: { color: 'var(--bad)' } }, `${fmtNum(r.errors)} erreur(s) : les sources correspondantes n’ont pas été touchées`) : null),
          bad.length ? h('details', h('summary', 'Détail'), h('ul', ...bad.slice(0, 20).map(x => h('li', h('small', `${String(x.src).split(/[\\/]/).pop()} : ${x.error || x.reason}`))))) : null,
          h('div.row', h('button.small', { onclick: () => { state.q = ''; state.facet = {}; state.sort = 'added_desc'; state.page = 0; go('photos'); } }, 'Voir les photos importées'))));
      }

      mount(picker, card(
        h('div.row', h('div.sect', `Photos de « ${title} »`), h('div.spacer'), h('button.ghost.small', { onclick: () => renderPicker(sc, drive) }, 'Réinitialiser le choix'), h('button.ghost.small', { onclick: async () => openPicker(sc.root, drive) }, phoneId ? 'Relire le téléphone' : 'Réanalyser'), h('button.ghost.small', { onclick: () => clear(picker) }, 'Fermer')),
        h('p.dim', `${sc.root} · ${fmtNum(files.length)} photo(s), ${fmtBytes(sc.bytes)} · ${fmtNum(sc.newCount)} pas encore dans la photothèque` + (sc.truncated ? ' · liste limitée aux premières photos' : '')),
        files.length ? h('div', h('div.row.imp-tools',
          h('button.ghost.small', { onclick: () => { for (const f of files) sel.add(f.path); sync(); } }, 'Tout choisir'),
          h('button.ghost.small', { onclick: () => { sel.clear(); sync(); } }, 'Aucune'),
          h('button.ghost.small', { onclick: () => { sel.clear(); for (const f of files) if (!f.known) sel.add(f.path); sync(); } }, 'Nouvelles seulement'),
          h('button.ghost.small', { onclick: () => { for (const f of files) f.known ? sel.delete(f.path) : sel.add(f.path); sync(); } }, 'Inverser'),
          h('div.spacer'), countEl, sizeEl),
          h('p.dim.imp-hint', 'Cliquez sur une photo pour la choisir ou l’écarter ; Maj + clic choisit une série. Par défaut, seules les photos pas encore importées sont cochées.'),
          groupsEl,
          h('h4', 'Que faire des photos choisies ?'),
          modeBox, warn,
          h('div.imp-opts', h('label.check', verifyCb, ' Vérifier chaque copie par empreinte (toujours actif en déplacement)'), dupLabel),
          h('p.dim', `Destination : ${destDir || 'dossier d’import'} (réglable dans Paramètres). Aucun fichier n’est jamais remplacé : un nom déjà pris est suivi de (2), (3)…`),
          h('div.row', runBtn, cancelBtn),
          progress)
          : h('p.dim', 'Aucune image trouvée dans ce dossier.'),
        result));
      if (summary) showSummary(summary);
      sync();
    }

    mount(v,
      h('h2.page-title', 'Importation'),
      card(h('div.row', h('div.sect', 'Supports détectés'), h('div.spacer'), h('button.ghost.small', { onclick: () => loadDrives(true) }, '↻ Actualiser')),
        h('p.dim', 'Cartes mémoire, clés USB, disques et téléphones branchés à cet ordinateur. Choisissez-en un pour voir ses photos, puis cochez celles à importer.'),
        drivesWrap,
        h('div.form', field('Autre dossier (réseau, copie sur disque…)', h('div.row', manualInput, h('button.small', { onclick: () => openPicker(manualInput.value.trim(), null) }, 'Voir les photos'))))),
      picker,
      card(h('div.sect', 'Ajouter et indexer un dossier (sans copie)'),
        h('p.dim', "L'indexation lit les fichiers, extrait les métadonnées et génère les vignettes. Vos originaux ne sont ni copiés, ni modifiés, ni déplacés."),
        h('div.form',
          field('Chemin du dossier', pathInput),
          field('Support rattaché', supportSel),
          h('div.field', h('label', ' '), h('button', { onclick: addFolder }, 'Ajouter le dossier')),
        )),
      card(h('div.sect', 'Dossiers indexés'), folderList),
    );
    renderFolders(folders.list);
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
  // Arborescence, synonymes, catégories (lib/keywords.mjs) ; une recherche sur un mot-clé inclut ceux
  // qui sont rangés dessous et ses synonymes.
  async function viewKeywords(v) {
    clear(v);
    const kw = state.kwView ??= { filter: '', category: '', open: {}, tab: 'tree' };
    let all = [], byId = new Map(), cats = [];
    const treeWrap = h('div.kw-tree'), statsWrap = h('div'), dupWrap = h('div');
    const pathOf = k => { const out = []; let p = k; for (let i = 0; p && i < 32; i++) { out.unshift(p.name); p = p.parent_id ? byId.get(p.parent_id) : null; } return out.join(' › '); };
    const childrenOf = id => all.filter(k => (k.parent_id ?? null) === id).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    const descendants = id => { const out = new Set([id]); let grew = true; while (grew) { grew = false; for (const k of all) if (k.parent_id && out.has(k.parent_id) && !out.has(k.id)) { out.add(k.id); grew = true; } } return out; };
    const total = id => { const ids = descendants(id); return all.filter(k => ids.has(k.id)).reduce((a, k) => a + k.photo_count, 0); };
    const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

    async function load() {
      const r = await api('/keywords');
      all = r.list; cats = r.categories ?? []; byId = new Map(all.map(k => [k.id, k])); state.keywords = all;
      renderTree(); renderCats();
    }
    function matches(k) {
      if (kw.category && (k.data?.category ?? '') !== kw.category) return false;
      if (!kw.filter) return true;
      const f = norm(kw.filter);
      return norm(k.name).includes(f) || (k.data?.synonyms ?? []).some(s => norm(s).includes(f));
    }
    function renderTree() {
      clear(treeWrap);
      if (!all.length) { treeWrap.appendChild(h('p.dim', 'Aucun mot-clé. Créez-en ci-dessus, depuis une photo, ou importez une liste.')); return; }
      const filtering = !!(kw.filter || kw.category);
      // en filtrant : les mots-clés trouvés et leurs parents (pour garder le chemin)
      const keep = new Set();
      if (filtering) for (const k of all) if (matches(k)) { let p = k; for (let i = 0; p && i < 32; i++) { keep.add(p.id); p = p.parent_id ? byId.get(p.parent_id) : null; } }
      const row = (k, depth) => {
        const kids = childrenOf(k.id).filter(c => !filtering || keep.has(c.id));
        const open = filtering || kw.open[k.id];
        const toggle = kids.length ? h('button.kw-toggle', { title: open ? 'Replier' : 'Déplier', onclick: () => { kw.open[k.id] = !kw.open[k.id]; renderTree(); } }, open ? '▾' : '▸') : h('span.kw-toggle');
        const syn = k.data?.synonyms?.length ? h('small.dim', ' = ' + k.data.synonyms.join(', ')) : null;
        const sum = kids.length ? total(k.id) : k.photo_count;
        const el = h('div.kw-row', { style: { paddingLeft: (depth * 22 + 4) + 'px' }, class: filtering && !matches(k) ? 'kw-ctx' : '' },
          toggle,
          h('div.grow', h('b', k.name), syn, k.data?.category ? h('span.pill', { style: { marginLeft: '8px' } }, k.data.category) : null,
            k.data?.description ? h('div', h('small.dim', k.data.description)) : null),
          h('span.badge', { title: kids.length ? `${k.photo_count} photo(s) directement, ${sum} avec les mots-clés rangés dessous` : 'photos' }, kids.length && sum !== k.photo_count ? `${fmtNum(k.photo_count)} · ${fmtNum(sum)}` : fmtNum(k.photo_count)),
          h('div.row-actions',
            h('button.ghost.small', { onclick: () => App.searchKeyword(k) }, 'Voir'),
            h('button.ghost.small', { onclick: () => editKw(k) }, 'Modifier…'),
            h('button.ghost.small', { title: 'Créer un mot-clé rangé sous celui-ci', onclick: () => editKw(null, k.id) }, '+ Dessous'),
            h('button.danger.small', { onclick: () => removeKw(k) }, 'Supprimer')));
        treeWrap.appendChild(el);
        if (open) for (const c of kids) row(c, depth + 1);
      };
      const roots = childrenOf(null).filter(k => !filtering || keep.has(k.id));
      for (const k of roots) row(k, 0);
      if (filtering && !roots.length) treeWrap.appendChild(h('p.dim', 'Aucun mot-clé ne correspond.'));
    }
    const catSel = h('select', { onchange: () => { kw.category = catSel.value; renderTree(); } });
    function renderCats() {
      mount(catSel, h('option', { value: '' }, 'Toutes les catégories'), ...cats.map(c => h('option', { value: c, selected: c === kw.category }, c)));
      if (kw.category && !cats.includes(kw.category)) kw.category = '';
    }
    async function removeKw(k) {
      const kids = childrenOf(k.id).length;
      const msg = `Supprimer « ${k.name} » et ses ${k.photo_count} affectation(s) ?` + (kids ? `\nLes ${kids} mot(s)-clé(s) rangé(s) dessous remontent d’un niveau.` : '') + '\nLes photos ne sont pas touchées.';
      if (!(await confirmDialog('Supprimer le mot-clé', msg))) return;
      await api('/keywords/' + k.id, 'DELETE'); toast('Mot-clé supprimé'); await load(); loadSide();
    }
    function editKw(k, parentId = null) {
      const name = h('input', { type: 'text', value: k?.name ?? '' });
      const forbidden = k ? descendants(k.id) : new Set();
      const par = h('select', {}, h('option', { value: '' }, '— Racine —'),
        ...all.filter(x => !forbidden.has(x.id)).map(x => ({ x, p: pathOf(x) })).sort((a, b) => a.p.localeCompare(b.p, 'fr', { sensitivity: 'base' }))
          .map(({ x, p }) => h('option', { value: x.id, selected: (k ? k.parent_id : parentId) === x.id }, p)));
      const listId = 'kwCats' + Date.now();
      const cat = h('input', { type: 'text', value: k?.data?.category ?? '', placeholder: 'ex. : Lieux, Personnes, Thèmes', list: listId });
      const syn = h('input', { type: 'text', value: (k?.data?.synonyms ?? []).join(', '), placeholder: 'séparés par des virgules' });
      const desc = h('textarea', { rows: 2 }, k?.data?.description ?? '');
      const m = modal({ title: k ? `Modifier « ${k.name} »` : 'Nouveau mot-clé',
        body: h('div.form', field('Libellé', name), field('Rangé sous', par), field('Catégorie', cat), h('datalist', { id: listId }, ...cats.map(c => h('option', { value: c }))),
          field('Synonymes', syn, 'Une recherche sur un synonyme trouve les photos de ce mot-clé.'), field('Description', desc)),
        actions: [h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
          h('button', { onclick: async () => {
            const body = { name: name.value.trim(), parentId: par.value || null, category: cat.value, synonyms: syn.value, description: desc.value };
            if (!body.name) return toast('Libellé obligatoire', 'bad');
            try {
              if (k) await api('/keywords/' + k.id, 'PUT', body);
              else await api('/keywords', 'POST', body);
              if (body.parentId) kw.open[body.parentId] = true;
              m.close(); toast(k ? 'Mot-clé modifié' : 'Mot-clé créé'); await load(); loadSide();
            } catch (e) { toast(e.message, 'bad'); }
          } }, 'Enregistrer')] });
      setTimeout(() => name.focus(), 0);
    }
    function mergeDialog(group) {
      let target = group.keywords[0].id;
      const radios = group.keywords.map(k => h('label.kw-merge', h('input', { type: 'radio', name: 'kwTarget', value: k.id, checked: k.id === target, onchange: () => { target = k.id; } }),
        h('span', h('b', k.path), h('small.dim', ` — ${k.photo_count} photo(s)${k.category ? ' · ' + k.category : ''}`))));
      const m = modal({ title: 'Fusionner des mots-clés', body: h('div', h('p', 'Mot-clé à conserver :'), ...radios,
        h('p.dim', 'Les photos des autres mots-clés reçoivent celui-ci ; leurs libellés deviennent ses synonymes, et les mots-clés rangés dessous sont déplacés sous lui. Les photos ne sont pas modifiées.')),
        actions: [h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
          h('button', { onclick: async () => {
            try { await api('/keywords/merge', 'POST', { targetId: target, sourceIds: group.keywords.map(k => k.id).filter(id => id !== target) }); m.close(); toast('Mots-clés fusionnés'); await load(); loadSide(); }
            catch (e) { toast(e.message, 'bad'); }
          } }, 'Fusionner')] });
    }
    async function loadSide() {
      const [u, d] = await Promise.all([api('/keywords/usage'), api('/keywords/duplicates')]);
      mount(statsWrap,
        h('div.kpis', kpi('Mots-clés', fmtNum(u.keywords), { sub: `${fmtNum(u.roots)} à la racine` }), kpi('Utilisés', fmtNum(u.used), { sub: `${fmtNum(u.unused)} sans photo` }),
          kpi('Affectations', fmtNum(u.assignments)), kpi('Photos indexées', u.photos ? Math.round(100 * u.photosWith / u.photos) + ' %' : '—', { sub: `${fmtNum(u.photos - u.photosWith)} sans mot-clé` })),
        u.photos - u.photosWith > 0 ? h('div.row', h('button.small.ghost', { title: 'Ouvre la Photothèque filtrée sur les photos sans aucun mot-clé',
          onclick: () => { state.q = ''; document.getElementById('search').value = ''; state.facet = { noKeyword: 'true' }; state.page = 0; go('photos'); } },
          `Voir les ${fmtNum(u.photos - u.photosWith)} photo(s) sans mot-clé`)) : null,
        u.top.length ? h('div', h('h4', 'Les plus utilisés'), h('div', ...u.top.map(k => h('span.kw-chip', { onclick: () => App.searchKeyword(k) }, k.name, h('small.dim', String(k.photo_count)))))) : null,
        u.categories.length > 1 || u.categories[0]?.category ? h('div', h('h4', 'Par catégorie'), table({ columns: [
          { label: 'Catégorie', format: r => r.category || h('span.dim', 'Sans catégorie') }, { label: 'Mots-clés', key: 'keywords', align: 'right' }, { label: 'Affectations', key: 'assignments', align: 'right' }], rows: u.categories })) : null);
      clear(dupWrap);
      if (!d.groups.length) { dupWrap.appendChild(h('p.dim', 'Aucun doublon de vocabulaire repéré.')); return; }
      dupWrap.appendChild(h('p.dim', `${d.groups.length} groupe(s) de mots-clés qui désignent peut-être la même chose. Rien n’est fusionné sans votre accord.`));
      for (const g of d.groups) dupWrap.appendChild(h('div.kw-dup',
        h('div.grow', ...g.keywords.map((k, i) => h('span', i ? ' · ' : '', h('b', k.path), h('small.dim', ` (${k.photo_count})`))), h('div', h('small.dim', g.reasons.join(', ')))),
        h('button.small', { onclick: () => mergeDialog(g) }, 'Fusionner…')));
    }

    const filter = h('input', { type: 'search', placeholder: 'Filtrer (libellé ou synonyme)', value: kw.filter, oninput: () => { kw.filter = filter.value.trim(); renderTree(); } });
    const expand = open => { for (const k of all) if (childrenOf(k.id).length) kw.open[k.id] = open; renderTree(); };
    const imp = h('input', { type: 'file', accept: '.txt,.csv', style: { display: 'none' }, onchange: async () => {
      const file = imp.files[0]; if (!file) return;
      const text = await file.text();
      const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const cells = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',' || c === ';') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out.map(s => s.trim()); };
      let names;
      if (/^"?nom"?[,;]/i.test(lines[0] ?? '')) names = lines.slice(1).map(cells).filter(c => c[0]).map(c => ({ name: c[0], parent: c[1] || null, category: c[3] ?? null, synonyms: c[4] ?? null, description: c[5] ?? null }));
      else names = lines;
      const r = await api('/keywords/import', 'POST', { names }); imp.value = ''; toast(`${r.created} mot(s)-clé(s) importé(s) ou complété(s)`); await load(); loadSide();
    } });
    mount(v, h('h2.page-title', 'Mots-clés'),
      card(h('div.row.kw-bar', filter, catSel, h('div.spacer'),
        h('button.ghost.small', { onclick: () => expand(true) }, 'Tout déplier'), h('button.ghost.small', { onclick: () => expand(false) }, 'Tout replier'),
        h('button.ghost.small', { onclick: () => imp.click(), title: 'Fichier texte (un mot-clé par ligne) ou CSV exporté par Photothèque' }, 'Importer…'), imp,
        h('button.ghost.small', { onclick: () => { location.href = '/api/keywords/export'; } }, 'Exporter (CSV)'),
        h('button.small', { onclick: () => editKw(null) }, '+ Nouveau mot-clé')),
        h('p.dim', 'Rangez les mots-clés les uns sous les autres : chercher un mot-clé trouve aussi les photos des mots-clés rangés dessous et de ses synonymes. Le nombre affiché après « · » compte les photos de toute la branche.'),
        treeWrap),
      h('div.grid2', card(h('div.sect', 'Statistiques d’utilisation'), statsWrap), card(h('div.sect', 'Doublons de vocabulaire'), dupWrap)));
    await load(); await loadSide();
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
    noKeyword: 'sans mot-clé', hasKeyword: 'avec mot-clé', hasCaption: 'avec légende', noCaption: 'sans légende', noDate: 'sans date', duplicate: 'doublons',
    hideVariants: 'sans les variantes', variants: 'seulement les variantes', variantsOf: 'référence et variantes de',
    place: 'lieu', hasPlace: 'lieu', backup: 'sauvegarde', keywordCategory: 'catégorie de mot-clé',
  };
  function describeQuery(q) {
    const kwName = id => state.keywords.find(k => k.id === id)?.name ?? id;
    const parts = Object.entries(q ?? {}).filter(([k]) => CRITERIA[k]).map(([k, val]) => {
      if (val === true || val === 'true') return CRITERIA[k];
      if (k === 'missing') return +val ? 'indisponibles' : 'présentes';
      if (k === 'hasGps') return [false, 0, '0', 'false'].includes(val) ? 'sans GPS' : 'avec GPS';
      if (k === 'hasPlace') return [false, 0, '0', 'false'].includes(val) ? 'lieu non renseigné' : 'lieu renseigné';
      if (k === 'backup') return { covered: 'copie de sauvegarde', uncovered: 'sans copie de sauvegarde', single: 'un seul exemplaire' }[val] ?? val;
      if (k === 'keywordId') return `${CRITERIA[k]} « ${kwName(val)} »`;
      if (k === 'from' || k === 'to') return `${CRITERIA[k]} ${fmtDate(String(val).slice(0, 10))}`;
      if (k === 'orientation') return { landscape: 'paysage', portrait: 'portrait', square: 'carré' }[val] ?? val;
      return `${CRITERIA[k]} « ${[].concat(val).join(', ')} »`;
    });
    return parts.length ? parts.join(' · ') : 'aucun critère';
  }
  // ---------- Retouche non destructive (réglages enregistrés à part : lib/edits.mjs) ----------
  function openRetouche(photoId) { state.editPhotoId = photoId; state.editBack = state.view === 'retouche' ? state.editBack : state.view; go('retouche'); }

  async function viewRetouche(v) {
    const pid = state.editPhotoId, enc = encodeURIComponent(pid);
    const photo = (await api('/photos/' + enc)).photo;
    let meta = await api(`/photos/${enc}/edits`);
    const F = meta.fields, neutral = { ...meta.defaults };
    let versions = meta.versions;
    let cur = versions.find(x => x.is_default) ?? versions[0] ?? null; // null : original, aucune version encore
    let params = { ...(cur?.params ?? neutral) };
    let cropMode = false, cropBox = null, ratio = 'free';
    const fileName = photo.files?.[0]?.file_name || photo.title || 'Photo';

    // ---- aperçu (rendu par le serveur, mis en cache) ----
    const img = h('img.rt-img', { alt: '' });
    const overlay = h('div.rt-crop', { hidden: true });
    const stage = h('div.rt-stage', h('div.rt-frame', img, overlay));
    const busy = h('div.rt-busy', { hidden: true }, 'Rendu…');
    let seq = 0, timer = null;
    const renderUrl = (prm, noCrop) => `/api/photos/${enc}/render?size=1400${noCrop ? '&nocrop=1' : ''}&params=${encodeURIComponent(JSON.stringify(prm))}`;
    function refreshPreview(delay = 120) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const n = ++seq, url = renderUrl(params, cropMode), pre = new Image();
        busy.hidden = false;
        pre.onload = () => { if (n !== seq) return; img.src = url; busy.hidden = true; if (cropMode) drawCrop(); };
        pre.onerror = () => { if (n === seq) { busy.hidden = true; toast('Rendu impossible pour cette photo', 'bad'); } };
        pre.src = url;
      }, delay);
    }
    // avant / après : l'original (aperçu non retouché) tant que le bouton est enfoncé
    const beforeBtn = h('button.ghost.small', { title: 'Maintenir pour voir l’original' }, '◐ Avant / après');
    const showBefore = on => { img.src = on ? renderUrl(neutral, false) : renderUrl(params, cropMode); };
    beforeBtn.addEventListener('pointerdown', () => showBefore(true));
    for (const ev of ['pointerup', 'pointerleave']) beforeBtn.addEventListener(ev, () => showBefore(false));

    // ---- enregistrement : chaque modification validée est une étape annulable de la version ----
    async function commit() {
      try {
        if (!cur) { cur = (await api(`/photos/${enc}/edits`, 'POST', { params })).version; versions = [...versions, cur]; }
        else cur = (await api('/edits/' + encodeURIComponent(cur.id), 'PUT', { params })).version;
        params = { ...cur.params }; versions = versions.map(x => (x.id === cur.id ? cur : x));
        drawPanel();
      } catch (e) { toast(e.message, 'bad'); }
    }
    async function act(path, method = 'POST', payload) {
      try { cur = (await api('/edits/' + encodeURIComponent(cur.id) + path, method, payload)).version; params = { ...cur.params }; versions = versions.map(x => (x.id === cur.id ? cur : x)); drawPanel(); refreshPreview(0); }
      catch (e) { toast(e.message, 'bad'); }
    }
    const set = (patch, now = false) => { Object.assign(params, patch); refreshPreview(); if (now) commit(); };

    // ---- géométrie : quarts de tour et miroirs transforment aussi le recadrage (exprimé dans l'image affichée) ----
    function turn(dir) {
      const c = params.crop;
      const crop = c ? (dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }) : null;
      set({ rotate: (params.rotate + dir * 90 + 360) % 360, crop }, true);
    }
    function flip(axis) {
      const c = params.crop;
      const crop = c ? (axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h }) : null;
      set(axis === 'h' ? { flipH: !params.flipH, crop } : { flipV: !params.flipV, crop }, true);
    }

    // ---- recadrage : cadre déplaçable et redimensionnable sur l'image entière (sans recadrage) ----
    const RATIOS = { free: 'Libre', orig: 'Proportion d’origine', '1:1': 'Carré 1:1', '4:3': '4:3', '3:2': '3:2', '16:9': '16:9', '4:5': '4:5 (portrait)', '2:3': '2:3 (portrait)' };
    const aspect = () => (img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1);
    const ratioValue = () => { if (ratio === 'free') return null; if (ratio === 'orig') return aspect(); const [a, b] = ratio.split(':').map(Number); return a / b; };
    function fitRatio(b) {
      const r = ratioValue(); if (!r) return b;
      const A = aspect(); let w = b.w, hh = (w * A) / r;
      if (hh > 1) { hh = 1; w = (hh * r) / A; }
      return { x: Math.min(b.x, 1 - w), y: Math.min(b.y, 1 - hh), w, h: hh };
    }
    function drawCrop() {
      overlay.hidden = !cropMode; if (!cropMode || !cropBox) return;
      Object.assign(overlay.style, { left: cropBox.x * 100 + '%', top: cropBox.y * 100 + '%', width: cropBox.w * 100 + '%', height: cropBox.h * 100 + '%' });
    }
    let dragC = null;
    overlay.appendChild(h('div.rt-handle'));
    overlay.addEventListener('pointerdown', e => {
      e.preventDefault();
      dragC = { x: e.clientX, y: e.clientY, box: { ...cropBox }, resize: e.target.classList.contains('rt-handle') };
      try { overlay.setPointerCapture(e.pointerId); } catch { /* sans capture */ }
    });
    overlay.addEventListener('pointermove', e => {
      if (!dragC) return;
      const R = img.getBoundingClientRect(), dx = (e.clientX - dragC.x) / R.width, dy = (e.clientY - dragC.y) / R.height, b = dragC.box;
      if (dragC.resize) {
        let w = Math.max(0.05, Math.min(1 - b.x, b.w + dx)), hh = Math.max(0.05, Math.min(1 - b.y, b.h + dy));
        const r = ratioValue(); if (r) { hh = (w * aspect()) / r; if (b.y + hh > 1) { hh = 1 - b.y; w = (hh * r) / aspect(); } }
        cropBox = { x: b.x, y: b.y, w, h: hh };
      } else cropBox = { ...b, x: Math.max(0, Math.min(1 - b.w, b.x + dx)), y: Math.max(0, Math.min(1 - b.h, b.y + dy)) };
      drawCrop();
    });
    overlay.addEventListener('pointerup', () => { dragC = null; });
    function startCrop() { cropMode = true; cropBox = params.crop ? { ...params.crop } : { x: 0, y: 0, w: 1, h: 1 }; drawPanel(); refreshPreview(0); }
    function endCrop(apply) {
      cropMode = false; overlay.hidden = true;
      if (apply) set({ crop: cropBox && (cropBox.w < 0.999 || cropBox.h < 0.999) ? cropBox : null }, true);
      else { drawPanel(); refreshPreview(0); }
    }

    // ---- panneau de réglages ----
    const panel = h('div.rt-panel');
    function slider(key) {
      const f = F[key], out = h('span.rt-val', String(params[key]));
      const input = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: params[key] });
      input.addEventListener('input', () => { out.textContent = input.value; set({ [key]: +input.value }); });
      input.addEventListener('change', () => commit());
      input.addEventListener('dblclick', () => { input.value = 0; out.textContent = '0'; set({ [key]: 0 }, true); });
      return h('div.rt-slider', h('label', f.label, out), input);
    }
    function drawPanel() {
      const verSel = h('select', { onchange: e => { cur = versions.find(x => x.id === e.target.value) ?? null; params = { ...(cur?.params ?? neutral) }; drawPanel(); refreshPreview(0); } },
        versions.length ? null : h('option', { value: '' }, 'Original (aucune retouche)'),
        ...versions.map(x => h('option', { value: x.id, selected: x.id === cur?.id }, x.name + (x.is_default ? ' ★' : ''))));
      const groups = {};
      for (const key of Object.keys(F)) if (key !== 'straighten') (groups[F[key].group] ??= []).push(slider(key));
      const cap = meta.capability;
      mount(panel,
        cap.fullRes === false ? h('div.album-alert.warn', cap.reason) : null,
        h('div.rt-sect', 'Version'),
        h('div.row', verSel),
        h('div.row.wrap',
          h('button.ghost.small', { title: 'Nouvelle version à partir des réglages actuels', onclick: async () => { cur = (await api(`/photos/${enc}/edits`, 'POST', cur ? { from: cur.id } : { params })).version; versions = [...versions, cur]; params = { ...cur.params }; drawPanel(); } }, '+ Nouvelle version'),
          cur ? h('button.ghost.small', { onclick: async () => { const nm = prompt('Nom de la version', cur.name); if (nm) await act('', 'PUT', { name: nm }); } }, 'Renommer…') : null,
          cur && !cur.is_default ? h('button.ghost.small', { title: 'Version utilisée par l’export', onclick: async () => { await act('', 'PUT', { isDefault: true }); versions = (await api(`/photos/${enc}/edits`)).versions; drawPanel(); } }, '★ Par défaut') : null,
          cur ? h('button.ghost.small.danger', { onclick: async () => { if (!(await confirmDialog('Supprimer la version', `Supprimer « ${cur.name} » ? L’original n’est jamais modifié.`))) return; await api('/edits/' + encodeURIComponent(cur.id), 'DELETE'); meta = await api(`/photos/${enc}/edits`); versions = meta.versions; cur = versions.find(x => x.is_default) ?? null; params = { ...(cur?.params ?? neutral) }; drawPanel(); refreshPreview(0); } }, 'Supprimer') : null),
        h('div.row.wrap',
          h('button.ghost.small', { disabled: !cur?.undo, title: 'Ctrl+Z', onclick: () => act('/undo') }, '↶ Annuler'),
          h('button.ghost.small', { disabled: !cur?.redo, title: 'Ctrl+Y', onclick: () => act('/redo') }, '↷ Rétablir'),
          h('button.ghost.small', { disabled: !cur || cur.neutral, title: 'Revenir aux réglages neutres (annulable)', onclick: () => act('/reset') }, 'Réinitialiser'),
          beforeBtn),
        h('div.rt-sect', 'Filtres'),
        h('div.rt-presets', ...Object.entries(meta.presets).map(([k, pr]) => h('button.ghost.small', { onclick: () => {
          const tone = Object.fromEntries(meta.toneKeys.map(t => [t, neutral[t]]));
          set({ ...tone, ...pr.params }, true);
        } }, pr.label))),
        h('div.rt-sect', 'Géométrie'),
        cropMode
          ? h('div', h('div.form', field('Proportion', h('select', { onchange: e => { ratio = e.target.value; cropBox = fitRatio(cropBox); drawCrop(); } }, ...Object.entries(RATIOS).map(([k, l]) => h('option', { value: k, selected: k === ratio }, l))))),
              h('p.dim', 'Faites glisser le cadre ; le coin en bas à droite le redimensionne.'),
              h('div.row', h('button.ghost.small', { onclick: () => { cropBox = { x: 0, y: 0, w: 1, h: 1 }; drawCrop(); } }, 'Image entière'), h('div.spacer'),
                h('button.ghost.small', { onclick: () => endCrop(false) }, 'Annuler'), h('button.small', { onclick: () => endCrop(true) }, 'Appliquer')))
          : h('div.row.wrap',
              h('button.ghost.small', { title: 'Tourner à gauche', onclick: () => turn(-1) }, '↺'),
              h('button.ghost.small', { title: 'Tourner à droite', onclick: () => turn(1) }, '↻'),
              h('button.ghost.small' + (params.flipH ? '.on' : ''), { title: 'Miroir horizontal', onclick: () => flip('h') }, '⇋'),
              h('button.ghost.small' + (params.flipV ? '.on' : ''), { title: 'Miroir vertical', onclick: () => flip('v') }, '⇵'),
              h('button.ghost.small' + (params.crop ? '.on' : ''), { onclick: startCrop }, '✂ Recadrer')),
        cropMode ? null : slider('straighten'),
        ...Object.entries(groups).flatMap(([g, list]) => [h('div.rt-sect', g), ...list]),
        h('div.rt-sect', 'Courbe de tonalité'), curveEditor(),
        h('div.form', field('Noir et blanc', h('select', { onchange: e => set({ mono: e.target.value || null }, true) },
          h('option', { value: '' }, 'Couleur'), h('option', { value: 'bw', selected: params.mono === 'bw' }, 'Noir et blanc'), h('option', { value: 'sepia', selected: params.mono === 'sepia' }, 'Sépia')))),
        h('p.dim', 'Double-clic sur un curseur : remise à zéro. Les réglages sont enregistrés à part ; l’original n’est jamais modifié.'));
      drawCrop();
    }

    // ---- courbe de tonalité : points déplaçables (clic = ajouter, double-clic = retirer) ----
    function curveEditor() {
      const S = 220, cv = h('canvas.rt-curve', { width: S, height: S, title: 'Cliquer pour ajouter un point, le faire glisser ; double-clic pour le retirer' });
      const pts = () => params.curve ? params.curve.map(q => [...q]) : [[0, 0], [255, 255]];
      let work = pts(), drag = -1;
      const toXY = e => { const r = cv.getBoundingClientRect(); return [Math.round(Math.min(255, Math.max(0, (e.clientX - r.left) / r.width * 255))), Math.round(Math.min(255, Math.max(0, 255 - (e.clientY - r.top) / r.height * 255)))]; };
      function draw() {
        const c = cv.getContext('2d'), css = getComputedStyle(document.body);
        c.clearRect(0, 0, S, S);
        c.strokeStyle = css.getPropertyValue('--border') || '#334155'; c.lineWidth = 1;
        for (let i = 1; i < 4; i++) { const v = Math.round(i * S / 4) + 0.5; c.beginPath(); c.moveTo(v, 0); c.lineTo(v, S); c.moveTo(0, v); c.lineTo(S, v); c.stroke(); }
        c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, S); c.lineTo(S, 0); c.stroke(); c.setLineDash([]);
        const lut = curveLutUi(work);
        c.strokeStyle = css.getPropertyValue('--accent') || '#22d3ee'; c.lineWidth = 2; c.beginPath();
        for (let x = 0; x < 256; x++) { const px = x / 255 * S, py = S - lut[x] / 255 * S; x ? c.lineTo(px, py) : c.moveTo(px, py); }
        c.stroke();
        c.fillStyle = '#fff';
        for (const [x, y] of work) { c.beginPath(); c.arc(x / 255 * S, S - y / 255 * S, 4.5, 0, 7); c.fill(); c.stroke(); }
      }
      const apply = commitNow => { const sorted = [...work].sort((a, b) => a[0] - b[0]); set({ curve: sorted }, commitNow); };
      cv.addEventListener('pointerdown', e => {
        const [x, y] = toXY(e);
        drag = work.findIndex(q => Math.abs(q[0] - x) <= 8 && Math.abs(q[1] - y) <= 10);
        if (drag < 0 && work.length < 16 && !work.some(q => q[0] === x)) { work.push([x, y]); work.sort((a, b) => a[0] - b[0]); drag = work.findIndex(q => q[0] === x); }
        try { cv.setPointerCapture(e.pointerId); } catch { /* sans capture */ }
        draw();
      });
      cv.addEventListener('pointermove', e => {
        if (drag < 0) return;
        let [x, y] = toXY(e);
        const lo = drag > 0 ? work[drag - 1][0] + 1 : 0, hi = drag < work.length - 1 ? work[drag + 1][0] - 1 : 255;
        x = Math.min(hi, Math.max(lo, x)); work[drag] = [x, y]; draw(); apply(false);
      });
      cv.addEventListener('pointerup', () => { if (drag >= 0) { drag = -1; apply(true); } });
      cv.addEventListener('dblclick', e => {
        const [x, y] = toXY(e), i = work.findIndex(q => Math.abs(q[0] - x) <= 8 && Math.abs(q[1] - y) <= 10);
        if (i > 0 && i < work.length - 1) { work.splice(i, 1); draw(); apply(true); }
      });
      const preset = h('select', { onchange: e => { const c = meta.curves[e.target.value]; work = c.points ? c.points.map(q => [...q]) : [[0, 0], [255, 255]]; draw(); set({ curve: c.points }, true); } },
        h('option', { value: '' }, 'Courbes prédéfinies…'), ...Object.entries(meta.curves).map(([k, c]) => h('option', { value: k }, c.label)));
      requestAnimationFrame(draw);
      return h('div.rt-curve-wrap', cv, h('div.row', preset, h('button.ghost.small', { onclick: () => { work = [[0, 0], [255, 255]]; draw(); set({ curve: null }, true); } }, 'Linéaire')));
    }

    // ---- logiciel externe : toujours sur une copie ----
    async function externalDialog() {
      const ext = await api('/external');
      const src = h('select', {}, ...Object.entries(ext.sources).map(([k, l]) => h('option', { value: k }, l)));
      const out = h('div');
      const m2 = modal({ title: 'Ouvrir dans un logiciel externe', body: h('div',
        h('p', 'Le logiciel reçoit une ', h('b', 'copie'), ' rangée dans ', h('code', ext.dir), ' : l’original n’est jamais modifié.'),
        h('p.dim', `Logiciel : ${ext.check.label}. `, h('button.link', { onclick: () => { m2.close(); go('settings'); } }, 'Choisir dans Paramètres')),
        h('div.form', field('Fichier à ouvrir', src)), out),
        actions: [h('button.ghost', { onclick: () => m2.close() }, 'Fermer'),
          h('button', { onclick: async () => {
            try {
              const r = await api(`/photos/${enc}/external`, 'POST', { source: src.value });
              mount(out, h('p', `Copie ouverte avec ${r.program} : `, h('code', r.file)),
                r.fromPreview ? h('div.album-alert.warn', 'Original indisponible ou RAW : la version a été rendue depuis l’aperçu en cache.') : null,
                h('p.dim', 'Enregistrez vos modifications dans ce dossier, puis :'),
                h('button.ghost.small', { onclick: async () => { const x = await api('/external/index', 'POST'); toast(`${x.added} photo(s) ajoutée(s), ${x.updated} mise(s) à jour`); } }, 'Ajouter les fichiers modifiés à la photothèque'));
            } catch (e) { mount(out, h('div.album-alert.bad', e.message)); }
          } }, 'Ouvrir')] });
    }

    // raccourcis Ctrl+Z / Ctrl+Y (hors champs de saisie)
    keyHandler = e => {
      if (state.view !== 'retouche' || state.editPhotoId !== pid || !cur) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest?.('input, textarea, select') || document.querySelector('.modal')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey && cur.undo) { e.preventDefault(); act('/undo'); }
      else if ((k === 'y' || (k === 'z' && e.shiftKey)) && cur.redo) { e.preventDefault(); act('/redo'); }
    };

    mount(v,
      h('div.row', h('h2.page-title', `Retouche — ${fileName}`), h('div.spacer'),
        h('button.ghost.small', { onclick: () => go(state.editBack || 'photos') }, '← Retour'),
        h('button.ghost.small', { title: 'GIMP, Photoshop, darktable… sur une copie', onclick: externalDialog }, 'Ouvrir dans…'),
        h('button.small', { onclick: () => exportDialog([pid]) }, 'Exporter…')),
      h('div.rt-layout', h('div.rt-view', stage, busy), panel));
    drawPanel(); refreshPreview(0);
  }

  // ---------- Export de photos (lib/exports.mjs) : profil, réglages, travail suivi, compte rendu ----------
  // ---------- Courbe de tonalité : affichage (même interpolation que curveLut, lib/edits.mjs, qui fait foi) ----------
  function curveLutUi(points) {
    const lut = new Uint8Array(256), n = points.length, xs = points.map(q => q[0]), ys = points.map(q => q[1]);
    if (n < 2) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1, xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], t = a * a + b * b;
      if (t > 9) { const k = 3 / Math.sqrt(t); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
    }
    for (let x = 0; x < 256; x++) {
      let y;
      if (x <= xs[0]) y = ys[0]; else if (x >= xs[n - 1]) y = ys[n - 1];
      else { let i = 0; while (x > xs[i + 1]) i++; const hh = xs[i + 1] - xs[i], t = (x - xs[i]) / hh, t2 = t * t, t3 = t2 * t;
        y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1]; }
      lut[x] = Math.round(Math.min(255, Math.max(0, y)));
    }
    return lut;
  }

  // ---------- Photos récemment consultées (préférence locale, 60 au plus) ----------
  const RECENT_KEY = 'phototheque.recent';
  const recentIds = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(x => typeof x === 'string'); } catch { return []; } };
  function pushRecent(id) { if (!id) return; try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter(x => x !== id)].slice(0, 60))); } catch { /* historique non gardé */ } }

  // ---------- Visionneuse : zoom pleine définition, informations, classement rapide ----------
  // Touches : 0 à 5 = note ; 6 à 9 = étiquette rouge, jaune, verte, bleue (même touche : retirée) ; I = informations ;
  // K = mot-clé ; Z, +, -, double-clic, molette = zoom.
  const LABEL_COLORS = ['', '#ef4444', '#eab308', '#22c55e', '#3b82f6', '#a855f7'];
  const LABEL_NAMES = ['aucune', 'rouge', 'jaune', 'verte', 'bleue', 'violette'];
  function viewerOpts({ onChange = () => {}, onClose = () => {} } = {}) {
    let kwInput = null;
    const setField = async (p, fields, msg) => {
      try { await api('/photos', 'PUT', { id: p.id, ...fields }); lightboxUpdate({ id: p.id, ...fields }); onChange(); toast(msg); }
      catch (e) { toast(e.message, 'bad'); }
    };
    const info = async p => {
      const { photo: d } = await api('/photos/' + p.id);
      const data = d.data ?? {};
      const place = ['Sublocation', 'City', 'State', 'Country'].map(k => Array.isArray(data[k]) ? data[k][0] : data[k]).filter(Boolean).join(', ');
      const exp = [d.focal_length ? `${d.focal_length} mm` : '', d.aperture ? `f/${d.aperture}` : '', d.shutter || '', d.iso ? `ISO ${d.iso}` : ''].filter(Boolean).join(' · ');
      const dl = rows => h('dl', ...rows.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
      const stars = h('div.stars', ...[1, 2, 3, 4, 5].map(n => h('button' + (n <= d.rating ? '' : '.off'), { title: `${n} étoile(s) (touche ${n})`, onclick: () => setField(p, { rating: n === d.rating ? 0 : n }, n === d.rating ? 'Note retirée' : `Note : ${n}`) }, '★')));
      const labels = h('div.labels', ...[1, 2, 3, 4, 5].map(n => h('button' + (d.color === n ? '.on' : ''), { title: `Étiquette ${LABEL_NAMES[n]}${n <= 4 ? ` (touche ${n + 5})` : ''}`, style: { background: LABEL_COLORS[n] }, onclick: () => setField(p, { color: d.color === n ? 0 : n }, d.color === n ? 'Étiquette retirée' : `Étiquette ${LABEL_NAMES[n]}`) })));
      kwInput = h('input', { type: 'text', placeholder: 'Ajouter un mot-clé (touche K)…', onkeydown: async e => {
        if (e.key !== 'Enter' || !kwInput.value.trim()) return;
        const names = kwInput.value.split(',').map(x => x.trim()).filter(Boolean);
        try { await api('/metadata/edit', 'POST', { ids: [p.id], changes: { keywordsAdd: names }, apply: true }); toast('Mot-clé ajouté'); onChange(); lightboxUpdate({ id: p.id }); }
        catch (err) { toast(err.message, 'bad'); }
      } });
      const file = d.files?.[0];
      return h('div',
        h('b', d.title || file?.file_name || 'Sans titre'), d.description ? h('p.dim', d.description) : null,
        h('h4', 'Classement'), stars, labels,
        h('h4', 'Mots-clés'), h('div', ...(d.keywords ?? []).map(k => h('span.kw-chip', { title: 'Voir les photos', onclick: () => { lightboxClose(); App.searchKeyword(k); } }, k.name))), kwField(kwInput),
        h('h4', 'Prise de vue'), dl([['Date', d.captured_at ? fmtDateTime(d.captured_at) : ''], ['Appareil', [d.camera_make, d.camera_model].filter(Boolean).join(' ')], ['Objectif', d.lens], ['Exposition', exp],
          ['Dimensions', d.width ? `${d.width} × ${d.height} px` : ''], ['Format', d.format ? String(d.format).toUpperCase() : ''], ['Couleur', [data.ColorModel, data.IccProfile].filter(Boolean).join(' · ')],
          ['Lieu', place], ['GPS', d.gps_lat != null ? `${(+d.gps_lat).toFixed(5)} ; ${(+d.gps_lon).toFixed(5)}` : ''], ['Auteur', d.author], ['Copyright', d.copyright]]),
        h('h4', `Fichier${(d.files?.length ?? 0) > 1 ? 's' : ''}`), ...(d.files ?? []).map(fl => dl([['Chemin', fl.path], ['État', fl.status === 'available' ? 'disponible' : 'indisponible'], ['Taille', fl.size_bytes != null ? fmtBytes(fl.size_bytes) : '']])),
        h('p.dim', { style: { marginTop: '14px' } }, 'Touches : ← → photo · 0–5 note · 6–9 étiquette · K mot-clé · Z zoom · I informations · Échap fermer'));
    };
    return {
      info, onClose,
      fullUrl: (p, showOriginal) => p.edit && !showOriginal ? `/api/photos/${encodeURIComponent(p.id)}/render?edit=${encodeURIComponent(p.edit.id)}&size=3000` : `/api/photos/${encodeURIComponent(p.id)}/full`,
      onKey: (e, p) => {
        if (e.ctrlKey || e.metaKey || e.altKey || !p) return false;
        if (/^[0-5]$/.test(e.key)) { const n = +e.key; setField(p, { rating: n }, n ? `Note : ${n}` : 'Note retirée'); return true; }
        if (/^[6-9]$/.test(e.key)) { const n = +e.key - 5; const cur = p.color === n ? 0 : n; setField(p, { color: cur }, cur ? `Étiquette ${LABEL_NAMES[n]}` : 'Étiquette retirée'); return true; }
        if (e.key === 'k' || e.key === 'K') { if (!document.getElementById('lbInfo').hidden && kwInput) { kwInput.focus(); return true; } return false; }
        return false;
      },
    };
  }

  // ---------- Comparaison côte à côte (2 à 4 photos), zoom et déplacement synchronisés ----------
  async function compareView(ids) {
    ids = [...new Set(ids)].slice(0, 4);
    if (ids.length < 2) return toast('Choisissez de 2 à 4 photos', 'bad');
    const r = await api('/photos?ids=' + encodeURIComponent(ids.join(',')) + '&limit=4');
    const cards = ids.map(id => r.rows.find(x => x.id === id)).filter(Boolean);
    const details = await Promise.all(cards.map(c => api('/photos/' + c.id).then(x => x.photo).catch(() => null)));
    let z = 1, sync = true, lock = false, changed = false;
    const panels = cards.map((c, i) => {
      const img = h('img', { src: c.preview || c.thumb || '', alt: '', draggable: 'false' });
      const stageEl = h('div.cmp-stage', img);
      const d = details[i] ?? {};
      const size = d.files?.[0]?.size_bytes;
      const stars = h('div.stars');
      const drawStars = () => mount(stars, ...[1, 2, 3, 4, 5].map(n => h('button' + (n <= (c.rating ?? 0) ? '' : '.off'), { onclick: async () => {
        const v = n === c.rating ? 0 : n; await api('/photos', 'PUT', { id: c.id, rating: v }); c.rating = v; changed = true; drawStars(); } }, '★')));
      drawStars();
      const meta = h('div.cmp-meta', h('b', d.title || d.files?.[0]?.file_name || 'Sans titre'),
        h('div.dim', [c.width ? `${c.width} × ${c.height}` : '', size != null ? fmtBytes(size) : '', c.format ? String(c.format).toUpperCase() : ''].filter(Boolean).join(' · ')),
        h('div.dim', [c.captured_at ? fmtDateTime(c.captured_at) : 'sans date', [c.camera_make, c.camera_model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')),
        stars);
      return { c, img, stageEl, el: h('div.cmp-panel', stageEl, meta), full: false, nat: null };
    });
    const zoomLbl = h('span.cmp-zoom', 'Ajusté');
    const syncCb = h('input', { type: 'checkbox', checked: true, onchange: () => { sync = syncCb.checked; } });
    const root = h('div.compare', { tabindex: '-1' },
      h('div.cmp-bar', h('b', `Comparaison de ${cards.length} photos`), h('span.dim', 'Molette ou double-clic : zoom · glisser : déplacer'),
        h('div.spacer'), zoomLbl, h('button.ghost.small', { onclick: () => setZoom(1) }, 'Ajuster'), h('button.ghost.small', { onclick: () => setZoom(z * 2) }, 'Zoom ×2'),
        h('label.check', syncCb, h('span', 'Synchroniser')), h('button.small', { onclick: close }, 'Fermer')),
      h('div.cmp-grid', { style: { gridTemplateColumns: `repeat(${cards.length}, 1fr)` } }, ...panels.map(p => p.el)));
    document.body.appendChild(root); root.focus();
    // taille « ajustée » de chaque photo dans son panneau ; le zoom z multiplie cette taille (même cadrage relatif pour toutes)
    async function ensureFull(p) {
      if (p.full) return; p.full = true;
      const im = new Image(); im.src = p.c.edit ? `/api/photos/${encodeURIComponent(p.c.id)}/render?edit=${encodeURIComponent(p.c.edit.id)}&size=3000` : `/api/photos/${encodeURIComponent(p.c.id)}/full`;
      try { await UI.loadImage(im); p.img.src = im.src; } catch { p.full = false; }
    }
    function layout(p) {
      const st = p.stageEl, w0 = p.img.naturalWidth || p.c.width || 1, h0 = p.img.naturalHeight || p.c.height || 1;
      const fit = Math.min(st.clientWidth / w0, st.clientHeight / h0);
      p.img.style.width = Math.round(w0 * fit * z) + 'px'; p.img.style.height = Math.round(h0 * fit * z) + 'px';
      root.classList.toggle('zoomed', z > 1);
    }
    function setZoom(nz, src = null, fx = 0.5, fy = 0.5) {
      z = Math.max(1, Math.min(16, nz)); zoomLbl.textContent = z === 1 ? 'Ajusté' : `× ${z.toFixed(1)}`;
      for (const p of (sync || !src ? panels : [src])) {
        if (z > 1.5) ensureFull(p).then(() => { layout(p); scrollTo(p, fx, fy); });
        layout(p); scrollTo(p, fx, fy);
      }
    }
    function scrollTo(p, fx, fy) { const st = p.stageEl; st.scrollLeft = fx * st.scrollWidth - st.clientWidth / 2; st.scrollTop = fy * st.scrollHeight - st.clientHeight / 2; }
    for (const p of panels) {
      p.img.addEventListener('load', () => layout(p));
      const st = p.stageEl;
      st.addEventListener('wheel', e => { e.preventDefault(); const rc = st.getBoundingClientRect(); const fx = (st.scrollLeft + e.clientX - rc.left) / st.scrollWidth, fy = (st.scrollTop + e.clientY - rc.top) / st.scrollHeight; setZoom(e.deltaY < 0 ? z * 1.25 : z / 1.25, p, fx, fy); }, { passive: false });
      st.addEventListener('dblclick', e => { const rc = st.getBoundingClientRect(); setZoom(z > 1 ? 1 : 3, p, (st.scrollLeft + e.clientX - rc.left) / st.scrollWidth, (st.scrollTop + e.clientY - rc.top) / st.scrollHeight); });
      st.addEventListener('scroll', () => {
        if (lock || !sync) return; lock = true;
        const fx = (st.scrollLeft + st.clientWidth / 2) / st.scrollWidth, fy = (st.scrollTop + st.clientHeight / 2) / st.scrollHeight;
        for (const o of panels) if (o !== p) scrollTo(o, fx, fy);
        requestAnimationFrame(() => { lock = false; });
      });
      let drag = null;
      st.addEventListener('mousedown', e => { if (z <= 1 || e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, l: st.scrollLeft, t: st.scrollTop }; e.preventDefault(); });
      root.addEventListener('mousemove', e => { if (!drag) return; st.scrollLeft = drag.l - (e.clientX - drag.x); st.scrollTop = drag.t - (e.clientY - drag.y); });
      root.addEventListener('mouseup', () => { drag = null; });
    }
    const onResize = () => panels.forEach(layout);
    addEventListener('resize', onResize);
    root.addEventListener('keydown', e => { if (e.key === 'Escape') close(); else if (e.key === '+' || e.key === '=') setZoom(z * 1.25); else if (e.key === '-') setZoom(z / 1.25); else if (e.key === 'z' || e.key === 'Z') setZoom(z > 1 ? 1 : 3); });
    requestAnimationFrame(onResize);
    function close() { removeEventListener('resize', onResize); root.remove(); if (changed && state.view === 'photos') go('photos'); }
  }

  // ---------- Historique de navigation (boutons ‹ › et touches Alt+← / Alt+→ du navigateur) ----------
  let restoring = false;
  const navSnapshot = () => ({ view: state.view, facet: { ...state.facet }, q: state.q, sort: state.sort, page: state.page, albumId: state.albumId ?? null, editPhotoId: state.editPhotoId ?? null });
  function pushNav() {
    if (restoring) return;
    const snap = navSnapshot();
    const { _i, ...cur } = history.state ?? {};
    if (JSON.stringify(cur) === JSON.stringify(snap)) return;
    if (history.state) history.pushState(snap, '', '#' + snap.view); else history.replaceState(snap, '', '#' + snap.view);
    updateNavButtons();
  }
  let navDepth = 0, navMax = 0; // position dans l'historique de cette session (pour griser ‹ ›)
  function updateNavButtons() {
    const s = history.state; if (s && typeof s._i !== 'number') { s._i = ++navDepth; navMax = navDepth; history.replaceState(s, '', location.hash); }
    const back = document.getElementById('navBack'), fwd = document.getElementById('navFwd');
    if (back) back.disabled = !(history.state?._i > 1);
    if (fwd) fwd.disabled = !(history.state?._i < navMax);
  }
  addEventListener('popstate', async e => {
    const s = e.state; if (!s || !s.view) return;
    restoring = true;
    try {
      state.facet = { ...(s.facet ?? {}) }; state.q = s.q ?? ''; state.sort = s.sort ?? state.sort; state.page = s.page ?? 0;
      if (s.albumId) state.albumId = s.albumId; if (s.editPhotoId) state.editPhotoId = s.editPhotoId;
      const se = document.getElementById('search'); if (se) se.value = state.q;
      navDepth = s._i ?? navDepth;
      await go(s.view);
    } finally { restoring = false; updateNavButtons(); }
  });

  // ---------- Métadonnées documentaires : modifier, relire les fichiers, écrire les XMP (lib/metadata.mjs) ----------
  // Toujours un aperçu avant d'écrire ; chaque modification de fiches forme un lot annulable.
  async function metadataDialog({ ids, query, label, count, onDone = () => {} }) {
    const M = await api('/metadata');
    const base = ids ? { ids } : { query };
    const target = ids ? `${fmtNum(count)} photo(s) sélectionnée(s)` : `${fmtNum(count)} photo(s) de « ${label} »`;
    const out = h('div.meta-out');
    const tabsEl = h('div.tabs'); const pane = h('div.meta-pane');
    let tab = 'edit';
    const TABS = { edit: 'Modifier', read: 'Relire les fichiers', write: 'Écrire les XMP', history: 'Historique' };
    const renderTabs = () => mount(tabsEl, ...Object.entries(TABS).map(([k, l]) => h('button' + (k === tab ? '.active' : ''), { onclick: () => { tab = k; renderTabs(); renderPane(); } }, l)));
    const modeSel = () => h('select', {}, h('option', { value: '' }, '— inchangé —'), ...Object.entries(M.modes).map(([k, l]) => h('option', { value: k }, l)));
    const changeTable = (rows, { source = false } = {}) => table({ className: 'meta-table', columns: [
      { label: 'Photo', format: r => h('b', r.name) },
      { label: 'Champ', format: r => r.c.label },
      { label: 'Avant', format: r => r.c.beforeText ? h('span' + (r.c.overwrite ? '.meta-old' : ''), r.c.beforeText) : h('span.dim', 'vide') },
      { label: 'Après', format: r => r.c.afterText ? h('span.meta-new', r.c.afterText) : h('span.dim', 'vide') },
      ...(source ? [{ label: 'Source', format: r => r.c.source }] : []),
    ], rows: rows.flatMap(r => r.changes.map(c => ({ name: r.name, c }))).slice(0, 400) });
    const summaryLine = (s, more) => h('p', h('b', `${fmtNum(s.changed)} photo(s) modifiée(s)`), ` sur ${fmtNum(s.photos)} · ${fmtNum(s.values)} valeur(s)`,
      s.overwrites ? h('span.pill.warn', { style: { marginLeft: '8px' } }, `${fmtNum(s.overwrites)} valeur(s) existante(s) remplacée(s)`) : h('span.pill.ok', { style: { marginLeft: '8px' } }, 'aucune valeur existante remplacée'),
      more ? h('small.dim', ` — aperçu limité aux 300 premières photos (${fmtNum(more)} de plus)`) : null);
    async function run(what, payload, { applyLabel, render }) {
      mount(out, h('p.dim', 'Calcul de l’aperçu…'));
      try {
        const r = await api('/metadata/' + what, 'POST', { ...base, ...payload });
        const n = what === 'write' ? (r.count.create + r.count.update + (payload.conflicts === 'replace' ? r.count.conflict : 0)) : r.summary.changed;
        // une seule fenêtre à la fois (ui.js) : la confirmation se fait par un second clic sur le bouton
        let armed = false;
        mount(out, ...render(r), n ? h('div.row', h('div.spacer'), h('button', { onclick: async e => {
          if (what !== 'write' && r.summary.overwrites && !armed) { armed = true; e.target.classList.add('danger'); e.target.textContent = `Confirmer : remplacer ${fmtNum(r.summary.overwrites)} valeur(s) existante(s)`; return; }
          mount(out, h('p.dim', 'Application…'));
          try {
            const a = await api('/metadata/' + what, 'POST', { ...base, ...payload, apply: true });
            if (what === 'write') mount(out, h('p', `${a.created} annexe(s) créée(s), ${a.updated} mise(s) à jour, ${a.replaced} remplacée(s) (ancienne version gardée en .bak), ${a.skipped} laissée(s).`), a.errors.length ? h('p.bad', `${a.errors.length} erreur(s) : ` + a.errors.slice(0, 5).map(e => `${e.name} (${e.error})`).join(' ; ')) : null);
            else mount(out, h('p', `${fmtNum(a.photos)} photo(s) modifiée(s), ${fmtNum(a.values)} valeur(s). `, a.batchId ? h('button.ghost.small', { onclick: async () => { const u = await api('/metadata/undo', 'POST', { batchId: a.batchId }); toast(`${u.restored} valeur(s) rétablie(s)${u.kept ? `, ${u.kept} modifiée(s) depuis laissée(s)` : ''}`); mount(out, h('p.dim', 'Lot annulé.')); onDone(); } }, 'Annuler ce lot') : null));
            toast('Terminé'); onDone();
          } catch (e) { mount(out, h('p.bad', e.message)); }
        } }, applyLabel(n))) : h('p.dim', 'Rien à faire.'));
      } catch (e) { mount(out, h('p.bad', e.message)); }
    }

    function renderPane() {
      clear(out);
      if (tab === 'edit') {
        const rows = Object.entries(M.fields).filter(([k]) => k !== 'keywords').map(([k, l]) => {
          const mode = modeSel();
          const input = k === 'rating' ? h('select', {}, ...[0, 1, 2, 3, 4, 5].map(n => h('option', { value: n }, n ? '★'.repeat(n) : 'aucune')))
            : k === 'color' ? h('select', {}, ...M.labels.map((c, i) => h('option', { value: i }, c || 'aucune')))
            : k === 'description' ? h('textarea', { rows: 2 }) : h('input', { type: 'text' });
          input.disabled = true;
          mode.onchange = () => { input.disabled = !mode.value || mode.value === 'clear'; };
          return { k, l, mode, input };
        });
        const kwAdd = h('input', { type: 'text', placeholder: 'séparés par des virgules ; « Lieux|Montagne » pour ranger' });
        const kwDel = h('input', { type: 'text', placeholder: 'séparés par des virgules' });
        const payload = () => {
          const changes = {};
          for (const r of rows) if (r.mode.value) changes[r.k] = { mode: r.mode.value, value: r.input.value };
          changes.keywordsAdd = kwAdd.value.split(',').map(x => x.trim()).filter(Boolean);
          changes.keywordsRemove = kwDel.value.split(',').map(x => x.trim()).filter(Boolean);
          return { changes };
        };
        mount(pane, h('p.dim', 'Choisissez pour chaque champ : remplacer, remplir seulement s’il est vide, ou effacer. Rien n’est écrit avant l’aperçu.'),
          h('div.meta-grid', ...rows.flatMap(r => [h('label', r.l), r.mode, r.input])),
          h('div.form', field('Ajouter les mots-clés', kwField(kwAdd)), field('Retirer les mots-clés', kwField(kwDel), 'retirer « Montagne » retire aussi « Lieux › Montagne »')),
          h('div.row', h('div.spacer'), h('button.ghost', { onclick: () => run('edit', payload(), { applyLabel: n => `Appliquer à ${fmtNum(n)} photo(s)`, render: r => [summaryLine(r.summary, r.more), changeTable(r.rows)] }) }, 'Aperçu')));
      } else if (tab === 'read') {
        const mode = h('select', {}, h('option', { value: 'fill' }, 'Compléter seulement les champs vides de la fiche'), h('option', { value: 'replace' }, 'Remplacer aussi les valeurs différentes'));
        mount(pane, h('p', 'Relit les fichiers : le ', h('b', 'XMP annexe'), ' s’il existe, sinon les métadonnées ', h('b', 'embarquées'), ' (XMP, IPTC, EXIF). Les fichiers ne sont pas modifiés.'),
          h('p.dim', 'Priorité : la fiche de Photothèque est la référence. Par défaut, seuls ses champs vides sont complétés.'),
          h('div.form', field('Mode', mode)),
          h('div.row', h('div.spacer'), h('button.ghost', { onclick: () => run('read', { mode: mode.value }, { applyLabel: n => `Reprendre dans ${fmtNum(n)} fiche(s)`, render: r => [summaryLine(r.summary, r.more), r.issueCount ? h('p.dim', `${r.issueCount} photo(s) ignorée(s) : ` + r.issues.slice(0, 5).map(i => `${i.name} (${i.issue})`).join(' ; ')) : null, changeTable(r.rows, { source: true })] }) }, 'Aperçu')));
      } else if (tab === 'write') {
        const conf = h('select', {}, h('option', { value: 'skip' }, 'Laisser les annexes modifiées par un autre logiciel'), h('option', { value: 'replace' }, 'Les remplacer (une copie .bak est gardée)'));
        const s = M.settings;
        mount(pane, h('p', 'Écrit les métadonnées de la fiche dans un fichier ', h('b', 'XMP annexe'), ', lisible par les autres logiciels. ', h('b', 'L’original n’est jamais modifié.')),
          h('p.dim', `Emplacement : ${M.destinations[s.destination]}${s.destination === 'folder' ? ` (${M.dir})` : ''} · nom : ${M.namings[s.naming]}. `, h('button.link', { onclick: () => { m.close(); go('settings'); } }, 'Changer dans Paramètres')),
          h('div.form', field('Annexes déjà modifiées ailleurs', conf)),
          h('div.row', h('div.spacer'), h('button.ghost', { onclick: () => run('write', { conflicts: conf.value }, { applyLabel: n => `Écrire ${fmtNum(n)} annexe(s)`, render: r => [
            h('div.row', ...Object.entries(r.statuses).filter(([k]) => r.count[k]).map(([k, l]) => h('span.pill' + (k === 'create' || k === 'update' ? '.ok' : k === 'same' ? '' : '.warn'), `${r.count[k]} ${l}`))),
            table({ className: 'meta-table', columns: [{ label: 'Photo', format: x => h('b', x.name) }, { label: 'État', format: x => r.statuses[x.status] }, { label: 'Annexe', format: x => h('small.dim', x.target) }], rows: r.rows.slice(0, 300) })] }) }, 'Aperçu')));
      } else {
        const list = h('div');
        const load = async () => {
          const { batches } = await api('/metadata');
          if (!batches.length) return mount(list, h('p.dim', 'Aucune modification en masse.'));
          mount(list, table({ columns: [
            { label: 'Date', format: b => fmtDateTime(b.ts) }, { label: 'Opération', format: b => b.label ?? b.detail },
            { label: 'Photos', key: 'photos', align: 'right' }, { label: 'Valeurs', key: 'values', align: 'right' },
            { label: '', align: 'right', format: b => b.undone ? h('span.dim', 'annulé') : h('button.ghost.small', { title: 'Rétablit les valeurs d’avant ; une valeur modifiée depuis est laissée telle quelle', onclick: async e => {
              if (!e.target.dataset.armed) { e.target.dataset.armed = '1'; e.target.classList.add('danger'); e.target.textContent = `Confirmer : rétablir ${b.values} valeur(s)`; return; }
              const u = await api('/metadata/undo', 'POST', { batchId: b.id }); toast(`${u.restored} valeur(s) rétablie(s)${u.kept ? `, ${u.kept} laissée(s)` : ''}`); load(); onDone();
            } }, 'Annuler') }], rows: batches }));
        };
        mount(pane, h('p.dim', 'Les dernières modifications en masse (toutes photos confondues). Annuler rétablit les valeurs d’avant.'), list); load();
      }
    }
    renderTabs(); renderPane();
    const m = modal({ title: `Métadonnées — ${target}`, wide: true, body: h('div', tabsEl, pane, out), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer')] });
  }

  async function exportDialog(ids) {
    if (!ids.length) return;
    let meta = await api('/exports/profiles');
    const keyOf = () => [...Object.keys(meta.builtin).map(k => 'b:' + k), ...Object.keys(meta.saved).map(k => 's:' + k)];
    const profOf = k => (k.startsWith('b:') ? meta.builtin[k.slice(2)] : meta.saved[k.slice(2)]);
    const sel = h('select'), fmt = h('select', {}, ...Object.entries(meta.formats).map(([k, f]) => h('option', { value: k }, f.label)));
    const quality = h('input', { type: 'number', min: 30, max: 100 }), maxSide = h('input', { type: 'number', min: 64, max: 20000, placeholder: 'pleine définition' });
    const version = h('select', {}, h('option', { value: 'default' }, 'Version retouchée par défaut (sinon l’original)'), h('option', { value: 'original' }, 'Original non retouché'));
    const metaSel = h('select', {}, ...Object.entries(meta.metadata).map(([k, l]) => h('option', { value: k }, l)));
    const iccSel = h('select', {}, ...Object.entries(meta.colorProfiles).map(([k, l]) => h('option', { value: k }, l)));
    const wmText = h('input', { type: 'text', placeholder: 'aucun' }), wmPos = h('select', {}, ...Object.entries(meta.positions).map(([k, l]) => h('option', { value: k }, l)));
    const naming = h('input', { type: 'text' }), folder = h('input', { type: 'text', placeholder: 'Export <date et heure>' });
    // dimensions physiques (tirage) : format en mm, résolution, ajustement ; vide = export en pixels
    const PRINT_SIZES = { '': 'Aucun (dimensions en pixels)', '100x150': '10 × 15 cm', '130x180': '13 × 18 cm', '150x200': '15 × 20 cm', '200x300': '20 × 30 cm', '210x297': 'A4 (21 × 29,7 cm)', '300x400': '30 × 40 cm', '300x450': '30 × 45 cm', custom: 'Personnalisé…' };
    const pSize = h('select', {}, ...Object.entries(PRINT_SIZES).map(([k, l]) => h('option', { value: k }, l)));
    const pW = h('input', { type: 'number', min: 10, max: 2000, step: 0.1, placeholder: 'largeur' }), pH = h('input', { type: 'number', min: 10, max: 2000, step: 0.1, placeholder: 'hauteur' });
    const pDpi = h('input', { type: 'number', min: 72, max: 1200, value: 300 });
    const pFit = h('select', {}, ...Object.entries(meta.printFits).map(([k, l]) => h('option', { value: k }, l)));
    const pRot = h('input', { type: 'checkbox', checked: true });
    const printInfo = h('small.dim');
    const printFields = h('div.form', field('Largeur (mm)', pW), field('Hauteur (mm)', pH), field('Résolution (ppp)', pDpi), field('Ajustement', pFit));
    const rotRow = h('div.row', { style: { gap: '14px' } }, h('label.row', { style: { gap: '6px' } }, pRot, 'Suivre l’orientation de chaque photo'), printInfo);
    function syncPrint() {
      const on = !!pSize.value; const custom = pSize.value === 'custom';
      if (on && !custom) { const [w, hh] = pSize.value.split('x'); pW.value = w; pH.value = hh; }
      pW.disabled = pH.disabled = !custom; maxSide.disabled = on;
      printFields.style.display = rotRow.style.display = on ? '' : 'none';
      const w = +pW.value, hh = +pH.value, d = +pDpi.value;
      printInfo.textContent = on && w && hh && d ? `Fichiers de ${Math.round(w / 25.4 * d)} × ${Math.round(hh / 25.4 * d)} px ; résolution effective calculée pour chaque photo (alerte sous ${meta.printDpiLow} ppp).` : '';
    }
    for (const el of [pSize, pW, pH, pDpi]) el.addEventListener('input', syncPrint);
    pSize.addEventListener('change', syncPrint);
    const status = h('div'), delBtn = h('button.ghost.small.danger', { hidden: true }, 'Supprimer ce profil');
    function fillSel(selected) { mount(sel, ...keyOf().map(k => h('option', { value: k, selected: k === selected }, (k.startsWith('s:') ? '★ ' : '') + profOf(k).name))); }
    function load(k) {
      const p = profOf(k); if (!p) return;
      fmt.value = p.format; quality.value = p.quality; maxSide.value = p.maxSide ?? ''; version.value = p.version; metaSel.value = p.metadata; iccSel.value = meta.colorProfiles[p.colorProfile] ? p.colorProfile : 'srgb';
      wmText.value = p.watermark.text; wmPos.value = p.watermark.position; naming.value = p.naming; folder.value = p.folder;
      if (p.print) { const k = `${p.print.width_mm}x${p.print.height_mm}`; pSize.value = PRINT_SIZES[k] ? k : 'custom'; pW.value = p.print.width_mm; pH.value = p.print.height_mm; pDpi.value = p.print.dpi; pFit.value = p.print.fit; pRot.checked = p.print.rotate; }
      else pSize.value = '';
      syncPrint();
      delBtn.hidden = !k.startsWith('s:'); quality.disabled = !meta.formats[p.format].quality;
    }
    const current = () => ({ format: fmt.value, quality: +quality.value, maxSide: maxSide.value ? +maxSide.value : null, version: version.value, metadata: metaSel.value, colorProfile: iccSel.value,
      watermark: { text: wmText.value, position: wmPos.value }, naming: naming.value, folder: folder.value,
      print: pSize.value && +pW.value && +pH.value ? { width_mm: +pW.value, height_mm: +pH.value, dpi: +pDpi.value || 300, fit: pFit.value, rotate: pRot.checked } : null });
    sel.addEventListener('change', () => load(sel.value));
    fmt.addEventListener('change', () => { quality.disabled = !meta.formats[fmt.value].quality; });
    delBtn.addEventListener('click', async () => { await api('/exports/profiles/' + encodeURIComponent(sel.value.slice(2)), 'DELETE'); meta = await api('/exports/profiles'); fillSel('b:web'); load('b:web'); });
    const saveBtn = h('button.ghost.small', { onclick: async () => {
      const nm = prompt('Nom du profil d’export'); if (!nm) return;
      const r = await api('/exports/profiles', 'POST', { ...current(), name: nm }); meta = await api('/exports/profiles'); fillSel('s:' + r.id); load('s:' + r.id); toast('Profil enregistré');
    } }, 'Enregistrer comme profil…');
    const go2 = h('button', { onclick: async () => {
      go2.disabled = true;
      try {
        const { jobId } = await api('/exports', 'POST', { photoIds: ids, profile: current() });
        let job;
        do { await new Promise(r => setTimeout(r, 400)); job = (await api('/jobs/' + jobId)).job; mount(status, h('p.dim', `Export en cours… ${job.done ?? 0} / ${job.total || ids.length}`)); } while (job.status === 'running');
        if (job.status === 'error') throw new Error(job.error);
        const r = job.result;
        const low = r.lowDpi ?? [];
        mount(status, h('p', `✓ ${r.files.length} fichier(s) · ${fmtBytes(r.bytes)}`, r.files[0]?.colorProfile ? ` · profil ${r.files[0].colorProfile}` : ''), h('p.dim', 'Dossier : ' + r.dir),
          r.readme ? h('p.dim', `Fiche de commande : ${r.readme} (formats, résolution effective de chaque tirage). Dossier prêt à être déposé chez le laboratoire ; rien n’a été envoyé.`) : null,
          low.filter(x => x.level === 'bad').length ? h('div.album-alert.bad', `${low.filter(x => x.level === 'bad').length} tirage(s) en résolution insuffisante (moins de ${meta.printDpiLow} ppp effectifs) : ${low.filter(x => x.level === 'bad').slice(0, 4).map(x => `${x.name} (${x.effectiveDpi} ppp)`).join(', ')}`) : null,
          low.filter(x => x.level === 'warn').length ? h('div.album-alert.warn', `${low.filter(x => x.level === 'warn').length} tirage(s) en résolution limite : ${low.filter(x => x.level === 'warn').slice(0, 4).map(x => `${x.name} (${x.effectiveDpi} ppp)`).join(', ')}`) : null,
          r.fromPreview ? h('div.album-alert.warn', `${r.fromPreview} photo(s) exportée(s) depuis l’aperçu en cache (original indisponible ou RAW) : définition réduite.`) : null,
          ...r.errors.slice(0, 8).map(e => h('div.album-alert.bad', `${e.photoId.slice(0, 8)}… : ${e.error}`)));
        toast(`${r.files.length} photo(s) exportée(s)`);
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      go2.disabled = false;
    } }, `Exporter ${ids.length} photo(s)`);
    fillSel('b:web'); load('b:web');
    const m = modal({ title: 'Exporter', wide: true, body: h('div',
      h('div.form', field('Profil', sel)),
      h('div.form', field('Format', fmt), field('Qualité (JPEG, WebP)', quality), field('Plus grand côté (pixels)', maxSide)),
      h('div.form', field('Dimensions d’impression', pSize)),
      printFields,
      rotRow,
      h('div.form', field('Version', version), field('Métadonnées', metaSel), field('Profil de couleur', iccSel)),
      h('p.dim', `Profils ICC d’un laboratoire : déposez les fichiers .icc dans ${meta.profilesDir}`),
      h('div.form', field('Filigrane (texte)', wmText), field('Position du filigrane', wmPos)),
      h('div.form', field('Nom des fichiers', naming), field('Sous-dossier', folder)),
      h('p.dim', `Modèles de nom : {nom} (fichier d’origine), {titre}, {date}, {n} (rang). Les fichiers vont dans ${meta.dir} ; un fichier existant n’est jamais écrasé et les originaux ne sont jamais modifiés.`),
      h('div.row', saveBtn, delBtn), status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), go2] });
  }

  // ---------- Albums : liste + éditeur de pages ----------
  // Formats et gabarits viennent du serveur (lib/albums.mjs) : l'interface ne fait que les dessiner.
  let albumMeta = null;
  // raccourcis clavier de l'éditeur d'album (Ctrl+Z / Ctrl+Y) : un seul écouteur, branché sur l'album ouvert
  let keyHandler = null;
  document.addEventListener('keydown', e => keyHandler?.(e));
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
      card(h('div.sect', 'Importer un projet'),
        h('p.dim', "Réimporte un projet exporté (« Exporter le projet », fichier .album.json) comme nouvel album. Les photos sont retrouvées dans ce catalogue par identifiant, contenu (empreinte) ou chemin ; aucun album existant n'est remplacé."),
        h('button.ghost', { onclick: importAlbumProject }, 'Importer un projet…')),
      card(h('div.sect', 'Mes albums'), wrap));
    await refresh();
  }

  // ---------- Planche-contact (lib/contactsheet.mjs) : réglages, aperçu, PDF ----------
  // `ids` (sélection, dans l'ordre) ou `query` (critères de la grille au format de /api/photos, tri compris).
  let sheetMeta = null;
  async function contactSheetDialog({ ids, query, label, count, presetTitle }) {
    sheetMeta ??= await api('/contactsheet');
    const M = sheetMeta, KEY = 'phototheque.contactsheet';
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') ?? {}; } catch { /* préférence absente */ }
    const o = { ...M.defaults, ...saved };
    const layout = h('select', {}, ...Object.entries(M.layouts).map(([k, l]) => h('option', { value: k, selected: (o.layout ?? 'grid') === k }, l)));
    const isDetail = () => layout.value === 'detail', isCat = () => layout.value === 'catalog', isPort = () => layout.value === 'portfolio';
    const subtitle = h('input', { type: 'text', placeholder: 'Sous-titre (facultatif)' });
    const author = h('input', { type: 'text', value: o.author ?? '', placeholder: 'Photographe, auteur (facultatif)' });
    const background = h('select', {}, ...Object.entries(M.backgrounds).map(([k, b]) => h('option', { value: k, selected: (o.background ?? 'white') === k }, b.label)));
    const coverCb = h('input', { type: 'checkbox', checked: o.cover !== false });
    const margin = h('input', { type: 'number', min: 5, max: 30, value: o.margin ?? 12, style: { width: '70px' } });
    const groupBy = h('select', {}, ...Object.entries(M.groupBy).map(([k, l]) => h('option', { value: k, selected: (o.groupBy ?? 'year') === k }, l)));
    const title = h('input', { type: 'text', value: presetTitle ?? (label && label !== 'Photothèque' ? label : ''), placeholder: 'Titre en tête de page (facultatif)' });
    const page = h('select', {}, ...Object.entries(M.pages).map(([k, p]) => h('option', { value: k, selected: o.page === k }, p.label)));
    const cols = h('input', { type: 'number', min: 1, max: 12, value: o.columns, style: { width: '70px' } });
    const rows = h('input', { type: 'number', min: 1, max: 16, value: o.rows, style: { width: '70px' } });
    const quality = h('select', {}, ...Object.entries(M.qualities).map(([k, q]) => h('option', { value: k, selected: o.quality === k }, q.label)));
    const edited = h('input', { type: 'checkbox', checked: o.edited !== false });
    const boxes = Object.entries(M.fields).map(([k, l]) => { const cb = h('input', { type: 'checkbox', checked: (o.fields ?? []).includes(k) }); cb.dataset.key = k; return h('label.check', cb, ' ' + l); });
    const info = h('p.dim'), status = h('div');
    const options = () => ({ layout: layout.value, groupBy: groupBy.value, title: title.value, subtitle: subtitle.value, author: author.value, background: background.value, cover: coverCb.checked, margin: +margin.value, page: page.value, columns: +cols.value, rows: +rows.value, quality: quality.value, edited: edited.checked,
      fields: boxes.map(b => b.querySelector('input')).filter(cb => cb.checked).map(cb => cb.dataset.key) });
    const n = Math.min(count ?? 0, M.maxPhotos);
    const gridOnly = [], catOnly = [], portOnly = [], legendFor = [];
    const sync = () => {
      for (const el of gridOnly) el.style.display = isDetail() || isPort() ? 'none' : ''; // `hidden` serait écrasé par le CSS de .field
      for (const el of legendFor) el.style.display = isDetail() ? 'none' : '';
      for (const el of catOnly) el.style.display = isCat() ? '' : 'none';
      for (const el of portOnly) el.style.display = isPort() ? '' : 'none';
      const per = isDetail() || isPort() ? 1 : Math.max(1, (+cols.value || 1) * (+rows.value || 1)); info.textContent = `${n} photo(s)${ids ? ' sélectionnée(s)' : ' de la recherche affichée'} · ${per} par page → ${isCat() ? 'pages selon les groupes, plus le sommaire' : `${(Math.ceil(n / per) || 0) + (isPort() && coverCb.checked && n ? 1 : 0)} page(s)${isPort() && coverCb.checked ? ', couverture comprise' : ''}`}` + ((count ?? 0) > M.maxPhotos ? ` (limitée aux ${M.maxPhotos} premières en PDF)` : '');
    };
    for (const el of [cols, rows]) el.addEventListener('input', sync);
    layout.addEventListener('change', sync); coverCb.addEventListener('change', sync);
    const fileBase = () => (title.value || (label || 'Photothèque') + (isDetail() ? ' fiches' : isPort() ? ' portfolio' : isCat() ? ` catalogue par ${M.groupBy[groupBy.value].toLowerCase()}` : '')).replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim();
    async function produce(inline) {
      const opts = options(); try { localStorage.setItem(KEY, JSON.stringify({ ...opts, title: undefined, subtitle: undefined })); } catch { /* préférence non mémorisée */ }
      const res = await fetch('/api/contactsheet', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(ids ? { ids } : { query }), label, inline, options: inline ? { ...opts, quality: 'screen' } : opts }) });
      if (!res.ok) { let msg = 'Échec de la production de la planche-contact'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
      let report = null; try { report = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(res.headers.get('X-Pdf-Report') || ''), c => c.charCodeAt(0)))); } catch { /* compte rendu absent */ }
      return { blob: await res.blob(), report };
    }
    const summary = r => r ? [h('p', `${r.photos} ${r.layout === 'detail' ? 'fiche(s)' : 'photo(s)'}${r.groups ? ` en ${r.groups.length} groupe(s)` : ''} sur ${r.pages} page(s) · ${fmtBytes(r.bytes)}${r.edited ? ` · ${r.edited} en version retouchée` : ''}`),
      r.capped ? h('div.album-alert.warn', `Photos présentes dans plusieurs groupes : catalogue limité à ${M.maxPhotos} cases`) : null,
      r.unreadable.length ? h('div.album-alert.bad', `${r.unreadable.length} photo(s) illisible(s) (n° ${r.unreadable.slice(0, 8).map(u => u.n).join(', ')}${r.unreadable.length > 8 ? '…' : ''}) : case marquée « illisible »`) : null,
      r.fromPreview.length ? h('div.album-alert.warn', `${r.fromPreview.length} photo(s) prise(s) sur l’aperçu en cache, original indisponible`) : null,
      r.truncated?.length ? h('div.album-alert.warn', `${r.truncated.length} fiche(s) trop longue(s) pour la page (n° ${r.truncated.slice(0, 8).join(', ')}${r.truncated.length > 8 ? '…' : ''}) : la fin des informations n’est pas imprimée`) : null] : [];
    const busy = on => { for (const b of m.box.querySelectorAll('button[data-sheet]')) b.disabled = on; };
    const previewBtn = h('button.ghost', { dataset: { sheet: 'preview' }, onclick: async () => {
      busy(true); mount(status, h('p.dim', 'Préparation de l’aperçu…'));
      try {
        const { blob, report } = await produce(true), src = URL.createObjectURL(blob);
        clear(status);
        // la fenêtre d'aperçu remplace celle des réglages : on peut y revenir ou télécharger directement
        const back = () => contactSheetDialog({ ids, query, label, count, presetTitle: title.value });
        const pv = modal({ title: isDetail() ? 'Aperçu des fiches détaillées' : isCat() ? 'Aperçu du catalogue' : isPort() ? 'Aperçu du portfolio' : 'Aperçu de la planche-contact', wide: true, body: h('div', ...summary(report), h('iframe.pdf-frame', { src, title: 'Aperçu PDF' })), actions: [
          h('button.ghost', { onclick: () => pv.close() }, 'Fermer'), h('button.ghost', { onclick: back }, 'Modifier les réglages'),
          h('button', { onclick: async () => { await back(); document.querySelector('button[data-sheet="go"]')?.click(); } }, 'Télécharger le PDF')] });
        new MutationObserver((_, ob) => { if (!pv.box.isConnected) { URL.revokeObjectURL(src); ob.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, 'Aperçu');
    const goBtn = h('button', { dataset: { sheet: 'go' }, onclick: async () => {
      busy(true); mount(status, h('p.dim', 'Production du PDF…'));
      try {
        const { blob, report } = await produce(false);
        const name = (fileBase() || 'planche-contact') + '.pdf';
        const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        mount(status, h('p', '✓ PDF enregistré dans le dossier de téléchargement du navigateur.'), ...summary(report));
        toast(isDetail() ? 'Fiches détaillées produites' : isCat() ? 'Catalogue produit' : isPort() ? 'Portfolio produit' : 'Planche-contact produite');
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, 'Télécharger le PDF');
    // catalogue CSV : les mêmes photos, une ligne par photo et toutes les colonnes (sans la limite du PDF)
    const csvBtn = h('button.ghost', { dataset: { sheet: 'csv' }, title: `Colonnes : ${M.csvColumns.join(', ')}`, onclick: async () => {
      busy(true); mount(status, h('p.dim', 'Préparation du CSV…'));
      try {
        const res = await fetch('/api/catalog/csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(ids ? { ids } : { query }), label: title.value || label }) });
        if (!res.ok) { let msg = 'Échec de l’export CSV'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
        const blob = await res.blob(), a = h('a', { href: URL.createObjectURL(blob), download: ((title.value || label || 'catalogue').replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim() || 'catalogue') + '.csv' });
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        mount(status, h('p', `✓ CSV enregistré dans le dossier de téléchargement : ${res.headers.get('X-Csv-Photos')} photo(s), ${M.csvColumns.length} colonnes (séparateur « ; », virgule décimale, UTF-8).`));
        toast('Catalogue CSV exporté');
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, 'Exporter en CSV');
    const colsF = field('Colonnes', cols), rowsF = field('Lignes', rows), legend = h('div', h('b', 'Légende'), h('div.sheet-fields', ...boxes));
    const detailNote = h('p.dim', 'Une photo par page, puis titre, description, date, auteur, mots-clés, appareil, exposition, dimensions, GPS, emplacements et empreinte.');
    const groupF = field('Regrouper par', groupBy);
    const catNote = h('p.dim', 'Un sommaire en tête (groupes, nombre de photos, page), puis chaque groupe sur ses propres pages. Par mot-clé, une photo figure dans chacun de ses mots-clés ; par lieu, ville et pays des métadonnées, sinon position GPS.');
    const portF = h('div', h('div.row.wrap', { style: { gap: '12px' } }, field('Sous-titre', subtitle), field('Auteur', author)),
      h('div.row.wrap', { style: { gap: '12px', alignItems: 'end' } }, field('Fond', background), h('label.check', coverCb, ' Page de couverture (première photo, titre, auteur)')),
      h('p.dim', 'Une photo par page, aussi grande que les marges le permettent, légende sobre centrée sous l’image (titre, sinon nom du fichier, puis les autres champs cochés).'));
    gridOnly.push(colsF, rowsF); legendFor.push(legend); catOnly.push(groupF, catNote); portOnly.push(portF);
    const m = modal({ title: 'Planche-contact, fiches, catalogue, portfolio', body: h('div.import-report',
      info,
      field('Document', layout), groupF,
      field('Titre', title), portF,
      h('div.row.wrap', { style: { gap: '12px' } }, field('Format', page), colsF, rowsF, field('Marges (mm)', margin), field('Qualité', quality)),
      legend, detailNote, catNote,
      h('label.check', edited, ' Montrer les photos dans leur version retouchée par défaut'),
      h('p.dim', 'Chaque photo est montrée entière, sans recadrage. Les originaux sont lus sans être modifiés.'),
      status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), csvBtn, previewBtn, goBtn] });
    const syncNote = () => { detailNote.style.display = isDetail() ? '' : 'none'; }; layout.addEventListener('change', syncNote); syncNote(); sync();
  }

  // ---------- Réimport d'un projet d'album (lib/albums.mjs importProject) : analyse, puis confirmation ----------
  function importAlbumProject() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return;
      let project;
      try { project = JSON.parse(await file.text()); } catch { toast('Fichier illisible : ce n’est pas du JSON', 'bad'); return; }
      let an;
      try { an = (await api('/albums/import/analyse', 'POST', { project })).analysis; } catch (e) { toast(e.message, 'bad'); return; }
      const name = h('input', { type: 'text', value: an.name });
      const withEdits = h('input', { type: 'checkbox', checked: true });
      const ph = an.photos, how = [ph.byId && `${ph.byId} par identifiant`, ph.bySha256 && `${ph.bySha256} par contenu`, ph.byPath && `${ph.byPath} par chemin`].filter(Boolean).join(', ');
      const m = modal({ title: `Importer « ${an.name} »`, body: h('div.import-report',
        field('Nom du nouvel album', name),
        h('p', `${an.formatLabel} · ${an.printedPages} page(s) imprimée(s)`),
        h('p', ph.total ? `${ph.found} photo(s) retrouvée(s) sur ${ph.total}` + (how ? ` (${how})` : '') : 'Aucune photo dans ce projet.'),
        ph.missing.length ? h('div.import-missing', h('p', { style: { color: 'var(--warn)' } }, `⚠ ${ph.missing.length} photo(s) introuvable(s) dans ce catalogue : leurs cadres seront signalés dans l’album. Indexez le dossier qui les contient puis réimportez, ou remplacez-les dans l’éditeur.`),
          h('ul.dim', ...ph.missing.slice(0, 20).map(x => h('li', x.title || x.path || x.id)), ph.missing.length > 20 ? h('li', `… et ${ph.missing.length - 20} autre(s)`) : null)) : null,
        an.edits.total ? h('label.check', withEdits, ` Recréer les ${an.edits.total} retouche(s) du projet (${an.edits.same} déjà présente(s) ; une nouvelle version ne devient « par défaut » que si la photo n’en a aucune)`) : null,
        h('p.dim', 'Les originaux ne sont jamais copiés ni modifiés.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try {
            const r = await api('/albums/import', 'POST', { project, name: name.value, withEdits: withEdits.checked });
            m.close();
            toast(`Album « ${r.name} » importé : ${r.photos.found}/${r.photos.total} photo(s)` + (r.edits.created ? `, ${r.edits.created} retouche(s) recréée(s)` : '') + (r.edits.notDefault ? ` (${r.edits.notDefault} à choisir comme version par défaut)` : ''));
            openAlbum(r.album.id);
          } catch (e) { toast(e.message, 'bad'); }
        } }, 'Importer'),
      ] });
    });
    input.click();
  }
  function openAlbum(id) { state.albumId = id; go('album'); }

  async function viewAlbum(v) {
    albumMeta = await api('/albums'); // toujours à jour : modèles et profils de prestataire enregistrés
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

    // le recadrage suit la photo quand on la déplace d'un cadre à l'autre
    const cropsOf = n => album.pages[n - 1].slots.map((_, i) => album.pages[n - 1].crops?.[i] ?? null);
    const setCrop = (list, s, c) => { while (list.length <= s) list.push(null); list[s] = c; return list; };
    async function dropOn(n, s) {
      if (!drag || (drag.page === n && drag.slot === s)) return;
      const from = drag; drag = null;
      // échange fait côté serveur en une seule étape (photo + recadrage), donc annulable d'un coup
      await change('/move-photo', 'POST', { from: { page: from.page, slot: from.slot }, to: { page: n, slot: s } });
    }

    // ---- Annuler / rétablir (piles tenues par le serveur, lib/albums.mjs) ----
    async function undoRedo(kind) {
      const r = await change('/' + kind, 'POST');
      if (r?.done) toast(`${kind === 'undo' ? 'Annulé' : 'Rétabli'} : ${r.done}`);
    }
    // raccourcis Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z), hors des champs de saisie et des fenêtres ouvertes
    keyHandler = e => {
      if (state.view !== 'album' || state.albumId !== album.id) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.modal')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (album.history?.undo) undoRedo('undo'); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); if (album.history?.redo) undoRedo('redo'); }
    };

    // ---- Recadrage manuel : même calcul que cropWindow (lib/albums.mjs) ----
    // r = largeur/hauteur de l'image, A = largeur/hauteur du cadre ; renvoie la place de l'image
    // dans le cadre (en fractions du cadre) et la partie visible (en fractions de l'image).
    function cropBox(r, A, crop) {
      const z = crop?.zoom ?? 1;
      const iw = (r > A ? r / A : 1) * z, ih = (r > A ? 1 : A / r) * z; // taille de l'image / taille du cadre
      const w = Math.min(1, 1 / iw), hh = Math.min(1, 1 / ih);
      const cx = Math.min(1 - w / 2, Math.max(w / 2, crop?.x ?? 0.5)), cy = Math.min(1 - hh / 2, Math.max(hh / 2, crop?.y ?? 0.5));
      return { iw, ih, w, h: hh, cx, cy, left: -(cx - w / 2) * iw, top: -(cy - hh / 2) * ih };
    }
    // libellé imprimé d'une ligne d'album : « Page 3 » ou « Pages 4–5 »
    const labelOf = n => { const pg = album.pages[n - 1]; return pg.span === 2 ? `Pages ${pg.folio}–${pg.folio + 1}` : `Page ${pg.folio}`; };
    // proportion d'un cadre ; pour une double page, les cadres sont en fractions de la planche (deux largeurs)
    const frameAspect = (fr, pg) => (fr.w * album.width_mm * (pg?.span ?? 1)) / (fr.h * album.height_mm);
    const imgStyle = (b) => ({ position: 'absolute', maxWidth: 'none', objectFit: 'fill', width: b.iw * 100 + '%', height: b.ih * 100 + '%', left: b.left * 100 + '%', top: b.top * 100 + '%' });

    function cropDialog(n, s) {
      const pg = album.pages[n - 1], fr = L[pg.layout].frames[s], ph = album.photos[pg.slots[s]];
      if (!ph?.width || !ph?.height) { toast('Dimensions de la photo inconnues : recadrage impossible', 'bad'); return; }
      const r = ph.width / ph.height, A = frameAspect(fr, pg);
      let crop = { ...(pg.crops?.[s] ?? { x: 0.5, y: 0.5, zoom: 1 }) };
      // scène à la proportion du cadre, au plus 560 × 400 px
      const sw = Math.min(560, 400 * A), sh = sw / A;
      const img = h('img', { src: ph.preview || ph.thumb, alt: '', draggable: 'false' });
      const stage = h('div.crop-stage', { style: { width: sw + 'px', height: sh + 'px' } }, img, h('div.crop-thirds'));
      const zoom = h('input', { type: 'range', min: 1, max: 5, step: 0.01, value: crop.zoom });
      const info = h('small.dim');
      const frameMm = fr.w * album.width_mm * (pg.span ?? 1);
      function draw() {
        const b = cropBox(r, A, crop); crop.x = b.cx; crop.y = b.cy; // centre ramené dans les limites
        Object.assign(img.style, imgStyle(b));
        zoom.value = crop.zoom;
        const dpi = Math.round(25.4 * ph.width * b.w / frameMm);
        info.textContent = `Zoom × ${crop.zoom.toFixed(2)} · résolution à l'impression ≈ ${dpi} ppp` + (dpi < albumMeta.dpiAdvised ? ` (${albumMeta.dpiAdvised} conseillés)` : '');
        info.className = dpi < 150 ? 'bad' : dpi < albumMeta.dpiAdvised ? 'warn' : 'dim';
      }
      let start = null;
      stage.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY, cx: crop.x, cy: crop.y }; try { stage.setPointerCapture(e.pointerId); } catch { /* pointeur sans capture possible */ } stage.classList.add('grabbing'); });
      stage.addEventListener('pointermove', e => {
        if (!start) return;
        const b = cropBox(r, A, crop);
        crop.x = start.cx - (e.clientX - start.x) / (sw * b.iw); crop.y = start.cy - (e.clientY - start.y) / (sh * b.ih);
        draw();
      });
      const stop = () => { start = null; stage.classList.remove('grabbing'); };
      stage.addEventListener('pointerup', stop); stage.addEventListener('pointercancel', stop);
      stage.addEventListener('wheel', e => { e.preventDefault(); crop.zoom = Math.min(5, Math.max(1, crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); draw(); }, { passive: false });
      zoom.addEventListener('input', () => { crop.zoom = +zoom.value; draw(); });
      // alignement : bord gauche / centre / bord droit, haut / milieu / bas (le centre est ramené dans les limites)
      const ALIGN9 = [['↖', 0, 0], ['↑', 0.5, 0], ['↗', 1, 0], ['←', 0, 0.5], ['•', 0.5, 0.5], ['→', 1, 0.5], ['↙', 0, 1], ['↓', 0.5, 1], ['↘', 1, 1]];
      const NAMES = { 0: ['à gauche', 'en haut'], 0.5: ['au centre', 'au milieu'], 1: ['à droite', 'en bas'] };
      const aligner = h('div.align9', ...ALIGN9.map(([t, x, y]) => h('button.ghost.small', { type: 'button', title: `Aligner la photo ${NAMES[x][0]}, ${NAMES[y][1]}`, onclick: () => { crop.x = x; crop.y = y; draw(); } }, t)));
      const m = modal({ title: `Recadrer — ${labelOf(n).toLowerCase()}, cadre ${s + 1}`, wide: true, body: h('div.crop-dialog',
        stage,
        h('div.row', h('span', 'Zoom'), zoom, info),
        h('div.row', { style: { gap: '10px' } }, h('span', 'Aligner'), aligner, h('small.dim', 'Cale la partie visible sur un bord ou au centre de la photo (utile après un zoom).')),
        h('p.dim', 'Faites glisser la photo pour choisir la partie visible ; molette ou curseur pour zoomer. L’original n’est pas modifié.')), actions: [
        h('button.ghost', { onclick: () => { crop = { x: 0.5, y: 0.5, zoom: 1 }; draw(); } }, 'Réinitialiser'),
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { const r2 = await change(pageUrl(n), 'PUT', { crops: setCrop(cropsOf(n), s, crop) }); if (r2) m.close(); } }, 'Enregistrer'),
      ] });
      draw();
    }

    // ---- Style d'une page et modèles graphiques réutilisables (lib/albums.mjs, STYLE_PRESETS) ----
    function styleDialog(n) {
      const pg = album.pages[n - 1], st = pg.style ?? { border: { width: 0, color: '#ffffff' }, textColor: null, align: 'center' };
      const bg = h('input', { type: 'color', value: pg.background });
      const bw = h('input', { type: 'number', min: 0, max: albumMeta.borderMax, step: 0.1, value: st.border.width });
      const bc = h('input', { type: 'color', value: st.border.color });
      const autoInk = h('input', { type: 'checkbox', checked: !st.textColor });
      const ink = h('input', { type: 'color', value: st.textColor || inkOn(pg.background), disabled: !st.textColor });
      autoInk.addEventListener('change', () => { ink.disabled = autoInk.checked; });
      const align = h('select', {}, ...Object.entries(albumMeta.aligns).map(([k, l]) => h('option', { value: k, selected: k === st.align }, l)));
      const model = () => ({ background: bg.value, border: { width: +bw.value || 0, color: bc.value }, textColor: autoInk.checked ? null : ink.value, align: align.value });
      const models = h('select');
      const delBtn = h('button.ghost.small.danger', { type: 'button' }, 'Supprimer le modèle');
      function fillModels(selected) {
        const S = albumMeta.styles;
        mount(models, ...Object.entries(S.builtin).map(([k, v]) => h('option', { value: k, selected: k === selected }, v.name)),
          ...Object.entries(S.saved).map(([k, v]) => h('option', { value: k, selected: k === selected }, '★ ' + v.name)));
        delBtn.hidden = !S.saved[models.value];
      }
      const refreshMeta = async () => { albumMeta = await api('/albums'); };
      models.addEventListener('change', () => { delBtn.hidden = !albumMeta.styles.saved[models.value]; });
      delBtn.addEventListener('click', async () => {
        const name = albumMeta.styles.saved[models.value]?.name; if (!name) return;
        try { await api('/albums/styles/' + encodeURIComponent(models.value), 'DELETE'); await refreshMeta(); fillModels('classique'); toast(`Modèle « ${name} » supprimé`); } catch (e) { toast(e.message, 'bad'); }
      });
      const apply = async (payload, all) => { const r = await change('/style', 'POST', { ...payload, ...(all ? {} : { page: n }) }); if (r) { m.close(); toast(all ? 'Style appliqué à tout l’album' : `Style appliqué (${labelOf(n).toLowerCase()})`); } };
      const saveBtn = h('button.ghost.small', { type: 'button', onclick: async () => {
        const nm = prompt('Nom du modèle graphique'); if (!nm) return;
        try { const r = await api('/albums/styles', 'POST', { ...model(), name: nm }); await refreshMeta(); fillModels(r.key); toast(`Modèle « ${r.model.name} » enregistré`); } catch (e) { toast(e.message, 'bad'); }
      } }, 'Enregistrer ce style comme modèle…');
      fillModels(Object.entries(albumMeta.styles.builtin).find(([, v]) => v.background === pg.background && v.border.width === st.border.width)?.[0] ?? 'classique');
      const m = modal({ title: `Style — ${labelOf(n).toLowerCase()}`, wide: true, body: h('div',
        h('div.sect', 'Cette page'),
        h('div.form', field('Fond', bg), field('Bordure des photos (mm)', bw), field('Couleur de la bordure', bc)),
        h('p.dim', `Bordure : 0 = aucune, ${albumMeta.borderMax} mm au plus ; filet tracé à l’intérieur de chaque cadre, sauf sur les pages à fond perdu (il serait rogné à la coupe).`),
        h('div.form', field('Alignement des textes', align), field('Couleur des textes', h('div.row', { style: { gap: '8px' } }, h('label.row', { style: { gap: '4px' } }, autoInk, 'Automatique'), ink))),
        h('div.row', { style: { gap: '8px' } },
          h('button.small', { type: 'button', onclick: () => apply({ model: { ...model(), name: 'Style personnalisé' } }, false) }, 'Appliquer à cette page'),
          h('button.ghost.small', { type: 'button', onclick: () => apply({ model: { ...model(), name: 'Style personnalisé' } }, true) }, 'Appliquer à toutes les pages'),
          saveBtn),
        h('div.sect', { style: { marginTop: '14px' } }, 'Modèles graphiques'),
        h('div.form', field('Modèle', models)),
        h('div.row', { style: { gap: '8px' } },
          h('button.ghost.small', { type: 'button', onclick: () => apply({ key: models.value }, false) }, 'Appliquer à cette page'),
          h('button.ghost.small', { type: 'button', onclick: () => apply({ key: models.value }, true) }, 'Appliquer à tout l’album'),
          delBtn),
        h('p.dim', 'Un modèle réunit le fond, la bordure des photos et le style des textes ; les modèles enregistrés (★) servent à tous les albums. Les nouvelles pages reprennent le style de la page qui les précède. Annulable (Ctrl+Z).')),
        actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer')] });
    }

    // side : 'left' ou 'right' dans la vue en planches (la feuille se colle au pli), sinon rien
    function pageView(pg, n, side = '') {
      const issues = album.issues.filter(i => i.page === n && i.level !== 'info');
      const lay = L[pg.layout], span = pg.span ?? 1, sw = album.width_mm * span;
      // largeur bornée pour qu'une page en hauteur ne dépasse pas 420 px de haut sans être déformée
      const st = pg.style ?? { border: { width: 0, color: '#ffffff' }, textColor: null, align: 'center' };
      const sheet = h('div.album-page' + (state.albumGuides ? '.guides' : '') + (span === 2 ? '.spread' : ''), { style: { aspectRatio: `${sw} / ${album.height_mm}`, width: `min(100%, ${Math.round(420 * sw / album.height_mm)}px)`, background: pg.background, color: st.textColor || inkOn(pg.background) } });
      if (state.albumGuides) sheet.appendChild(h('div.album-centre'));
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
          const src = ph.preview || ph.thumb, crop = pg.crops?.[s] ?? null;
          const im = src ? h('img', { src, alt: ph.title || '', draggable: 'true', ondragstart: () => { drag = { page: n, slot: s }; } }) : null;
          if (im && ph.width && ph.height) Object.assign(im.style, imgStyle(cropBox(ph.width / ph.height, frameAspect(fr, pg), crop)));
          cell.appendChild(im ?? h('span', '🖼️'));
          // bordure : même épaisseur relative que dans le PDF (mm rapportés à la largeur de la feuille)
          if (st.border.width > 0 && !lay.fullBleed) cell.appendChild(h('div.frame-border', { style: { borderWidth: `calc(${(st.border.width / sw * 100).toFixed(4)}cqw)`, borderColor: st.border.color } }));
          if (crop) cell.appendChild(h('span.frame-cropped', { title: `Recadrée (zoom × ${crop.zoom.toFixed(2)})` }, '✂'));
          if (ph.edit) cell.appendChild(h('span.frame-edited', { title: `Version retouchée « ${ph.edit.name} » (modifiable dans la Retouche)` }, '✎'));
          cell.appendChild(h('div.frame-tools',
            src ? h('button', { title: 'Recadrer la photo dans le cadre', onclick: e => { e.stopPropagation(); cropDialog(n, s); } }, '✂') : null,
            h('button', { title: 'Retirer la photo du cadre', onclick: e => { e.stopPropagation(); change(pageUrl(n), 'PUT', { slots: setSlot(n, s, null) }); } }, '×')));
        } else cell.appendChild(h('span', id ? '⚠' : '+'));
        sheet.appendChild(cell);
      });
      if (pg.layout === 'titre') sheet.appendChild(h('div.album-title.al-' + st.align, h('div.t1', pg.title || 'Titre'), pg.caption ? h('div.t2', pg.caption) : null));
      else if (pg.caption && !lay.fullBleed) sheet.appendChild(h('div.album-caption.al-' + st.align, pg.caption));
      // numéros des pages imprimées au coin extérieur : droite si impaire, gauche si paire
      if (!lay.fullBleed) for (let k = 0; k < span; k++) {
        const f = pg.folio + k, odd = f % 2 === 1, x0 = (k / span) * 100, x1 = ((k + 1) / span) * 100;
        sheet.appendChild(h('div.album-folio', { style: odd ? { right: `calc(${100 - x1}% + ${2.2 / span}%)`, left: 'auto' } : { left: `calc(${x0}% + ${2.2 / span}%)`, right: 'auto' } }, String(f)));
      }
      const label = span === 2 ? `Pages ${pg.folio}–${pg.folio + 1}` : `Page ${pg.folio}`;

      const laySel = layoutSelect(pg.layout); laySel.addEventListener('change', () => change(pageUrl(n), 'PUT', { layout: laySel.value }));
      const color = h('input', { type: 'color', value: pg.background, title: 'Couleur de fond', onchange: e => change(pageUrl(n), 'PUT', { background: e.target.value }) });
      const text = (key, ph2) => h('input', { type: 'text', value: pg[key], placeholder: ph2, onchange: e => change(pageUrl(n), 'PUT', { [key]: e.target.value }) });
      const last = album.pages.length;
      return h('div.album-page-wrap' + (span === 2 ? '.spread' : '') + (side ? '.' + side : ''),
        sheet,
        h('div.album-page-tools',
          h('div.row', h('b', label), h('div.spacer'),
            h('button.ghost.small', { disabled: n === 1, title: 'Avancer la page', onclick: () => change(pageUrl(n) + '/move', 'POST', { to: n - 1 }) }, '↑'),
            h('button.ghost.small', { disabled: n === last, title: 'Reculer la page', onclick: () => change(pageUrl(n) + '/move', 'POST', { to: n + 1 }) }, '↓'),
            h('button.ghost.small', { title: 'Style de la page : fond, bordures, textes, modèles', onclick: () => styleDialog(n) }, '🎨'),
            h('button.ghost.small', { title: 'Dupliquer la page', onclick: () => change(pageUrl(n) + '/duplicate', 'POST') }, '⧉'),
            h('button.ghost.small', { title: 'Supprimer la page', onclick: async () => { if (await confirmDialog('Supprimer la page', `Supprimer ${label.toLowerCase()} ? Les photos restent dans la photothèque.`)) change(pageUrl(n), 'DELETE'); } }, '🗑')),
          h('div.row', laySel, color),
          pg.layout === 'titre' ? text('title', 'Titre') : null,
          text('caption', pg.layout === 'titre' ? 'Sous-titre' : 'Légende de la page'),
          issues.length ? h('div.album-issues', ...issues.map(i => h('small.' + i.level, i.message.replace(/^Pages? [\d–]+ : /, '')))) : null));
    }

    // Planches (vue en vis-à-vis) : page 1 seule à droite, puis paires gauche (paire) / droite (impaire).
    // Une double page occupe sa planche ; mal placée (début à droite), elle reste seule et une alerte le dit.
    function planches() {
      const out = []; let cur = null;
      album.pages.forEach((pg, i) => {
        const n = i + 1;
        if (pg.span === 2) { out.push({ spread: n }); cur = null; return; }
        if (pg.folio % 2 === 0) { cur = { left: n, right: null }; out.push(cur); return; }
        if (cur && !cur.right) { cur.right = n; cur = null; } else out.push({ left: null, right: n });
      });
      return out;
    }

    function render() {
      const sc = document.getElementById('main'), top = sc.scrollTop;
      title.textContent = album.name; // une annulation peut rendre son ancien nom à l'album
      const used = new Set(album.pages.flatMap(p => p.slots).filter(Boolean)).size;
      const alerts = album.issues.filter(i => i.level !== 'info');
      const empties = album.issues.filter(i => i.level === 'info').length;
      const addSel = layoutSelect('une');
      const guides = h('input', { type: 'checkbox', checked: !!state.albumGuides, onchange: e => { state.albumGuides = e.target.checked; render(); } });
      const spreads = h('input', { type: 'checkbox', checked: !!album.spreads, onchange: e => change('', 'PUT', { spreads: e.target.checked }) });
      const addWrap = h('div.album-page-wrap.add', h('div.form', field('Nouvelle page', addSel), h('div.field', h('label', ' '), h('button', { onclick: () => change('/pages', 'POST', { layout: addSel.value }) }, 'Ajouter une page'))));
      mount(body,
        h('div.row', h('span.dim', `${album.formatLabel} · ${album.width_mm} × ${album.height_mm} mm · ${album.printedPages} page(s) · ${used} photo(s)`), h('div.spacer'),
          h('button.ghost.small', { disabled: !album.history?.undo, title: album.history?.undo ? `Annuler : ${album.history.undo} (Ctrl+Z)` : 'Rien à annuler', onclick: () => undoRedo('undo') }, '↶ Annuler'),
          h('button.ghost.small', { disabled: !album.history?.redo, title: album.history?.redo ? `Rétablir : ${album.history.redo} (Ctrl+Y)` : 'Rien à rétablir', onclick: () => undoRedo('redo') }, '↷ Rétablir'),
          h('label.row', { style: { gap: '6px' }, title: 'Présenter les pages en vis-à-vis, comme dans le livre (la page 1 est seule, à droite)' }, spreads, 'Vue en planches'),
          h('label.row', { style: { gap: '6px' }, title: 'Marges de sécurité (pointillés rouges) et repères du centre de la page' }, guides, 'Guides')),
        alerts.length || empties ? card(h('div.sect', alerts.length ? `⚠ ${alerts.length} alerte(s)` : 'Contrôles'),
          ...alerts.map(i => h('div.album-alert.' + i.level, i.message)),
          empties ? h('p.dim', `${empties} cadre(s) vide(s).`) : null) : null,
        album.spreads
          ? h('div.album-pages.spreads', ...planches().map(pl => pl.spread
              ? h('div.planche', pageView(album.pages[pl.spread - 1], pl.spread))
              : h('div.planche', pl.left ? pageView(album.pages[pl.left - 1], pl.left, 'left') : h('div.planche-blank'),
                  pl.right ? pageView(album.pages[pl.right - 1], pl.right, 'right') : h('div.planche-blank'))), addWrap)
          : h('div.album-pages', ...album.pages.map((pg, i) => pageView(pg, i + 1)), addWrap));
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
      const m = modal({ title: `${labelOf(n)} — cadre ${s + 1}`, wide: true, body: h('div', h('div.form', field('Recherche', q), field('Collection', coll)), count, gridEl) });
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
      const out = [h('p', `${r.pages} page(s)${r.layout === 'spreads' ? ` en ${r.pdfPages} planche(s)` : ''}, ${r.images} image(s), ${fmtBytes(r.bytes)} · ${r.width_mm} × ${r.height_mm} mm${r.bleed ? ` + fonds perdus ${albumMeta.bleedMm} mm` : ''}`)];
      const where = l => l.slice(0, 6).map(x => `p. ${x.page}`).join(', ') + (l.length > 6 ? '…' : '');
      const lost = r.unfilled.filter(u => u.reason !== 'cadre vide'), empty = r.unfilled.length - lost.length;
      if (lost.length) out.push(h('div.album-alert.bad', `${lost.length} cadre(s) sans photo lisible (${where(lost)})`));
      if (r.fromPreview.length) out.push(h('div.album-alert.warn', `${r.fromPreview.length} photo(s) prise(s) sur l'aperçu en cache, original indisponible : qualité réduite (${where(r.fromPreview)})`));
      if (r.edited?.length) out.push(h('p.dim', `${r.edited.length} photo(s) imprimée(s) dans leur version retouchée par défaut.`));
      if (r.fromCopy.length) out.push(h('div.album-alert', `${r.fromCopy.length} photo(s) prise(s) sur une copie identique, original indisponible (${where(r.fromCopy)})`));
      if (r.lowDpi.length) out.push(h('div.album-alert.warn', `${r.lowDpi.length} photo(s) sous la résolution visée (${where(r.lowDpi)})`));
      if (empty) out.push(h('p.dim', `${empty} cadre(s) vide(s)${r.quality === 'screen' ? ', grisés dans l’aperçu' : ', laissés au fond de page'}.`));
      return out;
    }
    async function previewPdf() {
      toast('Préparation de l’aperçu…');
      try {
        const { blob, report } = await fetchPdf({ quality: 'screen', inline: 1, layout: album.spreads ? 'spreads' : 'pages' });
        const src = URL.createObjectURL(blob);
        const m = modal({ title: `Aperçu — ${album.name}`, wide: true, body: h('div', ...pdfSummary(report), h('iframe.pdf-frame', { src, title: 'Aperçu PDF' })),
          actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), h('button', { onclick: () => { m.close(); exportPdf(); } }, 'Exporter pour l’impression…')] });
        new MutationObserver((_, o) => { if (!m.box.isConnected) { URL.revokeObjectURL(src); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
      } catch (e) { toast(e.message, 'bad'); }
    }
    function exportPdf() {
      const prof = h('select', {}, ...Object.entries(albumMeta.pdfProfiles).map(([k, p]) => h('option', { value: k }, p.label)));
      const bleed = h('input', { type: 'checkbox' });
      const disp = h('select', {}, h('option', { value: 'pages' }, 'Page par page (pour l’imprimeur)'), h('option', { value: 'spreads', selected: !!album.spreads }, 'Planches : pages en vis-à-vis (pour l’écran)'));
      const bad = album.issues.filter(i => i.level === 'bad');
      const status = h('div');
      const go2 = h('button', { onclick: async () => {
        go2.disabled = true; mount(status, h('p.dim', 'Production du PDF… (les photos sont rééchantillonnées depuis les originaux)'));
        try {
          const { blob, report } = await fetchPdf({ quality: prof.value, bleed: bleed.checked ? 1 : 0, layout: disp.value });
          const a = h('a', { href: URL.createObjectURL(blob), download: (album.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'album') + '.pdf' });
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          mount(status, h('p', '✓ PDF enregistré dans le dossier de téléchargement du navigateur.'), ...pdfSummary(report));
          toast('PDF produit');
        } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
        go2.disabled = false;
      } }, 'Produire le PDF');
      const m = modal({ title: 'Exporter en PDF', body: h('div',
        h('div.form', field('Qualité', prof), field('Disposition', disp)),
        h('label.row', { style: { gap: '6px' } }, bleed, `Ajouter des fonds perdus de ${albumMeta.bleedMm} mm (imprimeur : la page est agrandie, les photos pleine page débordent, la coupe se fait au format)`),
        bad.length ? h('div.album-alert.bad', `${bad.length} alerte(s) bloquante(s) dans l’album : ${bad[0].message}${bad.length > 1 ? '…' : ''}`) : null,
        h('p.dim', 'Les originaux sont lus sans être modifiés. Une photo n’est jamais agrandie au-delà de sa résolution réelle.'),
        status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), go2] });
    }

    // ---- Dossier prêt à envoyer chez un prestataire (lib/albumpdf.mjs, sendFolder) : rien n'est transmis ----
    function sendDialog() {
      const sel = h('select'), specs = h('div'), checks = h('div'), status = h('div');
      const svcOf = k => albumMeta.services.builtin[k] ?? albumMeta.services.saved[k];
      function fill(selected) {
        const S = albumMeta.services;
        mount(sel, ...Object.entries(S.builtin).map(([k, v]) => h('option', { value: k, selected: k === selected }, v.name)),
          ...Object.entries(S.saved).map(([k, v]) => h('option', { value: k, selected: k === selected }, '★ ' + v.name)));
      }
      const mm = v => String(v).replace('.', ',');
      async function show() {
        const v = svcOf(sel.value); if (!v) return;
        mount(specs, h('p.dim', [albumMeta.serviceOutputs[v.output], albumMeta.serviceLayouts[v.layout].toLowerCase(), `${v.dpi} ppp`, v.bleed_mm ? `fonds perdus ${mm(v.bleed_mm)} mm` : 'sans fonds perdus',
          v.output === 'jpeg' ? `JPEG qualité ${v.jpegQuality}` : null, v.colorProfile.startsWith('file:') ? 'profil ' + v.colorProfile.slice(5) : 'sRGB',
          v.width_mm ? `format ${v.width_mm} × ${v.height_mm} mm` : null, v.safety_mm ? `zone de sécurité ${mm(v.safety_mm)} mm` : null,
          v.minPages || v.maxPages ? `${v.minPages ?? 1} à ${v.maxPages ?? '…'} pages` : null, v.pageMultiple ? `multiple de ${v.pageMultiple}` : null].filter(Boolean).join(' · ')),
          v.notes ? h('p.dim', 'Notes : ' + v.notes) : null);
        delBtn.hidden = !albumMeta.services.saved[sel.value]; editBtn.textContent = albumMeta.services.saved[sel.value] ? 'Modifier ce profil…' : 'Nouveau profil d’après celui-ci…';
        try {
          const r = await api('/albums/' + encodeURIComponent(album.id) + '/send/check', 'POST', { service: sel.value });
          mount(checks, r.issues.length ? h('div', ...r.issues.map(i => h('div.album-alert.' + (i.level === 'info' ? 'info' : i.level), i.message))) : h('p', '✓ Aucune alerte pour ce profil.'));
        } catch (e) { mount(checks, h('div.album-alert.bad', e.message)); }
      }
      const delBtn = h('button.ghost.small.danger', { type: 'button', onclick: async () => {
        const name = albumMeta.services.saved[sel.value]?.name; if (!name) return;
        await api('/albums/services/' + encodeURIComponent(sel.value), 'DELETE'); albumMeta = await api('/albums'); fill('generique-pdf'); show(); toast(`Profil « ${name} » supprimé`);
      } }, 'Supprimer ce profil');
      const editBtn = h('button.ghost.small', { type: 'button', onclick: () => serviceForm(svcOf(sel.value), !!albumMeta.services.saved[sel.value]) });
      const form = h('div');
      function serviceForm(v, editing) {
        const inp = (val, o = {}) => h('input', { type: 'number', value: val ?? '', ...o });
        const name = h('input', { type: 'text', value: editing ? v.name : '', placeholder: 'ex. : nom du prestataire — livre 30 × 30' });
        const output = h('select', {}, ...Object.entries(albumMeta.serviceOutputs).map(([k, l]) => h('option', { value: k, selected: k === v.output }, l)));
        const layout = h('select', {}, ...Object.entries(albumMeta.serviceLayouts).map(([k, l]) => h('option', { value: k, selected: k === v.layout }, l)));
        const dpi = inp(v.dpi, { min: 100, max: 600 }), bleed = inp(v.bleed_mm, { min: 0, max: 10, step: 0.5 }), q = inp(v.jpegQuality, { min: 60, max: 100 });
        const icc = h('select', {}, ...Object.entries(albumMeta.colorProfiles).map(([k, l]) => h('option', { value: k, selected: k === v.colorProfile }, l)));
        const w = inp(v.width_mm, { min: 50, max: 1000, placeholder: 'libre' }), hh = inp(v.height_mm, { min: 50, max: 1000, placeholder: 'libre' }), safe = inp(v.safety_mm, { min: 0, max: 30, step: 0.5 });
        const minP = inp(v.minPages, { min: 1, max: 1000, placeholder: '—' }), maxP = inp(v.maxPages, { min: 1, max: 1000, placeholder: '—' }), mult = inp(v.pageMultiple, { min: 1, max: 16, placeholder: '—' });
        const notes = h('textarea', { rows: 2, placeholder: 'adresse du site, références, consignes…' }, v.notes || '');
        mount(form, card(h('div.sect', editing ? 'Modifier le profil' : 'Nouveau profil de prestataire'),
          h('p.dim', 'Reportez ici les spécifications publiées par le prestataire (format, fonds perdus, zone de sécurité, nombre de pages, type de fichier).'),
          h('div.form', field('Nom', name)),
          h('div.form', field('Fichiers', output), field('Disposition', layout), field('Résolution (ppp)', dpi)),
          h('div.form', field('Fonds perdus (mm)', bleed), field('Qualité JPEG', q), field('Profil de couleur (JPEG)', icc)),
          h('div.form', field('Largeur attendue (mm)', w), field('Hauteur attendue (mm)', hh), field('Zone de sécurité (mm)', safe)),
          h('div.form', field('Pages au minimum', minP), field('Pages au maximum', maxP), field('Multiple de', mult)),
          field('Notes', notes),
          h('div.row', { style: { gap: '8px' } }, h('button.small', { type: 'button', onclick: async () => {
            try {
              const r = await api('/albums/services', 'POST', { name: name.value, output: output.value, layout: layout.value, dpi: +dpi.value, bleed_mm: +bleed.value, jpegQuality: +q.value, colorProfile: icc.value,
                width_mm: w.value ? +w.value : null, height_mm: hh.value ? +hh.value : null, safety_mm: +safe.value || 0, minPages: minP.value ? +minP.value : null, maxPages: maxP.value ? +maxP.value : null, pageMultiple: mult.value ? +mult.value : null, notes: notes.value });
              albumMeta = await api('/albums'); fill(r.key); mount(form); show(); toast(`Profil « ${r.service.name} » enregistré`);
            } catch (e) { toast(e.message, 'bad'); }
          } }, 'Enregistrer le profil'), h('button.ghost.small', { type: 'button', onclick: () => mount(form) }, 'Annuler'))));
      }
      sel.addEventListener('change', show);
      const go2 = h('button', { onclick: async () => {
        go2.disabled = true; mount(status, h('p.dim', 'Préparation du dossier…'));
        try {
          const { jobId } = await api('/albums/' + encodeURIComponent(album.id) + '/send', 'POST', { service: sel.value });
          let job;
          do { await new Promise(r => setTimeout(r, 500)); job = (await api('/jobs/' + jobId)).job; mount(status, h('p.dim', `Préparation… ${job.done ?? 0} / ${job.total || '?'} fichier(s) de page`)); } while (job.status === 'running');
          if (job.status === 'error') throw new Error(job.error);
          const r = job.result, bad = r.issues.filter(i => i.level === 'bad').length;
          mount(status, h('p', `✓ Dossier prêt : ${r.files.length} fichier(s) d’impression · ${fmtBytes(r.bytes)} · ${r.pages} page(s)`), h('p.dim', 'Dossier : ' + r.dir),
            h('p.dim', 'Il contient aussi LISEZ-MOI.txt (spécifications, contrôles, liste des fichiers) et album.json (le projet). Rien n’a été envoyé : déposez ces fichiers vous-même sur le site du prestataire.'),
            bad ? h('div.album-alert.bad', `${bad} alerte(s) à corriger avant l’envoi (voir LISEZ-MOI.txt).`) : null, ...pdfSummary(r).slice(1));
          toast('Dossier d’envoi préparé');
        } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
        go2.disabled = false;
      } }, 'Préparer le dossier');
      fill('generique-pdf');
      const m = modal({ title: 'Préparer l’envoi à un prestataire', wide: true, body: h('div',
        h('div.form', field('Profil du prestataire', sel)), specs,
        h('div.row', { style: { gap: '8px' } }, editBtn, delBtn), form,
        h('div.sect', { style: { marginTop: '10px' } }, 'Contrôles'), checks,
        h('p.dim', `Le dossier est créé dans ${albumMeta.exportDir} : fichiers d’impression (PDF ou JPEG par page), fiche LISEZ-MOI et projet. Les profils intégrés sont génériques (300 ppp, 3 mm de fonds perdus, sRGB) et ne reprennent les spécifications d’aucun prestataire : pour un prestataire donné, créez un profil d’après sa documentation.`),
        status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), go2] });
      show();
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
        h('button.ghost.small', { onclick: sendDialog, title: 'Fichiers d’impression + fiche de contrôle dans un dossier, selon le profil du prestataire' }, 'Préparer l’envoi…'),
        h('a.btn.ghost.small', { href: '/api' + base + '/export', download: '' }, 'Exporter le projet'),
        h('button.danger.small', { onclick: async () => { if (await confirmDialog("Supprimer l'album", `Supprimer « ${album.name} » ? Les photos restent dans la photothèque ; seul l'album disparaît.`)) { await api(base, 'DELETE'); toast('Album supprimé (photos conservées)'); go('albums'); } } }, 'Supprimer')),
      body);
    render();
  }
  // ---------- Doublons et photos similaires (lib/duplicates.mjs) : comparer, désigner, jamais supprimer ----------
  async function viewDuplicates(v) {
    state.dup ??= { level: 'exact', threshold: null, seconds: null, limit: 30 };
    const S = state.dup;
    const qs = extra => new URLSearchParams(Object.fromEntries(Object.entries({ threshold: S.threshold ?? '', seconds: S.seconds ?? '', ...extra }).filter(([, x]) => x !== '' && x != null)));
    let sum = await api('/duplicates/summary?' + qs());
    S.threshold ??= sum.defaults.threshold; S.seconds ??= sum.defaults.seconds;
    const body = h('div.dup-list'), tabs = h('div.row.dup-tabs'), opts = h('div.row'), hashCard = h('div');
    const HELP = {
      exact: 'Même contenu au bit près (empreinte SHA-256). Une photo présente en plusieurs fichiers apparaît seule, avec la liste de ses fichiers.',
      potential: 'Même nom de fichier et mêmes dimensions, ou même instant de prise de vue avec le même appareil — mais contenu différent. À vérifier.',
      similar: 'Empreinte visuelle proche : même image retouchée, réduite, recadrée, réenregistrée… Plus la tolérance est haute, plus les rapprochements sont larges.',
      burst: 'Photos prises en rafale par le même appareil, à quelques secondes d’intervalle.',
    };

    function photoCol(g, p) {
      const isRef = p.isReference, isVar = !!p.reference && !isRef;
      // le premier fichier listé est celui qu'utilisent l'affichage, les albums et l'export
      const fileRows = p.files.map((f, k) => h('div.dup-file' + (f.available ? '' : '.off'),
        h('span', { title: f.path }, f.path),
        h('small.dim', [f.support, f.bytes != null ? fmtBytes(f.bytes) : null, f.available ? null : 'indisponible', g.kind === 'files' ? (k === 0 ? 'fichier de référence' : 'copie') : null].filter(Boolean).join(' · ')),
        g.kind === 'files' && k > 0 ? h('button.ghost.small', { onclick: async () => { await api('/duplicates/reference-file', 'POST', { fileId: f.id }); toast('Fichier de référence choisi (les autres fichiers restent indexés comme copies)'); load(); } }, 'Fichier de référence') : null,
        p.files.length > 1 ? h('button.ghost.small.danger', { title: 'Retire ce fichier du catalogue ; il reste sur le disque', onclick: async () => {
          if (!(await confirmDialog('Supprimer la fiche', `Supprimer la fiche de ce fichier du catalogue ?\n\n${f.path}\n\nLe fichier n’est ni effacé ni déplacé : il reste sur le disque et ne sera plus réindexé. La photo garde ses ${p.files.length - 1} autre(s) fichier(s), ses mots-clés et ses retouches.`))) return;
          try { await api('/duplicates/remove', 'POST', { fileId: f.id }); toast('Fiche supprimée. Fichier conservé sur le disque.'); load(true); } catch (e) { toast(e.message, 'bad'); }
        } }, 'Supprimer la fiche…') : null));
      return h('div.dup-photo' + (isRef ? '.ref' : ''),
        h('div.dup-thumb', { onclick: () => lightboxOpen(g.photos, g.photos.indexOf(p), () => {}) }, p.thumb ? h('img', { src: p.thumb, alt: '', loading: 'lazy' }) : h('span', '🖼️'),
          isRef ? h('span.dup-badge', '★ Référence') : isVar ? h('span.dup-badge.var', 'Variante') : null),
        h('div.dup-meta',
          h('div', h('b', p.width && p.height ? `${p.width} × ${p.height}` : 'dimensions inconnues'), p.bytes != null ? ` · ${fmtBytes(p.bytes)}` : '', p.format ? ` · ${p.format.toUpperCase()}` : ''),
          h('div.dim', [p.captured_at ? fmtDateTime(p.captured_at) : 'sans date', p.camera].filter(Boolean).join(' · ')),
          p.edits ? h('div.dim', `✎ ${p.edits} version(s) retouchée(s)`) : null,
          p.missing ? h('div.album-alert.warn', 'Indisponible (support absent ?)') : null,
          ...fileRows),
        g.photos.length > 1 ? h('div.row.wrap',
          isRef ? null : h('button.small', { title: 'Les autres photos du groupe deviennent ses variantes (rien n’est supprimé)', onclick: async () => { await api('/duplicates/reference', 'POST', { photoIds: g.photos.map(x => x.id), reference: p.id }); toast('Référence désignée, variantes conservées'); load(); } }, '★ Référence'),
          h('button.ghost.small.danger', { title: 'Retire cette photo du catalogue ; ses fichiers restent sur le disque', onclick: async () => {
            const lost = [p.edits ? `${p.edits} version(s) retouchée(s)` : null, 'ses mots-clés, sa note et sa légende'].filter(Boolean).join(', ');
            if (!(await confirmDialog('Supprimer la fiche', `Supprimer la fiche de cette photo (${p.width ?? '?'} × ${p.height ?? '?'}) du catalogue ? Avec elle disparaissent ${lost} ; un album qui l’utilisait signalera son cadre.\n\nSes ${p.files.length} fichier(s) ne sont ni effacés ni déplacés : ils restent sur le disque et ne seront plus réindexés.`))) return;
            try { await api('/duplicates/remove', 'POST', { photoId: p.id }); toast('Fiche supprimée. Fichiers conservés sur le disque.'); load(true); } catch (e) { toast(e.message, 'bad'); }
          } }, 'Supprimer la fiche…')) : null);
    }
    function groupCard(g) {
      const hasRef = g.photos.some(p => p.isReference || p.reference);
      return card(
        h('div.row', h('b', g.photos.length > 1 ? `${g.photos.length} photos` : `${g.photos[0]?.files.length ?? 0} fichiers`), h('span.dim', g.reason), h('div.spacer'),
          g.photos.length > 1 ? h('button.ghost.small', { title: g.photos.length > 4 ? 'Compare les 4 premières photos du groupe' : 'Afficher les photos côte à côte, zoom synchronisé', onclick: () => compareView(g.photos.map(x => x.id).slice(0, 4)) }, 'Comparer') : null,
          hasRef ? h('button.ghost.small', { onclick: async () => { await api('/duplicates/reference', 'POST', { photoIds: g.photos.map(x => x.id), clear: true }); load(); } }, 'Annuler la référence') : null,
          g.photos.length > 1 ? h('button.ghost.small', { title: 'Ce groupe ne sera plus proposé', onclick: async () => { await api('/duplicates/ignore', 'POST', { photoIds: g.photos.map(x => x.id) }); toast('Groupe écarté : ces photos sont distinctes'); load(); } }, 'Ce ne sont pas des doublons') : null),
        h('div.dup-row', ...g.photos.map(p => photoCol(g, p))));
    }

    async function computeHashes(all = false) {
      const { jobId } = await api('/duplicates/hashes', 'POST', { all });
      let job;
      do { await new Promise(r => setTimeout(r, 400)); job = (await api('/jobs/' + jobId)).job; mount(hashCard, card(h('p.dim', `Calcul des empreintes visuelles… ${job.done ?? 0} / ${job.total || '?'}`))); } while (job.status === 'running');
      if (job.status === 'error') toast(job.error, 'bad'); else toast(`${job.result.computed} empreinte(s) calculée(s)${job.result.failed ? `, ${job.result.failed} photo(s) illisible(s)` : ''}`);
      load(true);
    }

    async function load(refreshSummary = false) {
      if (refreshSummary) { sum = await api('/duplicates/summary?' + qs()); drawOpts(); } // compteurs des boutons d'options
      mount(tabs, ...Object.entries(sum.levels).map(([k, label]) => h('button.small' + (S.level === k ? '' : '.ghost'), { onclick: () => { S.level = k; S.limit = 30; drawOpts(); load(); } }, `${label} (${sum[k]})`)));
      mount(hashCard, sum.hashesMissing ? card(h('div.row', h('span', `${sum.hashesMissing} photo(s) n’ont pas encore d’empreinte visuelle : elles n’apparaissent pas dans les photos similaires.`), h('div.spacer'), h('button.small', { onclick: () => computeHashes(false) }, 'Calculer'))) : null);
      const r = await api('/duplicates?' + qs({ level: S.level, limit: S.limit }));
      mount(body,
        h('p.dim', HELP[S.level] + ' Rien n’est jamais supprimé automatiquement.'),
        r.groups.length ? null : h('div.empty', h('div.big', '✓'), 'Aucun groupe à ce niveau.'),
        ...r.groups.map(groupCard),
        r.total > r.groups.length ? h('button.ghost', { onclick: () => { S.limit += 30; load(); } }, `Afficher plus (${r.groups.length} sur ${r.total})`) : null);
    }
    function drawOpts() {
      if (S.level === 'similar') {
        const out = h('span.rt-val', String(S.threshold));
        const range = h('input', { type: 'range', min: 0, max: sum.defaults.maxThreshold, step: 1, value: S.threshold });
        range.addEventListener('input', () => { out.textContent = range.value; });
        range.addEventListener('change', () => { S.threshold = +range.value; load(true); });
        mount(opts, h('label.row', { style: { gap: '8px' } }, 'Tolérance', range, out, h('small.dim', '0 = quasi identiques · 8 = conseillé · 20 = large')),
          h('div.spacer'), h('button.ghost.small', { title: 'Recalculer toutes les empreintes (après une mise à jour des vignettes, par exemple)', onclick: () => computeHashes(true) }, 'Recalculer les empreintes'));
      } else if (S.level === 'burst') {
        const sec = h('input', { type: 'number', min: 0.5, max: 60, step: 0.5, value: S.seconds, style: { width: '80px' } });
        sec.addEventListener('change', () => { S.seconds = +sec.value; load(true); });
        mount(opts, h('label.row', { style: { gap: '8px' } }, 'Intervalle maximal (secondes)', sec));
      } else clear(opts);
      if (sum.excludedFiles) opts.appendChild(h('button.ghost.small', { title: 'Les fichiers dont la fiche a été supprimée pourront de nouveau être indexés (à la prochaine indexation de leur dossier)', onclick: async () => {
        if (!(await confirmDialog('Réautoriser les fichiers écartés', `${sum.excludedFiles} fichier(s) dont la fiche a été supprimée pourront de nouveau être indexés. Rien n’est indexé tout de suite : ils reviendront à la prochaine indexation de leur dossier.`))) return;
        await api('/duplicates/remove', 'POST', { reset: true }); toast('Fichiers écartés réautorisés'); load(true); } }, `Réautoriser les fichiers écartés (${sum.excludedFiles})`));
      if (sum.ignoredPairs) opts.appendChild(h('button.ghost.small', { title: 'Reproposer les groupes déclarés « pas des doublons »', onclick: async () => { await api('/duplicates/ignore', 'POST', { reset: true }); load(true); } }, `Reproposer les groupes écartés (${sum.ignoredPairs} paire(s))`));
    }

    mount(v, h('h2.page-title', 'Doublons et photos similaires'), tabs, hashCard, opts, body);
    drawOpts(); await load();
  }

  // ---------- vue Rapports (lib/reports.mjs) : inventaires et rapports en PDF ou CSV ----------
  async function viewReports(v) {
    clear(v);
    const meta = await api('/reports');
    mount(v, h('h2.page-title', 'Rapports et inventaires'),
      h('p.dim', 'Documents de contrôle du fonds, en PDF ou en CSV (tableur). Aucun rapport ne modifie le catalogue ni les fichiers.'),
      ...Object.entries(meta.reports).map(([kind, r]) => reportCard(kind, r, meta)));
  }

  /** Une ligne de compte rendu lisible pour chaque rapport (indicateurs renvoyés dans X-Report). */
  function reportSummary(kind, s) {
    if (!s) return null;
    const n = fmtNum;
    if (kind === 'inventory') return h('div.album-alert' + (s.missing ? '.warn' : '.ok'), `${n(s.supports.length)} support(s) · ${n(s.files)} fichier(s) · ${fmtBytes(s.bytes)} · ${n(s.missing)} indisponible(s)${s.orphans ? ` · ${n(s.orphans)} sans support` : ''}`);
    if (kind === 'missing') return h('div.album-alert' + (s.lost ? '.bad' : s.missing ? '.warn' : '.ok'), s.missing ? `${n(s.missing)} fichier(s) manquant(s) sur ${n(s.files)} · ${n(s.photos)} photo(s) concernée(s), dont ${n(s.lost)} sans aucune copie disponible${s.found ? ` · ${n(s.found)} retrouvé(s)` : ''}` : `Aucun fichier manquant (${n(s.files)} vérifié(s))${s.found ? ` · ${n(s.found)} retrouvé(s), index à rafraîchir` : ''}`);
    if (kind === 'integrity') {
      const bad = s.hash + s.size + s.unreadable;
      return h('div.album-alert' + (bad || !s.db || s.foreignKeys ? '.bad' : s.absent || s.offline ? '.warn' : '.ok'),
        `Base ${s.db && !s.foreignKeys ? 'intègre' : 'EN ANOMALIE'} · ${n(s.ok)} fichier(s) conforme(s) · ${n(bad)} altéré(s), modifié(s) ou illisible(s) · ${n(s.absent)} introuvable(s) · ${n(s.offline)} non vérifié(s) (support non connecté)${s.mode === 'full' ? ` · ${n(s.hashed)} empreinte(s) recalculée(s)` : ''}`);
    }
    if (kind === 'backups') return h('div.album-alert' + (s.bad || s.ageDays === null ? '.bad' : '.ok'),
      `${n(s.count)} sauvegarde(s) · dernière sauvegarde des données : ${s.ageDays === null ? 'aucune' : s.ageDays === 0 ? 'aujourd’hui' : `il y a ${s.ageDays} jour(s)`}${s.bad != null ? ` · ${n(s.bad)} archive(s) altérée(s)` : ''} · sauvegarde automatique ${s.auto ? 'activée' : 'désactivée'}`);
    if (kind === 'coverage') return h('div.album-alert' + (s.uncovered ? '.warn' : '.ok'),
      `${n(s.covered)} / ${n(s.photos)} photo(s) avec une copie sur un support de sauvegarde ou d’archive · ${n(s.uncovered)} sans copie · ${n(s.single)} sur un seul support${s.backupSupports ? '' : ' · aucun support de sauvegarde déclaré'}`);
    return null;
  }

  function reportCard(kind, r, meta) {
    const controls = []; let options = () => ({});
    if (kind === 'inventory') {
      const sel = h('select', {}, h('option', { value: '' }, 'Tous les supports'), ...meta.supports.map(s => h('option', { value: s.id }, s.name + (s.status === 'absent' ? ' (non connecté)' : ''))));
      controls.push(field('Support', sel)); options = () => ({ supportId: sel.value });
    }
    if (kind === 'integrity') {
      const sel = h('select', {}, h('option', { value: 'quick' }, 'Rapide : présence et taille des fichiers'), h('option', { value: 'full' }, 'Complet : empreintes SHA-256 recalculées (relit tous les fichiers)'));
      controls.push(field('Contrôle', sel)); options = () => ({ mode: sel.value });
    }
    if (kind === 'backups') {
      const cb = h('input', { type: 'checkbox', checked: true });
      controls.push(h('label.check', cb, ' Relire et vérifier chaque archive')); options = () => ({ verify: cb.checked });
    }
    const status = h('div'), btns = [];
    const busy = on => btns.forEach(b => { b.disabled = on; });
    async function run(format, inline = false) {
      const res = await fetch(`/api/reports/${kind}/${format}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options: options(), inline }) });
      if (!res.ok) { let msg = 'Échec du rapport'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
      let rep = null; try { rep = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(res.headers.get('X-Report') || ''), c => c.charCodeAt(0)))); } catch { /* compte rendu absent */ }
      const cd = res.headers.get('Content-Disposition') || '', name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(cd) ?? [])[1] ?? `rapport.${format}`);
      return { blob: await res.blob(), rep, name };
    }
    const act = (label, fn, primary = false) => { const b = h(primary ? 'button' : 'button.ghost', { onclick: async () => {
      busy(true); mount(status, h('p.dim', kind === 'integrity' ? 'Contrôle en cours… (le contrôle complet relit chaque fichier)' : 'Préparation…'));
      try { await fn(); } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, label); b.dataset.report = kind; btns.push(b); return b; };
    const save = ({ blob, name }) => { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
    const preview = act('Aperçu', async () => {
      const out = await run('pdf', true), src = URL.createObjectURL(out.blob);
      mount(status, reportSummary(kind, out.rep?.summary));
      const pv = modal({ title: `Aperçu — ${r.label}`, wide: true, body: h('div', reportSummary(kind, out.rep?.summary), h('p.dim', `${out.rep?.pages ?? '?'} page(s) · ${fmtBytes(out.rep?.bytes)}`), h('iframe.pdf-frame', { src, title: 'Aperçu PDF' })),
        actions: [h('button.ghost', { onclick: () => pv.close() }, 'Fermer'), h('button', { onclick: () => { save({ blob: out.blob, name: out.name }); toast('PDF enregistré'); } }, 'Télécharger le PDF')] });
      new MutationObserver((_, ob) => { if (!pv.box.isConnected) { URL.revokeObjectURL(src); ob.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
    });
    const pdfBtn = act('PDF', async () => { const out = await run('pdf'); save(out); mount(status, reportSummary(kind, out.rep?.summary), h('p.dim', `✓ ${out.name} enregistré dans le dossier de téléchargement (${out.rep?.pages} page(s)).`)); toast('Rapport PDF produit'); }, true);
    const csvBtn = act('CSV', async () => { const out = await run('csv'); save(out); mount(status, reportSummary(kind, out.rep?.summary), h('p.dim', `✓ ${out.name} enregistré : ${fmtNum(out.rep?.rows ?? 0)} ligne(s) (séparateur « ; », UTF-8).`)); toast('Rapport CSV produit'); });
    return card(h('div.sect', r.label), h('p.dim', r.desc), controls.length ? h('div.row.wrap', { style: { gap: '12px' } }, ...controls) : null,
      h('div.row', { style: { gap: '8px', marginTop: '8px' } }, preview, pdfBtn, csvBtn), status);
  }

  // ---------- vue Statistiques : tableau de bord (lib/dashboard.mjs) ----------
  // Graphiques en barres (HTML/CSS) : une barre cliquable ouvre la Photothèque filtrée sur cette valeur.
  const MOIS = ['', 'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function openFiltered(facet) { state.q = ''; state.facet = facet; state.page = 0; go('photos'); }
  /** Barres horizontales : [{ label, n, title?, facet? }] ; `fmt` formate la valeur. */
  function hbars(rows, { fmt = fmtNum, total = null, empty = 'Aucune donnée.' } = {}) {
    if (!rows.length) return h('p.dim', empty);
    const max = Math.max(...rows.map(r => r.n), 1);
    return h('div.hbars', ...rows.map(r => h(r.facet ? 'button.hbar.link' : 'div.hbar', { title: r.title ?? (r.facet ? 'Voir ces photos' : ''), onclick: r.facet ? () => openFiltered(r.facet) : null },
      h('span.hbar-label', r.label), h('span.hbar-track', h('span.hbar-fill', { style: { width: Math.max(r.n ? 1.5 : 0, r.n * 100 / max) + '%' } })),
      h('span.hbar-val', fmt(r.n) + (total ? ` · ${Math.round(r.n * 1000 / total) / 10} %`.replace('.', ',') : '')))));
  }
  /** Colonnes verticales (années, mois) : [{ label, n, facet? }]. */
  function vbars(rows, { empty = 'Aucune donnée.', every = 1 } = {}) {
    if (!rows.length) return h('p.dim', empty);
    const max = Math.max(...rows.map(r => r.n), 1);
    return h('div.vbars', { style: { gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` } }, ...rows.map((r, i) => h(r.facet ? 'button.vbar.link' : 'div.vbar', { title: `${r.title ?? r.label} : ${fmtNum(r.n)} photo(s)`, onclick: r.facet ? () => openFiltered(r.facet) : null },
      h('span.vbar-val', r.n ? fmtNum(r.n) : ''), h('span.vbar-col', h('span.vbar-fill', { style: { height: (r.n * 100 / max) + '%' } })), h('span.vbar-label', i % every === 0 ? r.label : ''))));
  }

  async function viewStats(v) {
    clear(v);
    state.dash ??= { year: '', supportId: '', format: '' };
    const F = state.dash;
    const qs = extra => new URLSearchParams(Object.fromEntries(Object.entries({ ...F, ...extra }).filter(([, x]) => x)));
    const r = await api('/dashboard?' + qs());
    const d = r.dashboard, T = d.totals, G = d.gaps;
    const sel = (key, opts, label) => h('select', { title: label, onchange: e => { F[key] = e.target.value; viewStats(v); } }, h('option', { value: '' }, label), ...opts.map(([val, l]) => h('option', { value: val, selected: F[key] === val }, l)));
    const filters = h('div.row.wrap.dash-filters', { style: { gap: '8px' } },
      sel('year', r.years.map(y => [y.y, `${y.y} (${y.n})`]), 'Toutes les années'),
      sel('supportId', r.supports.map(s => [s.id, s.name]), 'Tous les supports'),
      sel('format', r.formats.filter(x => x.format).map(x => [x.format, `${x.format} (${x.n})`]), 'Tous les formats'),
      h('div.spacer'),
      h('button.ghost.small', { title: 'Recalculer, y compris la taille des dossiers', onclick: async () => { await api('/dashboard?' + qs({ refresh: 1 })); viewStats(v); } }, '↻ Actualiser'),
      h('button.ghost.small', { onclick: async () => {
        const res = await fetch('/api/dashboard/pdf?' + qs({ inline: 1 })); if (!res.ok) { toast('Échec du PDF', 'bad'); return; }
        const src = URL.createObjectURL(await res.blob());
        const pv = modal({ title: 'Aperçu — tableau de bord', wide: true, body: h('iframe.pdf-frame', { src, title: 'Aperçu PDF' }), actions: [h('button.ghost', { onclick: () => pv.close() }, 'Fermer'), h('a.btn', { href: '/api/dashboard/pdf?' + qs(), download: '' }, 'Télécharger le PDF')] });
        new MutationObserver((_, ob) => { if (!pv.box.isConnected) { URL.revokeObjectURL(src); ob.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
      } }, 'Aperçu PDF'),
      h('a.btn.ghost.small', { href: '/api/dashboard/pdf?' + qs(), download: '' }, 'PDF'),
      h('a.btn.ghost.small', { href: '/api/dashboard/csv?' + qs(), download: '' }, 'CSV'));
    const filtered = F.year || F.supportId || F.format;
    const HL = { ok: ['✓ Bon', 'ok'], warn: ['À surveiller', 'warn'], bad: ['À corriger', 'bad'] }[d.health.level];
    const cov = d.coverage.photos ? Math.round(d.coverage.covered * 100 / d.coverage.photos) : 0;
    const base = filtered ? { ...(F.year ? { year: F.year } : {}), ...(F.supportId ? { supportId: F.supportId } : {}), ...(F.format ? { format: F.format } : {}) } : {};
    const gap = (label, key, facet) => ({ label, n: G[key], facet: facet ? { ...base, ...facet } : null, title: facet ? 'Voir ces photos' : '' });
    const vol = Object.entries(d.volumes).map(([k, x]) => ({ label: x.label, n: x.bytes, title: `${x.path ?? 'supports indexés'} — ${fmtNum(x.files)} fichier(s)` }));
    const months = d.dist.month.slice(-36).map(x => { const [y, mo] = x.k.split('-'); const last = new Date(+y, +mo, 0).getDate(); return { label: `${MOIS[+mo]} ${y.slice(2)}`, title: `${MOIS[+mo]} ${y}`, n: x.n, facet: { ...base, from: `${x.k}-01`, to: `${x.k}-${last}T23:59:59` } }; });
    const B = d.backups;

    mount(v, h('h2.page-title', 'Tableau de bord'), filters,
      h('p.dim', `Calculé le ${fmtDateTime(d.computedAt)}${d.cached ? ' (en cache : ↻ pour recalculer)' : ` en ${d.ms} ms`}${filtered ? ' — filtré ; les volumes des dossiers ne dépendent pas des filtres' : ''}. Cliquez une barre pour voir les photos correspondantes.`),
      h('div.kpis',
        kpi('Photos', fmtNum(T.photos)),
        kpi('Fichiers', fmtNum(T.files), { sub: fmtBytes(T.bytes) + ' référencés' }),
        kpi('Indisponibles', fmtNum(T.unavailable), { tone: T.unavailable ? 'warn' : '', sub: `${fmtNum(T.missingPhotos)} photo(s) sans fichier disponible` }),
        kpi('Supports', fmtNum(T.supports), { sub: `${fmtNum(T.supportsAbsent)} absent(s)`, tone: T.supportsAbsent ? 'warn' : '' }),
        kpi('État du catalogue', HL[0], { tone: HL[1] }),
        kpi('Originaux couverts', cov + ' %', { tone: cov === 100 ? 'ok' : 'warn', sub: 'copie sur un support de sauvegarde' }),
        kpi('Doublons', fmtNum(d.duplicates.photosWithCopies), { sub: `${fmtNum(d.duplicates.extraFiles)} fichier(s) en surplus · ${fmtNum(d.duplicates.variants)} variante(s)` }),
        kpi('Classement', `${fmtNum(T.keywords)} mots-clés`, { sub: `${fmtNum(T.albums)} album(s) · ${fmtNum(T.collections)} collection(s)` })),
      h('div.dash-grid',
        card(h('div.sect', 'État général'), ...d.health.notes.map(n => h('div.album-alert.' + (d.health.level === 'ok' ? 'ok' : d.health.level), n)),
          h('p.dim', d.health.db ? 'Base de données : contrôle rapide correct.' : 'Base de données : ' + d.health.dbMessage)),
        card(h('div.sect', 'Manques documentaires'), hbars([
          gap('Sans mot-clé', 'noKeyword', { noKeyword: true }), gap('Sans légende', 'noCaption', { noCaption: true }), gap('Sans titre', 'noTitle'),
          gap('Sans date de prise de vue', 'noDate', { noDate: true }), gap('Sans coordonnées GPS', 'noGps', { hasGps: '0' }), gap('Sans note', 'noRating')], { total: T.photos })),
        card(h('div.sect', 'Volumes'), hbars(vol, { fmt: fmtBytes }),
          h('p.dim', 'Les originaux et leurs copies restent sur leurs supports ; les autres volumes sont des dossiers de l’application. Les aperçus sont un cache régénérable.')),
        card(h('div.sect', 'Sauvegardes'), B ? h('div',
          B.alerts.filter(a => a.level !== 'info').map(a => h('div.album-alert.' + a.level, a.message)),
          B.recent.length ? hbars(B.recent.map(b => ({ label: fmtDateTime(b.at), n: b.size, title: b.name + (b.test ? ` — test ${b.test.ok ? 'réussi' : 'en échec'}` : ' — jamais testée') })), { fmt: fmtBytes }) : h('p.dim', 'Aucune sauvegarde.'),
          h('p.dim', `${fmtNum(B.count)} archive(s), ${fmtBytes(B.bytes)} · ${B.failures.length} échec(s) en 30 jours · ${B.destinations.filter(x => x.enabled).length} destination(s)`),
          h('button.ghost.small', { onclick: () => go('admin-backups') }, 'Ouvrir les sauvegardes')) : h('p.dim', 'Indisponible.'))),
      card(h('div.sect', 'Par année'), vbars(d.dist.year.map(x => ({ label: x.k || '?', title: x.k || 'sans date', n: x.n, facet: x.k ? { ...base, year: x.k } : { ...base, noDate: true } })))),
      card(h('div.sect', 'Par mois', h('small.dim', months.length < d.dist.month.length ? ' (36 derniers mois avec photos)' : '')), vbars(months, { every: months.length > 18 ? 3 : 1 })),
      h('div.dash-grid',
        card(h('div.sect', 'Mois de l’année'), vbars(Array.from({ length: 12 }, (_, i) => ({ label: MOIS[i + 1], n: d.dist.monthOfYear.find(x => x.k === i + 1)?.n ?? 0 })))),
        card(h('div.sect', 'Formats'), hbars(d.dist.format.map(x => ({ label: x.k || '(inconnu)', n: x.n, facet: x.k ? { ...base, format: x.k } : null })), { total: T.photos })),
        card(h('div.sect', 'Appareils'), hbars(d.dist.camera.map(x => ({ label: x.k ? (x.make && !x.k.startsWith(x.make) ? `${x.make} ${x.k}` : x.k) : '(inconnu)', n: x.n, facet: x.k ? { ...base, camera: x.k } : null })), { total: T.photos })),
        card(h('div.sect', 'Objectifs'), hbars(d.dist.lens.map(x => ({ label: x.k || '(inconnu)', n: x.n, facet: x.k ? { ...base, lens: x.k } : null })), { total: T.photos })),
        card(h('div.sect', 'Notes'), hbars(d.dist.rating.map(x => ({ label: x.k ? '★'.repeat(x.k) : 'sans note', n: x.n, facet: x.k ? { ...base, rating: String(x.k) } : null })), { total: T.photos })),
        card(h('div.sect', 'Supports'), hbars(d.supports.map(s => ({ label: s.name + (s.status === 'absent' ? ' (absent)' : ''), n: s.photos, facet: { ...base, supportId: s.id }, title: `${fmtBytes(s.bytes)} · ${fmtNum(s.files)} fichier(s)` })), { empty: 'Aucun support.' }))),
      card(h('div.sect', 'Historique des importations'), d.imports.length ? table({ columns: [
        { label: 'Date', format: i => fmtDateTime(i.started_at) },
        { label: 'Source', format: i => h('span.wrap', i.source ?? '') },
        { label: 'Mode', format: i => (i.mode === 'copy' ? 'copie' : 'index') },
        { label: 'Traités', key: 'done', align: 'right' },
        { label: 'Ignorés', key: 'skipped', align: 'right' },
        { label: 'Erreurs', format: i => h('span.' + (i.errors ? 'bad' : 'dim'), fmtNum(i.errors ?? 0)), align: 'right' },
        { label: 'État', key: 'status' },
      ], rows: d.imports }) : h('p.dim', 'Aucune importation.')));
  }

  // ---------- verrouillage de l'application (Paramètres) ----------
  function lockCard(LK) {
    const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: '6 caractères au moins' });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const idle = h('input', { type: 'number', min: 1, max: 480, value: LK.idleMinutes ?? 30 });
    const out = h('div');
    const call = async (path, payload, okMsg) => {
      try { await api(path, 'POST', payload); toast(okMsg); await state.refreshLock?.(); go('settings', { replace: true }); } catch (e) { mount(out, h('div.album-alert.bad', e.message)); }
    };
    const setPw = () => { if (pw.value !== pw2.value) { mount(out, h('div.album-alert.bad', 'Les deux saisies diffèrent')); return; } call('/lock/password', { current: cur.value, password: pw.value, idleMinutes: +idle.value }, LK.enabled ? 'Mot de passe changé' : 'Verrouillage activé'); };
    return card(h('div.sect', 'Verrouillage de l’application'),
      h('p', LK.enabled ? `🔒 Activé : mot de passe demandé au lancement et après ${LK.idleMinutes} min d’inactivité.` : 'Désactivé : l’application s’ouvre sans mot de passe.'),
      h('div.form', LK.enabled ? field('Mot de passe actuel', cur) : null, field(LK.enabled ? 'Nouveau mot de passe' : 'Mot de passe', pw), field('Confirmation', pw2), field('Verrouiller après (minutes sans activité)', idle)),
      h('div.row', { style: { gap: '8px' } }, h('button.small', { onclick: setPw }, LK.enabled ? 'Changer le mot de passe' : 'Activer le verrouillage'),
        LK.enabled ? h('button.ghost.small', { onclick: () => call('/lock/idle', { current: cur.value, idleMinutes: +idle.value }, 'Délai enregistré') }, 'Enregistrer le délai') : null,
        LK.enabled ? h('button.ghost.small.danger', { onclick: () => call('/lock/disable', { current: cur.value }, 'Verrouillage désactivé') }, 'Désactiver') : null),
      out,
      h('p.dim', 'Le verrou protège l’accès par l’interface. Il ne chiffre ni le catalogue ni les photos, lisibles par quiconque a accès aux fichiers de l’ordinateur : pour cela, utilisez le chiffrement du disque (BitLocker). Le mot de passe n’est pas enregistré, seulement une empreinte de contrôle. Oublié ? Arrêtez l’application et lancez « node scripts/deverrouiller.mjs ».'));
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
    const MD = await api('/metadata');
    const EXT = await api('/external');
    const LK = await api('/lock');
    const editorIn = h('input', { type: 'text', value: EXT.settings.editor || '', placeholder: 'ex. : C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe — vide : application associée' });
    const readCb = h('input', { type: 'checkbox', checked: MD.settings.readOnIndex !== false });
    const destSel = h('select', {}, ...Object.entries(MD.destinations).map(([k, l]) => h('option', { value: k, selected: MD.settings.destination === k }, l)));
    const nameSel = h('select', {}, ...Object.entries(MD.namings).map(([k, l]) => h('option', { value: k, selected: MD.settings.naming === k }, l)));

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
      card(h('div.sect', 'Métadonnées'),
        h('p.dim', 'Priorité : la fiche de Photothèque est la référence et n’est jamais écrasée sans aperçu. À la lecture, le XMP annexe passe avant les métadonnées embarquées dans le fichier. L’écriture se fait uniquement dans des XMP annexes : les originaux ne sont jamais modifiés.'),
        h('div.form',
          h('label.check', readCb, h('span', 'À l’indexation, remplir les champs vides des nouvelles photos (titre, légende, mots-clés, note, lieu…) depuis leurs fichiers')),
          field('Emplacement des XMP écrits', destSel, `Dossier dédié : ${MD.dir}`),
          field('Nom des fichiers XMP', nameSel))),
      lockCard(LK),
      card(h('div.sect', 'Logiciel de retouche externe'),
        h('p.dim', `« Ouvrir dans… » (écran Retouche) donne au logiciel une copie rangée dans ${EXT.dir} ; l’original n’est jamais modifié.`),
        h('div.form', field('Programme', editorIn, EXT.check.ok ? `Actuellement : ${EXT.check.label}` : EXT.check.label))),
      h('div.row', h('button', { onclick: save }, 'Enregistrer les paramètres')));

    async function save() {
      const r = await api('/settings', 'PUT', {
        scan: { thumbSize: +thumbSize.value, previewSize: +previewSize.value, hash: hashCb.checked, thumb: thumbCb.checked, followSymlinks: symCb.checked },
        import: { dest: destInput.value, keepFolders: keepCb.checked },
      });
      await api('/metadata/settings', 'PUT', { readOnIndex: readCb.checked, destination: destSel.value, naming: nameSel.value });
      try { await api('/external', 'PUT', { editor: editorIn.value }); } catch (e) { toast(e.message, 'bad'); }
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
    state.version = st.version; state.scan = st.scan; state.import = st.import; state.stats = st.stats; state.aiEnabled = !!st.ai?.enabled;
    supKinds = st.supportKinds; supRoles = st.supportRoles;
    document.getElementById('sidebarFoot').appendChild(h('small', `v${st.version}`));
    // recherche
    const searchEl = document.getElementById('search');
    let tId; searchEl.addEventListener('input', () => { clearTimeout(tId); tId = setTimeout(() => setQuery(searchEl.value.trim()), 300); });
    // menu admin
    document.getElementById('topbarActions').appendChild(h('button.ghost.small', { onclick: () => go('admin') }, 'Administration'));
    // verrouillage : bouton « Verrouiller », et contrôle chaque minute (verrou après inactivité, sans attendre un clic)
    const lockBtn = h('button.ghost.small', { title: 'Verrouiller l’application (mot de passe pour revenir)', onclick: lockNow, style: { display: 'none' } }, '🔒 Verrouiller');
    document.getElementById('topbarActions').prepend(lockBtn);
    state.refreshLock = async () => { try { const l = await (await fetch('/api/lock')).json(); lockBtn.style.display = l.enabled ? '' : 'none'; if (l.enabled && !l.unlocked && !lockWait) lockScreen(); } catch { /* serveur arrêté */ } };
    setInterval(state.refreshLock, 60000);
    await state.refreshLock();
    if (st.backupAlerts) document.getElementById('topbarActions').prepend(h('button.ghost.small.warn-btn', { title: 'Sauvegardes : alertes à consulter', onclick: () => go('admin-backups') }, `⚠ Sauvegardes (${st.backupAlerts})`));
    // historique de navigation : précédent / suivant (vue, filtres, recherche, page)
    document.getElementById('menuToggle').after(
      h('button.icon-btn', { id: 'navBack', title: 'Revenir à l’écran précédent (Alt+←)', disabled: true, onclick: () => history.back() }, '‹'),
      h('button.icon-btn', { id: 'navFwd', title: 'Écran suivant (Alt+→)', disabled: true, onclick: () => history.forward() }, '›'));
    renderNav(); await go('photos');
  }

  return { boot, go, api, searchKeyword, state, refreshNav: renderNav };
})();

document.addEventListener('DOMContentLoaded', () => App.boot().catch(e => toast('Erreur : ' + e.message, 'bad')));
