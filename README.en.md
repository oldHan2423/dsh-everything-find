# dsh-everything-find

[中文](README.md) | English

Everything file-name search for DeepSeek Harness on **Windows**: the model can call `everything_find` to locate files anywhere on disk instead of guessing directories or shelling out.

It talks to the running Everything through the official command-line interface **ES** (`es.exe`) over IPC — **it changes no Everything setting and needs no HTTP server**. The plugin ships `es.exe`, so it works right after install.

## Tool: `everything_find`

| Parameter | Required | Meaning |
|---|---|---|
| `query` | conditional | Everything search syntax: space = AND, `\|` = OR, `!` = NOT; supports `ext:ts`, `dm:today`, `size:>1mb`, `path:foo`; `*` matches every name |
| `path` | conditional | Restrict to a folder and **all of its subfolders**; `path` alone lists that whole tree |
| `directOnly` | | List only the **direct children** of `path`, without recursing (requires `path`; es.exe `-parent`) |
| `max` | | Result cap; defaults to the configured `maxResults` (50) and is clamped to 1000 |
| `type` | | `any` / `files` / `folders` |
| `sort` | | One of `name`, `path`, `size`, `extension`, `date-created`, `date-modified`, `date-accessed`, `attributes`, `filelist-filename`, `run-count`, `date-recently-changed`, `date-run` |
| `descending` | | Sort descending |

At least one of `query` or `path` is required: with neither, the call is refused (Everything would otherwise return the head of the whole index); `path` alone behaves like `query: "*"` plus `path`.

Returns:

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

`count` is the size of this page, `total` the number of matches Everything reports, and `truncated` means the page is shorter than the match set: a page that filled `max` asks Everything for the real total, while a short page already **is** the whole set. Raise `max` (up to 1000) or narrow `query`/`path` to see the rest.

## Configuration

On DSH 0.1.7 and later: **Settings → Plugins → `dsh-everything-find`**. The card sits on the bundle's own page, under its description, and renders with the same components as the built-in settings pages.

| Setting | Default | Meaning |
|---|---|---|
| `esExe` | empty | Absolute path to `es.exe`; empty auto-detects (see the order below) |
| `esInstance` | empty | Everything instance name to query (`es.exe -instance`); empty means the unnamed instance a normal installation runs |
| `timeoutMs` | `10000` | Milliseconds `es.exe` waits for the Everything database to finish loading before it sends the query (`es.exe -timeout`). Raise it on a large index or a slow disk |
| `maxResults` | `50` | Default result cap when a call omits `max` (a single call may ask for at most 1000) |

The `es.exe path` control **shows the path in effect** while nothing overrides it, and the line under it names its origin (the configured path, the bundled copy, the system `PATH`, or a common install location); the card detects once as soon as it opens. **Leaving the control untouched overrides nothing**: automatic detection stays in force and no path is written to the configuration. Typing a path or picking one with Browse turns it into a pinned override — the field then shows the overridden badge, and Reset restores the automatic behavior. `Everything instance` has nothing to detect, so an empty value is the default unnamed instance.

Beside the path field:

- **重新检测 (re-detect)** — run the detection again, e.g. after changing `PATH` or installing ES.
- **浏览… (browse)** — open the host's directory chooser and pick the directory holding es.exe (usually `C:\Program Files\Everything`); the plugin locates that directory's `es.exe` and stages it in the path field. **The staged path still needs Save.**

Browse uses DSH's official directory-picker capability (the native OS chooser on a local deployment); a deployment that offers only the in-app browse backend shows no Browse button, and the path field remains the way to set it.

`es.exe` is resolved in this order (first hit wins):

1. `esExe` from the configuration card
2. `config.esExe` in `cordis.yml` / the plugin patch
3. **The bundled `bin/es.exe`** — the default, works right after install
4. The system `PATH`
5. Common install locations (`C:\Program Files\Everything\es.exe`, Scoop, Chocolatey, …)

