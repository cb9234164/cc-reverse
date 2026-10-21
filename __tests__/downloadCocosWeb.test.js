const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Downloader, parseSettings, safeRelative, textureExtensions } = require('../scripts/download-cocos-web');

describe('Cocos web download manifests', () => {
  let tmp, server, origin, requests, files;
  const texture = 'aaaaaaaa-1111-2222-3333-444444444444';
  const audio = 'bbbbbbbb-1111-2222-3333-444444444444';
  const font = 'cccccccc-1111-2222-3333-444444444444';
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-download-'));
    requests = [];
    files = {
      '/game/index.html': ['text/html', '<script src="src/settings.abc.js"></script><link href="style.css" rel="stylesheet"><script>loadScript("cocos2d-js-min.abc.js")</script>'],
      '/game/src/settings.abc.js': ['application/javascript', 'window._CCSettings={bundleVers:{main:"abc",lazy:"def"},jsList:["plugins/runtime.js"]};'],
      '/game/src/plugins/runtime.js': ['application/javascript', 'var pluginLoaded = true;\n//# sourceMappingURL=runtime.js.map'],
      '/game/src/plugins/runtime.js.map': ['application/json', '{"version":3,"sources":[],"mappings":""}'],
      '/game/style.css': ['text/css', 'body{background:url("background.png")}'],
      '/game/background.png': ['image/png', 'image'],
      '/game/cocos2d-js-min.abc.js': ['application/javascript', 'var ENGINE_VERSION="2.4.11";'],
      '/game/assets/internal/config.json': ['application/json', { name: 'internal', uuids: [] }],
      '/game/assets/main/config.abc.json': ['application/json', {
        name: 'main', debug: true, uuids: [texture, audio, font],
        packs: { '0pack': [0] }, versions: { import: ['0pack', 'packhash', 0, 'stale', 1, 'audiohash', 2, 'fonthash'], native: [0, 'imagehash', 1, 'soundhash', 2, 'fontnative'] },
      }],
      '/game/assets/main/index.abc.js': ['application/javascript', 'var mainBundle = true;'],
      '/game/assets/main/import/0p/0pack.packhash.json': ['application/json', { type: 'cc.Texture2D', data: '1_4,0,0' }],
      [`/game/assets/main/import/bb/${audio}.audiohash.json`]: ['application/json', [{ __type__: 'cc.AudioClip', _native: '.ogg' }]],
      [`/game/assets/main/import/cc/${font}.fonthash.json`]: ['application/json', [{ __type__: 'cc.TTFFont', _native: 'font.ttf' }]],
      [`/game/assets/main/native/aa/${texture}.imagehash.jpg`]: ['image/jpeg', 'jpeg-image'],
      [`/game/assets/main/native/aa/${texture}.imagehash.webp`]: ['image/webp', 'webp-image'],
      [`/game/assets/main/native/aa/${texture}.imagehash.png`]: ['text/html', '<!DOCTYPE html><html>Not a real image</html>'],
      [`/game/assets/main/native/bb/${audio}.soundhash.ogg`]: ['audio/ogg', 'ogg-audio'],
      [`/game/assets/main/native/cc/${font}.fontnative/font.ttf`]: ['application/octet-stream', 'font'],
      // This bundle never loads on the entry page; the settings manifest is enough to find it.
      '/game/assets/lazy/config.def.json': ['application/json', { name: 'lazy', uuids: [], versions: { import: ['packLazy', 'lazyhash'] } }],
      '/game/assets/lazy/index.def.js': ['application/javascript', 'var lazyBundle = true;'],
      '/game/assets/lazy/import/pa/packLazy.lazyhash.json': ['application/json', []],
    };
    server = http.createServer((req, res) => {
      requests.push(req.url);
      const entry = files[req.url];
      if (!entry) { res.writeHead(404); res.end('missing'); return; }
      res.writeHead(200, { 'Content-Type': entry[0] });
      res.end(typeof entry[1] === 'string' ? entry[1] : JSON.stringify(entry[1]));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const options = () => ({ url: origin + '/game/index.html', output: path.join(tmp, 'output'), retries: 0, timeout: 1000 });

  it('downloads every declared bundle, packs, native variants, nested fonts, maps and CSS assets', async () => {
    const downloader = new Downloader(options());
    expect(await downloader.run()).toBe(true);
    const out = path.join(tmp, 'output');
    expect(fs.readFileSync(path.join(out, `assets/main/native/aa/${texture}.imagehash.jpg`), 'utf8')).toBe('jpeg-image');
    expect(fs.readFileSync(path.join(out, `assets/main/native/aa/${texture}.imagehash.webp`), 'utf8')).toBe('webp-image');
    expect(fs.existsSync(path.join(out, `assets/main/native/cc/${font}.fontnative/font.ttf`))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets/lazy/import/pa/packLazy.lazyhash.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'src/plugins/runtime.js.map'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'background.png'))).toBe(true);
    expect(downloader.manifest.failedRequired.some(file => file.url.includes('/import/aa/' + texture))).toBe(false);
    expect(fs.existsSync(path.join(out, `assets/main/native/aa/${texture}.imagehash.png`))).toBe(false);
    expect(downloader.manifest.summary.failedRequired).toBe(0);
    // Resume reuses verified bytes, but refetches a local file whose content was corrupted.
    requests.length = 0;
    fs.writeFileSync(path.join(out, 'background.png'), 'broken');
    expect(await new Downloader(options()).run()).toBe(true);
    expect(requests).toContain('/game/background.png');
    expect(requests).not.toContain('/game/assets/main/config.abc.json');
    expect(requests).not.toContain(`/game/assets/main/native/aa/${texture}.imagehash.jpg`);
  });

  it('reports missing required imports instead of claiming a complete build', async () => {
    delete files['/game/assets/lazy/import/pa/packLazy.lazyhash.json'];
    const downloader = new Downloader(options());
    expect(await downloader.run()).toBe(false);
    expect(downloader.manifest.failedRequired.some(file => file.url.includes('packLazy'))).toBe(true);
  });

  it('rejects HTTP 200 HTML fallback pages masquerading as static resources', async () => {
    files['/game/background.png'] = ['text/html', '<!DOCTYPE html><html>Resource missing</html>'];
    const downloader = new Downloader(options());
    expect(await downloader.run()).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'output/background.png'))).toBe(false);
    expect(downloader.manifest.failedRequired.some(file => file.path === 'background.png')).toBe(true);
  });

  it('does not execute settings and refuses unsafe local paths', () => {
    expect(textureExtensions('1_4_7@35,9729,9729')).toEqual(['.jpg', '.webp', '.astc']);
    expect(parseSettings('window._CCSettings={debug:!0,bundleVers:{main:"abc"}};').debug).toBe(true);
    expect(() => parseSettings('window._CCSettings=runArbitraryCode();')).toThrow('executable expressions');
    expect(() => safeRelative('../outside.js')).toThrow('Unsafe');
    expect(safeRelative('assets/%2e%2e/file.js')).not.toBe('assets/../file.js');
    fs.writeFileSync(path.join(tmp, 'existing.txt'), 'keep');
    expect(() => new Downloader({ ...options(), output: tmp })).toThrow('nonempty');
  });
});
