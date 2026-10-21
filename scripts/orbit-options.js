// Shared arguments for the OrbitMiniGameZhaoCha recovery recipe.
const fs = require('fs');
const path = require('path');
const { Command } = require('commander');

function loadOptions() {
  const cli = new Command()
    .description('Project-specific Cocos Creator 2.4.11 Web Mobile recovery')
    .requiredOption('--source <directory>', 'original web-mobile build')
    .requiredOption('--output <directory>', 'recovery directory (full recipe requires empty output)')
    .requiredOption('--creator <executable>', 'Cocos Creator 2.4.11 executable')
    .option('--python <executable>', 'Python with Pillow installed', 'python')
    .option('--script-paths <json>', 'original script paths JSON or a previous _recovery/manifest.json')
    .option('--replace-empty-audio', 'archive empty audio and create silent WAV placeholders')
    .option('--build', 'also rebuild with Creator and verify its success log')
    .parse(process.argv);
  const opts = cli.opts();
  for (const key of ['source', 'output', 'creator']) opts[key] = path.resolve(opts[key]);
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
  };
  if (inside(opts.source, opts.output) || inside(opts.output, opts.source)) {
    throw new Error('Source and output directories must not contain one another.');
  }
  if (!fs.statSync(opts.source).isDirectory() || !fs.statSync(opts.creator).isFile()) {
    throw new Error('Source directory or Creator executable is invalid.');
  }
  return opts;
}

module.exports = { loadOptions };
