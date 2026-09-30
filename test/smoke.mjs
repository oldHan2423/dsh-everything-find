// Checks for dsh-everything-find: the host half runs against the real es.exe through a fake
// cordis context, the browser half through a fake module loader and a minimal hook runtime.
//
// Run it from the installed copy inside a profile (`node node_modules/dsh-everything-find/test/smoke.mjs`),
// because the DSH peer packages this module imports resolve through the profile's node_modules.
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE_DIR = new URL('..', import.meta.url)
const failures = []
const skip = []

/**
 * Record one check.
 * @param label - what the check proves.
 * @param condition - whether it held.
 * @param detail - extra evidence printed beside the result.
 */
function ok(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`)
  if (!condition) failures.push(`${label}${detail ? ' :: ' + detail : ''}`)
}

let host
try {
  host = await import(new URL('host.js', PACKAGE_DIR).href)
} catch (error) {
  console.error(`Cannot load host.js: ${error.message}`)
  console.error('Run this file from the installed copy inside a DSH profile so @deepseek-ai/* resolves.')
  process.exit(1)
}

let definition = null
host.apply({ inject: () => {}, tools: { register: (def) => { definition = def; return () => {} } } }, { maxResults: 50, timeoutMs: 10000 })
ok('host: registers the everything_find tool', definition !== null && definition.name === 'everything_find')
ok('host: parameter spec becomes JSON Schema', definition.parameters?.type === 'object', Object.keys(definition.parameters?.properties ?? {}).join(','))
ok('host: sort is an enum, so a typo never reaches es.exe', (definition.parameters.properties.sort.enum ?? []).includes('date-modified'))
ok('host: description states the subtree semantics', /subfolders/.test(definition.description))

// DSH's settings forms serve only LIVE (volatile) fields: a non-volatile Config makes
// SettingsForms.describe() skip the entry, which leaves the plugin with no configuration page at all.
{
  const volatileForm = (schema) => {
    if (schema.meta.volatile) return schema
    if (schema.type !== 'object') return undefined
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : { dict }
  }
  const form = volatileForm(host.Config)
  const fields = Object.keys(form?.dict ?? {})
  ok('host: every Config field is volatile, so the settings page is served', fields.length === 4, fields.join(',') || 'NONE (entry would be skipped)')
}

/** Run one tool call. */
const run = async (args) => await definition.execute(args, {})

let reachable = true
try {
  await run({ query: '*', max: 1 })
} catch (error) {
  reachable = false
  skip.push(`es.exe checks skipped: ${error.message}`)
}

if (reachable) {
  const multi = await run({ query: 'ext:log dm:today', max: 5 })
  ok('host: a multi-term query returns matches', multi.count > 0, `count=${multi.count} total=${multi.total}`)
  ok('host: total is the real match count, not the page', multi.total >= multi.count, `total=${multi.total}`)
  ok('host: truncated states whether the page is short', multi.truncated === (multi.total > multi.count))

  const none = await run({ query: 'zzzdsheverythingnothing42', max: 5 })
  ok('host: no match is an empty result, not an error', none.count === 0 && none.total === 0 && none.truncated === false, JSON.stringify(none))
  ok('host: empty render says so', definition.output.render({}, none)[0].text === 'No matches.')

  const pathOnly = await run({ path: '.', max: 5 })
  ok('host: path-only listing works', Array.isArray(pathOnly.results))

  // `path` walks the whole subtree; `directOnly` answers "what is in this folder itself".
  const recursive = await run({ path: 'D:\\deepseek-harness', max: 50 })
  const direct = await run({ path: 'D:\\deepseek-harness', directOnly: true, max: 50 })
  ok('host: directOnly lists only the direct children', direct.count > 0 && direct.results.every((row) => row.path === 'D:\\deepseek-harness'), `${direct.count} rows, first=${JSON.stringify(direct.results[0] ?? null)}`)
  ok('host: the same folder without directOnly reaches deeper', recursive.results.some((row) => row.path !== 'D:\\deepseek-harness'), `${recursive.count} rows`)

  const capped = await run({ query: '*', max: 100000 })
  ok('host: a huge max is clamped to the 1000 ceiling', capped.count === 1000, `count=${capped.count}`)

  // The runtime hands `presentResult` a ToolResult whose `meta` is the projection, never the value.
  const asResult = (value) => ({ content: definition.output.render({}, value), isError: false, meta: definition.output.presentationMeta({}, value) })
  const card = definition.presentResult({}, asResult(multi))
  ok('host: presentResult returns the search paths card', card?.card === 'search' && card.shape === 'paths' && card.paths.length === multi.count)
  ok('host: the search card carries the honest total', card.total === multi.total && card.truncated === multi.truncated)
  const emptyCard = definition.presentResult({}, asResult(none))
  ok('host: an empty page is a valid empty card', emptyCard?.paths.length === 0 && emptyCard.total === 0 && emptyCard.truncated === false)
  ok('host: a result without projection metadata has no card', definition.presentResult({}, { content: [], isError: false }) === undefined)
  ok('host: malformed metadata narrows to no card', definition.presentResult({}, { content: [], isError: false, meta: { paths: 7, truncated: 'yes' } }) === undefined)

  // A volatile field reaches the plugin as a live handle; the plugin must read through it instead of
  // treating the handle as the value.
  let liveDefinition = null
  host.apply({ inject: () => {}, tools: { register: (def) => { liveDefinition = def; return () => {} } } }, {
    esExe: { get: () => '' },
    esInstance: { get: () => '' },
    timeoutMs: { get: () => 10000 },
    maxResults: { get: () => 3 },
  })
  const live = await liveDefinition.execute({ query: 'ext:log' }, {})
  ok('host: a volatile handle supplies the live value', live.count === 3, `count=${live.count}`)
}

let blankError = ''
try { await run({}) } catch (error) { blankError = error.message }
ok('host: blank query and path is refused', /needs something to find/.test(blankError))

let directError = ''
try { await run({ query: 'ext:log', directOnly: true }) } catch (error) { directError = error.message }
ok('host: directOnly without a path is refused', /needs `path`/.test(directError), directError.slice(0, 80))

let sortError = ''
try { await run({ query: 'ext:log', sort: 'bogus' }) } catch (error) { sortError = `${error.name ?? ''} ${error.message}` }
ok('host: an unknown sort is rejected before es.exe runs', /sort|enum|one of/i.test(sortError), sortError.slice(0, 80))

// ---------------------------------------------------------------- host routes
/** Call one registered route and parse its JSON answer. */
async function callRoute(handler) {
  const answer = { code: 0, body: '' }
  await handler({}, { writeHead: (code) => { answer.code = code }, end: (text) => { answer.body = text } })
  return JSON.parse(answer.body)
}

// A directory that holds an es.exe, as the operator's picked Everything folder would.
const pickedDir = await fs.mkdtemp(join(tmpdir(), 'dsh-es-pick-'))
await fs.writeFile(join(pickedDir, 'es.exe'), '')
const routes = new Map()
const fakePicker = { capability: () => ({ kind: 'native', pick: async () => pickedDir }) }
host.apply({
  tools: { register: () => () => {} },
  inject: (services, cb) => {
    if (services.includes('directoryPicker')) cb({ directoryPicker: fakePicker })
    if (services.includes('webServer')) {
      cb({
        webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
        effect: (fn) => { fn(); return () => {} },
      })
    }
  },
}, { esExe: '', timeoutMs: 10000, maxResults: 50 })

ok('host: registers its configuration routes', routes.has('/dsh-everything-find/api/status') && routes.has('/dsh-everything-find/api/pick'), [...routes.keys()].join(','))

const status = await callRoute(routes.get('/dsh-everything-find/api/status'))
ok('host: status names the effective es.exe and where it came from', status.path.endsWith('es.exe') && status.source === 'bundled' && status.pickable === true, JSON.stringify(status))

const picked = await callRoute(routes.get('/dsh-everything-find/api/pick'))
ok('host: picking locates the es.exe inside the chosen directory', picked.ok === true && picked.located === true && picked.path === join(pickedDir, 'es.exe'), JSON.stringify(picked))
await fs.rm(pickedDir, { recursive: true, force: true })

// A browse-only deployment has no single-path chooser: the route still answers and says so.
const browseRoutes = new Map()
host.apply({
  tools: { register: () => () => {} },
  inject: (services, cb) => {
    if (services.includes('directoryPicker')) cb({ directoryPicker: { capability: () => ({ kind: 'browse' }) } })
    if (services.includes('webServer')) {
      cb({
        webServer: { register: (route) => { browseRoutes.set(route.path, route.handler); return () => browseRoutes.delete(route.path) } },
        effect: (fn) => { fn(); return () => {} },
      })
    }
  },
}, { esExe: '', timeoutMs: 10000, maxResults: 50 })
const browseStatus = await callRoute(browseRoutes.get('/dsh-everything-find/api/status'))
const browsePick = await callRoute(browseRoutes.get('/dsh-everything-find/api/pick'))
ok('host: a browse-only deployment reports the picker unavailable', browseStatus.pickable === false && browsePick.ok === false && browsePick.code === 'unavailable', `${JSON.stringify(browseStatus)} ${JSON.stringify(browsePick)}`)

// ---------------------------------------------------------------- browser half
const calls = []

/** The settings primitives the card renders with, recorded so the wiring can be asserted. */
const recorded = { scope: null, specs: null }
const primitives = {
  SettingsForm: 'SettingsForm',
  SettingsValueField: 'SettingsValueField',
  Button: 'Button',
  settingsTextField: (key) => ({ key, numeric: false }),
  settingsNumberField: (key) => ({ key, numeric: true }),
  SettingsFormModel: class {
    constructor(scope, specs) {
      recorded.scope = scope
      recorded.specs = specs
    }
    bind(project) {
      return { getSnapshot: () => project(), subscribe: () => () => {} }
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(name) {
      // The path field starts unset so the card's "show what is actually in effect" path is exercised.
      return { text: name === 'esExe' ? '' : `v:${name}`, overridden: false, invalid: false }
    }
    actions() {
      return {
        edit: (...args) => calls.push(['edit', ...args]),
        resetField: (...args) => calls.push(['resetField', ...args]),
        save: () => calls.push(['save']),
        discard: () => calls.push(['discard']),
      }
    }
    dispose() {
      calls.push(['dispose'])
    }
  },
}

const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }

/** Collect every element with one tag from a fake element tree. */
function collect(node, tag, found = []) {
  if (Array.isArray(node)) {
    for (const entry of node) collect(entry, tag, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  if (node.type === tag) found.push(node)
  for (const child of node.children ?? []) collect(child, tag, found)
  return found
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
await import(new URL('client.js', PACKAGE_DIR).href)
ok('client: the bundle registers itself', loaded !== null && loaded.id === 'dsh-everything-find')
const clientExports = loaded.factory((id) => (id === 'react' ? React : id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined))
ok('client: only `slots` gates the entry', JSON.stringify(clientExports.inject) === '["slots"]')

/** Host route requests the card made, answered with the two payloads its routes return. */
const requests = []
globalThis.fetch = (url, init) => {
  const target = String(url)
  requests.push([init?.method ?? 'GET', target])
  const body = target.endsWith('/status')
    ? { path: 'C:\\Users\\han\\.dsh\\local-plugins\\dsh-everything-find\\bin\\es.exe', source: 'bundled', pickable: true }
    : { ok: true, located: true, directory: 'C:\\Program Files\\Everything', path: 'C:\\Program Files\\Everything\\es.exe' }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const configSource = { getSnapshot: () => ({ status: 'ready' }), subscribe: () => () => {}, mutate: () => Promise.resolve(true) }
const registrations = []
const slots = { inject: (_slot, cb) => cb(), register: (options, Component) => { registrations.push({ options, Component }); return () => {} } }
const effect = (fn) => { fn(); return () => {} }
clientExports.apply({
  slots,
  effect,
  inject: (services, cb) => {
    if (services.includes('configForms')) cb({ slots, effect, configForms: { get: () => configSource } })
  },
})

ok('client: registers exactly one configuration card', registrations.length === 1, registrations.map((entry) => entry.options.name).join(','))
const card = registrations[0]
ok('client: the card occupies plugins.bundle.config keyed by the package name', card.options.name === 'plugins.bundle.config' && card.options.key === 'dsh-everything-find')
ok('client: the form wraps this entry’s config form', recorded.scope === configSource)
ok('client: the card covers exactly the host Config fields', recorded.specs.map((spec) => spec.key).join(',') === Object.keys(host.Config.dict ?? {}).join(','), `${recorded.specs.map((spec) => spec.key).join(',')} vs ${Object.keys(host.Config.dict ?? {}).join(',')}`)
ok('client: text fields stay text and numeric fields numeric', recorded.specs.map((spec) => `${spec.key}:${spec.numeric ? 'number' : 'text'}`).join(',') === 'esExe:text,esInstance:text,timeoutMs:number,maxResults:number')

const face = card.options.inject()
ok('client: the face carries both card hooks and the form actions', typeof face.hooks.everythingCard?.getSnapshot === 'function' && typeof face.hooks.everythingStatus?.getSnapshot === 'function' && ['edit', 'resetField', 'save', 'discard', 'detect', 'browse'].every((action) => typeof face[action] === 'function'))

// The card detects by itself as soon as it exists, without the operator asking.
await new Promise((resolve) => setTimeout(resolve, 0))
ok('client: the card detects the effective es.exe on its own', requests.some(([method, url]) => method === 'GET' && url.endsWith('/status')), JSON.stringify(requests))

const tree = card.Component({
  ...face,
  useEverythingCard: (selector) => selector(face.hooks.everythingCard.getSnapshot()),
  useEverythingStatus: (selector) => selector(face.hooks.everythingStatus.getSnapshot()),
})
ok('client: the card renders the shared settings form', tree.type === 'SettingsForm')
ok('client: the form copy is Chinese', tree.props.labels.save === '保存' && tree.props.labels.saving === '保存中…' && /[\u4e00-\u9fa5]/.test(tree.props.labels.unavailable))
const controls = collect(tree, 'SettingsValueField')
ok('client: one control per field', controls.length === 4)
ok('client: field labels are Chinese', controls.map((control) => control.props.label).join('|') === 'es.exe 路径|Everything 实例名|数据库加载超时（毫秒）|默认结果条数')
ok('client: every hint is Chinese', controls.every((control) => /[\u4e00-\u9fa5]/.test(control.props.hint)))
ok('client: two controls are numeric', controls.filter((control) => control.props.numeric === true).length === 2)
ok('client: the unset path control carries the effective path', controls[0].props.text === 'C:\\Users\\han\\.dsh\\local-plugins\\dsh-everything-find\\bin\\es.exe' && controls[0].props.overridden === false, JSON.stringify(controls[0].props.text))
ok('client: each control carries its placeholder', controls[0].props.placeholder === '自动探测' && controls[1].props.placeholder === '默认（未命名实例）')
ok('client: controls carry the framework labels', controls[0].props.overriddenLabel === '已覆盖' && controls[0].props.resetLabel === '恢复默认' && controls[0].props.invalidLabel === '请填数字；留空表示使用默认值。')

const buttons = collect(tree, 'Button')
ok('client: the path field offers re-detect and browse', buttons.length === 2 && buttons[0].children[0] === '重新检测' && buttons[1].children[0] === '浏览…')
const rendered = JSON.stringify(tree)
ok('client: the card names where the effective path came from', rendered.includes('来源：随包副本'), rendered.slice(rendered.indexOf('来源'), rendered.indexOf('来源') + 60))

buttons[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
ok('client: browsing asks the host for a directory', requests.some(([method, url]) => method === 'POST' && url.endsWith('/pick')), JSON.stringify(requests))
ok('client: browsing stages the picked es.exe without saving', calls.some((call) => call[0] === 'edit' && call[1] === 'esExe' && call[2] === 'C:\\Program Files\\Everything\\es.exe'), JSON.stringify(calls))

buttons[0].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
ok('client: re-detect asks the host again', requests.filter(([method, url]) => method === 'GET' && url.endsWith('/status')).length >= 2, JSON.stringify(requests))

controls[0].props.onEdit('C:\\tools\\es.exe')
controls[1].props.onReset()
tree.props.onSave()
tree.props.onDiscard()
ok('client: edits and resets reach the form actions', calls.some((call) => call[0] === 'edit' && call[1] === 'esExe' && call[2] === 'C:\\tools\\es.exe') && calls.some((call) => call[0] === 'resetField' && call[1] === 'esInstance'))
ok('client: save and discard reach the form actions', calls.some((call) => call[0] === 'save') && calls.some((call) => call[0] === 'discard'))

for (const note of skip) console.log(`SKIP  ${note}`)
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n- ${failures.join('\n- ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
