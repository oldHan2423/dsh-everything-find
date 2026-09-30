# dsh-everything-find

中文 | [English](README.en.md)

Windows 上的 [Everything](https://www.voidtools.com/) 文件名搜索，接入 DeepSeek Harness：模型可以直接调用 `everything_find` 全盘找文件，不必先猜目录，也不必走 shell。

底层用 Everything 官方命令行接口 **ES**（`es.exe`）通过 IPC 查询正在运行的 Everything —— **不修改 Everything 的任何设置，也不需要开启 HTTP 服务**。插件随包分发 `es.exe`，装完即用。

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

返回结构：

```json
{
  "count": 1,
  "total": 1,
  "truncated": false,
  "results": [
    { "name": "a.spec.ts", "path": "D:\\repo\\tests", "size": 1234, "dateModified": "2026-09-11T15:19:18" }
  ]
}
```

`count` 是本页条数，`total` 是 Everything 报告的真实匹配总数，`truncated` 表示这页没覆盖全部匹配：取满 `max` 的页面会去问 Everything 要真实总数，而没取满的页面本身**就是**全集。想看剩下的请提高 `max`（最多 1000）或收窄 `query`/`path`。

## 配置

DSH 0.1.7 及以上：**设置 → 插件 → `dsh-everything-find`**，配置卡片就在该 bundle 自己的页面上、描述下方，样式与文案和内置插件的设置页一致。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `esExe` | 空 | 指定 `es.exe` 的绝对路径；留空则按下面的顺序自动探测 |
| `esInstance` | 空 | 要查询的 Everything 实例名（`es.exe -instance`）；留空＝普通安装所使用的未命名实例 |
| `timeoutMs` | `10000` | `es.exe` 等待 Everything 数据库加载完成再发查询的毫秒数（`es.exe -timeout`）。索引很大或磁盘很慢时调大 |
| `maxResults` | `50` | `everything_find` 未显式指定 `max` 时的返回上限（单次调用最多可要到 1000） |

`es.exe 路径` 框在没有手动覆盖时**直接显示当前生效的路径**，下面一行标出它的来源（配置里的路径 / 随包副本 / 系统 PATH / 常见安装位置）；打开卡片时自动检测一次。**不动它就等于没有覆盖**，插件的自动探测照旧，也不会往配置里写死路径；一旦手动填写或用「浏览…」选入，就成为固定覆盖值（字段上出现「已覆盖」，可用「恢复默认」清回自动）。`Everything 实例名` 没有可探测来源，留空即默认的未命名实例。

旁边两个按钮：

- **重新检测** —— 重跑一次探测（改完 `PATH` 或新装了 ES 之后点一下即可）。
- **浏览…** —— 打开本机目录选择器，选中 es.exe 所在的目录（通常是 `C:\Program Files\Everything`），插件会自动定位该目录下的 `es.exe` 并填入路径；**填入后仍需点「保存」才生效**。

「浏览…」用的是 DSH 官方的目录选择能力（本机部署是系统原生选择框）；只提供网页内浏览后端的部署（例如远程访问）不会显示这个按钮，此时手填路径即可。

`es.exe` 的解析顺序（前面的优先，找到一个就用）：

1. 配置卡片里的 `esExe`
2. `cordis.yml` / 插件 patch 的 `config.esExe`
3. **随包分发的 `bin/es.exe`** —— 默认路径，装完即用
4. 系统 `PATH`
5. 常见安装位置（`C:\Program Files\Everything\es.exe`、Scoop、Chocolatey 等）

保存后下一次调用即用新值：字段是 `volatile` 的，配置改动原地生效、不会重挂插件，也不需要重启。若某个部署的设置界面不下发任何配置表单，就到 profile 的 `cordis.patch.yml` 里覆盖本 bundle 插入的那条 entry：

```yaml
- id: dsh-everything-find
  config:
    esExe: 'C:\Program Files\Everything\es.exe'
    timeoutMs: 20000
    maxResults: 100
```

### DSH 版本兼容性

配置卡片用官方设置页的同款组件渲染（`SettingsForm` + `SettingsValueField`），需要 DSH **0.1.7 及以上**：它走 `configForms` 服务 + 「插件」页的 `plugins.bundle.config` 槽，字段声明为 `volatile`，保存后原地生效、无需重挂插件。更早的版本没有这套设置机制，本插件仍照常提供 `everything_find` 工具，但配置只能写在 profile 的 `cordis.patch.yml` 里，界面上没有配置卡片。

## 安装

```powershell
# 从源码运行时用 pnpm dsh …；装了全局 dsh 就直接用 dsh …
pnpm dsh plugin --profile web add dsh-everything-find
```

`dsh plugin` 把参数转交给 **profile 目录里**的 pnpm，所以 `file:`、本地目录、git、tarball 等规格同样可用；装完按提示重启。

手动安装：把本包放进 profile 的 `node_modules`，并在 profile 的 `package.json` 中把它加入 `dependencies` 与 `dsh.profile.bundles`。

> **manifest 必须是不带 BOM 的 UTF-8**：启动时会直接 `JSON.parse` 每个 bundle 的 `package.json`，带 BOM 会让实例起不来。

`file:` 安装只在安装时把文件链进 profile。之后再改源码不会自动同步：重跑一次 `dsh plugin … add`（或把改动过的文件拷进 `node_modules/dsh-everything-find`）再重载。

## 没有构建步骤

host 半边是纯 ESM（`host.js`），浏览器半边是手写的 lazy-CJS factory（`client.js`）：没有 TypeScript、没有打包器，改完同步+重启即可，不需要 `pnpm build`。

`test/smoke.mjs` 不需要测试框架就能跑通两半边。请从**装好的副本**里运行，因为它 import 的 DSH 包要靠 profile 解析：

```powershell
node <profile>\node_modules\dsh-everything-find\test\smoke.mjs
```

它检查工具 schema、参数处理、真实 `es.exe` 的结果契约，以及卡片的注册与写入链路；Everything 没运行时，涉及 `es.exe` 的用例会自动跳过。

## 可用性与降级

插件加载后异步探测一次（用配置里的 `timeoutMs`），据此决定要不要暴露 `everything_find`：

- **探测通过** → 注册工具；它的描述会引导模型**优先用它找文件或目录**，grep 留给文件内容检索。
- **判定不可用**（`es.exe` 解析不到，或 ES 退出码 8＝Everything 的 IPC 窗口不在）→ **不注册该工具**，文件检索自动回到 DSH 内置的 glob / grep（原生兜底）。把 Everything 启起来后，重载插件或重启 DSH 即恢复。
- **其它错误**（含探测本身异常）→ 保持注册（fail-open）；问题在调用时报出，错误信息会提示改用内置 glob。

## 前置条件与已知限制

- **仅 Windows**：Everything 只有 Windows 版。
- **Everything 需常驻运行**：`es.exe` 通过 IPC 与它通信；未运行时的表现见上一节（工具不会被注册）。
- **需要 ES 1.1.0.3x 及以上**：每次查询都以 `--` 开关终止符收尾，而 ES 1.1.0.27 会报 `Error 6: Unknown switch`；随包的是 1.1.0.38。把 `esExe` 指向更老的 ES 会让每次调用都失败。
- **只匹配文件名与路径**，不能搜文件内容（Everything 未开内容索引）；内容检索用 grep 工具（工具描述里也写明了）。
- **只搜已建立索引的卷**：Everything 的索引范围决定能搜到哪里。
- **单页最多 1000 条**：要看更多请收窄查询，而不是继续加大 `max`。

## 许可证与第三方

- 本插件：MIT
- 随包分发的 `bin/es.exe` 来自 [voidtools/ES](https://github.com/voidtools/ES)（MIT，Copyright (c) 2025 voidtools），全文见 `LICENSE-ES.txt`
