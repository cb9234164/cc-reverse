# Creator 2.4.11 工程、源码和 JS 恢复指南

本指南记录 `OrbitMiniGameZhaoCha/build/web-mobile` 的恢复过程。通用兼容修复位于 `src/`；`scripts/*orbit*` 是针对该项目的恢复配方，不是任意 Cocos 项目的一键通用转换器。

## 为什么原来没有看到 JS

上游工具的 2.x 脚本转换默认把拆出的编译代码写成 `.ts`，通常在 `assets/Scripts/`，所以只搜索 `.js` 容易误以为脚本没有恢复。当前 `src/core/script/transform.js` 的 2.x 发射路径仍使用 `.ts`，仅修改 `codeGen.language` 不会把这一流程全部改成 `.js`。

编译代码与原始源码是两份不同内容：

- 有 source map 且 `sourcesContent` 完整时，可以恢复其中保存的原始 TS/JS；这次找到了 412 份，并核对 SHA-256。
- 没有 source map 时，通常只能拆分编译后的 JS。格式化、恢复 require 路径不能找回原注释、类型声明或所有变量名。
- 原项目本来使用 TypeScript 时，恢复到 `assets/` 的原源码仍是 `.ts`。本配方额外导出编译 JS，避免和编辑器使用的源码重复挂载。

## 环境准备

以下命令在 PowerShell 中执行，示例使用已有仓库 `D:\cc-reverse2`。建议 Node.js 18 或更高版本、Python 3.9 或更高版本，并安装 Cocos Creator 2.4.11。

```powershell
Set-Location D:\cc-reverse2
npm ci --ignore-scripts --no-audit --no-fund
python -m pip install "Pillow>=9.1"
node --version
python -c "from PIL import Image; print(Image.__version__)"
```

若 Python 是不包含 pip 的嵌入式版本，请使用已有 Pillow 的 Python，或在完整 Python 环境安装后通过 `--python` 指定解释器路径。

## 一条命令运行完整配方

也可直接双击仓库根目录的 `recover-orbit.bat`，按提示逐次输入构建目录、输出目录、Creator 路径、Python 路径和可选的脚本路径映射文件，再选择是否处理空音频、是否实际构建。映射留空使用本项目内置路径表。路径支持空格、中文和带引号粘贴；Y/N 选项按回车默认选择 Y。输入错误或输出目录非空时可以重新输入，按 Ctrl+C 取消。首次使用仍需先安装上述依赖。BAT 会调用 `scripts/recover-orbit-interactive.js`，运行后保留窗口显示结果。

选择一个**不存在或为空的输出目录**。已有工程会被拒绝，不会自动清空。输入、输出不能互相包含。

//D:\cc-reverse2-downloads\OpalOracle-webGL6
//D:\OpalOracle-webGL6-recovered2
```powershell
Set-Location D:\cc-reverse2
node .\scripts\recover-orbit-project.js `
  --source "D:\OrbitMiniGameZhaoCha\build\web-mobile" `
  --output "D:\OrbitMiniGameZhaoCha-recovered2" `
  --creator "D:\cocos-dashboard-editors\Creator\2.4.11\CocosCreator.exe" `
  --replace-empty-audio `
  --build
```

路径可自行修改。添加 `--python "C:\path\to\python.exe"` 可指定解释器。去掉 `--build` 只恢复和静态校验；不会声称完成编辑器构建。查看参数：

```powershell
node .\scripts\recover-orbit-project.js --help
```

`--replace-empty-audio` 用于本项目的原始空音频：先归档原文件及 meta，再生成 0.1 秒静音 WAV，保留 UUID。它不会还原丢失的声音。不传此参数且发现空音频时，流程会停下并列出文件。

### 没有 source map 时，JS 放在哪里

没有 source map 或没有 `sourcesContent` 时，脚本会输出编译后的 `.js` 和 `.meta`，优先放回原来的 `assets/` 子目录，并根据最终目录重写相对 `require`。例如原来是 `assets/Game/Script/gain/ClickEffect.ts`，此时输出 `assets/Game/Script/gain/ClickEffect.js`。

本项目默认加载 `scripts/orbit-default-script-paths.json`：这是之前有 source map 时保存的 414 个模块的路径表，只含 bundle、模块名、UUID 和路径，不含游戏源码。它按 UUID 和 bundle 匹配；若当前包内有更新的原路径或 source map，则优先使用包内信息。内置表能让当前项目即使删除所有 `.map` 也保留原目录。

其他项目可以通过 `--script-paths` 传入自己的路径 JSON，或之前恢复输出的 `_recovery/manifest.json`。例如在完整命令中加上：

```powershell
  --script-paths "D:\previous-recovery\_recovery\manifest.json"
