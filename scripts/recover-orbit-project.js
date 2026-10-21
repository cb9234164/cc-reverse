/* Reproducible recipe for the supplied OrbitMiniGameZhaoCha 2.4.11 build.
 * Run --help for arguments. Never point --output at an existing project.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadOptions } = require('./orbit-options');
const options = loadOptions();
const repo = path.resolve(__dirname, '..');

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: repo, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} exited with ${result.status}`);
}

if (fs.existsSync(options.output) && fs.readdirSync(options.output).length) {
  throw new Error('Output must be empty or nonexistent; existing files were not changed.');
}
const builtins = path.join(path.dirname(options.creator), 'resources/static/default-assets');
if (!fs.existsSync(builtins)) throw new Error('Creator default-assets directory not found: ' + builtins);
run(options.python, ['-c', 'from PIL import Image; print("Pillow ready")']);
const common = [
  '--source', options.source, '--output', options.output, '--creator', options.creator,
];
if (options.replaceEmptyAudio) common.push('--replace-empty-audio');
if (options.scriptPaths) common.push('--script-paths', path.resolve(options.scriptPaths));
run(process.execPath, [path.join(repo, 'bin/cc-reverse.js'), '--path', options.source,
  '--output', options.output, '--version-hint', '2.4.x']);
for (const script of ['recover-orbit.js']) run(process.execPath, [path.join(__dirname, script), ...common]);
run(options.python, [path.join(__dirname, 'recover-orbit-images.py'), '--output', options.output]);
for (const script of ['prepare-orbit.js', 'recover-orbit-aliases.js', 'finalize-orbit.js']) {
  run(process.execPath, [path.join(__dirname, script), ...common]);
}
run(process.execPath, [path.join(__dirname, 'validate-orbit.js'), ...common]);

if (options.build) {
  const log = path.join(options.output, '_recovery/creator-build.log');
  // Keep the semicolon-separated build options in one argument; no shell interpolation.
  run(options.creator, ['--path', options.output, '--build', 'platform=web-mobile;debug=true', '--logfile', log]);
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  if (!/Built to [^\r\n]+ successfully/.test(text) || /Build Failed|Build failed/.test(text)) {
    throw new Error('Creator did not confirm build success. Inspect ' + log);
  }
}
run(process.execPath, [path.join(__dirname, 'write-orbit-report.js'), ...common]);
console.log('Recovery complete: ' + options.output);
