/* Project-specific Creator 2.4.11 recovery; reads build artifacts only. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { assetPath, planScriptPaths } = require('./orbit-script-paths');
const {
  parseBundleConfig,
  getImportPath,
  findBundleConfigPath,
  findBundleScriptPath
} = require('../src/core/cocos3x/bundleConfig');
const {
  rehydrateIFileData
} = require('../src/core/cocos3x/rehydrate');
const {
  extractModulesOnly
} = require('../src/core/script');
const {
  uuidUtils
} = require('../src/utils/uuidUtils');
const {
  source,
  output,
  scriptPaths
} = require('./orbit-options').loadOptions();
const recovery = path.join(output, '_recovery');
const assetRoot = path.join(output, 'assets');
const write = (p, data) => {
  fs.mkdirSync(path.dirname(p), {
    recursive: true
  });
  fs.writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
};
const copy = (src, dst) => {
  fs.mkdirSync(path.dirname(dst), {
    recursive: true
  });
  fs.copyFileSync(src, dst);
};
const walk = p => fs.existsSync(p) ? fs.readdirSync(p, {
  withFileTypes: true
}).flatMap(e => e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]) : [];
const decode = u => uuidUtils.decodeUuid(u);
const stableUuid = key => {
  let h = crypto.createHash('sha256').update('orbit-recovery:' + key).digest('hex').slice(0, 32);
  h = h.slice(0, 12) + '4' + h.slice(13, 16) + 'a' + h.slice(17);
  return h.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
};
const safe = (base, rel) => {
  const p = path.resolve(base, rel.replace(/^db:\/\/assets\//, '').replace(/\\/g, '/'));
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new Error('Path escape: ' + rel);
  return p;
};
const meta = (p, uuid, extra = {}) => write(p + '.meta', {
  ver: '1.0.0',
  uuid,
  ...extra,
  subMetas: extra.subMetas || {}
});
const summary = {
  source,
  output,
  engine: '2.4.11',
  bundles: [],
  sourceFiles: [],
  compiledModules: [],
  assets: {},
  warnings: []
};

// Archive the unmodified upstream output, retaining a reproducible baseline.
const archived = path.join(recovery, 'cc-reverse-output', 'assets');
if (!fs.existsSync(archived)) {
  fs.mkdirSync(path.dirname(archived), {
    recursive: true
  });
  fs.renameSync(assetRoot, archived);
  copy(path.join(output, 'RECOVERY_REPORT.md'), path.join(recovery, 'CC_REVERSE_REPORT.md'));
}
fs.mkdirSync(assetRoot, {
  recursive: true
});
const bundles = [];
const records = [];
const assets = new Map();
const natives = new Map();
for (const e of fs.readdirSync(path.join(source, 'assets'), {
  withFileTypes: true
})) {
  if (!e.isDirectory()) continue;
  const dir = path.join(source, 'assets', e.name),
    cf = findBundleConfigPath(dir);
  if (!cf) continue;
  const cfg = parseBundleConfig(JSON.parse(fs.readFileSync(cf, 'utf8')), dir);
  cfg.raw = JSON.parse(fs.readFileSync(cf, 'utf8'));
  bundles.push(cfg);
  const ownNatives = new Map();
  for (const p of walk(path.join(dir, cfg.nativeBase))) {
    const rel = path.relative(path.join(dir, cfg.nativeBase), p).split(path.sep);
    const key = rel[1]?.replace(/\.[^.]+(?:\.[^.]+)?$/, ''); // full uuid/hash before version and extension
    const match = rel[1]?.match(/^([a-f0-9-]{8,36})(?:\.[^.]+)?(?:\.[^.]+)?$/i);
    const id = match?.[1] || key;
    if (id) {
      if (!ownNatives.has(id)) ownNatives.set(id, []);
      ownNatives.get(id).push(p);
      if (!natives.has(id)) natives.set(id, []);
      natives.get(id).push(p);
    }
  }
  cfg.natives = ownNatives;
  cfg.packIndex = new Map();
  cfg.packCache = new Map();
  for (const [p, ids] of Object.entries(cfg.packs)) ids.forEach((u, i) => cfg.packIndex.set(u, [p, i]));
  function getDoc(u) {
    const direct = getImportPath(cfg, u);
    let d;
    if (fs.existsSync(direct)) d = JSON.parse(fs.readFileSync(direct, 'utf8'));else if (cfg.packIndex.has(u)) {
      const [pk, i] = cfg.packIndex.get(u);
      if (!cfg.packCache.has(pk)) {
        const p = getImportPath(cfg, pk);
        cfg.packCache.set(pk, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
      }
      const packed = cfg.packCache.get(pk);
      if (Array.isArray(packed) && packed.length === 6 && typeof packed[0] === 'number' && packed[5]?.[i]) d = [...packed.slice(0, 5), ...packed[5][i]];else if (packed?.type === 'cc.Texture2D') return [{
        __type__: 'cc.Texture2D',
        content: packed.data.split('|')[i]
      }];
    }
    if (!d) return null;
    let decoded = rehydrateIFileData(d) || d;
    if (Array.isArray(decoded) && typeof d?.[0] === 'number' && d.length >= 11) {
      const tail = d[5][d[5].length - 1];
      const root = typeof tail === 'number' ? tail < 0 ? ~tail : tail : 0;
      if (root > 0) {
        const order = [root, ...decoded.map((_, i) => i).filter(i => i !== root)];
        const mapping = new Map(order.map((v, i) => [v, i]));
        const reindex = x => {
          if (!x || typeof x !== 'object') return;
          if (typeof x.__id__ === 'number') x.__id__ = mapping.get(x.__id__) ?? x.__id__;else Object.values(x).forEach(reindex);
        };
        decoded = order.map(i => decoded[i]);
        decoded.forEach(reindex);
      }
    }
    return decoded;
  }
  for (const u of cfg.uuids) {
    if (cfg.redirect[u]) continue;
    const doc = getDoc(u);
    const scene = Object.entries(cfg.scenes).find(([, v]) => v === u)?.[0];
    const info = cfg.paths[u] || {};
    const root = Array.isArray(doc) ? doc[0] : doc;
    const type = info.type || root?.__type__ || 'unknown';
    const rel = scene ? scene.replace(/^db:\/\/assets\//, '').replace(/\.fire$/, '') : info.path || `_packed/${u.slice(0, 2)}/${u}`;
    const base = scene ? safe(assetRoot, rel) : safe(assetRoot, cfg.name + '/' + rel);
    const a = {
      uuid: u,
      bundle: cfg.name,
      type,
      rel,
      base,
      doc,
      root,
      native: ownNatives.get(u) || [],
      scene: !!scene
    };
    if (assets.has(u)) {
      summary.warnings.push('Repeated asset UUID ' + u + ' in ' + cfg.name);
      continue;
    }
    assets.set(u, a);
  }
  const js = findBundleScriptPath(dir, 'index');
  if (js) {
    const text = fs.readFileSync(js, 'utf8');
    copy(js, path.join(recovery, 'original-js', 'assets', cfg.name, path.basename(js)));
    const extracted = extractModulesOnly(text).records;
    for (const r of extracted) {
      r.bundle = cfg.name;
      const rf = r.source.match(/cc\s*\.\s*_RF\s*\.\s*push\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)/);
      r.uuid = rf ? decode(rf[1]) : null;
      r.className = rf?.[2] || r.id;
      records.push(r);
    }
    // Handle both hashed bundle names and sourceMappingURL references.
    const mapReference = [...text.matchAll(/\/\/[#@]\s*sourceMappingURL\s*=\s*([^\s]+)/g)].pop()?.[1];
    const mapCandidates = [js + '.map', path.join(dir, 'index.js.map')];
    if (mapReference && !/^[a-z]+:/i.test(mapReference)) {
      const referenced = path.resolve(dir, mapReference);
      const rel = path.relative(source, referenced);
      if (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)) mapCandidates.unshift(referenced);
    }
    const mp = mapCandidates.find(file => fs.existsSync(file));
    if (mp) {
      copy(mp, path.join(recovery, 'original-js', 'assets', cfg.name, path.basename(mp)));
      const sm = JSON.parse(fs.readFileSync(mp, 'utf8'));
      for (let i = 0; i < sm.sources.length; i++) {
        const rel = assetPath(sm.sources[i]) || assetPath((sm.sourceRoot || '') + '/' + sm.sources[i]);
        if (!rel) {
          summary.warnings.push('Source map path outside assets, skipped: ' + sm.sources[i]);
          continue;
        }
        const dest = safe(output, rel);
        if (!dest.startsWith(assetRoot + path.sep)) throw new Error('Nonasset source ' + rel);
        const name = path.basename(rel).replace(/\.(ts|js)$/, '').toLowerCase();
        const matches = extracted.filter(r => path.basename(r.id).replace(/\.(ts|js)$/, '').toLowerCase() === name || r.className?.toLowerCase() === name);
        const r = matches.length === 1 ? records.find(x => x.bundle === cfg.name && x.id === matches[0].id) : null;
        if (r) r.originalPath = rel;
        if (typeof sm.sourcesContent?.[i] !== 'string') continue;
        const uuid = r?.uuid || stableUuid(rel);
        if (!r) summary.warnings.push('No compiled UUID match: ' + rel);else r.sourcePath = dest;
        write(dest, sm.sourcesContent[i]);
        meta(dest, uuid, {
          ver: '1.0.5',
          isPlugin: false,
          loadPluginInWeb: true,
          loadPluginInNative: true,
          loadPluginInEditor: false
        });
        summary.sourceFiles.push({
          path: rel,
          uuid,
          bundle: cfg.name,
          sha256: crypto.createHash('sha256').update(sm.sourcesContent[i]).digest('hex')
        });
      }
    }
  }
  summary.bundles.push({
    name: cfg.name,
    uuids: cfg.uuids.length,
    scenes: cfg.scenes
  });
}
console.log('Indexed', bundles.length, 'bundles,', assets.size, 'assets,', summary.sourceFiles.length, 'original sources');

// Restore module factory bindings using Babel scopes; preserve all compiled JS.
// Paths only, captured during the earlier source-map recovery of this project.
// UUID and bundle matching prevents applying these paths to unrelated scripts.
const mappingFile = scriptPaths ? path.resolve(scriptPaths) : path.join(__dirname, 'orbit-default-script-paths.json');
const mapping = fs.existsSync(mappingFile) ? JSON.parse(fs.readFileSync(mappingFile, 'utf8')) : null;
if (scriptPaths && !mapping) throw new Error('Script path mapping not found: ' + mappingFile);
planScriptPaths(records, { output, mapping, warnings: summary.warnings });
const targetFor = (record, spec) => {
  const id = String(record.deps?.[spec] ?? spec);
  const matches = records.filter(other => String(other.id) === id);
  const local = matches.filter(other => other.bundle === record.bundle);
  return local.length === 1 ? local[0] : matches.length === 1 ? matches[0] : null;
};
for (const r of records) {
  const scriptFile = r.plannedPath;
  const moduleName = String(r.id).replace(/[^\w$.-]/g, '_');
  const dest = safe(recovery, 'js-modules/' + r.bundle + '/' + moduleName + '.js');
  const params = [r.requireName || 'require', r.moduleName || 'module', r.exportsName || 'exports'];
  const ast = parser.parse(`function __recovered_factory__(${params.join(',')}){\n${r.source}\n}`, {
    sourceType: 'script'
  });
  const fn = ast.program.body[0];
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node !== fn) return;
      for (let i = 0; i < 3; i++) {
        const name = ['require', 'module', 'exports'][i];
        if (params[i] !== name) p.scope.rename(params[i], name);
      }
    }
  });
  traverse(ast, {
    CallExpression(p) {
      if (p.node.callee.type !== 'Identifier' || p.node.callee.name !== 'require' || p.node.arguments[0]?.type !== 'StringLiteral') return;
      const spec = p.node.arguments[0].value;
      const target = targetFor(r, spec);
      if (!target) return;
      const from = scriptFile;
      const to = target.plannedPath;
      let rel = path.relative(path.dirname(from), to).replace(/\\/g, '/').replace(/\.(ts|js)$/, '');
      if (!rel.startsWith('.')) rel = './' + rel;
      p.node.arguments[0].value = rel;
    }
  });
  const body = generate({
    type: 'File',
    program: {
      type: 'Program',
      sourceType: 'script',
      body: fn.body.body,
      directives: fn.body.directives
    }
  }, {
    comments: true,
    compact: false
  }).code + '\n';
  write(dest, body);
  const recoveredFrom = r.sourcePath ? 'source-map-content' : 'compiled-js';
  if (!r.sourcePath) {
    if (fs.existsSync(scriptFile) || fs.existsSync(scriptFile.replace(/\.js$/, '.ts'))) {
      throw new Error('Refusing to overwrite an existing script: ' + scriptFile);
    }
    write(scriptFile, body);
    r.uuid = r.uuid || stableUuid('script:' + r.bundle + ':' + r.id);
    meta(scriptFile, r.uuid, {
      ver: '1.0.5',
      isPlugin: false,
      loadPluginInWeb: true,
      loadPluginInNative: true,
      loadPluginInEditor: false
    });
    r.sourcePath = scriptFile;
  }
  summary.compiledModules.push({
    id: r.id,
    bundle: r.bundle,
    uuid: r.uuid,
    recoveredFrom,
    pathReason: r.pathReason,
    path: path.relative(output, dest).replace(/\\/g, '/'),
    sourcePath: r.sourcePath && path.relative(output, r.sourcePath).replace(/\\/g, '/')
  });
}
write(path.join(recovery, 'script-paths.json'), summary.compiledModules
  .filter(module => module.pathReason !== 'fallback')
  .map(module => ({ bundle: module.bundle, id: module.id, uuid: module.uuid, path: module.sourcePath })));
for (const p of walk(source).filter(p => /\.js(?:\.map)?$/.test(p) && !p.includes(path.sep + 'assets' + path.sep))) {
  copy(p, path.join(recovery, 'original-js', path.relative(source, p)));
}
// Runtime-loaded plugin scripts listed by the original build settings.
const settingsName = fs.readdirSync(path.join(source, 'src')).find(n => /^settings.*\.js$/.test(n));
const sandbox = {
  window: {}
};
vm.runInNewContext(fs.readFileSync(path.join(source, 'src', settingsName), 'utf8'), sandbox, {
  timeout: 2000
});
const settings = sandbox.window._CCSettings;
for (const rel of settings.jsList || []) {
  const src = path.join(source, 'src', rel);
  if (!fs.existsSync(src)) {
    summary.warnings.push('Missing jsList ' + rel);
    continue;
  }
  const dest = path.join(assetRoot, 'plugins', path.basename(rel).replace(/\.[a-f0-9]{5}(?=\.js$)/, ''));
  copy(src, dest);
  copy(src, path.join(recovery, 'original-js', 'src', rel));
  meta(dest, stableUuid('plugin:' + rel), {
    ver: '1.0.5',
    isPlugin: true,
    loadPluginInWeb: true,
    loadPluginInNative: true,
    loadPluginInEditor: false
  });
}
function normalizeRefs(x) {
  if (!x || typeof x !== 'object') return;
  if (x.__uuid__) x.__uuid__ = decode(x.__uuid__);
  for (const v of Object.values(x)) normalizeRefs(v);
}
for (const a of assets.values()) {
  normalizeRefs(a.doc);
  if (a.doc) write(path.join(recovery, 'import-documents', a.bundle, a.uuid + '.json'), a.doc);
}
const imageJobs = [];
const textureMeta = new Map();
const emitted = new Map();
const spriteInfo = new Map();
const extensions = {
  'cc.SceneAsset': '.fire',
  'cc.Prefab': '.prefab',
  'cc.AnimationClip': '.anim',
  'cc.Material': '.mtl',
  'cc.EffectAsset': '.effect',
  'cc.JsonAsset': '.json',
  'cc.BufferAsset': '.bin',
  'cc.TextAsset': '.txt'
};
function saveMeta(p, a, extra) {
  meta(p, a.uuid, extra);
  emitted.set(a.uuid, p);
  summary.assets[a.type] = (summary.assets[a.type] || 0) + 1;
}
function claimImage(a, p, src) {
  copy(src, p);
  textureMeta.set(p, {
    uuid: a.uuid,
    subMetas: {}
  });
  emitted.set(a.uuid, p);
  summary.assets['cc.Texture2D'] = (summary.assets['cc.Texture2D'] || 0) + 1;
}
// Full textures first, including auto-atlas pages whose IDs are not config paths.
for (const a of assets.values()) if (a.type === 'cc.Texture2D' && a.native.length) {
  const src = a.native[0];
  claimImage(a, a.base + path.extname(src), src);
}
for (const [u, files] of natives) {
  if (emitted.has(u)) continue;
  for (const src of files) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(src)) continue;
    const a = assets.get(u);
    const p = a ? a.base + path.extname(src) : path.join(assetRoot, 'RecoveredTextures', u + path.extname(src));
    claimImage({
      uuid: u,
      type: 'cc.Texture2D'
    }, p, src);
  }
}
// SpriteFrames become individual editable images with original SpriteFrame IDs.
for (const a of assets.values()) if (a.type === 'cc.SpriteFrame') {
  const data = a.root?.content || a.root || {};
  const tex = decode(a.root?._textureSetter?.__uuid__ || data.texture || '');
  const src = (natives.get(tex) || []).find(p => /\.(png|jpg|jpeg|webp)$/i.test(p));
  if (!src) {
    summary.warnings.push('Sprite texture missing: ' + a.uuid + ' -> ' + tex);
    continue;
  }
  let p;
  let parent = Array.from(assets.values()).find(t => t.bundle === a.bundle && t.type === 'cc.Texture2D' && t.rel === a.rel);
  const direct = parent && emitted.get(parent.uuid);
  const rect = data.rect || [0, 0, 0, 0],
    size = data.originalSize || rect.slice(2);
  const offset = data.offset || [0, 0];
  if (direct && parent.uuid === tex) {
    p = direct;
  } else {
    p = a.base + '.png';
    if (textureMeta.has(p) && Object.values(textureMeta.get(p).subMetas).some(s => s.uuid !== a.uuid)) p = a.base + '_' + a.uuid.slice(0, 8) + '.png';
    const uuid = parent?.uuid || stableUuid('sprite-texture:' + a.uuid);
    textureMeta.set(p, {
      uuid,
      subMetas: {}
    });
    emitted.set(uuid, p);
    imageJobs.push({
      src,
      dest: p,
      rect,
      rotated: !!data.rotated,
      originalSize: size,
      offset
    });
  }
  const cropped = !(direct && parent.uuid === tex);
  const trimX = cropped ? Math.round((size[0] - rect[2]) / 2 + offset[0]) : rect[0];
  const trimY = cropped ? Math.round((size[1] - rect[3]) / 2 - offset[1]) : rect[1];
  const ci = data.capInsets || [0, 0, 0, 0];
  const name = data.name || path.basename(a.base);
  const texMeta = textureMeta.get(p);
  texMeta.subMetas[name] = {
    ver: '1.0.6',
    uuid: a.uuid,
    importer: 'sprite-frame',
    rawTextureUuid: texMeta.uuid,
    trimType: 'custom',
    trimThreshold: 1,
    rotated: cropped ? false : !!data.rotated,
    offsetX: offset[0],
    offsetY: offset[1],
    trimX,
    trimY,
    width: rect[2],
    height: rect[3],
    rawWidth: size[0],
    rawHeight: size[1],
    borderLeft: ci[0],
    borderTop: ci[1],
    borderRight: ci[2],
    borderBottom: ci[3],
    subMetas: {}
  };
  emitted.set(a.uuid, p);
  spriteInfo.set(a.uuid, {
    asset: a,
    data,
    path: p,
    textureUuid: texMeta.uuid,
    source: src,
    tex
  });
  summary.assets['cc.SpriteFrame'] = (summary.assets['cc.SpriteFrame'] || 0) + 1;
}

// Normal serialized documents, native assets, JSON data, skeletons and fonts.
const atlasJobs = [];
const fontJobs = [];
for (const a of assets.values()) {
  const o = a.root;
  if (['cc.SpriteFrame', 'cc.Texture2D'].includes(a.type)) continue;
  if (a.type === 'cc.SpriteAtlas') {
    atlasJobs.push({
      uuid: a.uuid,
      dest: a.base + '.plist',
      frames: Object.entries(o?._spriteFrames || {}).map(([name, v]) => ({
        name,
        sprite: spriteInfo.get(v.__uuid__)
      })).filter(x => x.sprite).map(x => ({
        name: x.name,
        data: x.sprite.data,
        source: x.sprite.source,
        tex: x.sprite.tex
      }))
    });
    continue;
  }
  if (a.type === 'cc.BitmapFont' || a.type === 'cc.LabelAtlas') {
    fontJobs.push({
      uuid: a.uuid,
      dest: a.base + '.fnt',
      font: o,
      sprite: spriteInfo.get(o?.spriteFrame?.__uuid__)
    });
    continue;
  }
  if (a.type === 'sp.SkeletonData') {
    if (!o?._skeletonJson) {
      summary.warnings.push('Skeleton JSON missing: ' + a.uuid);
      continue;
    }
    const p = a.base + '.json';
    write(p, o._skeletonJson);
    const atlas = a.base + '.atlas';
    write(atlas, o._atlasText || '');
    meta(atlas, stableUuid('spine-atlas:' + a.uuid));
    const textures = [];
    for (let i = 0; i < (o.textureNames || []).length; i++) {
      const name = o.textureNames[i];
      const u = o.textures?.[i]?.__uuid__;
      const src = (natives.get(u) || [])[0];
      if (!src) {
        summary.warnings.push('Spine texture missing ' + a.uuid + ' ' + name);
        continue;
      }
      const page = safe(path.dirname(p), name);
      if (!fs.existsSync(page)) copy(src, page);
      if (!textureMeta.has(page)) textureMeta.set(page, {
        uuid: stableUuid('spine-page:' + page),
        subMetas: {}
      });
      textures.push(textureMeta.get(page).uuid);
    }
    saveMeta(p, a, {
      ver: '1.2.5',
      textures,
      scale: 1,
      premultipliedAlpha: false
    });
    continue;
  }
  if (a.type === 'cc.JsonAsset') {
    const p = a.base + '.json';
    write(p, o?.json ?? {});
    saveMeta(p, a, {
      ver: '1.0.0'
    });
    continue;
  }
  if (a.type === 'cc.TTFFont' || a.type === 'cc.AudioClip' || a.type === 'cc.VideoClip' || a.type === 'cc.Asset' || a.type === 'cc.BufferAsset' || a.type === 'cc.ParticleAsset' || a.type === 'cc.TextAsset') {
    const src = a.native[0];
    if (src) {
      const p = a.base + path.extname(src);
      copy(src, p);
      saveMeta(p, a, {
        ver: a.type === 'cc.AudioClip' ? '2.0.3' : '1.0.0',
        ...(a.type === 'cc.AudioClip' ? {
          downloadMode: 0,
          duration: o?.duration || 0
        } : {})
      });
    } else if (a.type === 'cc.TextAsset' && o?.text != null) {
      const p = a.base + '.txt';
      write(p, o.text);
      saveMeta(p, a, {});
    } else summary.warnings.push('Native asset missing: ' + a.type + ' ' + a.uuid);
    continue;
  }
  if (extensions[a.type] && a.doc) {
    const p = a.base + extensions[a.type];
    const doc = a.doc;
    // Lift embedded Components and Nodes to the editor's shared object table.
    const values = new Set(['cc.Vec2', 'cc.Vec3', 'cc.Vec4', 'cc.Quat', 'cc.Color', 'cc.Size', 'cc.Rect', 'cc.Mat4', 'TypedArray']);
    const flatten = (value, top = false) => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(v => flatten(v));
      if (!top && value.__type__ && !values.has(value.__type__)) {
        const idx = doc.length;
        doc.push(value);
        return {
          __id__: idx
        };
      }
      for (const [k, v] of Object.entries(value)) value[k] = flatten(v);
      return value;
    };
    if (Array.isArray(doc)) for (let i = 0; i < doc.length; i++) flatten(doc[i], true);
    if (a.type === 'cc.Material' && o?._techniqueData) {
      o._techniqueIndex = 0;
      o._techniqueData = o._techniqueData;
    }
    write(p, doc);
    saveMeta(p, a, a.type === 'cc.Prefab' ? {
      ver: '1.2.9',
      optimizationPolicy: 'AUTO',
      asyncLoadAssets: false,
      readonly: false
    } : a.type === 'cc.SceneAsset' ? {
      ver: '1.0.0',
      asyncLoadAssets: false,
      autoReleaseAssets: false
    } : {
      ver: '1.0.0'
    });
    continue;
  }
  if (!emitted.has(a.uuid)) summary.warnings.push('Unconverted asset ' + a.type + ' ' + a.uuid);
}
write(path.join(recovery, 'image-jobs.json'), imageJobs);
write(path.join(recovery, 'texture-metas.json'), Array.from(textureMeta, ([file, m]) => ({
  file,
  meta: {
    ver: '2.3.7',
    uuid: m.uuid,
    importer: 'texture',
    type: Object.keys(m.subMetas).length ? 'sprite' : 'raw',
    wrapMode: 'clamp',
    filterMode: 'bilinear',
    premultiplyAlpha: false,
    genMipmaps: false,
    packable: true,
    platformSettings: {},
    subMetas: m.subMetas
  }
})));
write(path.join(recovery, 'atlas-jobs.json'), atlasJobs);
write(path.join(recovery, 'font-jobs.json'), fontJobs.map(j => ({
  ...j,
  sprite: j.sprite && {
    path: j.sprite.path,
    textureUuid: j.sprite.textureUuid,
    data: j.sprite.data
  }
})));
// Editor bundle settings and preserved launch scene.
for (const cfg of bundles) {
  if (['main', 'internal', 'resources'].includes(cfg.name)) continue;
  const p = path.join(assetRoot, cfg.name);
  fs.mkdirSync(p, {
    recursive: true
  });
  meta(p, stableUuid('bundle:' + cfg.name), {
    ver: '1.1.3',
    importer: 'folder',
    isBundle: true,
    bundleName: cfg.name,
    priority: 1,
    compressionType: {},
    optimizeHotUpdate: {},
    inlineSpriteFrames: {},
    isRemoteBundle: {}
  });
}
const login = Array.from(assets.values()).find(a => a.scene && a.root?._name === 'Login');
const scenes = Array.from(assets.values()).filter(a => a.scene).map(a => ({
  url: 'db://assets/' + path.relative(assetRoot, a.base + '.fire').replace(/\\/g, '/'),
  uuid: a.uuid
}));
write(path.join(output, 'project.json'), {
  engine: 'cocos-creator-js',
  packages: 'packages',
  name: 'OrbitMiniGameZhaoCha-recovered',
  id: crypto.randomUUID(),
  version: '2.4.11',
  isNew: false,
  description: 'Recovered exclusively from web-mobile build with embedded source maps'
});
const ps = JSON.parse(fs.readFileSync(path.join(output, 'settings/project.json')));
Object.assign(ps, {
  'start-scene': login?.uuid || 'current',
  'design-resolution-width': 750,
  'design-resolution-height': 1334,
  'fit-width': true,
  'fit-height': false,
  'group-list': settings.groupList,
  'collision-matrix': settings.collisionMatrix
});
write(path.join(output, 'settings/project.json'), ps);
write(path.join(output, 'settings/builder.json'), {
  actualPlatform: 'web-mobile',
  platform: 'web-mobile',
  buildPath: 'build',
  debug: true,
  sourceMaps: true,
  md5Cache: false,
  startScene: login?.uuid,
  scenes: scenes.map(s => s.uuid),
  title: 'OrbitMiniGameZhaoCha-recovered',
  webOrientation: settings.orientation || 'portrait',
  inlineSpriteFrames: false,
  inlineSpriteFrames_native: true
});
write(path.join(output, 'tsconfig.json'), {
  compilerOptions: {
    module: 'commonjs',
    lib: ['es2015', 'es2017', 'dom'],
    target: 'es5',
    experimentalDecorators: true,
    skipLibCheck: true,
    allowSyntheticDefaultImports: true,
    outDir: 'temp/vscode-dist'
  },
  exclude: ['node_modules', 'library', 'local', 'temp', 'build', 'settings', '_recovery']
});
summary.scenes = scenes;
summary.assetFiles = Array.from(emitted, ([uuid, file]) => ({
  uuid,
  path: path.relative(output, file).replace(/\\/g, '/')
}));
write(path.join(recovery, 'manifest.json'), summary);
console.log(JSON.stringify({
  sources: summary.sourceFiles.length,
  compiledModules: summary.compiledModules.length,
  assets: summary.assets,
  imageJobs: imageJobs.length,
  warnings: summary.warnings.length,
  warningSamples: summary.warnings.slice(0, 12)
}, null, 2));
