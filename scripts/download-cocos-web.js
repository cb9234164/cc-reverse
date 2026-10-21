/* Download a public Creator 2.4 web build using its asset manifests.
 * Remote JavaScript is parsed as data, never evaluated or executed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { Command } = require('commander');
const { parseBundleConfig, getImportPath, getNativePath } = require('../src/core/cocos3x/bundleConfig');
const { rehydrateIFileData } = require('../src/core/cocos3x/rehydrate');

function literal(node) {
  if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(node?.type)) return node.value;
  if (node?.type === 'NullLiteral') return null;
  if (node?.type === 'UnaryExpression' && ['-', '+', '!'].includes(node.operator)) {
    const value = literal(node.argument);
    return node.operator === '-' ? -value : node.operator === '+' ? +value : !value;
  }
  if (node?.type === 'ArrayExpression') return node.elements.map(item => item ? literal(item) : null);
  if (node?.type === 'ObjectExpression') {
    const data = Object.create(null);
    for (const property of node.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) throw new Error('Unsupported computed settings property');
      data[property.key.name ?? property.key.value] = literal(property.value);
    }
    return data;
  }
  throw new Error('Settings contain executable expressions; automatic evaluation is disabled.');
}

function parseSettings(code) {
  const ast = parser.parse(code, { sourceType: 'unambiguous' });
  let settings;
  traverse(ast, {
    AssignmentExpression(item) {
      const left = item.node.left;
      if (left.type === 'MemberExpression' && (left.property.name || left.property.value) === '_CCSettings') {
        settings = literal(item.node.right);
      }
    },
  });
  return settings || null;
}

function webReferences(text, kind) {
  const found = new Set();
  if (kind === 'html') {
    // Strip comments so documentation links and disabled assets are not crawled.
    const html = text.replace(/<!--[\s\S]*?-->/g, '');
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) found.add(match[1].replace(/&amp;/g, '&'));
  }
  if (kind === 'css') {
    for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) found.add(match[1] || match[2]);
  }
  if (kind === 'html' || kind === 'js') {
    // Include bootstrap's dynamically inserted engine script and runtime WASM.
    for (const match of text.matchAll(/["']([^\s"'<>]+\.(?:js|css|wasm)(?:\?[^\s"'<>]*)?)["']/g)) {
      if (!/^(?:jsb-adapter\/|src\/(?:cocos2d-(?:runtime|jsb)|physics))/.test(match[1])) found.add(match[1]);
    }
    for (const match of text.matchAll(/\/\/[#@]\s*sourceMappingURL\s*=\s*([^\s]+)/g)) found.add(match[1]);
  }
  return [...found].filter(value => value && !/^(?:data:|blob:|javascript:|#)/i.test(value));
}

function safeRelative(relative) {
  const value = relative.replace(/\\/g, '/');
  if (!value || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('Unsafe download path: ' + relative);
  }
  // Preserve URL-encoded Windows-reserved characters instead of creating unsafe names.
  return value.split('/').map(part => {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { decoded = part; }
    if (/[<>:"/\\|?*\x00-\x1f]/.test(decoded) || /[. ]$/.test(decoded)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(decoded)
      || decoded === '.' || decoded === '..') return encodeURIComponent(part);
    return decoded;
  }).join('/');
}

const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function textureExtensions(content) {
  if (typeof content !== 'string') return ['.png'];
  // Creator Texture2D._deserialize: extnames indices, optional @pixel-format,
  // and '_' separated variants. Keep every declared variant, not just the browser's preferred one.
  const names = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.pvr', '.pkm', '.astc'];
  const extensions = content.split(',')[0].split('_').map(item => {
    const token = item.split('@')[0];
    return /^\d$/.test(token) ? names[Number(token)] : token;
  }).filter(ext => /^\.[a-z\d]+$/i.test(ext || ''));
  return [...new Set(extensions.length ? extensions : ['.png'])];
}

class Downloader {
  constructor(options) {
    this.options = { concurrency: 6, retries: 2, timeout: 30000, maxFiles: 50000, ...options };
    this.entry = new URL(options.url);
    if (!/^https?:$/.test(this.entry.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
    this.base = new URL('./', this.entry);
    this.root = path.resolve(options.output);
    this.manifestPath = path.join(this.root, '_download/manifest.json');
    this.jobs = new Map();
    this.destinations = new Map();
    this.previous = new Map();
    this.scanned = new Set();
    this.configs = new Map();
    this.manifest = { version: 1, entry: this.entry.href, base: this.base.href, startedAt: new Date().toISOString(),
      engine: 'unknown', bundles: [], files: [], warnings: [], skipped: [], unsupportedBundles: [] };
    if (fs.existsSync(this.manifestPath)) {
      const prior = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      if (prior.entry !== this.entry.href) throw new Error('Output belongs to another URL. Choose a different directory.');
      this.previous = new Map(prior.files.map(file => [file.url, file]));
    } else if (fs.existsSync(this.root) && fs.readdirSync(this.root).length) {
      throw new Error('Output is nonempty and has no download manifest. Choose a new directory.');
    }
  }

  localPath(url) {
    if (url.origin === this.base.origin && url.pathname.startsWith(this.base.pathname)) {
      return safeRelative(url.pathname.slice(this.base.pathname.length) || 'index.html');
    }
    return safeRelative('_external/' + url.host + '/' + url.pathname.replace(/^\//, ''));
  }

  add(reference, from = this.base.href, extra = {}) {
    const url = new URL(reference, from); url.hash = '';
    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.origin !== this.base.origin && !this.options.allowExternal && !extra.bundleResource) {
      if (!this.manifest.skipped.includes(url.href)) this.manifest.skipped.push(url.href);
      return null;
    }
    const existing = this.jobs.get(url.href);
    if (existing) { existing.required ||= !!extra.required; return existing; }
    if (this.jobs.size >= this.options.maxFiles) throw new Error('File limit reached; raise --max-files if needed.');
    const relative = safeRelative(extra.relative || this.localPath(url));
    const destinationKey = relative.toLowerCase();
    const collision = this.destinations.get(destinationKey);
    if (collision && collision !== url.href) throw new Error('Different URLs map to the same local file: ' + relative);
    this.destinations.set(destinationKey, url.href);
    const job = { url: url.href, path: relative, required: !!extra.required, reason: extra.reason || 'reference', status: 'queued' };
    this.jobs.set(url.href, job);
    return job;
  }

  save() {
    this.manifest.files = [...this.jobs.values()];
    this.manifest.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    fs.writeFileSync(this.manifestPath + '.tmp', JSON.stringify(this.manifest, null, 2));
    fs.renameSync(this.manifestPath + '.tmp', this.manifestPath);
  }

  async download(job) {
    const destination = path.join(this.root, job.path);
    const old = this.previous.get(job.url);
    if (old?.status === 'downloaded' && old.path === job.path && fs.existsSync(destination)) {
      const buffer = fs.readFileSync(destination);
      if (buffer.length === old.bytes && digest(buffer) === old.sha256) {
        Object.assign(job, { status: 'downloaded', bytes: old.bytes, sha256: old.sha256,
          httpStatus: old.httpStatus ?? 200, contentType: old.contentType, cached: true });
        return;
      }
    }
    let lastError;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeout);
      try {
        const response = await fetch(job.url, { signal: controller.signal, headers: {
          'User-Agent': 'cc-reverse-web-downloader/1.0', Referer: this.entry.href,
        } });
        job.httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          if ([404, 410].includes(response.status)) { job.status = 'missing'; return; }
          throw new Error('HTTP ' + response.status);
        }
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 256 * 1024 * 1024) { controller.abort(); throw new Error('File exceeds 256 MiB'); }
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const contentType = response.headers.get('content-type') || '';
        if (!/\.html?$/i.test(new URL(job.url).pathname)
          && (/text\/html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(buffer.subarray(0, 200).toString()))) {
          throw new Error('Server returned HTML instead of the requested resource');
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination + '.part', buffer);
        fs.renameSync(destination + '.part', destination);
        Object.assign(job, { status: 'downloaded', bytes, sha256: digest(buffer), contentType });
        return;
      } catch (error) { lastError = error; }
      finally { clearTimeout(timer); }
      if (attempt < this.options.retries) await delay(Math.min(2000, 300 * 2 ** attempt));
    }
    job.status = 'failed'; job.error = lastError?.message || 'Download failed';
  }

  async drain() {
    const queued = [...this.jobs.values()].filter(job => job.status === 'queued');
    let cursor = 0, completed = 0;
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency, queued.length) }, async () => {
      while (cursor < queued.length) {
        const job = queued[cursor++]; await this.download(job); completed++;
        if (completed % 100 === 0) {
          console.log(`Downloaded/probed ${completed}/${queued.length}; total discovered ${this.jobs.size}`);
          this.save();
        }
      }
    }));
    this.save();
  }

  text(job) {
    return job?.status === 'downloaded' ? fs.readFileSync(path.join(this.root, job.path), 'utf8') : null;
  }

  async scanWebFiles() {
    for (let pass = 0; pass < 8; pass++) {
      await this.drain();
      let discovered = false;
      for (const job of [...this.jobs.values()]) {
        if (job.status !== 'downloaded' || this.scanned.has(job.url)) continue;
        const ext = path.posix.extname(new URL(job.url).pathname).toLowerCase();
        if (!['.html', '.css', '.js'].includes(ext)) continue;
        this.scanned.add(job.url);
        const text = this.text(job);
        const htmlAssets = new Set(ext === '.html' ? [...text.replace(/<!--[\s\S]*?-->/g, '')
          .matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(match => match[1].replace(/&amp;/g, '&')) : []);
        for (const reference of webReferences(text, ext.slice(1))) {
          const previous = this.jobs.size;
          this.add(reference, job.url, { reason: 'web-reference',
            required: ext === '.css' || htmlAssets.has(reference) });
          discovered ||= previous !== this.jobs.size;
        }
        if (ext === '.js') {
          this.add(new URL(job.url).pathname + '.map', job.url, { reason: 'optional-source-map' });
          const plainMap = new URL(job.url);
          plainMap.pathname = plainMap.pathname.replace(/\.[a-f\d]{5,}(?=\.js$)/i, '') + '.map';
          this.add(plainMap.href, job.url, { reason: 'optional-source-map' });
        }
      }
      if (!discovered && ![...this.jobs.values()].some(job => job.status === 'queued')) break;
    }
    await this.drain();
  }

  addBundle(name, version, settings) {
    if (this.configs.has(name)) return;
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
      this.manifest.warnings.push('Unsupported bundle name: ' + name); return;
    }
    const remote = settings.remoteBundles?.includes(name);
    const serverRoot = settings.server ? String(settings.server).replace(/\/?$/, '/') : null;
    const base = remote && serverRoot ? new URL(`remote/${name}/`, new URL(serverRoot, this.base))
      : new URL(`assets/${name}/`, this.base);
    const filename = 'config' + (version ? '.' + version : '') + '.json';
    const job = this.add(filename, base.href, { relative: `assets/${name}/${filename}`, required: true,
      bundleResource: true, reason: 'bundle-config' });
    this.configs.set(name, { name, version, base, job });
    this.manifest.bundles.push({ name, base: base.href, version });
    this.add('index' + (version ? '.' + version : '') + '.js', base.href, {
      relative: `assets/${name}/index${version ? '.' + version : ''}.js`, bundleResource: true, reason: 'bundle-script',
    });
  }

  importJob(bundle, uuid, required = true) {
    const file = getImportPath(bundle.cfg, uuid, bundle.cfg.extensionMap[uuid] === '.cconb' ? '.cconb' : '.json');
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    const inBundle = path.relative(bundle.cfg.baseDir, file).split(path.sep).join('/');
    return this.add(inBundle, bundle.base.href, { relative, required, bundleResource: true, reason: 'asset-import' });
  }

  async discoverBundles(settings) {
    for (const [name, version] of Object.entries(settings.bundleVers || {})) this.addBundle(name, version, settings);
    for (const name of ['internal', 'main', ...(settings.hasResourcesBundle ? ['resources'] : []),
      ...(settings.hasStartSceneBundle ? ['start-scene'] : []), ...(settings.remoteBundles || [])]) {
      this.addBundle(name, settings.bundleVers?.[name], settings);
    }
    for (const rel of settings.jsList || []) this.add(rel, new URL('src/', this.base).href, { required: true, reason: 'settings-jsList' });
    for (let pass = 0; pass < 20; pass++) {
      await this.drain(); let newBundles = false;
      for (const bundle of this.configs.values()) {
        if (bundle.cfg || bundle.job.status !== 'downloaded') continue;
        const raw = JSON.parse(this.text(bundle.job)); bundle.raw = raw;
        if (raw.isZip || raw.encrypted) {
          this.manifest.unsupportedBundles.push(bundle.name);
          this.manifest.warnings.push(`Bundle ${bundle.name} is zipped/encrypted; individual resources may be unavailable.`);
        }
        const cfg = parseBundleConfig(raw, path.join(this.root, 'assets', bundle.name)); bundle.cfg = cfg;
        for (const dependency of cfg.deps) {
          const before = this.configs.size; this.addBundle(dependency, settings.bundleVers?.[dependency], settings);
          newBundles ||= before !== this.configs.size;
        }
        bundle.imports = new Map();
        const packed = new Set(Object.values(cfg.packs).flat());
        const imports = new Set([...Object.keys(cfg.packs), ...Object.keys(cfg.versions.import)]);
        for (const uuid of cfg.uuids) {
          if (!cfg.redirect[uuid] && !packed.has(uuid)
            && (!Object.keys(cfg.versions.import).length || cfg.versions.import[uuid] !== undefined)) imports.add(uuid);
        }
        for (const uuid of imports) {
          // Some builds retain versions for a child that is available only inside its pack.
          bundle.imports.set(uuid, this.importJob(bundle, uuid, !packed.has(uuid) || !!cfg.packs[uuid]));
        }
      }
      if (!newBundles) break;
    }
    await this.scanWebFiles();
  }

  nativeExtension(bundle, uuid) {
    const mapped = bundle.cfg.extensionMap[uuid];
    if (mapped && !['.json', '.cconb'].includes(mapped)) return mapped;
    let doc;
    const job = bundle.imports.get(uuid);
    if (job?.status === 'downloaded') {
      try { doc = JSON.parse(this.text(job)); } catch { /* Binary import, probe by asset type. */ }
    } else {
      for (const [pack, children] of Object.entries(bundle.cfg.packs)) {
        const index = children.indexOf(uuid); if (index < 0) continue;
        const packedJob = bundle.imports.get(pack); if (packedJob?.status !== 'downloaded') continue;
        try {
          const packed = JSON.parse(this.text(packedJob));
          if (packed?.type === 'cc.Texture2D') return textureExtensions(packed.data.split('|')[index]);
          if (Array.isArray(packed) && packed.length === 6 && typeof packed[0] === 'number') {
            doc = [...packed.slice(0, 5), ...packed[5][index]];
          } else if (Array.isArray(packed)) doc = packed[index];
        } catch { /* Unknown pack format. */ }
        break;
      }
    }
    if (doc) {
      try { doc = rehydrateIFileData(doc) || doc; } catch { /* Inspect raw data if unsupported. */ }
      const find = value => {
        if (!value || typeof value !== 'object') return null;
        if (value.__type__ === 'cc.Texture2D' && typeof value.content === 'string') return textureExtensions(value.content);
        if (typeof value._native === 'string' && value._native) return value._native;
        for (const child of Object.values(value)) { const native = find(child); if (native) return native; }
        return null;
      };
      const native = find(doc);
      if (native) return native;
    }
    const type = bundle.cfg.paths[uuid]?.type;
    return ({ 'cc.Texture2D': '.png', 'cc.ImageAsset': '.png', 'cc.AudioClip': '.mp3', 'cc.TTFFont': '.ttf',
      'cc.VideoClip': '.mp4', 'cc.BufferAsset': '.bin' })[type] || null;
  }

  async downloadNatives() {
    const unresolved = [];
    for (const bundle of this.configs.values()) {
      if (!bundle.cfg) continue;
      const nativeIds = new Set(Object.keys(bundle.cfg.versions.native));
      for (const [uuid, info] of Object.entries(bundle.cfg.paths)) {
        if (['cc.Texture2D', 'cc.ImageAsset', 'cc.AudioClip', 'cc.TTFFont', 'cc.VideoClip', 'cc.BufferAsset'].includes(info.type)
          && !bundle.cfg.redirect[uuid]) nativeIds.add(uuid);
      }
      for (const [uuid, extension] of Object.entries(bundle.cfg.extensionMap)) {
        if (!['.json', '.cconb'].includes(extension) && !bundle.cfg.redirect[uuid]) nativeIds.add(uuid);
      }
      for (const uuid of nativeIds) {
        const formats = this.nativeExtension(bundle, uuid);
        for (let ext of Array.isArray(formats) ? formats : [formats]) {
          let suffix = '';
          if (ext && !ext.startsWith('.')) { suffix = ext; ext = null; }
          const make = extension => {
            const marker = '.__native__';
            const file = extension ? getNativePath(bundle.cfg, uuid, extension)
              : getNativePath(bundle.cfg, uuid, marker).slice(0, -marker.length);
            // Fonts can retain a nested filename under native/<prefix>/<uuid>.<hash>/font.ttf.
            const relative = path.relative(this.root, suffix ? file + '/' + suffix : file).split(path.sep).join('/');
            const inBundle = path.relative(bundle.cfg.baseDir, path.join(this.root, relative)).split(path.sep).join('/');
            return this.add(inBundle, bundle.base.href, { relative, required: false, bundleResource: true, reason: 'native-asset' });
          };
          const job = make(ext || (suffix ? '' : '.png'));
          unresolved.push({ bundle, uuid, ext, suffix, fixed: Array.isArray(formats), jobs: [job], make });
        }
      }
    }
    await this.drain();
    // Native extensions are sometimes absent from packed descriptors. Try common formats only when needed.
    const candidates = ['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.ogg', '.wav', '.ttf', '.otf', '.mp4', '.bin', '.atlas', '.json', '.skel', '.pvr', '.pkm', '.astc'];
    for (const extension of candidates) {
      const pending = unresolved.filter(item => !item.fixed && !item.jobs.some(job => job.status === 'downloaded'));
      if (!pending.length) break;
      for (const item of pending) {
        if (item.suffix || item.ext === extension || item.jobs.some(job => job.url.endsWith(extension))) continue;
        item.jobs.push(item.make(extension));
      }
      await this.drain();
    }
    this.manifest.missingNatives = unresolved.filter(item => !item.jobs.some(job => job.status === 'downloaded'))
      .map(item => ({ bundle: item.bundle.name, uuid: item.uuid, format: item.ext, attempted: item.jobs.map(job => job.url) }));
  }

  async run() {
    this.add(this.entry.href, this.entry.href, { required: true, reason: 'entry' });
    await this.scanWebFiles();
    let settings;
    for (const job of this.jobs.values()) {
      if (job.status === 'downloaded' && /\/settings(?:\.[^/]+)?\.js$/.test(new URL(job.url).pathname)) {
        settings = parseSettings(this.text(job)); if (settings) break;
      }
    }
    if (!settings) {
      this.manifest.warnings.push('No Creator 2.4 _CCSettings found. Only discovered web entry resources were downloaded; this build format is not fully supported.');
      this.save(); throw new Error(this.manifest.warnings.at(-1));
    }
    this.manifest.engine = 'Creator 2.4 bundle build';
    for (const job of this.jobs.values()) {
      const filename = path.posix.basename(new URL(job.url).pathname);
      if (settings.debug ? filename === 'cocos2d-js.js' : /^cocos2d-js-min(?:\.[^.]+)?\.js$/.test(filename)) {
        job.required = true;
      }
    }
    await this.discoverBundles(settings);
    console.log(`Discovered ${this.configs.size} bundles; downloading native resources...`);
    await this.downloadNatives();
    await this.scanWebFiles();
    this.manifest.failedRequired = [...this.jobs.values()].filter(job => job.required && job.status !== 'downloaded')
      .map(job => ({ url: job.url, path: job.path, status: job.status, error: job.error }));
    const downloaded = [...this.jobs.values()].filter(job => job.status === 'downloaded');
    this.manifest.summary = { bundles: this.configs.size, files: downloaded.length,
      bytes: downloaded.reduce((sum, job) => sum + job.bytes, 0), failedRequired: this.manifest.failedRequired.length,
      missingNatives: this.manifest.missingNatives.length,
      unsupportedBundles: this.manifest.unsupportedBundles.length,
      optionalMissing: [...this.jobs.values()].filter(job => !job.required && job.status !== 'downloaded').length };
    this.manifest.finishedAt = new Date().toISOString(); this.save();
    console.log(JSON.stringify(this.manifest.summary, null, 2));
    console.log('Output: ' + this.root + '\nReport: ' + this.manifestPath);
    return !this.manifest.failedRequired.length && !this.manifest.missingNatives.length && !this.manifest.unsupportedBundles.length;
  }
}

async function main() {
  if (typeof fetch !== 'function') throw new Error('This script requires Node.js 18 or newer.');
  const integer = (value, min, max) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Expected integer ${min}..${max}`);
    return number;
  };
  const opts = new Command().description('Download a Creator 2.4 web build and every bundle listed in its manifests')
    .requiredOption('--url <url>', 'web index.html URL')
    .requiredOption('--output <directory>', 'new directory, or an earlier download of the same URL')
    .option('--concurrency <number>', 'parallel requests (1..16)', value => integer(value, 1, 16), 6)
    .option('--retries <number>', 'retries after network/server errors (0..5)', value => integer(value, 0, 5), 2)
    .option('--timeout <ms>', 'per-request timeout', value => integer(value, 1000, 120000), 30000)
    .option('--max-files <number>', 'discovery file limit', value => integer(value, 1, 1000000), 50000)
    .option('--allow-external', 'also follow referenced resources on other hosts')
    .parse(process.argv).opts();
  const downloader = new Downloader(opts);
  try { if (!await downloader.run()) process.exitCode = 1; }
  catch (error) { downloader.save(); throw error; }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { Downloader, parseSettings, webReferences, safeRelative, textureExtensions };
