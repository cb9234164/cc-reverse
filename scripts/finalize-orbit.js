// Explicit project repairs, kept separate from read-only validation.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const { loadOptions } = require('./orbit-options');
const { output, replaceEmptyAudio } = loadOptions();
const recovery = path.join(output, '_recovery');
const manifestPath = path.join(recovery, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
};
const repairs = { typeSupplements: [], silentAudioPlaceholders: [] };

function isErasedModule(code) {
  const ast = parser.parse(code, { sourceType: 'script' });
  const name = node => node?.type === 'Identifier' ? node.name
    : node?.type === 'MemberExpression' && !node.computed ? name(node.object) + '.' + name(node.property) : '';
  const allowed = node => {
    if (node.type === 'SequenceExpression') return node.expressions.every(allowed);
    if (node.type !== 'CallExpression') return false;
    const callee = name(node.callee);
    if (callee === 'cc._RF.pop') return node.arguments.length === 0;
    if (callee === 'cc._RF.push') return node.arguments.length === 3
      && name(node.arguments[0]) === 'module'
      && node.arguments.slice(1).every(arg => arg.type === 'StringLiteral');
    if (callee === 'Object.defineProperty') {
      const [object, key, descriptor] = node.arguments;
      const property = descriptor?.type === 'ObjectExpression' && descriptor.properties.length === 1
        ? descriptor.properties[0] : null;
      const value = property?.value;
      return name(object) === 'exports' && key?.value === '__esModule'
        && property?.type === 'ObjectProperty' && !property.computed
        && (property.key.name || property.key.value) === 'value'
        && ((value?.type === 'BooleanLiteral' && value.value === true)
          || (value?.type === 'UnaryExpression' && value.operator === '!'
            && value.argument.type === 'NumericLiteral' && value.argument.value === 0));
    }
    return false;
  };
  return ast.program.body.length > 0 && ast.program.body.every(statement =>
    statement.type === 'ExpressionStatement' && allowed(statement.expression));
}

const supplements = [
  {
    id: 'LevelConfigTypes',
    file: 'assets/Game/Script/gameModel/normalProgress/config/LevelConfigTypes.ts',
    names: ['CompleteAnimationConfig', 'CompleteAnimationStageConfig', 'LevelConfig', 'LevelStepConfig', 'TweenActionConfig'],
  },
  {
    id: 'VideoTypes', file: 'assets/scripts/video-player/soft/VideoTypes.ts',
    names: ['DecodedYuvFrame'],
  },
];
for (const supplement of supplements) {
  const candidates = manifest.compiledModules.filter(module => module.id === supplement.id);
  const target = path.join(output, supplement.file);
  if (fs.existsSync(target) || candidates.length !== 1) continue;
  const module = candidates[0];
  // Only replace this recipe's known erased modules, never recovered original sources.
  if (!module.sourcePath || (module.recoveredFrom
    ? module.recoveredFrom !== 'compiled-js'
    : !module.sourcePath.startsWith('assets/RecoveredScripts/'))) continue;
  const original = path.join(output, module.sourcePath);
  if (!fs.existsSync(original) || !module.uuid) throw new Error('Missing fallback module: ' + module.id);
  if (!isErasedModule(fs.readFileSync(original, 'utf8'))) {
    throw new Error('Refusing type supplement: module contains runtime code: ' + module.id);
  }
  for (const file of [original, original + '.meta']) {
    const destination = path.join(recovery, 'erased-type-modules', path.relative(output, file));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(file, destination);
  }
  write(target, '/** Recovery supplement: original type-only declarations were erased from the build.\n'
    + ' * Permissive aliases preserve imports; original interfaces were not recovered. */\n'
    + supplement.names.map(name => `export type ${name} = any;`).join('\n') + '\n');
  write(target + '.meta', {
    ver: '1.0.5', uuid: module.uuid, isPlugin: false,
    loadPluginInWeb: true, loadPluginInNative: true, loadPluginInEditor: false, subMetas: {},
  });
  module.sourcePath = supplement.file;
  module.recoveredFrom = 'type-supplement';
  repairs.typeSupplements.push(supplement);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const emptyAudio = walk(path.join(output, 'assets')).filter(file => /\.(mp3|ogg|wav)$/i.test(file) && fs.statSync(file).size === 0);
if (emptyAudio.length && !replaceEmptyAudio) {
  throw new Error('Empty audio found: ' + emptyAudio.join(', ') + '. Use --replace-empty-audio to preserve originals and generate silent WAV placeholders.');
}
for (const file of emptyAudio) {
  const target = file.replace(/\.[^.]+$/, '.wav');
  if (target !== file && fs.existsSync(target)) throw new Error('WAV already exists: ' + target);
  const meta = JSON.parse(fs.readFileSync(file + '.meta', 'utf8'));
  for (const original of [file, file + '.meta']) {
    const destination = path.join(recovery, 'corrupt-media', path.relative(path.join(output, 'assets'), original));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(original, destination);
  }
  // 0.1 s of silence: 22050 Hz, mono, signed 16-bit PCM.
  const samples = 2205, bytes = samples * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  write(target, wav); write(target + '.meta', { ...meta, duration: 0.1 });
  const oldPath = path.relative(output, file).split(path.sep).join('/');
  const newPath = path.relative(output, target).split(path.sep).join('/');
  for (const asset of manifest.assetFiles) if (asset.path === oldPath) asset.path = newPath;
  repairs.silentAudioPlaceholders.push({ original: oldPath, placeholder: newPath, uuid: meta.uuid });
}
for (const module of manifest.compiledModules) {
  if (!module.sourcePath) continue;
  const relative = module.sourcePath.replace(/\.(ts|js)$/, '.js');
  write(path.join(recovery, 'js-source-tree', relative), fs.readFileSync(path.join(output, module.path)));
}
write(manifestPath, manifest);
write(path.join(recovery, 'repairs.json'), repairs);
console.log(JSON.stringify(repairs, null, 2));
