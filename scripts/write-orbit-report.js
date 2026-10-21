const fs = require('fs');
const path = require('path');
const { source, output } = require('./orbit-options').loadOptions();
const recovery = path.join(output, '_recovery');
const read = name => JSON.parse(fs.readFileSync(path.join(recovery, name), 'utf8'));
const manifest = read('manifest.json');
const validation = read('VALIDATION.json');
const repairs = read('repairs.json');
const aliases = read('bundle-aliases.json');
const log = path.join(recovery, 'creator-build.log');
const buildLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
const built = /Built to [^\r\n]+ successfully/.test(buildLog) && !/Build Failed|Build failed/.test(buildLog);
const report = [
  '# Creator 2.4.11 构建包恢复记录', '',
  `- 输入：\`${source}\`。仅读取构建包。`,
  `- 输出：\`${output}\`。`,
  `- ${manifest.bundles.length} 个 bundle；${manifest.sourceFiles.length} 份 source map 内嵌原始源码；${manifest.compiledModules.length} 个编译 JS 模块。`,
  `- ${validation.scenes} 个场景、${validation.prefabs} 个预制体、${validation.animations} 个动画文件。`,
  `- Creator 实际重新构建：${built ? '成功，见 _recovery/creator-build.log' : '本次未验证'}。`, '',
  '## 脚本位置', '',
  '- `assets/`：编辑器使用的原始 TS/JS（source map 存在时），或拆包的 JS。',
  '- 无 source map 时，编译 JS 优先放回已知的原 assets 目录；无法确定原路径时放入 RecoveredScripts，并在 manifest.warnings 标明。',
  '- `_recovery/script-paths.json` 可作为后续无 source map 恢复时的 --script-paths 输入；manifest 中的 pathReason 说明每个路径的来源。',
  '- `_recovery/js-modules/<bundle>/`：拆包并格式化的编译 JS。',
  '- `_recovery/js-source-tree/assets/`：同一批 JS 按原源码目录排列的副本。',
  '- `_recovery/original-js/`：原始打包 JS、引擎和 source map。',
  '- `_recovery/cc-reverse-output/`：初次运行 cc-reverse 的输出备份。', '',
  '## 校验与补齐', '',
  '- 静态校验详见 `_recovery/VALIDATION.json`，源码 SHA-256 记录在 manifest.json。',
  `- ${repairs.typeSupplements.length} 份纯类型声明补充：使用 any 别名，原声明未恢复；见 repairs.json。`,
  `- ${repairs.silentAudioPlaceholders.length} 个原始空音频归档后使用静音 WAV 占位，保留 UUID；原声音不可恢复。`,
  `- ${aliases.length} 个共享资源路径副本使用新 UUID；见 bundle-aliases.json。`,
  '- 编辑器内置资源副本保存在 builtin-assets；工程使用所指定编辑器的内置资源。',
  '- 未逐关验证玩法、平台 SDK 或网络行为；没有 source map 的模块只能恢复编译产物。',
  '- 本脚本针对 OrbitMiniGameZhaoCha 2.4.11，不保证适用于其他项目。', '',
].join('\n');
fs.writeFileSync(path.join(output, 'README_还原说明.md'), report);