```

手写路径表格式示例（UUID 可选，未提供时按模块名匹配）：

```json
[
  { "bundle": "main", "id": "Player", "path": "assets/scripts/player/Player.ts" },
  { "bundle": "main", "id": "GameConfig", "path": "assets/scripts/config/GameConfig.js" }
]
```

路径表用于定位目录；无原始源码时 `.ts` 路径仍输出成 `.js`。也会利用包内保留的 assets 路径、调试路径注释、sourceURL，以及已知脚本之间的相对依赖推导路径。仅靠相对依赖无法找回被删除的所有目录名称；如果发布包只剩模块名、没有路径表或任何路径线索，就无法保证精确原目录，脚本会放入 `assets/RecoveredScripts/<bundle>/`，在 `manifest.warnings` 和每个模块的 `pathReason` 中标明原因。冲突路径会停止恢复，避免覆盖其他脚本。

每次恢复还会生成 `_recovery/script-paths.json`，可在下次通过 `--script-paths` 复用。有 `sourcesContent` 的原始 `.ts/.js` 仍按原内容恢复，不会被编译 JS 替换。

脚本依次执行上游 CLI、资源和源码恢复、图片/字体/图集转换、内置资源归档及纹理 UUID 修正、共享 bundle 路径副本、明确标注的项目补齐、只读静态校验和可选 Creator 构建。任一步非零退出都会停止。失败后可检查输出，完整重跑时请选另一个空目录。

## 分步命令

这些是完整配方内部执行的命令，适合排查；不要在已经完成恢复的目录里重复执行第一、二步。

```powershell
Set-Location D:\cc-reverse2
$recoveryBuild = "D:\OrbitMiniGameZhaoCha\build\web-mobile"
$recoveryOutput = "D:\OrbitMiniGameZhaoCha-recovered2"
$recoveryCreator = "D:\cocos-dashboard-editors\Creator\2.4.11\CocosCreator.exe"
$recoveryArgs = @('--source', $recoveryBuild, '--output', $recoveryOutput,
                  '--creator', $recoveryCreator, '--replace-empty-audio')

# 1. 上游工具的第一轮输出，不包含下面所有项目适配。
node .\bin\cc-reverse.js --path $recoveryBuild --output $recoveryOutput --version-hint 2.4.x
if ($LASTEXITCODE -ne 0) { throw 'cc-reverse failed' }

# 2. 把第一轮 assets 归档，再从构建包重建可编辑资源和脚本。
node .\scripts\recover-orbit.js @recoveryArgs
if ($LASTEXITCODE -ne 0) { throw 'Asset/source recovery failed' }

# 3. 还原独立精灵图片、字体和图集元数据。
python .\scripts\recover-orbit-images.py --output $recoveryOutput
if ($LASTEXITCODE -ne 0) { throw 'Image recovery failed' }

# 4. 归档重复的引擎内置资源、修正裁切纹理的父 UUID。
node .\scripts\prepare-orbit.js @recoveryArgs
if ($LASTEXITCODE -ne 0) { throw 'Asset preparation failed' }

# 5. 补齐共享 bundle 资源的可寻址路径。
node .\scripts\recover-orbit-aliases.js @recoveryArgs
if ($LASTEXITCODE -ne 0) { throw 'Bundle alias recovery failed' }

# 6. 补齐已擦除的纯类型声明、处理空音频、导出 JS 原目录副本。
node .\scripts\finalize-orbit.js @recoveryArgs
if ($LASTEXITCODE -ne 0) { throw 'Project finalization failed' }

