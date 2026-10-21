const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');
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
// Prefer actual engine builtins, preserving all recovered copies for reference.
const moved = [];
for (const p of walk(assets).filter(x => x.endsWith('.meta'))) {
  const m = JSON.parse(fs.readFileSync(p));
  const ids = [m.uuid, ...Object.values(m.subMetas || {}).map(v => v.uuid)].filter(Boolean);
  if (!ids.some(u => builtin.has(u))) continue;
  if (Object.values(m.subMetas || {}).some(v => !builtin.has(v.uuid))) continue;
  for (const src of [p.slice(0, -5), p]) if (fs.existsSync(src)) {
    const dest = path.join(recovery, 'builtin-assets', path.relative(assets, src));
    fs.mkdirSync(path.dirname(dest), {
      recursive: true
    });
    fs.renameSync(src, dest);
    moved.push(path.relative(root, src));
  }
}
// Cropped PNGs are new textures; retain original UUID on their JPG source.
const seen = new Map(),
  reassigned = [];
for (const p of walk(assets).filter(x => x.endsWith('.meta'))) {
  const m = JSON.parse(fs.readFileSync(p));
  if (seen.has(m.uuid) && /\.png\.meta$/.test(p) && /\.jpg\.meta$/.test(seen.get(m.uuid))) {
    const old = m.uuid;
    m.uuid = stable('cropped:' + path.relative(root, p));
    Object.values(m.subMetas || {}).forEach(v => v.rawTextureUuid = m.uuid);
    write(p, m);
    reassigned.push({
      path: p,
      old,
      uuid: m.uuid
    });
  }
  seen.set(m.uuid, p);
}
write(path.join(recovery, 'preparation.json'), {
  movedBuiltinFiles: moved,
  reassignedTextures: reassigned
});
