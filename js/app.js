'use strict';

let currentGroups    = [];
let currentAttrNames = [];
let currentFileName  = 'bom';
let currentVariantDefs       = [];
let currentHasModuleVariants = false;
let _csvHeaders   = null;
let _csvRows      = null;
let _scrSelection = null;  // Set of attr names to include; null = all

// ── Undo ──────────────────────────────────────────────────────────────────────
const _undoStack  = [];
const UNDO_LIMIT  = 20;

function cloneGroups(groups) {
  return groups.map(g => ({
    ...g,
    refs:           g.refs.slice(),
    attrs:          { ...g.attrs },
    _dirty:         new Set(g._dirty),
    refDnpVariants: Object.fromEntries(
      Object.entries(g.refDnpVariants).map(([k, v]) => [k, new Set(v)])
    ),
    refModuleMap:   { ...g.refModuleMap },
  }));
}

function pushUndo() {
  _undoStack.push({
    groups:    cloneGroups(currentGroups),
    attrNames: currentAttrNames.slice(),
  });
  if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
  _syncUndoBtn();
}

function popUndo() {
  if (_undoStack.length === 0) return;
  const snap = _undoStack.pop();
  currentGroups.length = 0;
  currentGroups.push(...snap.groups);
  currentAttrNames = snap.attrNames;
  renderTable(currentGroups, currentAttrNames);
  _syncUndoBtn();
}

function _syncUndoBtn() {
  const btn = document.getElementById('btn-undo');
  if (btn) btn.disabled = _undoStack.length === 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  // Drag-and-drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', (e) => {
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  // Browse button / file input
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = ''; // allow re-opening the same file
  });

  // Click on drop zone (but not on the label/button itself)
  dropZone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT') {
      fileInput.click();
    }
  });

  // Undo: Ctrl+Z / Cmd+Z — skip when user is editing inside an input
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      if (document.activeElement.tagName === 'INPUT') return;
      e.preventDefault();
      popUndo();
    }
  });

  // Warehouse CSV import
  const csvInput = document.getElementById('csv-input');
  document.getElementById('btn-import-csv').addEventListener('click', () => csvInput.click());
  csvInput.addEventListener('change', () => {
    const file = csvInput.files[0];
    if (!file) return;
    csvInput.value = '';
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const { headers, rows } = parseWarehouseCsv(e.target.result);
        _csvHeaders = headers;
        _csvRows    = rows;
        showImportModal();
      } catch (err) {
        alert('Failed to parse CSV:\n' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  });

  // Export buttons
  document.getElementById('btn-undo').addEventListener('click', () => popUndo());
  document.getElementById('btn-add-col').addEventListener('click', () => showAddColumnModal());
  document.getElementById('btn-scr').addEventListener('click', () => showScrModal());

  document.getElementById('btn-xlsx').addEventListener('click', () => {
    const base = currentFileName.replace(/\.sch$/i, '');
    if (currentVariantDefs.length > 0) {
      showVariantModal(base, currentHasModuleVariants);
    } else {
      exportXlsx(currentGroups, currentAttrNames, `${base}_bom.xlsx`, null);
    }
  });
});

// ── Load & parse file ─────────────────────────────────────────────────────────
function loadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const { components, variantDefs, hasModuleVariants } = parseSchematic(e.target.result);
      const { groups, attrNames } = buildBom(components);
      currentGroups            = groups;
      currentAttrNames         = attrNames;
      currentFileName          = file.name;
      currentVariantDefs       = variantDefs;
      currentHasModuleVariants = hasModuleVariants;
      showBom(file.name, components.length, groups.length);
    } catch (err) {
      alert('Failed to parse file:\n' + err.message);
      console.error(err);
    }
  };
  reader.onerror = () => alert('Could not read file.');
  reader.readAsText(file, 'utf-8');
}

// ── Add attribute column modal ────────────────────────────────────────────────
const FIXED_COL_NAMES = new Set(['Refs', 'Qty', 'Value', 'Package']);

function showAddColumnModal() {
  const modal  = document.getElementById('add-col-modal');
  const input  = document.getElementById('add-col-input');
  const error  = document.getElementById('add-col-error');

  input.value = '';
  error.classList.add('hidden');
  modal.classList.remove('hidden');
  input.focus();

  function tryAdd() {
    const name = input.value.trim();
    if (!name) return;

    if (FIXED_COL_NAMES.has(name) || currentAttrNames.includes(name)) {
      error.textContent = `Column "${name}" already exists.`;
      error.classList.remove('hidden');
      input.select();
      return;
    }

    pushUndo();
    currentAttrNames = [...currentAttrNames, name].sort();
    for (const g of currentGroups) {
      if (!(name in g.attrs)) g.attrs[name] = '';
    }
    modal.classList.add('hidden');
    renderTable(currentGroups, currentAttrNames);
  }

  document.getElementById('add-col-cancel').onclick = () => modal.classList.add('hidden');
  document.getElementById('add-col-confirm').onclick = tryAdd;
  input.onkeydown = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); tryAdd(); }
    else if (e.key === 'Escape') modal.classList.add('hidden');
    else error.classList.add('hidden');
  };
}

