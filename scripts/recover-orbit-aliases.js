// Preserve addressable paths for assets shared by multiple compiled bundles.
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
const {
  parseBundleConfig,
  findBundleConfigPath
} = require('../src/core/cocos3x/bundleConfig');
const {
  output: root,
  source
} = require('./orbit-options').loadOptions();
const assetRoot = path.join(root, 'assets'),
  build = path.join(source, 'assets');
const walk = p => fs.readdirSync(p, {
  withFileTypes: true
}).flatMap(e => e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]);
const uuid = s => crypto.createHash('sha256').update('bundle-alias:' + s).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const known = new Map();
for (const p of walk(assetRoot).filter(p => p.endsWith('.meta'))) {
  const m = JSON.parse(fs.readFileSync(p));
  known.set(m.uuid, {
    file: p.slice(0, -5),
    meta: m
  });
  for (const [key, sub] of Object.entries(m.subMetas || {})) known.set(sub.uuid, {
    file: p.slice(0, -5),
    meta: m,
    sub,
    key
  });
}
const aliases = [];
for (const b of fs.readdirSync(build)) {
  const dir = path.join(build, b);
  if (!fs.statSync(dir).isDirectory()) continue;
  const f = findBundleConfigPath(dir);
  if (!f) continue;
  const c = parseBundleConfig(JSON.parse(fs.readFileSync(f)), dir);
  const groups = new Map();
  for (const [u, info] of Object.entries(c.paths)) {
    if (c.redirect[u]) continue;
    const group = groups.get(info.path) || [];
    group.push({
      u,
      ...info
    });
    groups.set(info.path, group);
  }
  for (const [rel, group] of groups) {
    const sp = group.find(x => x.type === 'cc.SpriteFrame');
    const tex = group.find(x => x.type === 'cc.Texture2D');
    const ani = group.find(x => x.type === 'cc.AnimationClip');
    const original = known.get(sp?.u) || known.get(tex?.u) || known.get(ani?.u);
    if (!original) continue;
    const base = path.join(assetRoot, b, rel);
    const ext = path.extname(original.file);
    const dest = base + ext;
    if (fs.existsSync(dest)) continue;
    if (!['.png', '.jpg', '.jpeg', '.anim'].includes(ext)) continue;
    fs.mkdirSync(path.dirname(dest), {
      recursive: true
    });
    fs.copyFileSync(original.file, dest);
    const m = JSON.parse(JSON.stringify(original.meta));
    m.uuid = uuid(b + '/' + rel + '/asset');
    for (const sub of Object.values(m.subMetas || {})) {
      sub.uuid = uuid(b + '/' + rel + '/sprite');
      sub.rawTextureUuid = m.uuid;
    }
    fs.writeFileSync(dest + '.meta', JSON.stringify(m, null, 2));
    aliases.push({
      bundle: b,
      path: rel,
      file: path.relative(root, dest),
      source: original.file,
      uuid: m.uuid,
      originalUuid: sp?.u || tex?.u || ani?.u
    });
  }
}
fs.writeFileSync(path.join(root, '_recovery/bundle-aliases.json'), JSON.stringify(aliases, null, 2));
console.log('Additional addressable bundle paths:', aliases.length);
