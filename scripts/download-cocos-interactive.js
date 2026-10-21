const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const repo = path.resolve(__dirname, '..');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = rl[Symbol.asyncIterator]();
rl.on('SIGINT', () => rl.close());
async function ask(prompt, fallback = '') {
  process.stdout.write(prompt + (fallback ? ` [默认：${fallback}]` : '') + '：');
  const line = await lines.next();
  if (line.done) throw new Error('已取消，未开始下载。');
  const value = line.value.trim() || fallback;
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
async function main() {
  console.log('\nCocos Creator 2.4 网页构建下载器');
  console.log('按清单下载所有 bundle；同一网址可重复运行，校验已有文件后继续。\n');
  let url;
  for (;;) {
    url = await ask('输入 index.html 网址');
    try { if (/^https?:$/.test(new URL(url).protocol)) break; } catch { /* Ask again. */ }
    console.log('请输入有效的 HTTP(S) 网址。');
  }
  let output;
  while (!output) output = await ask('输入本地输出目录（新目录，或此网址的旧下载目录）');
  let concurrency;
  for (;;) {
    concurrency = await ask('并发下载数 1～16', '6');
    if (/^\d+$/.test(concurrency) && Number(concurrency) >= 1 && Number(concurrency) <= 16) break;
  }
  rl.close();
  const args = [path.join(__dirname, 'download-cocos-web.js'), '--url', url,
    '--output', path.resolve(repo, output), '--concurrency', concurrency];
  const child = spawn(process.execPath, args, { cwd: repo, stdio: 'inherit', windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}
main().catch(error => { rl.close(); console.error(error.message); process.exitCode = 1; });
