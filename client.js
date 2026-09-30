// dsh-everything-find browser half: this plugin's configuration card on the Plugins page.
//
// The card is built from the same primitives the built-in settings pages use (`SettingsForm`,
// `SettingsValueField`, `Button` from @deepseek-ai/dsh-client-ui-primitives), so it looks and behaves
// exactly like the pages beside it, and the staged-edit/save semantics stay the framework's.
//
// DSH 0.1.7+ serves plugin configuration through the `configForms` service and the Plugins page's
// `plugins.bundle.config` slot, keyed by the bundle's package name. This bundle's patch inserts
// exactly one entry whose id equals that package name, so one string serves as the profile entry id
// and the slot key alike.
//
// Two controls are not configuration fields: the line naming the es.exe in effect right now, and the
// buttons that re-detect it or open the host's own directory chooser. Both ride this plugin's host
// routes, because a third-party bundle owns no Remote of its own and the official chooser picks a
// directory, from which the host locates that directory's es.exe.
window.__ModuleLoader__.load({
  id: 'dsh-everything-find',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    // The settings primitives ship with the Web client the Plugins page already needs; a deployment
    // that somehow lacks them keeps the tool and simply shows no configuration card.
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      console.warn('[dsh-everything-find] configuration card unavailable: ' + String(error && error.message ? error.message : error))
    }

    var name = 'dsh-everything-find'
    // Only `slots` gates this Loader entry: a client entry still waiting for a missing service fails
    // the whole web boot audit, so the generation-specific `configForms` service is injected from a
    // nested scope below instead.
    var inject = ['slots']

    /** Bundle name, profile entry id, and configuration slot key: all three are this string. */
    var NAMESPACE = 'dsh-everything-find'

    /** This plugin's host routes for the card's detection and directory chooser. */
    var API = '/dsh-everything-find/api'

    /** Copy for this card. */
    var COPY = {
      unavailable: '该插件当前未加载，或本部署未开放它的配置，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填数字；留空表示使用默认值。',
      detect: '重新检测',
      browse: '浏览…',
      detecting: '正在检测 es.exe…',
      picking: '等待选择…',
      missing: '未找到 es.exe：请安装 ES，或用「浏览…」指定它的位置。',
      failed: '检测失败：',
      picked: '已填入所选路径，保存后生效。',
      pickedMiss: '该目录下没有 es.exe，已填入目录路径，请确认。',
      pickUnavailable: '本部署没有可用的目录选择器，请手动填写路径。',
      source: '来源：',
      fallback: '配置的路径未生效，当前回退到：',
    }

    /** Readable names for the candidates the host resolves es.exe from. */
    var SOURCE_LABELS = {
      configured: '配置里的路径',
      bundled: '随包副本',
      path: '系统 PATH',
      install: '常见安装位置',
    }

    /** The configuration fields in render order; each mirrors one Config field of the host half. */
    var FIELDS = [
      {
        key: 'esExe',
        label: 'es.exe 路径',
        hint: '留空则自动探测：随包副本 → 系统 PATH → 常见安装位置。',
        placeholder: '自动探测',
        numeric: false,
        // The control shows the path the host resolved while the field is not overridden, so it
        // always carries the value in effect; leaving it untouched keeps the automatic detection.
        auto: 'path',
      },
      {
        key: 'esInstance',
        label: 'Everything 实例名',
        hint: '留空即使用默认的未命名实例（普通安装就是这样）；只有 Everything 以命名实例运行时才需要填写。',
        placeholder: '默认（未命名实例）',
        numeric: false,
      },
      {
        key: 'timeoutMs',
        label: '数据库加载超时（毫秒）',
        hint: 'es.exe 等待 Everything 数据库加载完成的时间；索引很大或磁盘较慢时调大。',
        numeric: true,
      },
      {
        key: 'maxResults',
        label: '默认结果条数',
        hint: '调用未指定 max 时生效；单次调用最多可要 1000 条。',
        numeric: true,
      },
    ]

    var STATUS_STYLE = {
      margin: '6px 0 0',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    var ACTIONS_STYLE = {
      display: 'flex',
      gap: '8px',
      margin: '8px 0 0',
    }

    /**
     * A minimal snapshot store; the framework binds it into a `use*` selector hook.
     * @param initial - the first snapshot.
     * @returns the store.
     */
    function makeStore(initial) {
      var current = initial
      var listeners = new Set()
      return {
        getSnapshot: function () { return current },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        set: function (next) {
          current = next
          listeners.forEach(function (listener) { listener() })
        },
      }
    }

    /**
     * Render the detection line under the path field.
     * @param status - the card's detection snapshot.
     * @param overridden - whether the saved configuration pins a path of its own.
     * @returns the line to show under the path field.
     */
    function statusText(status, overridden) {
      if (status.state === 'loading') return COPY.detecting
      if (status.state === 'picking') return COPY.picking
      if (status.state === 'failed') return COPY.failed + status.message
      if (!status.path) return COPY.missing
      var origin = COPY.source + (SOURCE_LABELS[status.source] ?? status.source)
      // A pinned path the host could not use falls back to another candidate: say so, rather than
      // letting the field show one path while the line names a different origin.
      if (overridden && status.source !== 'configured') return COPY.fallback + status.path + '（' + origin + '）'
      return origin
    }

    /** One entry's staged form plus the host's es.exe detection. */
    class EverythingCardController {
      /** @param scope - the shared configuration form of this plugin's profile entry. */
      constructor(scope) {
        var self = this
        this.form = new primitives.SettingsFormModel(scope, FIELDS.map(function (field) {
          return field.numeric
            ? primitives.settingsNumberField(field.key)
            : primitives.settingsTextField(field.key)
        }))
        this.actions = this.form.actions()
        this.store = this.form.bind(function () {
          var state = self.form.shell()
          for (var index = 0; index < FIELDS.length; index++) {
            state[FIELDS[index].key] = self.form.field(FIELDS[index].key)
          }
          return state
        })
        this.status = makeStore({ state: 'loading' })
        // The card detects once as soon as it exists, so the operator sees the effective path without
        // asking; the buttons below re-run the same detection on demand.
        void this.detect()
      }

      /** Read which es.exe is in effect right now, and where the host got it. */
      detect() {
        var self = this
        this.status.set({ state: 'loading' })
        return this.request('/status').then(function (payload) {
          self.status.set({
            state: 'ready',
            path: payload.path,
            source: payload.source,
            pickable: payload.pickable === true,
          })
        }, function (error) {
          self.status.set({ state: 'failed', message: String(error && error.message ? error.message : error) })
        })
      }

      /** Open the host's directory chooser and adopt that directory's es.exe. */
      browse() {
        var self = this
        this.status.set({ state: 'picking' })
        return this.request('/pick', { method: 'POST' }).then(function (payload) {
          if (payload.ok === true) {
            // Stage the path like a typed edit: the operator still confirms with the form's save.
            self.actions.edit('esExe', payload.path)
            self.status.set({ state: 'ready', notice: payload.located === true ? COPY.picked : COPY.pickedMiss })
            return undefined
          }
          if (payload.code === 'cancelled') return self.detect()
          self.status.set({
            state: 'failed',
            message: payload.code === 'unavailable' ? COPY.pickUnavailable : String(payload.message ?? payload.code ?? ''),
          })
          return undefined
        }, function (error) {
          self.status.set({ state: 'failed', message: String(error && error.message ? error.message : error) })
        })
      }

      /**
       * One JSON request against this plugin's host routes.
       * @param path - the route suffix under {@link API}.
       * @param init - extra fetch options.
       * @returns the parsed JSON body.
       */
      request(path, init) {
        var options = Object.assign({ headers: { accept: 'application/json' }, cache: 'no-store' }, init ?? {})
        return fetch(API + path, options).then(function (response) {
          return response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))
        })
      }

      /**
       * Build the face the card's slot registration injects.
       * @returns the card hooks, the form actions, and the detection actions.
       */
      inject() {
        var self = this
        var face = this.actions
        face.hooks = { everythingCard: this.store, everythingStatus: this.status }
        face.detect = function () { return self.detect() }
        face.browse = function () { return self.browse() }
        return face
      }

      /** Release the form's subscription to the namespace. */
      dispose() {
        this.form.dispose()
      }
    }

    /**
     * The configuration card.
     * @param props - the inject face: the two card hooks, the form actions, and the detection actions.
     * @returns the settings form, or the framework's unavailable notice.
     */
    function EverythingCard(props) {
      var state = props.useEverythingCard(function (value) { return value })
      var status = props.useEverythingStatus(function (value) { return value })
      var busy = status.state === 'loading' || status.state === 'picking'
      var children = []
      for (var index = 0; index < FIELDS.length; index++) {
        var field = FIELDS[index]
        var fieldState = state[field.key]
        var text = fieldState.text
        // Show the effective path while nothing overrides it, so the control is never blank about
        // what is actually in use; an untouched field still saves nothing and stays automatic.
        if (text === '' && field.auto === 'path' && status.state === 'ready' && status.path) text = status.path
        children.push(React.createElement(primitives.SettingsValueField, {
          key: field.key,
          id: 'dsh-everything-find-' + field.key,
          label: field.label,
          hint: field.hint,
          placeholder: field.placeholder,
          overriddenLabel: COPY.overridden,
          resetLabel: COPY.reset,
          invalidLabel: COPY.invalidNumber,
          numeric: field.numeric === true,
          disabled: !state.writable,
          text: text,
          overridden: fieldState.overridden,
          invalid: fieldState.invalid,
          onEdit: function (key) {
            return function (value) { props.edit(key, value) }
          }(field.key),
          onReset: function (key) {
            return function () { props.resetField(key) }
          }(field.key),
        }))
        if (field.key !== 'esExe') continue
        children.push(React.createElement('p', { key: 'esexe-status', style: STATUS_STYLE }, statusText(status, fieldState.overridden)))
        children.push(React.createElement('div', { key: 'esexe-actions', style: ACTIONS_STYLE },
          React.createElement(primitives.Button, {
            key: 'detect',
            type: 'button',
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onClick: props.detect,
          }, COPY.detect),
          React.createElement(primitives.Button, {
            key: 'browse',
            type: 'button',
            variant: 'outline',
            size: 'sm',
            disabled: busy || !state.writable || status.pickable !== true,
            onClick: props.browse,
          }, COPY.browse),
        ))
        if (status.notice) children.push(React.createElement('p', { key: 'esexe-notice', style: STATUS_STYLE }, status.notice))
      }
      return React.createElement(primitives.SettingsForm, {
        labels: {
          unavailable: COPY.unavailable,
          readOnly: COPY.readOnly,
          saveFailed: COPY.saveFailed,
          save: COPY.save,
          saving: COPY.saving,
        },
        state: state,
        onSave: function () {
          props.save()
          // The host resolves the path when it saves the entry, so re-read it just after the write.
          setTimeout(props.detect, 600)
        },
        onDiscard: props.discard,
      }, children)
    }

    /**
     * Register the configuration card on the Plugins page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      if (primitives === null) return
      ctx.inject(['configForms'], function (configCtx) {
        var controller = new EverythingCardController(configCtx.configForms.get(NAMESPACE))
        ctx.effect(function () { return function () { controller.dispose() } }, 'dsh-everything-find: configuration form')
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register({
            name: 'plugins.bundle.config',
            key: NAMESPACE,
            inject: function () { return controller.inject() },
          }, EverythingCard)
        })
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
