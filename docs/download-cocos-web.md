# 从网址下载 Cocos Creator 网页构建

此脚本用于下载公开的 **Creator 2.4 分包构建**，保留网页构建原目录，供本地查看和后续逆向恢复使用。它会解析 settings 和每个 bundle 的 config，下载入口中尚未加载过的关卡资源，而不只保存浏览器首屏请求。

## 双击运行

首次安装依赖（Node.js 18 或更高版本）：

```powershell
Set-Location D:\cc-reverse2
npm ci --ignore-scripts --no-audit --no-fund
```

双击根目录的 `download-cocos.bat`，依次输入：

1. 网页入口完整网址，例如 `https://hwres.luminp.com/luminp/cp/htt_OpalOracle/webGL6/index.html`。
2. 本地保存目录，例如 `D:\cocos-downloads\OpalOracle-webGL6`。
3. 并发数，回车默认 6。

路径可以包含空格和中文，粘贴路径时可带双引号。下载完成后窗口会保留结果；如果资源不完整，会显示非零退出码，并在报告中记录缺失项。

## 命令行

```powershell
Set-Location D:\cc-reverse2
node .\scripts\download-cocos-web.js `
  --url "https://hwres.luminp.com/luminp/cp/htt_OpalOracle/webGL6/index.html" `
  --output "D:\cocos-downloads\OpalOracle-webGL6" `
  --concurrency 6
```

可选参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--concurrency` | 6 | 同时请求数，范围 1～16 |
| `--retries` | 2 | 网络/服务器错误的额外重试次数，404/410 不重试 |
| `--timeout` | 30000 | 单个请求超时，毫秒 |
| `--max-files` | 50000 | 最多发现的 URL 数量，防止无限抓取 |
| `--allow-external` | 关闭 | 允许跟随其他域名上的普通静态引用；由 settings 明确指定的远程 bundle 已自动支持 |

相同网址、相同输出目录可以重复运行：脚本会用大小和 SHA-256 校验已下载文件，正确文件直接复用，损坏或缺失的文件重新下载。网络中断后运行同一命令即可继续。新输出目录必须不存在或为空；非空目录只有在含有**同一网址**的 `_download/manifest.json` 时才可继续。

## 下载内容

- `index.html`、引用的 CSS、启动脚本、Cocos 引擎脚本，以及 CSS 中的图片/字体。
- `src/settings.<hash>.js` 中列出的所有 bundle，以及 config 的依赖 bundle。
- 每个 bundle 的 `config.<hash>.json`、存在的 `index.<hash>.js`、独立 import 数据和 packed import 数据。
- native 资源：先读取 import 中的扩展名/原文件名；解析 Texture2D 的格式编号和多格式变体并逐个下载；无法确定时尝试常见图片、音频、视频、字体和二进制格式。支持字体的嵌套 native 文件路径。
- 设置中的 `jsList` 运行时插件脚本。
- 已引用的 source map，以及脚本对应 `.js.map` 的可选探测；服务器没有发布 map 时会记录为可选缺失。
- settings 指定的远程 bundle 保存在本地 `assets/<bundle>/`，方便后续工具扫描；普通跨根目录或跨域文件保存在 `_external/`。

脚本把远程 JavaScript 作为文本/语法树读取，不运行游戏代码。下载内容不做解密、不改写游戏文件，也不生成原工程：**下载构建包和恢复工程是两个步骤**。

## 报告与缺失文件

输出目录额外包含 `_download/manifest.json`，记录每个 URL、本地路径、HTTP 状态、字节数、SHA-256、下载结果与资源来源。主要字段：

- `summary.files` / `summary.bytes`：已下载文件数和总字节数。
- `failedRequired`：缺少的入口静态文件、必要引擎脚本、bundle 配置/import 数据。
- `missingNatives`：扩展名探测后仍无法下载的 native 资源。
- `files` 中 `required:false` 且 `status:missing`：可选探测返回 404，例如未发布的 source map、没有脚本的资源 bundle、图片的错误扩展名候选。
- `warnings` / `skipped`：格式限制与未跟随的外域引用。
- `unsupportedBundles`：检测到的 zip/加密 bundle；尚未完整支持时返回非零退出码，不把下载到的部分资源当成完整构建。

退出码为 0 表示当前已识别清单中的必要资源全部取得；不表示成功枚举了服务器所有文件，也不保证游戏完全离线可玩。必要 import 或 native 缺失时返回 1，已下载文件仍然保留。

HTTP 服务通常不提供文件列表，因此脚本无法找回任何地方都未引用的文件、未知名称的 source map、登录后才出现的数据、运行时接口响应或已下线的文件。Creator 2.3、3.x、加密/zip bundle、自定义资源加载协议尚未完整支持，不能用首屏下载结果冒充完整下载。未识别到 2.4 settings 时会明确报错并保留已发现的入口文件。

## 后续还原工程

下载完成后，把下载目录作为恢复工具的 `--source` / `--path` 输入。源 JS 和 source map 的可用情况以下载报告为准。当前仓库的 `recover-orbit-project.js` 是 Orbit 项目专用配方；本网址的项目结构、纯类型补充和原路径映射可能需要另外适配，不能直接沿用 Orbit 内置路径表。

## 验证

`__tests__/downloadCocosWeb.test.js` 使用本地 HTTP 服务验证：hash bundle、未打开的关卡、pack 资源、原生资源扩展名回退、嵌套字体、CSS/source map 引用、损坏文件重下、必要文件缺失报告，以及不执行远程 settings 表达式。

2026-10-21 实测上述 OpalOracle 地址：75 个 bundle，下载 8,802 个文件，共 279,416,866 字节（约 266 MiB），必要资源和 native 资源缺失均为 0；163 个可选候选 URL 不存在，不计入必要文件缺失。实际输出为 `D:\cc-reverse2-downloads\OpalOracle-webGL6`，逐文件结果见其 `_download/manifest.json`。此次没有下载到 source map；服务器未发布的原始文件无法由下载器补出。未在本次验证中执行该游戏或逐关测试玩法。
