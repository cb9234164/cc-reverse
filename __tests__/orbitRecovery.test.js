const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('project recovery type supplements', () => {
  let tmp;
  const uuid = 'cb55249d-78cd-4118-bbd1-567a75db2895';
  const relative = 'assets/RecoveredScripts/Game/LevelConfigTypes.js';
  const target = 'assets/Game/Script/gameModel/normalProgress/config/LevelConfigTypes.ts';
  const compiled = '_recovery/js-modules/Game/LevelConfigTypes.js';
  function write(name, data) {
    const file = path.join(tmp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  function run(code) {
    write('output/' + relative, code);
    write('output/' + relative + '.meta', JSON.stringify({ uuid }));
    write('output/' + compiled, code);
    write('output/_recovery/manifest.json', JSON.stringify({
      assetFiles: [], compiledModules: [{ id: 'LevelConfigTypes', uuid, sourcePath: relative, path: compiled }],
    }));
    return spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/finalize-orbit.js'),
      '--source', path.join(tmp, 'source'), '--output', path.join(tmp, 'output'),
      '--creator', path.join(tmp, 'Creator.exe')], { encoding: 'utf8', windowsHide: true });
  }
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reverse-orbit-'));
    fs.mkdirSync(path.join(tmp, 'source'));
    write('Creator.exe', 'fixture');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('preserves an erased factory and emits a labelled type supplement with its UUID', () => {
    const code = '"use strict"; cc._RF.push(module,"cb552SdeM1BGLvRVnp12yiV","LevelConfigTypes"),'
      + 'Object.defineProperty(exports,"__esModule",{value:!0}),cc._RF.pop();';
    const result = run(code);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'output', target), 'utf8')).toContain('export type LevelConfig = any;');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'output', target + '.meta'))).uuid).toBe(uuid);
    expect(fs.readFileSync(path.join(tmp, 'output/_recovery/erased-type-modules', relative), 'utf8')).toBe(code);
    expect(fs.readFileSync(path.join(tmp, 'output/_recovery/js-source-tree', target.replace(/\.ts$/, '.js')), 'utf8')).toBe(code);
  });

  it('refuses to replace a module that contains runtime exports', () => {
    const code = 'Object.defineProperty(exports,"__esModule",{value:true}); exports.LevelConfig = class {};';
    const result = run(code);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('module contains runtime code');
    expect(fs.readFileSync(path.join(tmp, 'output', relative), 'utf8')).toBe(code);
    expect(fs.existsSync(path.join(tmp, 'output', target))).toBe(false);
  });
});
