/**
 * dsh-everything-find host half: exposes the local Everything file-name index as the
 * `everything_find` model tool, and publishes esExe/esInstance/timeoutMs/maxResults as this
 * plugin's configuration.
 *
 * es.exe is Everything's official command-line interface (ES); it reaches the running Everything
 * over IPC, so this plugin changes no Everything setting and needs no HTTP server. es.exe writes
 * console output in the ANSI code page (mojibake for non-ASCII paths) while its file export is
 * UTF-8, so every query exports JSON to a temp file and reads that back.
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)

/** Package directory, used to locate the es.exe shipped with this plugin. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** Settings namespace and profile entry id; also the key the Web card pairs with. */
export const SETTINGS_NAMESPACE = 'dsh-everything-find'

/** Result cap when neither the call nor the settings supply one. */
const DEFAULT_MAX = 50

/** Hard ceiling for one page: a larger page buries the caller's context in paths. */
const MAX_RESULTS = 1000

/** Milliseconds es.exe waits for the Everything database to load before sending a query. */
const DEFAULT_TIMEOUT_MS = 10000

/** Extra headroom over `timeoutMs` before the child process is killed. */
const EXEC_GRACE_MS = 15000

/** Route prefix this plugin's configuration card talks to. */
const ROUTE_PREFIX = '/dsh-everything-find/api'

/** How long one native directory chooser may stay open before the pending request gives up. */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

/** Sort names ES documents for `-sort`; an unknown name makes es.exe exit 4. */
const SORT_NAMES = [
  'name',
  'path',
  'size',
  'extension',
  'date-created',
  'date-modified',
  'date-accessed',
  'attributes',
  'filelist-filename',
  'run-count',
  'date-recently-changed',
  'date-run',
]

export const name = 'dsh-everything-find'
export const inject = ['tools']

/**
 * User-overridable configuration shared by the composition entry and the settings page.
 *
 * Every field is `volatile`: DSH's settings forms serve only live (volatile) fields, so a plain
 * field would leave this plugin with no configuration form at all, and a volatile field is the one
 * that can change without remounting the plugin. The plugin therefore reads each value through
 * {@link readConfig}, which unwraps the live handle the loader hands over for such a field.
 */
export const Config = z.object({
  esExe: z.string().default('').description(
    'es.exe（Everything 命令行接口）的绝对路径。留空则自动探测：随包副本 → 系统 PATH → 常见安装位置。',
  ).volatile(),
  esInstance: z.string().default('').description(
    '要查询的 Everything 实例名（对应 es.exe 的 -instance）。普通安装使用未命名实例，留空即可。',
  ).volatile(),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS).description(
    `es.exe 等待 Everything 数据库加载完成再发查询的毫秒数（对应 es.exe 的 -timeout，默认 ${DEFAULT_TIMEOUT_MS}）。索引很大或磁盘较慢时调大。`,
  ).volatile(),
  maxResults: z.natural().default(DEFAULT_MAX).description(
    `调用未显式指定 max 时的返回条数上限（默认 ${DEFAULT_MAX}，单次调用最多 ${MAX_RESULTS}）。`,
  ).volatile(),
})

/**
 * Read one configuration value from either generation.
 *
 * A volatile field reaches the plugin as a live handle rather than a value, so reading it through
 * the handle is what makes an edit take effect without remounting; the 0.1.5 settings source hands
 * back plain values instead.
 * @param source - the resolved configuration object.
 * @param key - the field name.
 * @returns the current value, or undefined when the field is absent.
 */
