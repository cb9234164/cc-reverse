const path = require('path');

// Only accept project asset paths. Never guess a disk path from a class name.
function assetPath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^db:\/\//, '').replace(/^\.\//, '');
  const match = normalized.match(/(?:^|\/)assets\/[^\r\n"'<>]+?\.(?:ts|js)$/);
  if (!match || /(?:^|\/)\.\.(?:\/|$)/.test(match[0]) || /[:\0]/.test(match[0])) return null;
  return match[0].replace(/^\//, '');
}

function entriesFromMapping(mapping) {
  if (!mapping) return [];
  // A previous _recovery/manifest.json is also a reusable path map.
  if (Array.isArray(mapping.compiledModules)) {
    return mapping.compiledModules.filter(item => item.sourcePath && !item.sourcePath.startsWith('assets/RecoveredScripts/'))
      .map(item => ({ bundle: item.bundle, id: item.id, uuid: item.uuid, path: item.sourcePath }));
  }
  if (Array.isArray(mapping)) return mapping;
  return Object.entries(mapping).map(([id, file]) => ({ id, path: file }));
}

function planScriptPaths(records, { output, mapping, warnings = [] } = {}) {
  const entries = entriesFromMapping(mapping);
  const candidate = new Map(records.map(record => [record, new Map()]));
  const add = (record, file, reason) => {
    const relative = assetPath(file)?.replace(/\.(ts|js)$/, '.js');
    if (!relative) return false;
    const choices = candidate.get(record);
    if (choices.has(relative)) return false;
    choices.set(relative, reason);
    return true;
  };
  const original = record => record.sourcePath && path.relative(output, record.sourcePath).split(path.sep).join('/');
  for (const record of records) {
    if (record.sourcePath) add(record, original(record), 'source-map-content');
    for (const entry of entries) {
      if (record.sourcePath || record.originalPath) continue;
      if (entry.bundle && entry.bundle !== record.bundle) continue;
      if (entry.uuid && record.uuid ? entry.uuid !== record.uuid : String(entry.id) !== String(record.id)) continue;
      if (!assetPath(entry.path)) throw new Error('Invalid script mapping path: ' + entry.path);
      add(record, entry.path, 'path-map');
    }
    for (const value of [record.originalPath, record.id, record.rawKey]) {
      const file = assetPath(value) || (typeof value === 'string' ? assetPath(value + '.js') : null);
      if (file) add(record, file, 'bundle-path');
    }
    // Debug builds may retain sourceURL directives or Creator's original-path comments.
    for (const match of record.source.matchAll(/(?:sourceURL\s*=\s*|^\s*\/\/\s*)([^\r\n]+)/gm)) {
      if (assetPath(match[1].trim())) add(record, match[1].trim(), 'bundle-comment');
    }
  }

  const targetsFor = (record, spec) => {
    const id = record.deps?.[spec] ?? spec;
    const matches = records.filter(other => String(other.id) === String(id));
    const local = matches.filter(other => other.bundle === record.bundle);
    return local.length === 1 ? local : matches.length === 1 ? matches : [];
  };
  // Directory relationships are recoverable only when at least one path is known.
  // Propagate forward from known paths and backward for same-directory imports.
  for (let pass = 0; pass < records.length; pass++) {
    let changed = false;
    for (const record of records) {
      for (const spec of Object.keys(record.deps || {})) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        if (/\.(?!ts$|js$)[^/]+$/.test(spec)) continue;
        const targets = targetsFor(record, spec);
        if (targets.length !== 1) continue;
        const target = targets[0];
        const from = candidate.get(record), to = candidate.get(target);
        const requested = spec.replace(/\.(?:ts|js)$/, '');
        if (from.size === 1 && (to.size === 0 || [...to.values()].every(reason => reason === 'relative-dependency'))) {
          const base = path.posix.resolve('/', path.posix.dirname([...from.keys()][0]), requested).slice(1);
          changed = add(target, base + '.js', 'relative-dependency') || changed;
        } else if (to.size === 1 && from.size === 0) {
          // Reverse only ./Name or ../Name; named directory segments cannot be inverted safely.
          const directories = path.posix.dirname(requested).split('/');
          if (!directories.every(part => part === '.' || part === '..')) continue;
          const back = directories.filter(part => part === '..').length;
          if (back) continue; // Parent traversal loses the original child-directory name.
          const name = path.posix.basename(String(record.id)).replace(/\.(ts|js)$/, '');
          if (!/^[\w$.-]+$/.test(name)) continue;
          changed = add(record, path.posix.join(path.posix.dirname([...to.keys()][0]), name + '.js'), 'relative-dependency') || changed;
        }
      }
    }
    if (!changed) break;
  }

  const occupied = new Map();
  for (const record of records) {
    const choices = candidate.get(record);
    let relative, reason;
    if (record.sourcePath) {
      relative = original(record); reason = 'source-map-content';
    } else if (choices.size === 1) {
      [relative, reason] = [...choices.entries()][0];
      relative = relative.replace(/\.(ts|js)$/, '.js');
    } else {
      if (choices.size > 1) warnings.push(`Ambiguous script path: ${record.bundle}/${record.id}: ${[...choices.keys()].join(', ')}`);
      const safeName = String(record.id).split(/[\\/]/).pop().replace(/\.(ts|js)$/, '').replace(/[^\w$.-]/g, '_');
      const safeBundle = String(record.bundle).replace(/[^\w$.-]/g, '_').replace(/^\.+$/, '_');
      relative = `assets/RecoveredScripts/${safeBundle}/${safeName || 'module'}.js`;
      reason = 'fallback';
      warnings.push(`Original script path unavailable: ${record.bundle}/${record.id}; emitted ${relative}`);
    }
    const key = relative.replace(/\.(ts|js)$/, '').toLowerCase();
    if (occupied.has(key)) throw new Error(`Script path collision: ${relative} (${record.id}, ${occupied.get(key)})`);
    occupied.set(key, record.id);
    record.plannedPath = path.resolve(output, relative);
    record.pathReason = reason;
  }
}

module.exports = { assetPath, planScriptPaths };
