// The BAT delegates input handling here so paths never become shell commands.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const repo = path.resolve(__dirname, '..');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
let interrupted = false;
rl.on('SIGINT', () => { interrupted = true; rl.close(); });

async function ask(prompt, fallback = '') {
  process.stdout.write(prompt + (fallback ? ` [默认：${fallback}]` : '') + '：');
  const line = await lines.next();
  if (line.done) throw new Error(interrupted ? '已取消。' : '输入结束，未执行恢复。');
  return line.value.trim() || fallback;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

async function askPath(prompt, kind, optional = false) {
  for (;;) {
    const input = unquote(await ask(prompt));
    if (!input) {
      console.log('请输入路径，可以直接粘贴带引号的路径。');
      continue;
    }
    const absolute = path.resolve(repo, input);
    try {
      if (optional && !fs.existsSync(absolute)) return absolute;
      const stat = fs.statSync(absolute);
      if (kind === 'file' ? stat.isFile() : stat.isDirectory()) return absolute;
    } catch { /* Explain and allow another input below. */ }
    console.log(kind === 'file' ? '文件不存在，请重新输入。' : '目录无效，请重新输入。');
  }
}

async function askYesNo(prompt, defaultYes) {
  for (;;) {
    const value = (await ask(prompt + (defaultYes ? ' (Y/n)' : ' (y/N)'), defaultYes ? 'y' : 'n')).toLowerCase();
    if (['y', 'yes', '是'].includes(value)) return true;
    if (['n', 'no', '否'].includes(value)) return false;
    console.log('请输入 Y 或 N，也可按回车使用默认选项。');
  }
}

async function main() {
  console.log('\ncc-reverse / Creator 2.4.11 交互式恢复');
  console.log('这是 Orbit 项目恢复配方；参数可更换，其他项目可能需要适配。');
  console.log('输出请选择不存在或为空的目录。按 Ctrl+C 可取消。\n');
  const source = await askPath('输入构建目录（例如 D:\\game\\build\\web-mobile）', 'directory');
  let output;
  for (;;) {
    output = await askPath('输入恢复输出目录', 'directory', true);
    const contains = (parent, child) => {
      const rel = path.relative(parent, child);
      return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
    };
    if (contains(source, output) || contains(output, source)) {
      console.log('输入、输出目录不能相同或互相包含，请另选输出目录。');
      continue;
    }
    if (fs.existsSync(output) && fs.readdirSync(output).length) {
      console.log('输出目录非空，请选择新目录；已有文件不会被清空。');
      continue;
    }
    break;
  }
  const creator = await askPath('输入 Creator 2.4.11 的 CocosCreator.exe 路径', 'file');
  const python = unquote(await ask('Python 命令或 python.exe 完整路径（需安装 Pillow）', 'python'));
  let scriptPaths = unquote(await ask('原脚本路径映射 JSON 或旧 manifest.json（留空使用本项目内置映射）'));
  while (scriptPaths && (!fs.existsSync(path.resolve(repo, scriptPaths)) || !fs.statSync(path.resolve(repo, scriptPaths)).isFile())) {
    console.log('映射文件不存在，请重新输入，或直接回车跳过。');
    scriptPaths = unquote(await ask('原脚本路径映射文件（可留空）'));
  }
  const replaceEmptyAudio = await askYesNo('是否把空音频归档并替换为静音 WAV', true);
  const build = await askYesNo('恢复后是否用 Creator 实际构建', true);
  rl.close();

  const args = [path.join(__dirname, 'recover-orbit-project.js'),
    '--source', source, '--output', output, '--creator', creator, '--python', python];
  if (replaceEmptyAudio) args.push('--replace-empty-audio');
  if (scriptPaths) args.push('--script-paths', path.resolve(repo, scriptPaths));
  if (build) args.push('--build');
  console.log('\n开始执行：');
  console.log(JSON.stringify({ source, output, creator, python, scriptPaths, replaceEmptyAudio, build }, null, 2));
  console.log('');
  // Pass an argument array directly; spaces, Chinese, &, ! are literal path characters.
  const child = spawn(process.execPath, args, { cwd: repo, stdio: 'inherit', windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code === null ? 1 : code));
  });
  if (process.exitCode === 0) console.log('\n恢复完成，输出目录：' + output);
}

main().catch(error => {
  rl.close();
  console.error('\n' + error.message);
  process.exitCode = interrupted ? 130 : 1;
});