function readConfig(source, key) {
  const value = source?.[key]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Resolve the es.exe to run: explicit setting, bundled copy, PATH, then common install locations.
 * @param configured - the path the user configured (may be empty).
 * @returns the chosen es.exe and which candidate supplied it, or undefined when none of them exists.
 */
function resolveEsExe(configured) {
  const candidates = []
  if (configured) candidates.push({ path: configured, source: 'configured' })
  candidates.push({ path: join(PACKAGE_DIR, 'bin', 'es.exe'), source: 'bundled' })
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push({ path: join(dir, 'es.exe'), source: 'path' })
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  candidates.push({ path: join(programFiles, 'Everything', 'es.exe'), source: 'install' })
  candidates.push({ path: join(programFilesX86, 'Everything', 'es.exe'), source: 'install' })
  if (process.env.LOCALAPPDATA) candidates.push({ path: join(process.env.LOCALAPPDATA, 'Programs', 'Everything', 'es.exe'), source: 'install' })
  if (process.env.USERPROFILE) candidates.push({ path: join(process.env.USERPROFILE, 'scoop', 'shims', 'es.exe'), source: 'install' })
  candidates.push({ path: 'C:\\ProgramData\\chocolatey\\bin\\es.exe', source: 'install' })
  for (const candidate of candidates) {
    // A candidate can exist yet be unreadable (denied ACL, broken reparse point); probe defensively.
    try {
      if (existsSync(candidate.path) && statSync(candidate.path).isFile()) return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Find es.exe inside a directory the operator picked.
 * @param directory - absolute directory path.
 * @returns the es.exe path inside it, or undefined when the directory holds none.
 */
function locateEsExe(directory) {
  const candidate = join(directory, 'es.exe')
  try {
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * Answer one configuration-card request with JSON.
 * @param res - the response owning the request lifecycle.
 * @param payload - the JSON-serializable body.
 */
function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * Normalize a result cap to a positive integer inside the page ceiling.
 * @param value - the raw cap (tool argument or settings value).
 * @param fallback - the configured default, used when the raw cap is missing or not usable.
 * @returns a positive integer cap no larger than {@link MAX_RESULTS}.
 */
function normalizeMax(value, fallback) {
  const configured = Number(fallback)
  const preferred = Number.isFinite(configured) && configured >= 1
    ? Math.min(Math.floor(configured), MAX_RESULTS)
    : DEFAULT_MAX
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return preferred
  return Math.min(Math.floor(numeric), MAX_RESULTS)
}

/**
 * Normalize the database-load timeout to a positive integer number of milliseconds.
 * @param value - the configured timeout.
 * @returns a positive integer number of milliseconds.
 */
function normalizeTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_TIMEOUT_MS
  return Math.floor(numeric)
}

/**
 * Split Everything query text into the arguments es.exe expects.
 *
 * ES treats each command-line argument as one search term and ANDs the arguments, so a
 * space-separated query has to arrive as separate arguments. Passing the whole text as one
 * argument searches for it as a literal phrase, which is why `ext:log dm:today` matched
 * nothing while `ext:log` worked. A double-quoted run stays one argument, so `"Program Files"`
 * keeps its Everything phrase meaning.
 * @param text - the caller's Everything query text.
 * @returns one argument per term, with blank terms dropped.
 */
function splitQueryTerms(text) {
  const terms = []
  let term = ''
  let quoted = false
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted
      term += char
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (term !== '') terms.push(term)
      term = ''
      continue
    }
    term += char
  }
  if (term !== '') terms.push(term)
  return terms
}

/**
 * Build the filter switches shared by the result query and the total-count query.
 * @param options - normalized query options.
 * @returns the switches that select what is searched, before any display switch.
 */
function filterArgs(options) {
  const args = ['-timeout', String(options.timeoutMs)]
  if (options.instance) args.push('-instance', options.instance)
  // `-path` searches the whole subtree below the folder; `-parent` matches only entries whose own
  // parent is that folder, which is how a caller asks for a folder's direct children.
  if (options.path) args.push(options.directOnly ? '-parent' : '-path', options.path)
  if (options.type === 'files') args.push('/a-d')
  if (options.type === 'folders') args.push('/ad')
  return args
}

/**
 * Run one Everything query and read its JSON export back.
 * @param esExe - absolute path to es.exe.
 * @param options - normalized query options.
 * @returns the raw result rows reported by Everything.
 */
async function query(esExe, options) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-es-'))
  const out = join(dir, 'out.json')
  try {
    const args = [...filterArgs(options), '-json', '-name', '-path-column', '-size', '-dm', '-date-format', '1', '-n', String(options.max)]
    if (options.sort) args.push('-sort', options.sort)
    if (options.descending) args.push('-sort-descending')
    // `--` disables switch parsing, so every switch must precede it and the query text follows it.
    args.push('-export-json', out, '--', ...splitQueryTerms(options.query))

    try {
      await execFileAsync(esExe, args, { windowsHide: true, timeout: options.timeoutMs + EXEC_GRACE_MS })
    } catch (error) {
      // ES exit code 8: no Everything IPC window, i.e. Everything is not running.
      if (error?.code === 8) throw new Error('Everything is not running (its IPC window was not found). Start Everything, or use the built-in glob tool meanwhile.')
      // ENOENT means the configured path does not exist: say which path, not a raw spawn message.
      if (error?.code === 'ENOENT') {
        throw new Error(`es.exe was not found at: ${esExe}. Fix \`esExe\` in this plugin's configuration card on the Plugins page (or in the profile patch); meanwhile use the built-in glob tool.`)
      }
      throw new Error(`es.exe failed: ${error?.stderr?.trim() || error?.message || String(error)}. If Everything stays unavailable, use the built-in glob tool.`)
    }

    const text = (await readFile(out, 'utf8')).trim()
    return text.length === 0 ? [] : JSON.parse(text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Ask Everything for the total number of matches, so a full page reports an honest total.
 * @param esExe - absolute path to es.exe.
 * @param options - the normalized options the page was fetched with.
 * @returns the match total, or undefined when the count query itself fails.
 */
async function countMatches(esExe, options) {
  const args = [...filterArgs(options), '-get-result-count', '--', ...splitQueryTerms(options.query)]
  try {
    const { stdout } = await execFileAsync(esExe, args, { windowsHide: true, timeout: options.timeoutMs + EXEC_GRACE_MS })
    const total = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(total) ? total : undefined
  } catch {
    // The page already answered, so an unavailable total only costs the exact `truncated` reading.
    return undefined
  }
}

/**
 * Probe whether an index actually answers, so a machine that never installed Everything keeps only
 * the built-in glob/grep tools instead of carrying a tool whose every call fails.
 * @param esExe - the resolved es.exe path, or undefined when no candidate exists.
 * @param timeoutMs - the configured database-load timeout.
 * @returns whether the tool should stay registered (unproven availability keeps it registered).
 */
async function everythingAnswers(esExe, timeoutMs) {
  if (!esExe) return false
  const dir = await mkdtemp(join(tmpdir(), 'dsh-es-probe-'))
  try {
    const args = ['-timeout', String(timeoutMs), '-n', '1', '-export-json', join(dir, 'probe.json'), '--', '*']
    await execFileAsync(esExe, args, { windowsHide: true, timeout: timeoutMs + EXEC_GRACE_MS })
    return true
  } catch (error) {
    // Exit code 8 is the documented "no Everything IPC window"; any other failure keeps the tool
    // registered so its own call reports the specific problem rather than vanishing silently.
    return error?.code !== 8
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Render the structured result as model-readable text.
 * @param value - the tool's structured value.
 * @returns one full path per line.
 */
function render(value) {
  if (value.results.length === 0) return 'No matches.'
  const lines = value.results.map(item => (item.dateModified ? `${item.path}\\${item.name}  [${item.dateModified}]` : `${item.path}\\${item.name}`))
  const tail = value.truncated
    ? `\n(${value.count} of ${value.total} matches shown; raise \`max\` or narrow \`query\`/\`path\` to see the rest)`
    : ''
  return `${value.count} match(es):\n${lines.join('\n')}${tail}`
}

/**
 * Register the everything_find tool and publish this plugin's configuration.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - the composition entry config (cordis.yml / plugin patch).
 */
export function apply(ctx, config) {
  // Authoritative config source: the resolved composition entry. A `volatile` field reaches the
  // plugin as a live handle, so an edit is visible without remounting (readConfig unwraps it); the
  // 0.1.5 settings service, where it exists, swaps in its own source instead.
  let current = () => config ?? {}

  ctx.inject(['settings'], (settingsCtx) => {
    // 0.1.7 replaced `SettingsProvider.installSection` with `SettingsForms`: the entry's own
    // (volatile) Config already carries every edit, so `config` above stays authoritative there.
    // Guarded so one package serves both provider generations.
    if (typeof settingsCtx.settings.installSection !== 'function') return
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config ?? {}, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  })

  const registeredTool = ctx.tools.register(defineTool({
    name: 'everything_find',
    description:
      'Search files and folders across every indexed drive by name or path through the local '
      + 'Everything index - far faster and wider than scanning a directory tree. Prefer this tool '
      + 'to locate any file or folder on disk, and treat the built-in glob tool and directory scans '
      + 'as the fallback for when this tool reports that Everything is unavailable. Read the paths '
      + 'it returns. `path` searches that folder AND all of its subfolders, unless `directOnly` asks '
      + 'for the folder\'s own children instead; it matches names and paths only, so it cannot search '
      + 'file contents - use grep for that.',
    parameters: {
      query: {
        type: 'string',
        description:
          'Everything search syntax: space means AND, `|` means OR, `!` excludes, and operators '
          + 'like `ext:ts`, `dm:today`, `size:>1mb`, `path:foo` are supported. Use `*` to match '
          + 'every name, for example with `path` to list a folder tree.',
      },
      path: { type: 'string', description: 'Restrict the search to this folder and all its subfolders. Pass it without `query` to list that folder tree.' },
      directOnly: { type: 'boolean', description: 'List only the direct children of `path` instead of its whole subtree (requires `path`).' },
      max: { type: 'integer', description: `Maximum number of results to return (default ${DEFAULT_MAX}, ceiling ${MAX_RESULTS}).` },
      type: {
        type: 'string',
        enum: ['any', 'files', 'folders'],
        description: 'Restrict results to files or folders (default any).',
      },
      sort: { type: 'string', enum: SORT_NAMES, description: 'Sort property (default: Everything\'s own relevance order).' },
      descending: { type: 'boolean', description: 'Sort descending instead of ascending.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                size: { type: 'integer' },
                dateModified: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: render(value) }],
      // The Web search card cannot be rebuilt from the rendered text, so project the page into the
      // result metadata that `presentResult` narrows back on live and replay paths alike.
      presentationMeta: (_args, value) => ({
        paths: value.results.map(item => `${item.path}\\${item.name}`),
        truncated: value.truncated,
        total: value.total,
      }),
    },
    async execute(args) {
      const resolved = current() ?? {}
      const esExe = resolveEsExe(readConfig(resolved, 'esExe'))?.path
      if (!esExe) {
        throw new Error(
          'everything_find is unavailable: es.exe (the Everything command-line interface) was '
          + 'not found. Install ES from https://www.voidtools.com/downloads/#cli, or set the esExe '
          + 'path on this plugin\'s configuration card (Settings > Plugins > dsh-everything-find) '
          + 'or in the profile patch. Until then, use the built-in glob tool to locate files.',
        )
      }
      // A blank query is only meaningful as a path-filtered listing; with neither a query nor a
      // path, Everything would silently return the head of the whole index.
      const searchText = (args.query ?? '').trim()
      const path = (args.path ?? '').trim() || undefined
      if (searchText === '' && path === undefined) {
        throw new Error(
          'everything_find needs something to find: pass `query` (Everything syntax), or '
          + '`path` alone to list that folder tree.',
        )
      }
      if (args.directOnly === true && path === undefined) {
        throw new Error(
          'everything_find: `directOnly` describes how to search one folder, so it needs `path` too.',
        )
      }
      const options = {
        query: searchText || '*',
        path,
        directOnly: args.directOnly === true,
        max: normalizeMax(args.max ?? readConfig(resolved, 'maxResults'), readConfig(resolved, 'maxResults')),
        type: args.type ?? 'any',
        sort: args.sort,
        descending: args.descending === true,
        timeoutMs: normalizeTimeout(readConfig(resolved, 'timeoutMs')),
        instance: String(readConfig(resolved, 'esInstance') ?? '').trim() || undefined,
      }
      const rows = await query(esExe, options)
      const results = rows.map(row => ({
        name: row.name,
        path: row.path,
        ...(typeof row.size === 'number' ? { size: row.size } : {}),
        ...(row.date_modified ? { dateModified: row.date_modified } : {}),
      }))
      // Only a full page can be short of the match set, and only then is the extra es.exe run
      // worth its latency; a short page already IS the whole match set.
      const total = rows.length >= options.max ? await countMatches(esExe, options) : results.length
      return {
        count: results.length,
        total: total ?? results.length,
        truncated: total === undefined ? rows.length >= options.max : total > results.length,
        results,
      }
    },
    // query is optional now, so a path-only call must still get a readable title.
    presentCall: args => ({ card: 'generic', title: `Everything: ${args.query || args.path || ''}`, kind: 'search', rawInput: args }),
    // Narrow the projected page back into the Web search card. Malformed or absent metadata (an
    // older log, a nested call) returns undefined so the card falls back to the rendered text
    // instead of throwing during replay; a zero-match page is a legitimate empty card.
    presentResult: (_args, result) => {
      const meta = result?.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
      const { paths, truncated, total } = meta
      if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) return undefined
      if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
      return {
        card: 'search',
        shape: 'paths',
        title: `Everything: ${paths.length} path(s)`,
        paths,
        truncated,
        total,
      }
    },
  }))

  // Everything is Windows-only and optional: withdraw the tool when nothing answers, so the built-in
  // glob/grep tools stay the only search surface. An inconclusive probe keeps it registered.
  const resolved = current() ?? {}
  void everythingAnswers(resolveEsExe(readConfig(resolved, 'esExe'))?.path, normalizeTimeout(readConfig(resolved, 'timeoutMs'))).then((available) => {
    if (available) return
    if (typeof registeredTool === 'function') registeredTool()
    else if (typeof registeredTool?.dispose === 'function') registeredTool.dispose()
  })

  // The configuration card asks which es.exe is in effect and may open the host's own directory
  // chooser. Both ride this plugin's routes: a third-party bundle owns no Remote of its own, and the
  // official chooser is a directory picker, so a picked directory has its es.exe located here.
  let nativePicker = null
  ctx.inject(['directoryPicker'], (pickerCtx) => {
    const capability = pickerCtx.directoryPicker?.capability?.()
    // Only the native backend can answer "pick one path"; a browse-only deployment keeps the card's
    // manual path field and its automatic detection.
    if (capability?.kind === 'native') nativePicker = capability
  })

  ctx.inject(['webServer'], (webCtx) => {
    const routes = [
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: (_req, res) => {
          const resolved = resolveEsExe(readConfig(current() ?? {}, 'esExe'))
          sendJson(res, {
            path: resolved?.path ?? '',
            source: resolved?.source ?? '',
            pickable: nativePicker !== null,
          })
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/pick`,
        handler: async (_req, res) => {
          if (nativePicker === null) {
            sendJson(res, { ok: false, code: 'unavailable' })
            return
          }
          try {
            const picked = await nativePicker.pick(AbortSignal.timeout(PICK_TIMEOUT_MS))
            if (picked === null) {
              sendJson(res, { ok: false, code: 'cancelled' })
              return
            }
            const located = locateEsExe(picked)
            sendJson(res, { ok: true, directory: picked, path: located ?? picked, located: located !== undefined })
          } catch (error) {
            sendJson(res, { ok: false, code: 'failed', message: String(error?.message ?? error) })
          }
        },
      }),
    ]
    webCtx.effect(() => () => {
      for (const dispose of routes) dispose()
    }, 'dsh-everything-find: configuration routes')
  })
}
