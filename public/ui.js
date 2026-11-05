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
  let lbState = { list: [], index: 0, onNav: null };
  function lightboxOpen(list, index, onNav, actions) {
    lbState = { list, index, onNav, actions };
    const box = document.getElementById('lightbox');
    box.hidden = false;
    renderLb();
  }
  function renderLb() {
    const { list, index } = lbState;
    const p = list[index]; if (!p) return;
    const img = document.getElementById('lbImg');
    // version retouchée par défaut (p.edit) montrée d'abord ; « Voir l'original » bascule sans rien modifier
    const shown = p.original && lbState.showOriginal ? { ...p, ...p.original } : p;
    img.src = shown.preview || shown.thumb || '';
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
    if (acts.length) document.getElementById('lbMeta').append(h('div.lb-actions', ...acts));
    document.getElementById('lbPrev').style.display = index > 0 ? '' : 'none';
    document.getElementById('lbNext').style.display = index < list.length - 1 ? '' : 'none';
  }
  function lbStep(d) {
    const n = lbState.index + d;
    if (n < 0 || n >= lbState.list.length) return;
    lbState.index = n; renderLb(); lbState.onNav?.(n);
  }
  function lightboxClose() { document.getElementById('lightbox').hidden = true; }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('lbClose')?.addEventListener('click', lightboxClose);
    document.getElementById('lbPrev')?.addEventListener('click', () => lbStep(-1));
    document.getElementById('lbNext')?.addEventListener('click', () => lbStep(1));
    document.addEventListener('keydown', e => {
      const box = document.getElementById('lightbox');
      if (!box || box.hidden) return;
      if (e.key === 'Escape') lightboxClose();
      else if (e.key === 'ArrowLeft') lbStep(-1);
      else if (e.key === 'ArrowRight') lbStep(1);
    });
  });

  return { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog, lightboxOpen, lightboxClose };
})();
