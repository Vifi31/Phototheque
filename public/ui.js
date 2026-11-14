// Helpers DOM, modales, toasts, visionneuse. Aucune dépendance. Exposé comme global UI.
'use strict';

const UI = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function h(tag, attrs = {}, ...children) {
    if (attrs === null || attrs === undefined || attrs instanceof Node || typeof attrs !== 'object' || Array.isArray(attrs)) {
      children.unshift(attrs); attrs = {};
    }
    const [name, ...classes] = String(tag).split('.');
    const el = document.createElement(name || 'div');
    for (const c of classes) if (c) el.classList.add(c);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') v.split(' ').filter(Boolean).forEach(c => el.classList.add(c));
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    add(el, children);
    return el;
  }
  function add(el, children) {
    for (const c of children.flat(4)) {
      if (c === null || c === undefined || c === false || c === '') continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const mount = (el, ...children) => { clear(el); add(el, children); return el; };

  // ---------- présentation ----------
  const fmtBytes = b => {
    if (!b) return '0 o';
    const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; let n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  };
  const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }); };
  const fmtDateTime = iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const fmtNum = n => Number(n ?? 0).toLocaleString('fr-FR');

  function kpi(label, value, { sub = '', tone = '' } = {}) {
    return h('div.kpi', h('span.kpi-label', label), h('b.kpi-value' + (tone ? '.' + tone : ''), value), sub ? h('small.kpi-sub', sub) : null);
  }
  const card = (...c) => h('div.card', ...c);
  const sectionTitle = (t, ...c) => h('h2.sect', t, ...c);

  function table({ columns, rows, foot, className = '' }) {
    const thead = h('thead', h('tr', ...columns.map(c => h('th', { class: c.align || '' }, c.label))));
    const tbody = h('tbody', ...rows.map(r => h('tr', ...columns.map(c => {
      const v = c.format ? c.format(r) : r[c.key];
      return h('td' + (c.align ? '.' + c.align : ''), ...(v instanceof Node ? [v] : [v]));
    }))));
    const cell = c => (c && typeof c === 'object' && !(c instanceof Node) ? h('td' + (c.align ? '.' + c.align : ''), c.content ?? '') : h('td', c));
    return h('table.data' + (className ? '.' + className : ''), thead, tbody, foot ? h('tfoot', h('tr', ...foot.map(cell))) : null);
  }

  function field(label, control, hint) { return h('div.field', h('label', label), control, hint ? h('small.hint', hint) : null); }

  // ---------- saisie de mots-clés avec propositions au fil de la frappe ----------
  // keywordInput(input, { source, multi }) → conteneur à placer à la place du champ.
  //   source : async () => liste des mots-clés (/api/keywords : id, name, parent_id, data.synonyms), relue au focus.
  //   multi  : saisie « a, b, c » ; la proposition concerne le mot en cours (après la dernière virgule).
  // Insensible aux accents, à la casse, aux tirets et aux apostrophes ; trouve aussi les synonymes.
  // Flèches ↑ ↓ pour choisir, Entrée ou Tab pour valider la proposition choisie (sans choix, Entrée garde son rôle
  // habituel), Échap pour fermer ; clic de souris possible. Un mot qui n'existe pas encore est signalé « Nouveau ».
  const kwFold = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[-'’_.]/g, ' ').replace(/\s+/g, ' ').trim();
  /** Propositions pour une saisie : tableau de { k, score, via, path } trié par pertinence (fonction pure, testée). */
  function keywordMatches(list, term, { exclude = new Set(), limit = 8 } = {}) {
    const t = kwFold(term);
    if (!t) return [];
    const byId = new Map(list.map(k => [k.id, k]));
    const pathOf = k => { const out = []; let p = k.parent_id ? byId.get(k.parent_id) : null; for (let i = 0; p && i < 32; i++) { out.unshift(p.name); p = p.parent_id ? byId.get(p.parent_id) : null; } return out.join(' › '); };
    const found = [];
    for (const k of list) {
      const n = kwFold(k.name);
      if (exclude.has(n)) continue;
      let score = -1, via = '';
      if (n.startsWith(t)) score = 0;
      else if (n.split(' ').some(w => w.startsWith(t))) score = 1;
      else {
        const syn = (k.data?.synonyms ?? []).find(s => { const f = kwFold(s); return f.startsWith(t) || f.split(' ').some(w => w.startsWith(t)); });
        if (syn) { score = 2; via = syn; }
        else if (n.includes(t)) score = 3;
        else { const syn2 = (k.data?.synonyms ?? []).find(s => kwFold(s).includes(t)); if (syn2) { score = 4; via = syn2; } }
      }
      if (score >= 0) found.push({ k, score, via, path: pathOf(k) });
    }
    found.sort((a, b) => a.score - b.score || a.k.name.localeCompare(b.k.name, 'fr', { sensitivity: 'base' }));
    return found.slice(0, limit);
  }
  function keywordInput(input, { source, multi = false } = {}) {
    const box = h('div.suggest.kw-suggest', { hidden: true, role: 'listbox' });
    const wrap = h('div.kw-ac', input, box);
    let list = null, items = [], hi = -1;
    input.setAttribute('autocomplete', 'off');
    const load = async () => { try { list = await source(); } catch { list = list ?? []; } };
    // mot en cours : de la dernière virgule au curseur (ou toute la saisie hors mode multiple)
    const current = () => {
      const v = input.value, caret = input.selectionStart ?? v.length;
      const start = multi ? v.lastIndexOf(',', caret - 1) + 1 : 0;
      const end = multi ? (v.indexOf(',', caret) < 0 ? v.length : v.indexOf(',', caret)) : v.length;
      return { start, end, text: v.slice(start, end).trim() };
    };
    // mots déjà saisis, sauf celui en cours : inutile de les reproposer
    const others = () => {
      if (!multi) return new Set();
      const c = current(), idx = (input.value.slice(0, c.start).match(/,/g) ?? []).length;
      return new Set(input.value.split(',').filter((_, i) => i !== idx).map(kwFold).filter(Boolean));
    };
    const close = () => { box.hidden = true; items = []; hi = -1; };
    const unique = k => list.filter(x => kwFold(x.name) === kwFold(k.name)).length === 1;
    const insertion = k => {
      if (unique(k)) return k.name;
      const parts = []; const byId = new Map(list.map(x => [x.id, x])); let p = k;
      for (let i = 0; p && i < 32; i++) { parts.unshift(p.name); p = p.parent_id ? byId.get(p.parent_id) : null; }
      return parts.join('|'); // « Lieux|Paris » : désigne sans ambiguïté un mot-clé de même nom ailleurs
    };
    const pick = k => {
      const c = current(), v = input.value;
      const before = v.slice(0, c.start).replace(/\s*$/, c.start ? ' ' : ''), after = v.slice(c.end).replace(/^\s+/, '');
      const text = insertion(k) + (multi ? (after ? '' : ', ') : '');
      input.value = before + text + (after ? (multi ? ', ' : '') + after : '');
      const pos = (before + text).length; input.setSelectionRange(pos, pos);
      close();
    };
    const mark = (name, term) => {
      const i = kwFold(name).indexOf(kwFold(term));
      // la forme repliée garde la longueur du libellé tant que la ponctuation / les accents sont à 1 caractère
      return i >= 0 && kwFold(name).length === name.trim().length ? [name.slice(0, i), h('mark', name.slice(i, i + kwFold(term).length)), name.slice(i + kwFold(term).length)] : [name];
    };
    const render = () => {
      const c = current();
      if (!list || !c.text || c.text.includes('|')) { close(); return; } // « Lieux|Montagne » : chemin saisi à la main
      items = keywordMatches(list, c.text, { exclude: others() });
      const exact = list.some(k => kwFold(k.name) === kwFold(c.text) || (k.data?.synonyms ?? []).some(s => kwFold(s) === kwFold(c.text)));
      if (!items.length && exact) { close(); return; }
      mount(box,
        ...items.map((m, i) => h('button' + (i === hi ? '.on' : ''), { type: 'button', role: 'option', tabindex: '-1',
          onmousedown: e => { e.preventDefault(); pick(m.k); } },
          h('span', ...mark(m.k.name, c.text)),
          m.path ? h('span.k', m.path) : null,
          m.via ? h('span.k', 'synonyme : ' + m.via) : null)),
        !exact ? h('div.kw-new', items.length ? '« ' + c.text + ' » sera créé comme nouveau mot-clé' : 'Nouveau mot-clé : « ' + c.text + ' »') : null);
      box.hidden = false;
    };
    input.addEventListener('focus', async () => { await load(); render(); });
    input.addEventListener('input', async () => { if (!list) await load(); hi = -1; render(); });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', e => {
      if (box.hidden || !items.length) return;
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); };
      if (e.key === 'ArrowDown') { hi = (hi + 1) % items.length; stop(); render(); }
      else if (e.key === 'ArrowUp') { hi = hi <= 0 ? items.length - 1 : hi - 1; stop(); render(); }
      else if (e.key === 'Escape') { stop(); close(); }
      else if ((e.key === 'Enter' && hi >= 0) || (e.key === 'Tab' && !e.shiftKey)) { stop(); pick(items[hi >= 0 ? hi : 0].k); }
    }, true);
    return wrap;
  }

  // ---------- toasts ----------
  function toast(message, type = 'ok') {
    const root = document.getElementById('toast');
    root.hidden = false;
    const t = h('div.toast' + (type !== 'ok' ? '.' + type : ''), message);
    // le conteneur est #toast lui-même : on empile via une couche interne
    root.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => { t.remove(); if (!root.children.length) root.hidden = true; }, 400); }, 3200);
  }

  // ---------- modales ----------
  function ensureModalRoot() {
    let r = document.getElementById('modalRoot');
    if (!r) { r = h('div', { id: 'modalRoot' }); document.body.appendChild(r); }
    return r;
  }
  function modal({ title, body, actions = [], wide = false }) {
    const root = ensureModalRoot();
    const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const box = h('div.modal' + (wide ? '.wide' : ''),
      h('div.modal-head', h('h3', title), h('button.modal-close', { onclick: close, 'aria-label': 'Fermer' }, '✕')),
      h('div.modal-body', body),
      actions.length ? h('div.modal-foot', ...actions) : null);
    mount(root, h('div.backdrop', { onclick: e => { if (e.target.classList.contains('backdrop')) close(); } }, box));
    return { close, box };
  }
  function confirmDialog(title, message) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; m.close(); resolve(v); } };
      const m = modal({ title, body: h('p', { style: { whiteSpace: 'pre-line', overflowWrap: 'anywhere' } }, message), actions: [h('button.ghost', { onclick: () => finish(false) }, 'Annuler'), h('button.danger', { onclick: () => finish(true) }, 'Confirmer')] });
      setTimeout(() => m.box.querySelector('.danger')?.focus(), 0);
    });
  }

  // ---------- visionneuse ----------
  // `opts` (facultatif) : { fullUrl(p, showOriginal) → image pleine définition pour le zoom,
  //   info(p) → élément (ou promesse) du panneau d'informations, onKey(e, p) → true si la touche est traitée,
  //   onClose() }
  let lbState = { list: [], index: 0, onNav: null, opts: {} };
  const LB_INFO_KEY = 'phototheque.lbInfo';
  function lightboxOpen(list, index, onNav, actions, opts = {}) {
    let info = false; try { info = localStorage.getItem(LB_INFO_KEY) === '1'; } catch { /* préférence absente */ }
    lbState = { list, index, onNav, actions, opts, info };
    const box = document.getElementById('lightbox');
    box.hidden = false;
    renderLb();
  }
  /** Rafraîchit la photo affichée (après une note, un mot-clé…), sans changer de photo. */
  function lightboxUpdate(p) { if (lbState.list[lbState.index]?.id === p.id) { lbState.list[lbState.index] = { ...lbState.list[lbState.index], ...p }; renderLb(true); } }

  /** Attend le chargement d'une image (load / error) ; decode() peut ne jamais aboutir dans une page masquée. */
  const loadImage = im => im.complete && im.naturalWidth ? Promise.resolve(im) : new Promise((ok, ko) => { im.addEventListener('load', () => ok(im), { once: true }); im.addEventListener('error', () => ko(new Error('Image illisible')), { once: true }); });
  // ---- zoom : « ajusté » (fit) ou échelle de l'image pleine définition, déplacement à la souris ----
  const zoom = { scale: 0, nat: null, url: '' }; // scale 0 = ajusté
  const stage = () => document.getElementById('lbStage');
  function zoomReset() { zoom.scale = 0; zoom.nat = null; zoom.url = ''; const img = document.getElementById('lbImg'); img.style.width = ''; img.style.height = ''; document.getElementById('lightbox').classList.remove('zoomed'); updateZoomLabel(); }
  function fitScale() { const st = stage(), n = zoom.nat; if (!n) return 1; return Math.min(1, (st.clientWidth || innerWidth) / n.w, (st.clientHeight || innerHeight) / n.h); }
  /** Zoome à `scale` (1 = 100 % de l'image pleine définition) en gardant le point (cx, cy) de l'écran sous la souris. */
  async function zoomTo(scale, cx = innerWidth / 2, cy = innerHeight / 2) {
    const p = lbState.list[lbState.index]; if (!p) return;
    const img = document.getElementById('lbImg'), st = stage(), box = document.getElementById('lightbox');
    const url = lbState.opts.fullUrl?.(p, !!lbState.showOriginal) || img.src;
    if (zoom.url !== url) {
      // image pleine définition : chargée une fois, puis affichée à la taille voulue
      const full = new Image(); full.src = url;
      try { await loadImage(full); } catch { return; }
      if (lbState.list[lbState.index] !== p) return;
      zoom.url = url; zoom.nat = { w: full.naturalWidth, h: full.naturalHeight };
      img.src = url;
    }
    const before = box.classList.contains('zoomed') ? img.getBoundingClientRect() : null;
    // « auto » : 100 % de l'image pleine définition, ou le double de l'affichage ajusté si elle tient déjà à l'écran
    if (scale === 'auto') scale = fitScale() < 0.9 ? 1 : fitScale() * 2;
    const s = Math.max(fitScale(), Math.min(4, scale));
    if (s <= fitScale() + 1e-6) { zoomReset(); renderLb(true); return; }
    // point visé, en fraction de l'image, avant le changement d'échelle
    const r0 = before ?? img.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (cx - r0.left) / (r0.width || 1))), fy = Math.min(1, Math.max(0, (cy - r0.top) / (r0.height || 1)));
    zoom.scale = s; box.classList.add('zoomed');
    img.style.width = Math.round(zoom.nat.w * s) + 'px'; img.style.height = Math.round(zoom.nat.h * s) + 'px';
    const sr = st.getBoundingClientRect();
    st.scrollLeft = fx * img.offsetWidth - (cx - sr.left);
    st.scrollTop = fy * img.offsetHeight - (cy - sr.top);
    updateZoomLabel();
  }
  function updateZoomLabel() { const b = document.getElementById('lbZoom'); if (b) b.textContent = zoom.scale ? `${Math.round(zoom.scale * 100)} %` : 'Ajusté'; }
  function zoomToggle(cx, cy) { if (zoom.scale) { zoomReset(); renderLb(true); } else zoomTo('auto', cx, cy); }

  function renderLb(keepZoom = false) {
    const { list, index } = lbState;
    const p = list[index]; if (!p) return;
    if (!keepZoom) zoomReset();
    const img = document.getElementById('lbImg');
    // version retouchée par défaut (p.edit) montrée d'abord ; « Voir l'original » bascule sans rien modifier
    const shown = p.original && lbState.showOriginal ? { ...p, ...p.original } : p;
    if (!zoom.scale) img.src = shown.preview || shown.thumb || '';
    img.alt = p.title || p.path || 'photo';
    document.getElementById('lbMeta').innerHTML = '';
    document.getElementById('lbMeta').append(
      h('div', p.title || ''),
      h('div', { class: 'dim' }, [p.captured_at ? fmtDate(p.captured_at) : '', p.camera_model ? ' · ' + p.camera_model : '', shown.width ? ` · ${shown.width}×${shown.height}` : '', p.missing ? ' · indisponible' : ''].join('')),
    );
    if (p.original) document.getElementById('lbMeta').append(h('div.lb-version',
      h('span.dim', lbState.showOriginal ? 'Original' : `✎ Version retouchée « ${p.edit?.name ?? ''} »`),
      h('button.ghost.small', { onclick: () => { lbState.showOriginal = !lbState.showOriginal; renderLb(); } }, lbState.showOriginal ? 'Voir la version retouchée' : 'Voir l’original')));
    // boutons propres à l'appelant (ex. « Retoucher », « Exporter… »)
    const acts = lbState.actions?.(p) ?? [];
    const tools = h('div.lb-actions',
      h('button.ghost.small', { id: 'lbZoom', title: 'Zoom : double-clic, molette, touche Z (100 % de l’image pleine définition)', onclick: () => zoomToggle() }, 'Ajusté'),
      lbState.opts.info ? h('button.ghost.small' + (lbState.info ? '.on' : ''), { title: 'Informations (touche I)', onclick: toggleInfo }, 'ⓘ Informations') : null,
      ...acts);
    document.getElementById('lbMeta').append(tools);
    updateZoomLabel();
    document.getElementById('lbPrev').style.display = index > 0 ? '' : 'none';
    document.getElementById('lbNext').style.display = index < list.length - 1 ? '' : 'none';
    renderInfo(p);
  }
  // ---- panneau d'informations (fiche complète fournie par l'appelant) ----
  let infoSeq = 0;
  async function renderInfo(p) {
    const panel = document.getElementById('lbInfo'); if (!panel) return;
    const on = !!(lbState.info && lbState.opts.info);
    panel.hidden = !on; document.getElementById('lightbox').classList.toggle('with-info', on);
    if (!on) return;
    const seq = ++infoSeq;
    panel.replaceChildren(h('p.dim', 'Chargement…'));
    try { const el = await lbState.opts.info(p); if (seq === infoSeq) panel.replaceChildren(el); }
    catch (e) { if (seq === infoSeq) panel.replaceChildren(h('p.dim', e.message)); }
  }
  function toggleInfo() { lbState.info = !lbState.info; try { localStorage.setItem(LB_INFO_KEY, lbState.info ? '1' : '0'); } catch { /* préférence non gardée */ } renderLb(true); }
  function lbStep(d) {
    const n = lbState.index + d;
    if (n < 0 || n >= lbState.list.length) return;
    lbState.index = n; renderLb(); lbState.onNav?.(n);
  }
  function lightboxClose() { const box = document.getElementById('lightbox'); if (box.hidden) return; box.hidden = true; zoomReset(); lbState.opts.onClose?.(); }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('lbClose')?.addEventListener('click', lightboxClose);
    document.getElementById('lbPrev')?.addEventListener('click', () => lbStep(-1));
    document.getElementById('lbNext')?.addEventListener('click', () => lbStep(1));
    const st = stage(), img = document.getElementById('lbImg');
    img?.addEventListener('dblclick', e => zoomToggle(e.clientX, e.clientY));
    st?.addEventListener('wheel', e => {
      e.preventDefault();
      const cur = zoom.scale || fitScale();
      zoomTo(e.deltaY < 0 ? cur * 1.25 : cur / 1.25, e.clientX, e.clientY);
    }, { passive: false });
    // déplacement à la souris quand l'image est agrandie
    let drag = null;
    st?.addEventListener('mousedown', e => { if (!zoom.scale || e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, l: st.scrollLeft, t: st.scrollTop }; st.classList.add('dragging'); e.preventDefault(); });
    addEventListener('mousemove', e => { if (!drag) return; st.scrollLeft = drag.l - (e.clientX - drag.x); st.scrollTop = drag.t - (e.clientY - drag.y); });
    addEventListener('mouseup', () => { drag = null; st?.classList.remove('dragging'); });
    document.addEventListener('keydown', e => {
      const box = document.getElementById('lightbox');
      if (!box || box.hidden) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { if (e.key === 'Escape') e.target.blur(); return; }
      const p = lbState.list[lbState.index];
      if (lbState.opts.onKey?.(e, p)) { e.preventDefault(); return; }
      if (e.key === 'Escape') { if (zoom.scale) { zoomReset(); renderLb(true); } else lightboxClose(); }
      else if (e.key === 'ArrowLeft') lbStep(-1);
      else if (e.key === 'ArrowRight') lbStep(1);
      else if (e.key === 'Home') { lbState.index = 0; renderLb(); lbState.onNav?.(0); }
      else if (e.key === 'End') { lbState.index = lbState.list.length - 1; renderLb(); lbState.onNav?.(lbState.index); }
      else if (e.key === 'z' || e.key === 'Z') zoomToggle();
      else if (e.key === '+' || e.key === '=') zoomTo((zoom.scale || fitScale()) * 1.25);
      else if (e.key === '-') zoomTo((zoom.scale || fitScale()) / 1.25);
      else if ((e.key === 'i' || e.key === 'I') && lbState.opts.info) toggleInfo();
      else return;
      e.preventDefault();
    });
  });

  return { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog, lightboxOpen, lightboxClose, lightboxUpdate, loadImage, keywordInput, keywordMatches };
})();
