'use strict';

/**
 * Generate an Eagle .scr script that sets all non-empty custom attributes
 * for every component in the BOM.
 *
 * Eagle command syntax: ATTRIBUTE refdes attrname 'value';
 *
 * The script is a full-state snapshot — running it multiple times is idempotent.
 * Empty attribute values are skipped (no command generated).
 */
function generateScr(groups, attrNames) {
  // top-level:  sheet → Map< "ref\x00attr", line >
  const topBySheet = new Map();
  // modules:    modName → Map< sheet, Map< "origName\x00attr", line > >
  const modBySheet = new Map();

  for (const group of groups) {
    for (const ref of group.refs) {
      const entry        = group.refModuleMap?.[ref];
      const moduleName   = entry?.moduleName   ?? null;
      const originalName = entry?.originalName ?? ref;
      const sheet        = entry?.sheet        ?? 1;

      for (const attrName of attrNames) {
        const val = group.attrs[attrName] ?? '';
        if (!val) continue;
        const escaped = val.replace(/'/g, "\\'");
        const line    = `ATTRIBUTE ${originalName} '${attrName}' '${escaped}';`;
        const key     = `${originalName}\x00${attrName}`;

        if (moduleName) {
          if (!modBySheet.has(moduleName)) modBySheet.set(moduleName, new Map());
          const bySheet = modBySheet.get(moduleName);
          if (!bySheet.has(sheet)) bySheet.set(sheet, new Map());
          if (!bySheet.get(sheet).has(key)) bySheet.get(sheet).set(key, line);
        } else {
          if (!topBySheet.has(sheet)) topBySheet.set(sheet, new Map());
          topBySheet.get(sheet).set(key, line);
        }
      }
    }
  }

  const out = [];

  // Top-level sections sorted by sheet number
  for (const [sheet, lineMap] of [...topBySheet.entries()].sort((a, b) => a[0] - b[0])) {
    if (out.length) out.push('');
    out.push(`EDIT .s${sheet};`);
    out.push(...lineMap.values());
  }

  // Module sections — each sheet accessed as "modname.mN"
  for (const [modName, bySheet] of modBySheet.entries()) {
    for (const [sheet, lineMap] of [...bySheet.entries()].sort((a, b) => a[0] - b[0])) {
      if (out.length) out.push('');
      out.push(`EDIT ${modName}.m${sheet};`);
      out.push(...lineMap.values());
      out.push('EDIT .sch;');
    }
  }

  return out.join('\n') + (out.length ? '\n' : '');
}

/**
 * Trigger a browser download of a text string.
 */
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export BOM as .xlsx using SheetJS (must be loaded before this is called).
 * Columns: Refs | Qty | Value | Package | [attrNames...]
 *
 * When variantName is provided, refs that are DNP in that variant are excluded.
 * Groups with no remaining refs after filtering are omitted entirely.
 */
function exportXlsx(groups, attrNames, filename, variantName) {
  const headers = ['Refs', 'Qty', 'Value', 'Package', ...attrNames];

  const rows = [];
  for (const g of groups) {
    const refs = variantName
      ? g.refs.filter(r => !(g.refDnpVariants[r] && g.refDnpVariants[r].has(variantName)))
      : g.refs;
    if (refs.length === 0) continue;
    rows.push([
      refs.join(', '),
      refs.length,
      g.value,
      g.package,
      ...attrNames.map(n => g.attrs[n] ?? ''),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

  // Auto-width: use the maximum character count per column
  const colWidths = headers.map((h, i) => {
    const maxLen = rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), h.length);
    return { wch: Math.min(maxLen + 2, 60) };
  });
  ws['!cols'] = colWidths;

  // Freeze header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BOM');
  XLSX.writeFile(wb, filename);
}