// ── .scr export config modal ─────────────────────────────────────────────────
function showScrModal() {
  const modal    = document.getElementById('scr-modal');
  const list     = document.getElementById('scr-attr-list');
  const confirmBtn = document.getElementById('scr-confirm');

  // Restore saved selection filtered to current attrs; fall back to all
  const checked = _scrSelection
    ? new Set(currentAttrNames.filter(n => _scrSelection.has(n)))
    : new Set(currentAttrNames);

  list.innerHTML = '';
  for (const name of currentAttrNames) {
    const label = document.createElement('label');
    const cb    = document.createElement('input');
    cb.type    = 'checkbox';
    cb.name    = name;
    cb.checked = checked.has(name);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    list.appendChild(label);
  }

  function allBoxes() { return Array.from(list.querySelectorAll('input[type="checkbox"]')); }

  document.getElementById('scr-sel-all').onclick  = () => allBoxes().forEach(cb => cb.checked = true);
  document.getElementById('scr-sel-none').onclick = () => allBoxes().forEach(cb => cb.checked = false);

  modal.classList.remove('hidden');

  document.getElementById('scr-cancel').onclick = () => modal.classList.add('hidden');

  confirmBtn.onclick = () => {
    const selected = allBoxes().filter(cb => cb.checked).map(cb => cb.name);
    _scrSelection = new Set(selected);
    modal.classList.add('hidden');
    if (selected.length === 0) return;
    const base = currentFileName.replace(/\.sch$/i, '');
    const scr  = generateScr(currentGroups, selected);
    downloadText(scr, `${base}_attrs.scr`);
  };
}

// ── Group merge ───────────────────────────────────────────────────────────────

function startMerge(group) {
  pushUndo();
  const peers = currentGroups.filter(g =>
    g !== group &&
    g.isWarning &&
    g.value   === group.value &&
    g.package === group.package
  );
  if (peers.length === 0) return;
  iterateMerge(group, peers.slice());
}

function iterateMerge(target, remaining) {
  if (remaining.length === 0) {
    markWarnings(currentGroups);
    const sorted = clusterSort(currentGroups);
    currentGroups.length = 0;
    currentGroups.push(...sorted);
    renderTable(currentGroups, currentAttrNames);
    return;
  }

  const candidate = remaining[0];
  const rest      = remaining.slice(1);

  const conflicts = currentAttrNames.filter(n => {
    const va = (target.attrs[n]    ?? '').trim();
    const vb = (candidate.attrs[n] ?? '').trim();
    return va && vb && va !== vb;
  });

  if (conflicts.length === 0) {
    performMerge(target, candidate, {});
    currentGroups.splice(currentGroups.indexOf(candidate), 1);
    iterateMerge(target, rest);
  } else {
    showMergeConflictDialog(target, candidate, conflicts, (chosen) => {
      performMerge(target, candidate, chosen);
      currentGroups.splice(currentGroups.indexOf(candidate), 1);
      iterateMerge(target, rest);
    });
  }
}

function performMerge(target, source, overrides) {
  target.refs = [...target.refs, ...source.refs];
  target.refs.sort(naturalRefSort);

  Object.assign(target.refDnpVariants, source.refDnpVariants);
  Object.assign(target.refModuleMap,   source.refModuleMap);

  for (const n of currentAttrNames) {
    if (Object.prototype.hasOwnProperty.call(overrides, n)) {
      if (target.attrs[n] !== overrides[n]) {
        target.attrs[n] = overrides[n];
        target._dirty.add(n);
      }
    } else {
      const va = (target.attrs[n] ?? '').trim();
      const vb = (source.attrs[n] ?? '').trim();
      if (!va && vb) {
        target.attrs[n] = vb;
        target._dirty.add(n);
      }
    }
  }
}

