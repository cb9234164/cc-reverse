# 本次修改与验证说明

基线：上游 cc-reverse 2.1.2，提交 `070cafb3d16cd3ed9346587db41860335fdbd7a9`。

## 通用源码修复

| 文件 | 修复原因及行为 |
| --- | --- |
| `src/core/cocos3x/bundleConfig.js` | versions 中数字表示 UUID 表索引，字符串表示资源或 pack ID。避免 `parseInt('0b014bcf9')` 把 pack 错当为索引 0，使 MD5 import 路径能匹配磁盘文件。 |
| `src/core/cocos3x/engine3x.js` | 识别 `src/settings.<hash>.js`，优先普通 settings.js；正确读取 settings.engineVersion，缺失时从 cocos2d-js 引擎文本读取版本；同时规范化 23 位脚本 meta UUID。未知版本保留原有 2.4.14 回退，不统一硬编码成 2.4.11。 |
| `src/core/cocos3x/rehydrate.js` | TRS 输出编辑器需要的 Float64Array TypedArray 描述；按 Creator 的低字节红色顺序还原 packed Color，修复位置/缩放和颜色异常。 |
| `src/utils/uuidUtils.js` | 增加 23 位脚本 UUID 的半字节解码，保留 @ 后缀，避免组件类型与脚本 meta UUID 不一致；继续支持原有 22 位 UUID。 |

回归用例覆盖 pack hash、数字索引、字符串 UUID、hash settings 和真实版本、TypedArray TRS、各通道不同的颜色、23 位脚本 UUID 和后缀。另将一个现有测试的路径断言改为兼容 Windows 分隔符，生产资源处理代码不因此改动。

## 项目恢复配方

新增 `scripts/orbit-options.js`、`recover-orbit-project.js`、`recover-orbit.js`、`recover-orbit-images.py`、`prepare-orbit.js`、`recover-orbit-aliases.js`、`finalize-orbit.js`、`validate-orbit.js` 和 `write-orbit-report.js`。

这些文件把先前手工操作整理为从本仓库可重复运行的流程，目录和编辑器路径通过参数传入。完整入口拒绝覆盖非空目录。修复步骤与校验步骤分开，`validate-orbit.js` 不修改 assets，只生成报告。项目专用脚本不会改变通用 CLI 的默认恢复行为，也不包含游戏源码和资源。

操作方法与输出说明见 [恢复指南](creator-2.4-recovery.md)。

交互入口：仓库根目录 `recover-orbit.bat` 调用 `scripts/recover-orbit-interactive.js`，每次提示输入路径和可选开关。使用 Node 参数数组启动恢复进程，带空格、中文、`&`、`!` 的路径不经过 shell 拼接；依赖缺失、无效路径、非空输出目录会给出提示。

无 source map 的脚本位置：新增 `scripts/orbit-script-paths.js`，在写出模块之前统一规划 JS 路径并修正相对 require。优先使用 source map 的路径和内容、包内路径、可复用的路径映射及依赖关系。`scripts/orbit-default-script-paths.json` 保存本项目之前恢复的 414 个模块的原路径（无源码），作为本项目的默认路径映射；其他项目可传入 `--script-paths`，BAT 也提供此输入项。路径确实丢失时保留 RecoveredScripts 备用目录并记录原因，不声称找回不存在的目录信息。只读校验新增相对 CommonJS require 检查。

## 本地验证记录（2026-10-21）

- `npm test -- --runInBand --silent`：18 个测试套件、177 项测试全部通过，含没有 map、只有 sources 没有 sourcesContent、带内容的 hash map 三种脚本恢复用例。
- 完整新输出验证：输入 `D:\OrbitMiniGameZhaoCha\build\web-mobile`，输出 `D:\cc-reverse2-verification`，没有复用已恢复工程的 assets 或导入缓存。
- 输出 101 个 bundle 配置、412 份原始源码、414 个编译 JS 模块、3 个场景、179 个预制体、170 个动画文件。
- 新输出静态校验中，源码哈希差异、重复 UUID、孤立 meta、语法错误、缺失相对 import、越界对象索引、无效文档、缺失资源引用、未知脚本类型、图片错误均为 0。
- 新输出经 Creator 2.4.11 实际 Web Mobile 重新构建成功，日志：`D:\cc-reverse2-verification\_recovery\creator-build.log`，结束行为 `Built to "D:\cc-reverse2-verification\build\web-mobile" successfully`。未逐关验证运行行为。
- 补齐 2 份已擦除的类型声明，归档 1 个空音频并生成静音占位，生成 20 个共享资源路径副本。补充文件均明确标记，不冒充原始源码。
- 无 source map 验证：当前输入目录已不含 bundle map，使用之前保存的路径映射，完整恢复到 `D:\cc-reverse2-no-map-verification`；414 个模块定位到原目录（其中 2 个擦除模块仍补充为 TS 类型声明）。原始 source map 源码数为 0，相对 import/require、脚本类型和资源引用检查全部通过；Creator 2.4.11 实际 Web Mobile 构建成功，见该输出 `_recovery/creator-build.log`。内置默认路径表与本次验证的已知路径映射相同。

## 提交建议

修改已经保存在工作区，尚未执行 git add、commit 或 push。建议先审查 `git diff`，再分两次提交：

1. 通用修复与测试：`src/core/cocos3x/{bundleConfig,engine3x,rehydrate}.js`、`src/utils/uuidUtils.js`、对应 `__tests__/` 文件。建议标题 `fix: restore Creator 2.4 hashed builds and script UUIDs`。
2. 文档与项目配方：`README.md`、`docs/creator-2.4-*.md`、上述 9 份 `scripts/` 文件，以及 `recover-orbit.bat`、`scripts/recover-orbit-interactive.js`、`scripts/orbit-script-paths.js`、`scripts/orbit-default-script-paths.json`、`__tests__/orbitRecovery.test.js` 和 `__tests__/orbitScriptPaths.test.js`。建议标题 `feat: add reproducible recovery and original compiled script placement`。

目标仓库开始时 58 份跟踪文件只有 CRLF/LF 差异；已逐文件核对字节后去除这些纯换行噪声，使 diff 只展示本次实际修改。没有重置语义内容。
