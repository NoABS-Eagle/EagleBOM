'use strict';

/**
 * Parse an Eagle .sch XML string and return { components, variantDefs }.
 * Components without a package (supply symbols, frames, etc.) are excluded.
 * Hierarchical module instances are expanded to their resolved reference designators.
 *
 * Attribute resolution order (each level overrides the previous):
 *   1. Library technology[""] defaults  (field templates, often empty)
 *   2. Library technology[partTechnology] defaults  (e.g. "-1%", "-5", "332")
 *   3. Part instance <attribute> children  (user-edited values)
 *
 * Each component also carries dnpVariants: Set<string> — variant names where
 * <variant populate="no"/> is declared on the part.
 */
function parseSchematic(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('XML parse error: ' + parseError.textContent.slice(0, 300));
  }

  const libMap = buildLibraryMap(doc);
  const components = [];

  const schematicEl = doc.querySelector('schematic');
  if (!schematicEl) throw new Error('No <schematic> element found');

  // ── Variant definitions ──────────────────────────────────────────────────
  const variantDefs = [];
  const variantDefsEl = findChild(schematicEl, 'variantdefs');
  if (variantDefsEl) {
    for (const vd of variantDefsEl.children) {
      if (vd.tagName !== 'variantdef') continue;
      const vname = vd.getAttribute('name');
      if (vname) variantDefs.push(vname);
    }
  }

  // ── Top-level parts ──────────────────────────────────────────────────────
  const topSheetMap = buildPartSheetMap(schematicEl);
  const topPartsEl  = findChild(schematicEl, 'parts');
  if (topPartsEl) {
    for (const partEl of topPartsEl.children) {
      if (partEl.tagName !== 'part') continue;
      const comp = parsePart(partEl, libMap);
      if (comp) {
        comp.sheet = topSheetMap[comp.name] ?? 1;
        components.push(comp);
      }
    }
  }

  // ── Hierarchical modules ─────────────────────────────────────────────────
  let hasModuleVariants = false;
  const modulesEl = findChild(schematicEl, 'modules');
  if (modulesEl) {
    const moduleMap = {};
    for (const modEl of modulesEl.children) {
      if (modEl.tagName !== 'module') continue;
      const modName      = modEl.getAttribute('name');
      const modSheetMap  = buildPartSheetMap(modEl);
      const modParts     = [];
      const modPartsEl   = findChild(modEl, 'parts');
      if (modPartsEl) {
        for (const partEl of modPartsEl.children) {
          if (partEl.tagName !== 'part') continue;
          const comp = parsePart(partEl, libMap);
          if (comp) {
            comp.sheet = modSheetMap[comp.name] ?? 1;
            if (comp.dnpVariants.size > 0) hasModuleVariants = true;
            modParts.push(comp);
          }
        }
      }
      moduleMap[modName] = modParts;
    }

    for (const instEl of doc.querySelectorAll('moduleinst')) {
      const instName  = instEl.getAttribute('name');
      const modName   = instEl.getAttribute('module');
      const offsetStr = instEl.getAttribute('offset');
      const offset    = offsetStr ? parseInt(offsetStr, 10) : null;

      const modParts = moduleMap[modName] || [];
      for (const comp of modParts) {
        const resolvedName = (offset !== null)
          ? resolveOffset(comp.name, offset)
          : `${instName}:${comp.name}`;
        components.push({
          ...comp,
          name:         resolvedName,
          moduleName:   modName,    // module type name, e.g. "MMM"
          originalName: comp.name,  // original name inside module, e.g. "R1"
        });
      }
    }
  }

  return { components, variantDefs, hasModuleVariants };
}