function showMergeConflictDialog(groupA, groupB, conflictAttrs, onConfirm) {
  const modal = document.getElementById('merge-modal');
  const list  = document.getElementById('merge-conflict-list');

  list.innerHTML = '';
  for (const n of conflictAttrs) {
    const row = document.createElement('div');
    row.className = 'conflict-row';

    const nameEl = document.createElement('div');
    nameEl.className   = 'conflict-attr-name';
    nameEl.textContent = n;
    row.appendChild(nameEl);

    for (const [idx, grp] of [[0, groupA], [1, groupB]]) {
      const label = document.createElement('label');
      label.className = 'conflict-option';

      const radio = document.createElement('input');
      radio.type    = 'radio';
      radio.name    = `mc-${n}`;
      radio.value   = String(idx);
      radio.checked = idx === 0;

      const valSpan  = document.createElement('span');
      valSpan.className   = 'conflict-value';
      valSpan.textContent = grp.attrs[n];

      const refsSpan = document.createElement('span');
      refsSpan.className   = 'conflict-refs';
      refsSpan.textContent = grp.refs.join(', ');

      label.append(radio, valSpan, refsSpan);
      row.appendChild(label);
    }

    list.appendChild(row);
  }

  modal.classList.remove('hidden');

  document.getElementById('merge-cancel').onclick = () => {
    modal.classList.add('hidden');
    markWarnings(currentGroups);
    const sorted = clusterSort(currentGroups);
    currentGroups.length = 0;
    currentGroups.push(...sorted);
    renderTable(currentGroups, currentAttrNames);
  };

  document.getElementById('merge-confirm').onclick = () => {
    const chosen = {};
    for (const n of conflictAttrs) {
      const checked = list.querySelector(`input[name="mc-${n}"]:checked`);
      if (checked) chosen[n] = checked.value === '0' ? groupA.attrs[n] : groupB.attrs[n];
    }
    modal.classList.add('hidden');
    onConfirm(chosen);
  };
}

// ── Warehouse import modal ────────────────────────────────────────────────────
function showImportModal() {
  const modal      = document.getElementById('import-modal');
  const keySelect  = document.getElementById('import-key-select');
  const noCommon   = document.getElementById('import-no-common');
  const fields     = document.getElementById('import-fields');
  const matchCount = document.getElementById('import-match-count');
  const confirmBtn = document.getElementById('import-confirm');

  const commonFields = _csvHeaders.filter(h => currentAttrNames.includes(h));

  if (commonFields.length === 0) {
    noCommon.classList.remove('hidden');
    fields.classList.add('hidden');
    confirmBtn.disabled = true;
  } else {
    noCommon.classList.add('hidden');
    fields.classList.remove('hidden');
    confirmBtn.disabled = false;

    keySelect.innerHTML = '';
    for (const f of commonFields) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = f;
      keySelect.appendChild(opt);
    }

    function updateCount() {
      const n = countWarehouseMatches(currentGroups, _csvRows, keySelect.value);
      matchCount.textContent = `${n} of ${currentGroups.length} groups matched`;
    }
    keySelect.onchange = updateCount;
    updateCount();
  }

  modal.classList.remove('hidden');

  document.getElementById('import-cancel').onclick = () => modal.classList.add('hidden');

  confirmBtn.onclick = () => {
    const keyField  = keySelect.value;
    const overwrite = document.getElementById('import-overwrite').checked;
    pushUndo();
    applyWarehouseData(currentGroups, _csvHeaders, _csvRows, keyField, overwrite);

    // Collect any new attr names introduced by the CSV columns
    const attrNameSet = new Set(currentAttrNames);
    for (const g of currentGroups) {
      for (const k of Object.keys(g.attrs)) attrNameSet.add(k);
    }
    currentAttrNames = Array.from(attrNameSet).sort();

    modal.classList.add('hidden');
    renderTable(currentGroups, currentAttrNames);
  };
}

// ── Variant picker modal ──────────────────────────────────────────────────────
function showVariantModal(base, hasModuleVariants) {
  const modal  = document.getElementById('variant-modal');
  const select = document.getElementById('variant-select');

  select.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value       = '';
  allOpt.textContent = 'All components';
  select.appendChild(allOpt);
  for (const v of currentVariantDefs) {
    const opt = document.createElement('option');
    opt.value       = v;
    opt.textContent = v;
    select.appendChild(opt);
  }

  const warning = modal.querySelector('.modal-warning');
  if (hasModuleVariants) {
    warning.textContent = '⚠ Module-level variants are not supported and will be ignored.';
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }

  modal.classList.remove('hidden');

  document.getElementById('modal-cancel').onclick = () => {
    modal.classList.add('hidden');
  };

  document.getElementById('modal-export').onclick = () => {
    const variantName = select.value || null;
    const filename    = variantName ? `${base}_${variantName}.xlsx` : `${base}_bom.xlsx`;
    modal.classList.add('hidden');
    exportXlsx(currentGroups, currentAttrNames, filename, variantName);
  };
}

function showBom(fileName, compCount, groupCount) {
  document.getElementById('drop-zone').classList.add('hidden');
  document.getElementById('bom-section').classList.remove('hidden');
  document.getElementById('file-name').textContent = fileName;
  document.getElementById('stats').textContent =
    `${compCount} component${compCount !== 1 ? 's' : ''} · ${groupCount} group${groupCount !== 1 ? 's' : ''}`;
  renderTable(currentGroups, currentAttrNames);
}
