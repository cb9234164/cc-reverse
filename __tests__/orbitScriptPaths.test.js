const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assetPath, planScriptPaths } = require('../scripts/orbit-script-paths');

describe('compiled JS placement without source maps', () => {
  const output = path.resolve(os.tmpdir(), 'script-placement-fixture');
  const record = (id, deps = {}, extra = {}) => ({ id, bundle: 'main', source: '', deps, ...extra });

  it('uses original bundle paths and resolves relative dependencies before emitting either module', () => {
    const main = record('assets/scripts/ui/Main.ts', { '../data/Config': 'Config' });
    const config = record('Config');
    planScriptPaths([config, main], { output });
    expect(main.plannedPath).toBe(path.join(output, 'assets/scripts/ui/Main.js'));
    expect(config.plannedPath).toBe(path.join(output, 'assets/scripts/data/Config.js'));
    expect(config.pathReason).toBe('relative-dependency');
  });

  it('accepts a previous manifest and retains the original folder while emitting .js', () => {
    const main = record('Main', {}, { uuid: 'script-uuid' });
    planScriptPaths([main], { output, mapping: { compiledModules: [
      { bundle: 'main', id: 'Main', uuid: 'script-uuid', sourcePath: 'assets/custom/Main.ts' },
    ] } });
    expect(main.plannedPath).toBe(path.join(output, 'assets/custom/Main.js'));
    expect(main.pathReason).toBe('path-map');
  });

  it('does not invent an original path when only the module basename remains', () => {
    const main = record('Main');
    const warnings = [];
    planScriptPaths([main], { output, warnings });
    expect(main.pathReason).toBe('fallback');
    expect(warnings.join(' ')).toContain('Original script path unavailable');
    expect(assetPath('assets/../../outside.js')).toBeNull();
  });

  it('keeps known original source and refuses colliding JS/TS module paths', () => {
    const a = record('A', {}, { sourcePath: path.join(output, 'assets/A.ts') });
    const b = record('B');
    expect(() => planScriptPaths([a, b], { output, mapping: { B: 'assets/A.js' } })).toThrow('collision');
  });

  it.each(['no-map', 'map-without-content', 'map-with-content'])(
    'writes scripts and correct relative requires into original folders: %s', mode => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-nomap-'));
    const write = (name, value) => {
      const file = path.join(tmp, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
      write('Creator.exe', 'fixture');
      write('source/src/settings.js', 'window._CCSettings={jsList:[],groupList:["default"],collisionMatrix:[[true]]};');
      write('source/assets/main/config.json', { name: 'main', uuids: [] });
      const moduleId = mode === 'no-map' ? 'assets/scripts/ui/Main.ts' : 'Main';
      write('source/assets/main/index.abc12.js', 'window.__require=function(t){return t}({'
        + JSON.stringify(moduleId) + ':[function(r,m,e){e.data=r("../data/Config");},{"../data/Config":"Config"}],'
        + '"Config":[function(r,m,e){e.value=42;},{}]}, {}, []);');
      if (mode !== 'no-map') write('source/assets/main/index.abc12.js.map', {
        version: 3, sources: ['assets/scripts/ui/Main.ts'],
        sourcesContent: mode === 'map-with-content' ? ['export const original = 7;\n'] : [],
      });
      write('output/assets/initial.txt', 'archive');
      write('output/RECOVERY_REPORT.md', 'initial');
      write('output/settings/project.json', {});
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/recover-orbit.js'),
        '--source', path.join(tmp, 'source'), '--output', path.join(tmp, 'output'),
        '--creator', path.join(tmp, 'Creator.exe')], { encoding: 'utf8', windowsHide: true });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const main = path.join(tmp, 'output/assets/scripts/ui/Main' + (mode === 'map-with-content' ? '.ts' : '.js'));
      const config = path.join(tmp, 'output/assets/scripts/data/Config.js');
      expect(fs.readFileSync(main, 'utf8')).toContain(mode === 'map-with-content' ? 'export const original = 7;' : 'require("../data/Config")');
      expect(fs.readFileSync(config, 'utf8')).toContain('exports.value = 42');
      expect(fs.existsSync(main + '.meta')).toBe(true);
      expect(fs.existsSync(config + '.meta')).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'output/_recovery/manifest.json')));
      expect(manifest.sourceFiles).toHaveLength(mode === 'map-with-content' ? 1 : 0);
      expect(manifest.compiledModules.filter(item => item.recoveredFrom === 'compiled-js')).toHaveLength(mode === 'map-with-content' ? 1 : 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
