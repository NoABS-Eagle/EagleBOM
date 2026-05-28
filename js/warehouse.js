'use strict';

function parseWarehouseCsv(text) {
  const delim = detectCsvDelimiter(text);
  const lines  = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');

  const headers = parseCsvLine(lines[0], delim);
  const rows    = lines.slice(1).map(l => {
    const vals = parseCsvLine(l, delim);
    const obj  = {};
    headers.forEach((h, i) => { if (h) obj[h] = vals[i] ?? ''; });
    return obj;
  });

  return { headers, rows };
}

function detectCsvDelimiter(text) {
  const first = text.split(/\r?\n/)[0];
  let best = ',', bestCount = 0;
  for (const d of [';', ',', '\t']) {
    const count = first.split(d).length - 1;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

function parseCsvLine(line, delim) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"')        inQuote = true;
      else if (ch === delim) { result.push(cur.trim()); cur = ''; }
      else                   cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

/**
 * Count how many BOM groups have a non-empty keyField value that appears in csvRows.
 */
function countWarehouseMatches(groups, csvRows, keyField) {
  const keySet = new Set(
    csvRows.map(r => (r[keyField] ?? '').toLowerCase().trim()).filter(Boolean)
  );
  return groups.filter(g => {
    const k = (g.attrs[keyField] ?? '').toLowerCase().trim();
    return k && keySet.has(k);
  }).length;
}

/**
 * Apply warehouse CSV data to BOM groups.
 * Returns the number of groups that were matched.
 * - keyField: column name used for matching (same name in both CSV and BOM attrs)
 * - overwrite: if false, skips BOM attrs that already have a non-empty value
 */
function applyWarehouseData(groups, csvHeaders, csvRows, keyField, overwrite) {
  const lookup = new Map();
  for (const row of csvRows) {
    const k = (row[keyField] ?? '').toLowerCase().trim();
    if (k && !lookup.has(k)) lookup.set(k, row);
  }

  const importCols = csvHeaders.filter(h => h !== keyField && h !== '');
  let matched = 0;

  for (const group of groups) {
    const keyVal = (group.attrs[keyField] ?? '').toLowerCase().trim();
    if (!keyVal) continue;
    const row = lookup.get(keyVal);
    if (!row) continue;

    matched++;
    for (const col of importCols) {
      const newVal = (row[col] ?? '').trim();
      if (!newVal) continue;
      if (!overwrite && group.attrs[col]) continue;
      group.attrs[col] = newVal;
      group._dirty.add(col);
    }
  }

  return matched;
}