// ── Library map ───────────────────────────────────────────────────────────────
// Builds: libName → dsName → devName → { package, techAttrs }
// techAttrs: techName → { attrName → defaultValue }
//
// Eagle stores attribute defaults in <technology> sections inside each device.
// Parts that haven't been individually edited inherit these library defaults.
function buildLibraryMap(doc) {
  const map = {};
  const schematicEl = doc.querySelector('schematic');
  if (!schematicEl) return map;

  const librariesEl = findChild(schematicEl, 'libraries');
  if (!librariesEl) return map;

  for (const libEl of librariesEl.children) {
    if (libEl.tagName !== 'library') continue;
    const libName = libEl.getAttribute('name');
    map[libName] = {};

    const devSetsEl = libEl.querySelector('devicesets');
    if (!devSetsEl) continue;

    for (const dsEl of devSetsEl.children) {
      if (dsEl.tagName !== 'deviceset') continue;
      const dsName = dsEl.getAttribute('name');
      map[libName][dsName] = {};

      const devsEl = findChild(dsEl, 'devices');
      if (!devsEl) continue;

      for (const devEl of devsEl.children) {
        if (devEl.tagName !== 'device') continue;
        const devName = devEl.getAttribute('name') ?? '';
        const pkg     = devEl.getAttribute('package') ?? '';

        // Collect per-technology attribute defaults
        const techAttrs = {};
        const techsEl = findChild(devEl, 'technologies');
        if (techsEl) {
          for (const techEl of techsEl.children) {
            if (techEl.tagName !== 'technology') continue;
            const techName = techEl.getAttribute('name') ?? '';
            const attrs = {};
            for (const attrEl of techEl.children) {
              if (attrEl.tagName !== 'attribute') continue;
              const n = attrEl.getAttribute('name');
              if (n) attrs[n] = attrEl.getAttribute('value') ?? '';
            }
            techAttrs[techName] = attrs;
          }
        }

        map[libName][dsName][devName] = { package: pkg, techAttrs };
      }
    }
  }
  return map;
}

// ── Parse a single <part> element ────────────────────────────────────────────
function parsePart(partEl, libMap) {
  const name       = partEl.getAttribute('name');
  const library    = partEl.getAttribute('library')    ?? '';
  const deviceset  = partEl.getAttribute('deviceset')  ?? '';
  const device     = partEl.getAttribute('device')     ?? '';
  const technology = partEl.getAttribute('technology') ?? '';
  const value      = (partEl.getAttribute('value') ?? '').trim();

  const devData = libMap[library]?.[deviceset]?.[device];

  // Exclude: library/device not found, or package is empty (supply symbols, frames, etc.)
  if (!devData || !devData.package) return null;

  // ── Attribute resolution (three layers) ────────────────────────────────────
  // Layer 1: "" technology — acts as field template (e.g. PACKAGE, AEC-Q, OPERATING_TEMP)
  const baseAttrs     = devData.techAttrs[''] ?? {};
  // Layer 2: specific technology — adds/overrides for this variant (e.g. "-1%", "-5", "332")
  const specificAttrs = technology ? (devData.techAttrs[technology] ?? {}) : {};
  // Layer 3: instance <attribute> children — user-edited values
  const instanceAttrs = {};
  const dnpVariants   = new Set();
  for (const child of partEl.children) {
    if (child.tagName === 'attribute') {
      const n = child.getAttribute('name');
      if (n) instanceAttrs[n] = child.getAttribute('value') ?? '';
    } else if (child.tagName === 'variant') {
      if ((child.getAttribute('populate') ?? '').toLowerCase() === 'no') {
        const vname = child.getAttribute('name');
        if (vname) dnpVariants.add(vname);
      }
    }
  }

  const attrs = { ...baseAttrs, ...specificAttrs, ...instanceAttrs };

  return { name, library, deviceset, device, technology, value, package: devData.package, attrs, dnpVariants };
}

// ── Resolve offset-based reference designator ─────────────────────────────────
// Eagle: <part name="C1"> in module with offset=100 → "C101"
function resolveOffset(name, offset) {
  const m = name.match(/^([A-Za-z_$][A-Za-z_$]*)(\d+)$/);
  if (!m) return name;
  return m[1] + (parseInt(m[2], 10) + offset);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function findChild(parent, tagName) {
  if (!parent) return null;
  for (const child of parent.children) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

// Build { partName → 1-based sheet index } from the <sheets> of any schematic/module element.
function buildPartSheetMap(parentEl) {
  const map = {};
  const sheetsEl = findChild(parentEl, 'sheets');
  if (!sheetsEl) return map;
  let idx = 1;
  for (const sheetEl of sheetsEl.children) {
    if (sheetEl.tagName !== 'sheet') continue;
    const instancesEl = findChild(sheetEl, 'instances');
    if (instancesEl) {
      for (const instEl of instancesEl.children) {
        if (instEl.tagName !== 'instance') continue;
        const part = instEl.getAttribute('part');
        if (part) map[part] = idx;
      }
    }
    idx++;
  }
  return map;
}
