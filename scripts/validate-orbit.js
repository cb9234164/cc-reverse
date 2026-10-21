const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const {
  uuidUtils
} = require('../src/utils/uuidUtils');
const {
  output: root,
  creator
} = require('./orbit-options').loadOptions();
const assets = path.join(root, 'assets'),
  recovery = path.join(root, '_recovery');
const builtins = path.join(path.dirname(creator), 'resources/static/default-assets');
const walk = p => fs.readdirSync(p, {
  withFileTypes: true
}).flatMap(e => e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]);
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), {
    recursive: true
  });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};
const stable = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const builtin = new Map();
for (const p of walk(builtins).filter(x => x.endsWith('.meta'))) {
  const m = JSON.parse(fs.readFileSync(p));
  builtin.set(m.uuid, p);
  Object.entries(m.subMetas || {}).forEach(([k, v]) => builtin.set(v.uuid, p + '#' + k));
}
const all = walk(assets),
  uuids = new Map(builtin),
  duplicates = [],
  orphanMeta = [],
  syntaxErrors = [],
  missingImports = [],
  sourcesMismatch = [],
  missingRefs = new Map(),
  badIds = [],
  badDocuments = [],
  unknownTypes = new Map();
for (const p of all.filter(x => x.endsWith('.meta'))) {
  const m = JSON.parse(fs.readFileSync(p));
  if (!fs.existsSync(p.slice(0, -5))) orphanMeta.push(p);
  for (const [u, label] of [[m.uuid, p], ...Object.entries(m.subMetas || {}).map(([k, v]) => [v.uuid, p + '#' + k])]) {
    if (!u) continue;
    if (uuids.has(u)) duplicates.push({
      uuid: u,
      a: uuids.get(u),
      b: label
    });else uuids.set(u, label);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(recovery, 'manifest.json')));
for (const s of manifest.sourceFiles) {
  const p = path.join(root, s.path);
  const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (h !== s.sha256) sourcesMismatch.push(s.path);
}
for (const p of [...all.filter(x => /\.(js|ts)$/.test(x)), ...walk(path.join(recovery, 'js-modules')).filter(x => x.endsWith('.js'))]) {
  try {
    const ast = parser.parse(fs.readFileSync(p, 'utf8'), {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'decorators-legacy', 'classProperties', 'dynamicImport']
    });
    const checkImport = spec => {
      if (!spec.startsWith('.')) return;
      const target = path.resolve(path.dirname(p), spec);
      if (![target, target + '.ts', target + '.js', path.join(target, 'index.ts'), path.join(target, 'index.js')].some(x => fs.existsSync(x) && fs.statSync(x).isFile())) missingImports.push({
        file: p,
        import: spec
      });
    };
    if (p.startsWith(assets + path.sep)) traverse(ast, {
      ImportDeclaration(t) {
        checkImport(t.node.source.value);
      },
      CallExpression(t) {
        if (t.node.callee.type === 'Identifier' && t.node.callee.name === 'require'
          && t.node.arguments[0]?.type === 'StringLiteral') checkImport(t.node.arguments[0].value);
      }
    });
  } catch (e) {
    syntaxErrors.push({
      file: p,
      message: e.message
    });
  }
}
const scriptUuids = new Set(all.filter(p => /\.(ts|js)\.meta$/.test(p)).map(p => JSON.parse(fs.readFileSync(p)).uuid));
for (const p of all.filter(p => /\.(fire|prefab|anim|mtl)$/.test(p))) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(p));
  } catch (e) {
    badDocuments.push({
      file: p,
      error: e.message
    });
    continue;
  }
  if (!Array.isArray(d) || !d[0]?.__type__) badDocuments.push({
    file: p,
    error: 'Not editor object-array format'
  });
  const visit = x => {
    if (!x || typeof x !== 'object') return;
    if (typeof x.__id__ === 'number' && (x.__id__ < 0 || x.__id__ >= d.length)) badIds.push({
      file: p,
      id: x.__id__,
      length: d.length
    });
    if (x.__uuid__ && !uuids.has(x.__uuid__)) {
      const list = missingRefs.get(x.__uuid__) || [];
      if (list.length < 5) list.push(p);
      missingRefs.set(x.__uuid__, list);
    }
    if (x.__type__ && !x.__type__.includes('.') && !['TypedArray'].includes(x.__type__)) {
      const u = uuidUtils.decodeUuid(x.__type__);
      if (!scriptUuids.has(u)) {
        const list = unknownTypes.get(x.__type__) || [];
        if (list.length < 5) list.push(p);
        unknownTypes.set(x.__type__, list);
      }
    }
    Object.values(x).forEach(visit);
  };
  visit(d);
}
const imageValidation = JSON.parse(fs.readFileSync(path.join(recovery, 'image-validation.json')));
const result = {
  sources: manifest.sourceFiles.length,
  compiledModules: manifest.compiledModules.length,
  assetFiles: all.filter(x => !x.endsWith('.meta')).length,
  scenes: all.filter(x => x.endsWith('.fire')).length,
  prefabs: all.filter(x => x.endsWith('.prefab')).length,
  animations: all.filter(x => x.endsWith('.anim')).length,
  metaUuids: uuids.size,
  sourcesMismatch,
  duplicates,
  orphanMeta,
  syntaxErrors,
  missingImports,
  badIds,
  badDocuments,
  missingRefs: Array.from(missingRefs, ([uuid, files]) => ({
    uuid,
    files
  })),
  unknownTypes: Array.from(unknownTypes, ([type, files]) => ({
    type,
    files
  })),
  imageErrors: imageValidation.errors
};
write(path.join(recovery, 'VALIDATION.json'), result);
console.log(JSON.stringify({
  ...result,
  missingRefs: result.missingRefs.slice(0, 12),
  unknownTypes: result.unknownTypes.slice(0, 12)
}, null, 2));
if ([sourcesMismatch, duplicates, orphanMeta, syntaxErrors, missingImports, badIds, badDocuments, result.missingRefs, result.unknownTypes, result.imageErrors].some(items => items.length)) process.exitCode = 1;
