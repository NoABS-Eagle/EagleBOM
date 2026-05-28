'use strict';

/**
 * Build BOM groups from a flat array of components.
 * Returns { groups, attrNames } where:
 *   groups    — array of group objects (mutable, used for editing)
 *   attrNames — sorted list of all unique attribute names found
 */
function buildBom(components) {
  // Collect all unique attribute names across all components
  const attrNameSet = new Set();
  for (const comp of components) {
    for (const key of Object.keys(comp.attrs)) {
      attrNameSet.add(key);
    }
  }
  const attrNames = Array.from(attrNameSet).sort();

  // Group components by the full attribute fingerprint
  const groupMap = new Map();
  for (const comp of components) {
    const key = buildGroupKey(comp, attrNames);
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        refs: [],
        // Display value: explicit value or fall back to deviceset name (e.g. "ADS1220")
        value: comp.value || comp.deviceset,
        package: comp.package,
        device: comp.device,
        library: comp.library,
        deviceset: comp.deviceset,
        technology: comp.technology,
        attrs: { ...comp.attrs },
        isWarning: false,
        refDnpVariants: {},  // ref → Set<variantName> where this ref is DNP
        refModuleMap:   {},  // ref → { moduleName, originalName }
        _dirty: new Set(),
      });
    }
    const group = groupMap.get(key);
    group.refs.push(comp.name);
    group.refDnpVariants[comp.name] = comp.dnpVariants;
    group.refModuleMap[comp.name]   = {
      moduleName:   comp.moduleName   ?? null,
      originalName: comp.originalName ?? comp.name,
      sheet:        comp.sheet        ?? 1,
    };
  }

  const groups = Array.from(groupMap.values());

  // Sort refs within each group using natural sort
  for (const g of groups) {
    g.refs.sort(naturalRefSort);
  }

  // Sort groups by first ref for stable table order
  groups.sort((a, b) => naturalRefSort(a.refs[0], b.refs[0]));

  markWarnings(groups);

  return { groups: clusterSort(groups), attrNames };
}

/**
 * (Re)compute isWarning and warningPeerKey on every group.
 * warningPeerKey is non-null only for groups that share value+package with another group.
 * Called after initial build and after any merge operation.
 */
function markWarnings(groups) {
  for (const g of groups) {
    g.isWarning      = false;
    g.warningPeerKey = null;
  }

  const vpMap = new Map();
  for (const g of groups) {
    const vpKey = `${g.value}\x00${g.package}`;
    if (!vpMap.has(vpKey)) vpMap.set(vpKey, []);
    vpMap.get(vpKey).push(g);
  }
  for (const [vpKey, list] of vpMap.entries()) {
    if (list.length > 1) {
      for (const g of list) {
        g.isWarning      = true;
        g.warningPeerKey = vpKey;
      }
    }
  }
}

/**
 * Re-sort so that warning clusters (same warningPeerKey) appear adjacent.
 * Each cluster is inserted at the position of its earliest first-ref.
 * Non-warning groups keep their natural sorted position.
 */
function clusterSort(groups) {
  const seen   = new Set();
  const result = [];

  for (const g of groups) {
    if (seen.has(g)) continue;
    seen.add(g);

    if (g.isWarning) {
      const peers = groups.filter(x => x.warningPeerKey === g.warningPeerKey && !seen.has(x));
      for (const p of peers) seen.add(p);
      const cluster = [g, ...peers];
      cluster.sort((a, b) => naturalRefSort(a.refs[0], b.refs[0]));
      result.push(...cluster);
    } else {
      result.push(g);
    }
  }

  return result;
}

// ── Group key ────────────────────────────────────────────────────────────────
// Includes library+deviceset+device+technology+value so that physically
// different parts with accidentally equal values never merge.
// Then appends all custom attribute values in stable (sorted-name) order.
function buildGroupKey(comp, attrNames) {
  const attrValues = attrNames.map(n => comp.attrs[n] ?? '').join('\x00');
  return [
    comp.library,
    comp.deviceset,
    comp.device,
    comp.technology,
    comp.value,
    attrValues,
  ].join('\x01');
}

// ── Natural sort for reference designators ───────────────────────────────────
// "C9" < "C10", "R1" < "R2", handles hierarchical "TM1:C1" too
function naturalRefSort(a, b) {
  const split = s => {
    const m = s.match(/^(.*?)(\d+)$/);
    return m ? [m[1], parseInt(m[2], 10)] : [s, 0];
  };
  const [pa, na] = split(a);
  const [pb, nb] = split(b);
  return pa !== pb ? pa.localeCompare(pb) : na - nb;
}
