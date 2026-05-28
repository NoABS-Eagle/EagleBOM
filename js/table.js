'use strict';

// ── Module state ──────────────────────────────────────────────────────────────
let _groups     = null;
let _attrNames  = null;
let _colOrder   = null;  // column names in display order (user can reorder)
let _colWidths  = {};    // colName → px (persists across re-renders)
let _dragCol    = null;  // column name currently being dragged
let _isResizing = false; // true while a resize drag is active

const FIXED_COLS = ['Refs', 'Qty', 'Value', 'Package'];
const WARNING_COLORS = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'];
const FIXED_WIDTHS = { Refs: 220, Qty: 48, Value: 90, Package: 90 };
const ATTR_DEFAULT_WIDTH = 130;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render (or re-render) the BOM table.
 * Preserves column order and widths across re-renders as long as the set of
 * column names hasn't changed (i.e. same file). Resets when a new file is loaded.
 */
function renderTable(groups, attrNames) {
  _groups    = groups;
  _attrNames = attrNames;

  const allCols = [...FIXED_COLS, ...attrNames];

  if (!_colOrder || !sameElements(_colOrder, allCols)) {
    if (_colOrder && _colOrder.every(c => allCols.includes(c))) {
      // Columns were only added (e.g. warehouse import) — preserve order, append new ones
      const newCols = allCols.filter(c => !_colOrder.includes(c));
      _colOrder = [..._colOrder, ...newCols];
    } else {
      // Column set changed structurally (new file) — full reset
      _colOrder  = allCols.slice();
      _colWidths = {};
    }
  }

  _render();
}

// ── Internal render ───────────────────────────────────────────────────────────

function _render() {
  const thead = document.getElementById('bom-head');
  const tbody = document.getElementById('bom-body');

  // ── Header ──────────────────────────────────────────────────────────────
  thead.innerHTML = '';
  const headerRow = document.createElement('tr');

  for (const col of _colOrder) {
    const th = document.createElement('th');
    th.textContent = col;
    th.dataset.col = col;
    th.style.width = (_colWidths[col] ?? FIXED_WIDTHS[col] ?? ATTR_DEFAULT_WIDTH) + 'px';
    th.draggable   = true;

    addColDrag(th, col);
    addResizeHandle(th, col);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  // ── Body ─────────────────────────────────────────────────────────────────
  tbody.innerHTML = '';

  // Assign a stable color index per warning cluster (by warningPeerKey)
  const warnColorMap = new Map();
  for (const group of _groups) {
    if (group.isWarning && !warnColorMap.has(group.warningPeerKey)) {
      warnColorMap.set(group.warningPeerKey, warnColorMap.size);
    }
  }

  for (const group of _groups) {
    const row = document.createElement('tr');
    if (group.isWarning) {
      row.classList.add('warning');
      const ci = warnColorMap.get(group.warningPeerKey) % WARNING_COLORS.length;
      row.classList.add(`warning-c${ci}`);
    }

    for (const col of _colOrder) {
      if (col === 'Refs') {
        const td = document.createElement('td');
        td.className = 'refs';
        td.appendChild(document.createTextNode(group.refs.join(', ')));

        if (group.isWarning) {
          const btn = document.createElement('button');
          btn.className = 'merge-btn';
          btn.title     = 'Merge duplicate groups';
          btn.innerHTML =
            '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
            '<path d="M1.5 1.5 L5.5 5.5 L9.5 1.5"/>' +
            '<line x1="5.5" y1="5.5" x2="5.5" y2="10"/>' +
            '</svg>';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startMerge(group);
          });
          td.appendChild(btn);
        }

        row.appendChild(td);
      } else if (col === 'Qty') {
        const td = document.createElement('td');
        td.className   = 'qty';
        td.textContent = group.refs.length;
        row.appendChild(td);
      } else if (col === 'Value') {
        addStaticCell(row, group.value, 'ro');
      } else if (col === 'Package') {
        addStaticCell(row, group.package, 'ro');
      } else {
        const td = document.createElement('td');
        td.className   = 'editable';
        if (group._dirty.has(col)) td.classList.add('dirty');
        td.textContent = group.attrs[col] ?? '';
        td.addEventListener('click', () => startEdit(td, group, col));
        row.appendChild(td);
      }
    }

    tbody.appendChild(row);
  }
}

// ── Column drag-to-reorder ────────────────────────────────────────────────────

function addColDrag(th, col) {
  th.addEventListener('dragstart', (e) => {
    // Don't start a column drag if the user is on the resize handle
    if (_isResizing) { e.preventDefault(); return; }

    _dragCol = col;
    th.classList.add('col-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', col);
  });

  th.addEventListener('dragend', () => {
    _dragCol = null;
    th.classList.remove('col-dragging');
    clearDragOver();
  });

  th.addEventListener('dragover', (e) => {
    if (!_dragCol || _dragCol === col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDragOver();
    th.classList.add('col-drag-over');
  });

  th.addEventListener('dragleave', (e) => {
    // Only clear when the cursor truly leaves this th (not just entering a child)
    if (!th.contains(e.relatedTarget)) th.classList.remove('col-drag-over');
  });

  th.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!_dragCol || _dragCol === col) return;

    // Move _dragCol to just before col
    const src = _colOrder.indexOf(_dragCol);
    if (src < 0) return;
    _colOrder.splice(src, 1);                       // remove from old position
    const dst = _colOrder.indexOf(col);             // find target in new array
    _colOrder.splice(dst, 0, _dragCol);             // insert before target

    _dragCol = null;
    _render();
  });
}

function clearDragOver() {
  document.querySelectorAll('th.col-drag-over')
    .forEach(el => el.classList.remove('col-drag-over'));
}

// ── Column resize ─────────────────────────────────────────────────────────────

function addResizeHandle(th, col) {
  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  handle.setAttribute('draggable', 'false'); // don't trigger column drag from handle
  th.appendChild(handle);

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _isResizing = true;

    const startX     = e.clientX;
    const startWidth = th.offsetWidth;
    handle.classList.add('is-dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const w = Math.max(40, startWidth + e.clientX - startX);
      th.style.width  = w + 'px';
      _colWidths[col] = w;
    }

    function onUp() {
      _isResizing = false;
      handle.classList.remove('is-dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

function addStaticCell(row, text, className) {
  const td = document.createElement('td');
  td.className   = className;
  td.textContent = text;
  row.appendChild(td);
}

function startEdit(td, group, attrName) {
  if (td.querySelector('input')) return; // already editing

  const original = group.attrs[attrName] ?? '';
  const input    = document.createElement('input');
  input.type     = 'text';
  input.value    = original;
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let committed = false;

  function commit() {
    if (committed) return;
    committed = true;
    const newVal = input.value;
    if (newVal !== original) pushUndo();
    group.attrs[attrName] = newVal;
    group._dirty.add(attrName);
    td.textContent = newVal;
    td.classList.add('dirty');
  }

  function cancel() {
    if (committed) return;
    committed = true;
    td.textContent = original;
  }

  input.addEventListener('blur', commit);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.removeEventListener('blur', commit);
      cancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      input.removeEventListener('blur', commit);
      commit();
      const all  = Array.from(document.querySelectorAll('td.editable'));
      const idx  = all.indexOf(td);
      const next = all[e.shiftKey ? idx - 1 : idx + 1];
      if (next) next.click();
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sameElements(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
