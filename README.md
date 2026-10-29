<div align="center">

# dsh-everything-find

**把 Windows 上的 Everything 索引接成模型可调用的文件搜索工具**

不用先猜目录，也不用走 shell —— 模型调一次 `everything_find` 就能全盘定位文件。

[![npm](https://img.shields.io/npm/v/dsh-everything-find?style=flat-square&color=4D6BFE)](https://www.npmjs.com/package/dsh-everything-find)
[![License](https://img.shields.io/github/license/oldHan2423/dsh-everything-find?style=flat-square)](https://github.com/oldHan2423/dsh-everything-find/blob/main/LICENSE)
[![Stars](https://img.shields.io/github/stars/oldHan2423/dsh-everything-find?style=flat-square&color=yellow)](https://github.com/oldHan2423/dsh-everything-find/stargazers)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&logo=windows11&logoColor=white)](https://www.voidtools.com/)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A5%200.1.7-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

[它解决什么问题](#它解决什么问题) · [工作原理](#工作原理) · [快速开始](#快速开始) · [工具](#工具everything_find) · [配置](#配置) · [降级](#可用性与降级) · [排查](#排查) · [限制](#前置条件与已知限制)

中文 | [English](README.en.md)

</div>

底层用 Everything 官方命令行接口 **ES**（`es.exe`）通过 IPC 查询正在运行的 Everything：**不修改 Everything 的任何设置，也不需要开启 HTTP 服务**。插件随包分发 `es.exe`，装完即用。

## 它解决什么问题

`glob` / `grep` 按路径模式递归扫描：知道大致目录时很快，全盘找一个只记得名字的文件则很慢。Everything 在 NTFS 索引上按文件名匹配，全盘查询毫秒级返回，还能按大小、修改时间、类型过滤。

| 要找什么 | 用哪个 |
|---|---|
| 只记得文件名片段，例如 `*.spec.ts` | `everything_find` |
| 已知目录，想列出里面的东西 | `everything_find` + `path`（只要直系子项再加 `directOnly`） |
| 按大小、修改时间、类型筛选 | `everything_find`：`size:>1mb`、`dm:today`、`ext:ts` |
| 文件内容里的字符串 | `grep` —— Everything 不建内容索引 |
| 非 Windows，或 Everything 没在跑 | 内置 `glob` / `grep` —— 探测失败时插件不注册工具，自动回落 |

## 工作原理

```mermaid
flowchart LR
  A[模型] -->|everything_find| B[插件 host.js]
  B -->|spawn| C[es.exe]
  C -->|IPC| D[Everything]
  D --> E[(NTFS 索引)]
```

1. 按下面的解析顺序找到 `es.exe`。
2. 每次调用 spawn 一次 `es.exe`，把结果导出到临时 JSON 文件再读回：`es.exe` 的控制台输出走 ANSI 代码页（非 ASCII 路径会乱码），导出文件才是 UTF-8。
3. 附 `-name -path-column -size -dm` 让导出直接带文件名、路径、大小、修改时间；取满 `max` 的页面再问一次 `-get-result-count`，拿到真实总数。

## 快速开始

前置只有两条：**Windows**，以及 **Everything 正在运行**（已索引你要搜的卷）。

### 安装

```powershell
# 从 npm 安装（已发布，推荐）
dsh plugin --profile web add dsh-everything-find

# 或直接从 GitHub 安装
dsh plugin --profile web add github:oldHan2423/dsh-everything-find

# 从源码运行时用 pnpm dsh …；装了全局 dsh 就直接用 dsh …
```

`dsh plugin` 把参数转交给 **profile 目录里**的 pnpm，所以 `file:`、本地目录、git、tarball 等规格同样可用；装完按提示重启。

手动安装：把本包放进 profile 的 `node_modules`，并在 profile 的 `package.json` 中把它加入 `dependencies` 与 `dsh.profile.bundles`。

> **manifest 必须是不带 BOM 的 UTF-8**：启动时会直接 `JSON.parse` 每个 bundle 的 `package.json`，带 BOM 会让实例起不来。

`file:` 安装只在安装时把文件链进 profile。之后再改源码不会自动同步：重跑一次 `dsh plugin … add`（或把改动过的文件拷进 `node_modules/dsh-everything-find`）再重载。

### 第一次调用

问模型「D 盘上的 .spec.ts 都在哪」，它调的是：

```json
// 入参
{ "query": "*.spec.ts", "type": "files", "max": 20 }
```

```json
// 返回
{
  "count": 1,
  "total": 1,
  "truncated": false,
  "results": [
    { "name": "a.spec.ts", "path": "D:\\repo\\tests", "size": 1234, "dateModified": "2026-09-11T15:19:18" }
  ]
}
```

## 工具：`everything_find`

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 条件 | Everything 搜索语法：空格＝AND，`\|`＝OR，`!`＝排除；支持 `ext:ts`、`dm:today`、`size:>1mb`、`path:foo`；用 `*` 匹配全部 |
| `path` | 条件 | 限定目录**及其所有子目录**；只给 `path` 就是列出整棵子树 |
| `directOnly` | | 只列 `path` 的**直系子项**、不递归（必须与 `path` 同用，对应 es.exe 的 `-parent`） |
| `max` | | 返回条数上限，默认取配置里的 `maxResults`（50），最多 1000 |
| `type` | | `any` / `files` / `folders` |
| `sort` | | 取 `name`、`path`、`size`、`extension`、`date-created`、`date-modified`、`date-accessed`、`attributes`、`filelist-filename`、`run-count`、`date-recently-changed`、`date-run` 之一 |
| `descending` | | 降序 |

`query` 与 `path` **至少给一个**：两者都不给会被拒绝（否则 Everything 会静默返回整个索引的开头一页）；只给 `path` 等价于 `query: "*"` 加上 `path`。

`count` 是本页条数，`total` 是 Everything 报告的真实匹配总数，`truncated` 表示这页没覆盖全部匹配：取满 `max` 的页面会去问 Everything 要真实总数，而没取满的页面本身**就是**全集。想看剩下的请提高 `max`（最多 1000）或收窄 `query`/`path`。

## 配置

DSH 0.1.7 及以上：**设置 → 插件 → `dsh-everything-find`**，配置卡片就在该 bundle 自己的页面上、描述下方，样式与文案和内置插件的设置页一致。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `esExe` | 空 | 指定 `es.exe` 的绝对路径；留空则按下面的顺序自动探测 |
| `esInstance` | 空 | 要查询的 Everything 实例名（`es.exe -instance`）；留空＝普通安装所使用的未命名实例 |
| `timeoutMs` | `10000` | `es.exe` 等待 Everything 数据库加载完成再发查询的毫秒数（`es.exe -timeout`）。索引很大或磁盘很慢时调大 |
| `maxResults` | `50` | `everything_find` 未显式指定 `max` 时的返回上限（单次调用最多可要到 1000） |

`es.exe 路径`框在没有手动覆盖时**直接显示当前生效的路径**，下面一行标出它的来源（配置里的路径 / 随包副本 / 系统 PATH / 常见安装位置）；打开卡片时自动检测一次。**不动它就等于没有覆盖**，插件的自动探测照旧，也不会往配置里写死路径；一旦手动填写或用「浏览…」选入，就成为固定覆盖值（字段上出现「已覆盖」，可用「恢复默认」清回自动）。`Everything 实例名`没有可探测来源，留空即默认的未命名实例。

旁边两个按钮：

- **重新检测** —— 重跑一次探测（改完 `PATH` 或新装了 ES 之后点一下即可）。
- **浏览…** —— 打开本机目录选择器，选中 es.exe 所在的目录（通常是 `C:\Program Files\Everything`），插件会自动定位该目录下的 `es.exe` 并填入路径；**填入后仍需点「保存」才生效**。

「浏览…」用的是 DSH 官方的目录选择能力（本机部署是系统原生选择框）；只提供网页内浏览后端的部署（例如远程访问）不会显示这个按钮，此时手填路径即可。

### 解析顺序

`es.exe` 按下面的顺序解析（前面的优先，找到一个就用）：

1. 配置卡片里的 `esExe`
2. `cordis.yml` / 插件 patch 的 `config.esExe`
3. **随包分发的 `bin/es.exe`** —— 默认路径，装完即用
4. 系统 `PATH`
5. 常见安装位置（`C:\Program Files\Everything\es.exe`、Scoop、Chocolatey 等）

保存后下一次调用即用新值：字段是 `volatile` 的，配置改动原地生效、不会重挂插件，也不需要重启。

### 用 patch 覆盖

若某个部署的设置界面不下发任何配置表单，就到 profile 的 `cordis.patch.yml` 里覆盖本 bundle 插入的那条 entry：

```yaml
- id: dsh-everything-find
  config:
    esExe: 'C:\Program Files\Everything\es.exe'
    timeoutMs: 20000
    maxResults: 100
```

### DSH 版本兼容性

配置卡片用官方设置页的同款组件渲染（`SettingsForm` + `SettingsValueField`），需要 DSH **0.1.7 及以上**：它走 `configForms` 服务 +「插件」页的 `plugins.bundle.config` 槽，字段声明为 `volatile`，保存后原地生效、无需重挂插件。更早的版本没有这套设置机制，本插件仍照常提供 `everything_find` 工具，但配置只能写在 profile 的 `cordis.patch.yml` 里，界面上没有配置卡片。

## 可用性与降级

插件加载后异步探测一次（用配置里的 `timeoutMs`），据此决定要不要暴露 `everything_find`：

- **探测通过** → 注册工具；它的描述会引导模型**优先用它找文件或目录**，grep 留给文件内容检索。
- **判定不可用**（`es.exe` 解析不到，或 ES 退出码 8＝Everything 的 IPC 窗口不在）→ **不注册该工具**，文件检索自动回到 DSH 内置的 glob / grep（原生兜底）。把 Everything 启起来后，重载插件或重启 DSH 即恢复。
- **其它错误**（含探测本身异常）→ 保持注册（fail-open）；问题在调用时报出，错误信息会提示改用内置 glob。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 模型始终不用 `everything_find` | 探测判定不可用：`es.exe` 解析不到，或 Everything 没在跑 | 启动 Everything，在设置卡片点「重新检测」；或重载插件 / 重启 DSH |
| 报 `Everything is not running (its IPC window was not found)` | ES 退出码 8，Everything 的 IPC 窗口不在 | 启动 Everything（托盘常驻即可） |
| 报 `es.exe was not found at: <路径>` | 配置里的 `esExe` 指向了不存在的文件 | 设置卡片里点「恢复默认」回到自动探测，或改成正确路径 |
| 报 `Error 6: Unknown switch` | `esExe` 指向的 ES 早于 1.1.0.3x | 换回随包的 `bin/es.exe`（1.1.0.38），或升级 ES |
| 明明存在的文件搜不到 | 该卷没进 Everything 索引，或索引过期 | 在 Everything 里加索引 / 重建；先用 `type: any` 排除类型过滤的影响 |
| 返回 `truncated: true` | 命中数超过 `max` | 提高 `max`（最多 1000）或收窄 `query` / `path` |
| 配置改了不生效 | 没点「保存」；或 DSH 早于 0.1.7，界面没有卡片 | 点「保存」；旧版本改 profile 的 `cordis.patch.yml` |
| 多实例安装时查到别的实例 | `esInstance` 留空＝未命名实例 | 填上要查询的 Everything 实例名 |

## 前置条件与已知限制

- **仅 Windows**：Everything 只有 Windows 版。
- **Everything 需常驻运行**：`es.exe` 通过 IPC 与它通信；未运行时的表现见上一节（工具不会被注册）。
- **需要 ES 1.1.0.3x 及以上**：每次查询都以 `--` 开关终止符收尾，而 ES 1.1.0.27 会报 `Error 6: Unknown switch`；随包的是 1.1.0.38。把 `esExe` 指向更老的 ES 会让每次调用都失败。
- **只匹配文件名与路径**，不能搜文件内容（Everything 未开内容索引）；内容检索用 grep 工具（工具描述里也写明了）。
- **只搜已建立索引的卷**：Everything 的索引范围决定能搜到哪里。
- **单页最多 1000 条**：要看更多请收窄查询，而不是继续加大 `max`。

## 开发

### 没有构建步骤

host 半边是纯 ESM（`host.js`），浏览器半边是手写的 lazy-CJS factory（`client.js`）：没有 TypeScript、没有打包器，改完同步+重启即可，不需要 `pnpm build`。

| 文件 | 作用 |
|---|---|
| `host.js` | host 半边：`everything_find` 工具、配置 schema、`es.exe` 探测与查询 |
| `client.js` | 浏览器半边：设置页里的配置卡片 |
| `cordis.patch.yml` | bundle patch：向 profile 插入本插件的 entry |
| `bin/es.exe` | 随包分发的 ES 1.1.0.38 |
| `test/smoke.mjs` | 两半边的自测，不需要测试框架 |

### 自测

`test/smoke.mjs` 不需要测试框架就能跑通两半边。请从**装好的副本**里运行，因为它 import 的 DSH 包要靠 profile 解析：

```powershell
node <profile>\node_modules\dsh-everything-find\test\smoke.mjs
```

它检查工具 schema、参数处理、真实 `es.exe` 的结果契约，以及卡片的注册与写入链路；Everything 没运行时，涉及 `es.exe` 的用例会自动跳过。

## 许可证与第三方

- 本插件：MIT
- 随包分发的 `bin/es.exe` 来自 [voidtools/ES](https://github.com/voidtools/ES)（MIT，Copyright (c) 2025 voidtools），全文见 `LICENSE-ES.txt`

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=oldHan2423/dsh-everything-find&type=Date)](https://star-history.com/#oldHan2423/dsh-everything-find&Date)

<div align="center">

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

</div>