Saving takes effect on the next call: the fields are `volatile`, so an accepted edit applies in place without remounting the plugin, and no restart is needed. On a deployment whose settings surface serves no configuration form, override the entry the bundle's patch inserts in the profile's `cordis.patch.yml` instead:

```yaml
- id: dsh-everything-find
  config:
    esExe: 'C:\Program Files\Everything\es.exe'
    timeoutMs: 20000
    maxResults: 100
```

### DSH version compatibility

The configuration card renders with the built-in settings pages' own components (`SettingsForm` + `SettingsValueField`) and needs DSH **0.1.7 or later**: it uses the `configForms` service and the Plugins page's `plugins.bundle.config` slot, and declares its fields `volatile`, so an accepted edit applies without remounting the plugin. Earlier releases have no such settings surface: the plugin still provides `everything_find`, but its configuration lives in the profile's `cordis.patch.yml` and no card appears.

## Install

```powershell
# `pnpm dsh …` when running dsh from source; plain `dsh …` for a global install
# GitHub source (available now)
dsh plugin --profile web add github:oldHan2423/dsh-everything-find

# npm source (once published)
pnpm dsh plugin --profile web add dsh-everything-find
```

`dsh plugin` forwards its arguments to pnpm **inside the profile directory**, so `file:`, local-directory, git, and tarball specs work the same way. Restart when it tells you to.

Manual install: drop this package into the profile's `node_modules` and add it to the profile `package.json` under both `dependencies` and `dsh.profile.bundles`.

> **The manifest must be UTF-8 without a BOM**: startup parses every bundle's `package.json` with `JSON.parse`, so a BOM stops the instance from booting.

A `file:` install is linked into the profile at install time. Editing the source afterwards does not reach the running profile: re-run `dsh plugin … add` (or copy the changed files into `node_modules/dsh-everything-find`) and reload.

## No build step

The host half is plain ESM (`host.js`) and the browser half is a hand-written lazy-CJS factory (`client.js`): no TypeScript, no bundler — edit, resync, restart; no `pnpm build`.

`test/smoke.mjs` drives both halves without a test runner. Run it from the installed copy, because the DSH packages it imports resolve through the profile:

```powershell
node <profile>\node_modules\dsh-everything-find\test\smoke.mjs
```

It checks the tool schema, the argument handling, the result contract against the real `es.exe`, and the card's registration and write path; the `es.exe` cases self-skip when Everything is not running.

## Availability and fallback

The plugin probes once asynchronously after load (using the configured `timeoutMs`) and decides whether to expose `everything_find`:

- **Probe passes** → the tool is registered; its description steers the model to **reach for it first when locating files or folders**, keeping grep for file contents.
- **Unavailable** (`es.exe` cannot be resolved, or ES exits 8 = Everything's IPC window is absent) → **the tool is not registered**, so file lookup falls back to the built-in glob / grep tools. Start Everything, then reload the plugin or restart DSH to get it back.
- **Any other error** (including a failed probe) → the tool stays registered (fail-open); the real problem surfaces on the call and tells the model to use the built-in glob tool instead.

## Requirements and known limitations

- **Windows only** — Everything is a Windows tool.
- **Everything must be running** — `es.exe` reaches it over IPC; when it is not, see the section above (the tool is not registered).
- **ES 1.1.0.3x or newer** — every query ends with the `--` switch terminator, which ES 1.1.0.27 rejects with `Error 6: Unknown switch`; the bundled copy is 1.1.0.38. Point `esExe` at an older ES and every call fails.
- **Name and path matches only** — file contents are not searched (Everything has no content index here); use the grep tool for content search (the tool description says so too).
- **Indexed volumes only** — whatever Everything indexes is what can be found.
- **A single page holds at most 1000 rows** — narrow the query rather than raising `max` further.

## License and third party

- This plugin: MIT
- The bundled `bin/es.exe` comes from [voidtools/ES](https://github.com/voidtools/ES) (MIT, Copyright (c) 2025 voidtools); full text in `LICENSE-ES.txt`