# 7. 只读检查 assets；仅写校验报告，发现错误时返回非零。
node .\scripts\validate-orbit.js @recoveryArgs
if ($LASTEXITCODE -ne 0) { throw 'Static validation failed' }
node .\scripts\write-orbit-report.js @recoveryArgs
```

分步执行时若要构建，可运行：

```powershell
$recoveryLog = Join-Path $recoveryOutput '_recovery\creator-build.log'
$recoveryProcess = Start-Process -FilePath $recoveryCreator -WindowStyle Hidden -PassThru `
  -ArgumentList @('--path', ('"' + $recoveryOutput + '"'),
                  '--build', 'platform=web-mobile;debug=true',
                  '--logfile', ('"' + $recoveryLog + '"'))
$recoveryProcess.WaitForExit()
if (!(Test-Path -LiteralPath $recoveryLog) -or
    !(Select-String -LiteralPath $recoveryLog -Pattern 'Built to .+ successfully' -Quiet)) {
  throw "Creator 尚未确认构建成功，请检查 $recoveryLog"
}
node .\scripts\write-orbit-report.js @recoveryArgs
```

不要只根据编辑器启动或进程退出判断构建成功。完整配方的 `--build` 会同时检查退出状态和成功日志。首次导入会生成 `library/`、`temp/`，可能需要较长时间；脚本不会自动删除已有工程的缓存。

## 输出位置

```text
<output>/
  assets/                         Creator 实际使用的源码与资源
  project.json                    Creator 2.4.11 工程入口
  settings/                       项目与构建设置
  README_还原说明.md               本次动态统计与限制说明
  RECOVERY_REPORT.md               上游第一轮报告
  _recovery/
    js-modules/<bundle>/          414 个拆分、格式化的编译 JS
    js-source-tree/assets/        编译 JS 按原源码目录排列的副本
    original-js/                  原始打包 JS、引擎和 source map
    cc-reverse-output/assets/     第一轮工具输出的备份
    import-documents/             解码后的导入数据，供排查
    manifest.json                 源码哈希、模块映射、资源列表、告警
    script-paths.json              已知脚本路径，下次可用 --script-paths 复用
    VALIDATION.json               静态校验结果
    image-validation.json         图像转换结果
    preparation.json              内置资源归档和纹理 UUID 修正记录
    bundle-aliases.json           共享资源路径副本记录
    repairs.json                  类型补充和静音占位记录
    builtin-assets/               提取到的引擎内置资源副本
    erased-type-modules/          被类型补充替代的空编译模块
    corrupt-media/                原始空音频及 meta
    creator-build.log             使用 --build 时生成
```

在 Dashboard 添加输出目录，选择 Creator 2.4.11。该项目入口是 `assets/core/Scene/Login.fire`，主场景是 `assets/core/Scene/Main.fire`。

## 已知补齐与限制

- `LevelConfigTypes.ts` 和 `VideoTypes.ts` 的原类型声明未包含在 source map。脚本只为该项目已知的两份擦除模块生成 `any` 类型别名，保留脚本 UUID，在文件头标明补充来源。这两份文件不计入 412 份原始源码。
- `level_full_qrwz/audio/p2.mp3` 在输入构建里就是 0 字节；静音占位不代表声音恢复成功。
- 多 bundle 共享同一资源时保留一份原 UUID，另外补齐可按路径加载的资源副本，并分配新 UUID，避免资源数据库冲突。
- 自动图集能恢复图像和帧数据，无法保证还原打包前完全相同的 atlas 设置。工程使用指定 Creator 的内置资源，提取副本保留在 `_recovery/`。
- 配方包含本项目的 750×1334 分辨率、场景名称和补充类型路径；换项目需要适配这些约定。它不自动恢复加密 JS、远程缺失 bundle 或不存在的原始 source map。
- 静态检查覆盖源码哈希、语法、相对 import、UUID 重复、资源引用、脚本组件类型、对象表索引和图片错误。它不等价于完整 TypeScript 类型检查，也不覆盖所有动态 require/运行时路径。
- 构建通过仍需逐关验证玩法、广告/平台 SDK 和网络接口。

## 验证和提交

```powershell
Set-Location D:\cc-reverse2
npm test -- --runInBand --silent
git diff --check
git status --short
```

通用修复、测试和文档可作为一个提交；`scripts/*orbit*` 项目配方可作为另一个提交。具体路径见 [修改说明](creator-2.4-changes.md)。不要把原游戏资源、恢复输出、`node_modules/`、`library/`、`temp/` 或构建日志加入工具仓库。
