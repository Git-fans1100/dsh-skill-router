/**
 * dsh-skill-router — 宿主客户端（设置栏目）
 * ============================================================
 * 职责（v0.4.0，SPEC §3.4）：在 DSH 原生设置界面注册「技能路由」栏目，
 * 提供插件介绍、只读运行状态（版本/索引/预热/漏斗）与总开关。
 *
 * 实现蓝本：simdt-consult v1.6.0 client.js（本机实证的宿主扩展协议）——
 *   1. ModuleLoader 协议头：window.__ModuleLoader__.load({ id, factory })
 *      工厂内仅 require 平台共享模块（react），返回 { inject, apply }
 *   2. 设置栏目：ctx.slots.inject('settings.section', () =>
 *      ctx.slots.register({ name:'settings.section', id, order, locale,
 *      label:惰性求值, inject:()=>({t}) }, Root))（官方 ui-agent-preset 先例）
 *   3. 双语词典：ctx.locale.register(NS, { zh, en }) + ctx.locale.bind(NS)
 *   4. 数据源：fetch 同源调用宿主 webServer exact 路由（无自起端口/token）：
 *      GET  /skill-router/api/state          只读状态
 *      POST /skill-router/api/settings/save  写总开关（布尔白名单在宿主侧）
 *      GET  /skill-router/api/donation-qr    微信自愿捐款二维码
 *
 * 规范遵循（SIMDT 会诊同款）：
 *   - 仅 require 平台共享模块 react；控件全部自绘（无 UI 库依赖）
 *   - <style> 随组件挂载，类名 sr- 前缀隔离；主题色走宿主 ThemeEngine
 *     真实变量（--dsw-alias-*）+ body[data-ds-dark-theme] 深色分支
 *   - 版本号三处一致（package.json / index.js / 本文件 ROUTER_VERSION）
 */
;(function () {
  'use strict'
  // 宿主客户端未注入 ModuleLoader（极旧版本/非预期环境）：静默退出，
  // 不抛错——插件装载失败不应拖垮宿主设置页。
  if (!window.__ModuleLoader__) return
  window.__ModuleLoader__.load({
    id: 'dsh-skill-router',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      // 版本号三处一致之一（另两处：package.json / index.js）
      const ROUTER_VERSION = '0.4.0'
      // locale 命名空间（= 插件名派生，规范同 SIMDT NS）
      const NS = 'skill-router'
      // 设置栏目 id（settings.section 列表里的唯一键）
      const SECTION_ID = 'skill-router'
      // 栏目排序：SIMDT 用 60（避开官方编号），本插件用 61 紧随其后同属插件区
      const SECTION_ORDER = 61

      // ------------------------------------------------------------
      // 双语词典（宿主按界面语言取 zh/en 之一；随插件卸载自动移除）
      // ------------------------------------------------------------
      const zh = {
        'meta.title': '技能路由器',
        'meta.description': '按需检索与预热挂载：把合适的技能送到模型眼前，其余留在索引里兜底',
        'settings.nav': '技能路由',
        'state.loading': '加载路由状态...',
        // —— 只读状态卡 ——
        'state.version': '版本',
        'state.index': '索引能力',
        'state.preheat': '预热 Bot',
        'state.funnel': '调用漏斗',
        'state.off': '已停摆',
        // —— 总开关 ——
        'switch.title': '启用技能路由',
        'switch.desc': '关闭后本插件立即停摆：检索与加载工具下线、预热挂载全部摘除，ds-bot 自动回退原生全量技能目录。重新打开即时恢复，无需重启。',
        'switch.saved': '已保存',
        // —— API 错误翻译 ——
        'api.networkFailed': '网络请求失败',
        'api.notReady': '插件服务未就绪',
        'api.httpError': '请求出错',
        // —— 微信自愿捐款（全局约定：强调完全自愿）——
        'donation.title': '自愿捐款',
        'donation.text': '本插件完全免费。如果它对你有帮助，欢迎自愿捐款支持开发——完全自愿，不捐款不影响任何功能。',
        'donation.version': '当前版本',
      }
      const en = {
        'meta.title': 'Skill Router',
        'meta.description': 'On-demand search and preheated mounting: puts the right skills in front of the model, the rest stay in the index',
        'settings.nav': 'Skill Router',
        'state.loading': 'Loading router state...',
        'state.version': 'Version',
        'state.index': 'Indexed capabilities',
        'state.preheat': 'Preheated bots',
        'state.funnel': 'Usage funnel',
        'state.off': 'Disabled',
        'switch.title': 'Enable Skill Router',
        'switch.desc': 'When off, this plugin stops immediately: search and load tools go offline, all preheated mounts are released, and ds-bot falls back to the native full skill catalog. Turning it back on takes effect instantly — no restart needed.',
        'switch.saved': 'Saved',
        'api.networkFailed': 'Network request failed',
        'api.notReady': 'Plugin service not ready',
        'api.httpError': 'Request failed',
        'donation.title': 'Donate',
        'donation.text': 'This plugin is completely free. If it helps you, feel free to donate to support development — entirely voluntary; not donating does not affect any feature.',
        'donation.version': 'Version',
      }

      // ------------------------------------------------------------
      // 统一请求防御层（SIMDT 同款四类错误翻译：网络失败/空响应/坏
      // JSON/HTTP 非 2xx，全部转成可 toast 的 Error）
      // ------------------------------------------------------------
      function makeRequestJson(t) {
        return async function requestJson(url, init) {
          let res
          try {
            res = await fetch(url, init)
          } catch {
            throw new Error(t('api.networkFailed') + '（' + url + '）')
          }
          const text = await res.text()
          if (text === '') throw new Error(t('api.notReady') + `（HTTP ${res.status}，${url}）`)
          let data
          try {
            data = JSON.parse(text)
          } catch {
            throw new Error(t('api.notReady') + `（HTTP ${res.status}，${url}）`)
          }
          if (!res.ok) throw new Error((data && data.message) || (t('api.httpError') + `（HTTP ${res.status}）`))
          if (data && data.success === false) throw new Error(data.message || t('api.httpError'))
          return data
        }
      }

      // ------------------------------------------------------------
      // lucide 风格描边图标（path 用 ' | ' 分隔多段；与宿主视觉一致）
      //   route：入口节点分流到两个出口（检索/预热的路由语义）
      //   heart：捐款卡（SIMDT 同款路径）
      // ------------------------------------------------------------
      const ICON_PATHS = {
        route: 'M3 5v14 | M3 12h4 | M7 12c2.5 0 2.5-5 5-5h6 | M7 12c2.5 0 2.5 5 5 5h6 | M15 4l3 3-3 3 | M15 14l3 3-3 3',
        heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
      }
      function Icon(props) {
        const { path, size = 16 } = props
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        }, path.split(' | ').map((d, i) => h('path', { key: i, d })))
      }

      // ------------------------------------------------------------
      // 样式（sr- 前缀；语义底色走宿主 --dsw-alias-* 主题 token，
      // 深浅色自动切换——策略与 SIMDT v1.6.0 一致）。
      // 品牌色用蓝（路由/网络语义，与 SIMDT teal 区分）：
      //   浅色文字级 #1d4ed8（白底 6.3:1 达 WCAG AA）
      //   深色分支提亮 #60a5fa（深底对比充足）
      // ------------------------------------------------------------
      const STYLES = `
.sr-root { height: 100%; overflow-y: auto; }
.sr-page { --sr-border: var(--dsw-alias-border-l2, #e5e7eb); --sr-muted: var(--dsw-alias-label-secondary, #6b7280);
  --sr-accent-text: #1d4ed8; --sr-accent-soft: rgba(37,99,235,.10);
  max-width: 64rem; margin: 0 auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1.25rem; }
/* 深色主题分支：宿主 ThemePresenter 在 body 挂 data-ds-dark-theme 空属性 */
body[data-ds-dark-theme] .sr-page { --sr-accent-text: #60a5fa; --sr-accent-soft: rgba(96,165,250,.14); }
.sr-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.sr-title { font-size: 1.25rem; font-weight: 600; margin: 0; display: flex; align-items: center; gap: .5rem;
  color: var(--dsw-alias-label-primary, inherit); }
.sr-title .logo { color: var(--sr-accent-text); display: inline-flex; }
.sr-subtitle { font-size: .875rem; color: var(--sr-muted); margin: .25rem 0 0; line-height: 1.6; }
.sr-card { border: 1px solid var(--sr-border); border-radius: .5rem; padding: 1rem 1.25rem;
  background: var(--dsw-alias-bg-layer-1, transparent); }
.sr-label { font-size: .8125rem; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.sr-meta { font-size: .8125rem; color: var(--sr-muted); margin: .25rem 0 0; line-height: 1.6; }
.sr-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
/* —— 开关（SIMDT 同款几何：轨道 2.25rem、knob 深浅分支配色）—— */
.sr-switch { position: relative; width: 2.25rem; height: 1.25rem; border-radius: 9999px;
  border: 1px solid var(--sr-border); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
  cursor: pointer; flex: none; padding: 0; }
.sr-switch.on { background: var(--sr-accent-text); border-color: var(--sr-accent-text); }
.sr-switch .knob { position: absolute; top: 1px; left: 1px; width: calc(1.25rem - 4px); height: calc(1.25rem - 4px);
  border-radius: 9999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: left .15s ease; }
.sr-switch.on .knob { left: calc(100% - 1.25rem + 1px); }
body[data-ds-dark-theme] .sr-switch.on .knob { background: #0f1115; }
/* —— 只读状态卡：四格网格（版本/索引/预热/漏斗）—— */
.sr-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; }
.sr-stat { border: 1px solid var(--sr-border); border-radius: .5rem; padding: .75rem .875rem; }
.sr-stat .k { font-size: .75rem; color: var(--sr-muted); }
.sr-stat .v { font-size: 1.125rem; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); margin: .25rem 0 0; }
.sr-stat .v small { font-size: .75rem; font-weight: 400; color: var(--sr-muted); }
/* —— 微信自愿捐款卡 —— */
.sr-donation { display: flex; gap: 1rem; align-items: flex-start; }
.sr-donation img { width: 96px; height: 96px; border-radius: .5rem; border: 1px solid var(--sr-border); flex: none;
  background: #fff; object-fit: contain; }
.sr-donation .body { display: flex; flex-direction: column; gap: .375rem; min-width: 0; }
.sr-donation .t { font-size: .8125rem; font-weight: 600; color: var(--dsw-alias-label-primary, inherit);
  display: flex; align-items: center; gap: .375rem; }
.sr-donation .t svg { color: #e0245e; }
.sr-donation .d { font-size: .8125rem; color: var(--sr-muted); line-height: 1.6; margin: 0; }
.sr-donation .v { font-size: .75rem; color: var(--sr-muted); }
/* —— Toast 提示（保存成功/失败反馈）—— */
.sr-toasts { position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%); display: flex;
  flex-direction: column; gap: .5rem; z-index: 9999; }
.sr-toast { padding: .5rem .875rem; border-radius: .375rem; font-size: .8125rem; color: #fff;
  background: #1f2937; box-shadow: 0 4px 12px rgba(0,0,0,.18); }
.sr-toast.error { background: #b42318; }
`

      // ------------------------------------------------------------
      // Toast（SIMDT 同款极简实现：3.5s 自动消失）
      // ------------------------------------------------------------
      const ToastCtx = React.createContext(null)
      function ToastProvider(props) {
        const [items, setItems] = React.useState([])
        const push = React.useCallback((type, message) => {
          const key = String(Date.now()) + Math.random().toString(36).slice(2)
          setItems(list => [...list, { key, type, message }])
          setTimeout(() => setItems(list => list.filter(it => it.key !== key)), 3500)
        }, [])
        const toast = React.useMemo(() => ({
          success: m => push('success', m),
          error: m => push('error', m),
        }), [push])
        return h(ToastCtx.Provider, { value: toast },
          props.children,
          h('div', { className: 'sr-toasts' },
            items.map(it => h('div', { key: it.key, className: 'sr-toast ' + it.type }, it.message))))
      }
      function useToast() { return React.useContext(ToastCtx) }

      // ------------------------------------------------------------
      // API（宿主 webServer exact 路由的同源 fetch；宿主 exact 路由
      // 不区分 method，读写必须不同路径）
      // ------------------------------------------------------------
      function makeApi(requestJson) {
        return {
          /** 只读状态：{ version, enabled, indexSize, preheat, funnel } */
          async getState() { return requestJson('/skill-router/api/state') },
          /** 写总开关（布尔白名单在宿主侧校验，非布尔 400） */
          async saveEnabled(enabled) {
            return requestJson('/skill-router/api/settings/save', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled }),
            })
          },
        }
      }

      // ------------------------------------------------------------
      // 只读状态卡：四格（版本 / 索引能力 / 预热 Bot / 调用漏斗）
      // 数据源 GET /state——与宿主侧 capability_stats 同一份漏斗数据
      // ------------------------------------------------------------
      function StatsGrid({ state, t }) {
        const funnel = state.funnel ?? {}
        const bots = Object.keys(state.preheat ?? {}).length
        return h('div', { className: 'sr-stats' },
          h('div', { className: 'sr-stat' },
            h('div', { className: 'k' }, t('state.version')),
            h('div', { className: 'v' }, 'v' + (state.version ?? ROUTER_VERSION))),
          h('div', { className: 'sr-stat' },
            h('div', { className: 'k' }, t('state.index')),
            h('div', { className: 'v' }, String(state.indexSize ?? 0))),
          h('div', { className: 'sr-stat' },
            h('div', { className: 'k' }, t('state.preheat')),
            h('div', { className: 'v' },
              state.enabled ? String(bots) : h('small', null, t('state.off')))),
          h('div', { className: 'sr-stat' },
            h('div', { className: 'k' }, t('state.funnel')),
            h('div', { className: 'v' }, `${funnel.search ?? 0}`,
              h('small', null, ` / ${funnel.load ?? 0} / ${funnel.use ?? 0}`))))
      }

      // ------------------------------------------------------------
      // 设置页：头部（名称+副标题）→ 状态卡 → 总开关卡 → 捐款卡
      // 开关切换：乐观更新 + 失败回滚 + toast 反馈（SIMDT 同款交互）
      // ------------------------------------------------------------
      function SettingsPage({ t }) {
        const toast = useToast()
        const requestJson = React.useMemo(() => makeRequestJson(t), [t])
        const api = React.useMemo(() => makeApi(requestJson), [requestJson])
        const [state, setState] = React.useState(null) // /state 数据

        React.useEffect(() => {
          let alive = true
          api.getState()
            .then(data => { if (alive) setState(data) })
            .catch(e => { if (alive) toast.error(e?.message || String(e)) })
          return () => { alive = false }
        }, [api])

        /** 切换总开关：乐观更新 → POST 保存 → 失败回滚并报错 */
        const toggleEnabled = async () => {
          if (!state) return
          const next = { ...state, enabled: !state.enabled }
          setState(next)
          try {
            await api.saveEnabled(next.enabled)
            toast.success(t('switch.saved'))
          } catch (e) {
            setState(state) // 回滚到旧状态
            toast.error(e?.message || String(e))
          }
        }

        return h('div', { className: 'sr-root' },
          h('div', { className: 'sr-page' },
            // —— 头部（logo + 名称 + 一句话介绍）——
            h('div', { className: 'sr-header' },
              h('div', null,
                h('h1', { className: 'sr-title' },
                  h('span', { className: 'logo' }, h(Icon, { path: ICON_PATHS.route, size: 22 })),
                  t('meta.title')),
                h('p', { className: 'sr-subtitle' }, t('meta.description')))),
            // —— 只读状态卡（state 就绪前显示加载提示）——
            state
              ? h('div', { className: 'sr-card' }, h(StatsGrid, { state, t }))
              : h('div', { className: 'sr-card' },
                  h('p', { className: 'sr-meta', style: { margin: 0 } }, t('state.loading'))),
            // —— 总开关卡（title/desc + switch，停摆语义写进 desc）——
            h('div', { className: 'sr-card' },
              h('div', { className: 'sr-row' },
                h('div', null,
                  h('div', { className: 'sr-label' }, t('switch.title')),
                  h('p', { className: 'sr-meta' }, t('switch.desc'))),
                h('button', {
                  className: 'sr-switch' + (state && state.enabled ? ' on' : ''),
                  role: 'switch', 'aria-checked': !!(state && state.enabled),
                  disabled: !state, onClick: () => toggleEnabled(),
                }, h('span', { className: 'knob' })))),
            // —— 微信自愿捐款（图片走宿主路由，同源免鉴权）——
            h('div', { className: 'sr-card' },
              h('div', { className: 'sr-donation' },
                h('img', { src: '/skill-router/api/donation-qr', alt: 'WeChat Donation QR' }),
                h('div', { className: 'body' },
                  h('div', { className: 't' }, h(Icon, { path: ICON_PATHS.heart, size: 14 }), t('donation.title')),
                  h('p', { className: 'd' }, t('donation.text')),
                  h('div', { className: 'v' }, `${t('donation.version')}: dsh-skill-router v${ROUTER_VERSION}`))))))
      }

      /** 设置栏目根：<style> 与 ToastProvider 必须在此挂载（SIMDT 同款，
       *  否则子组件 useToast() 返回 null 直接 crash、样式表不随栏目加载） */
      function SettingsRoot(props) {
        const t = props.t
        return h(ToastProvider, null,
          h('style', null, STYLES),
          h(SettingsPage, { t }))
      }

      return {
        // 注入清单：slots（settings.section 注册）+ locale（双语词典）
        inject: ['slots', 'locale'],
        apply(ctx) {
          // 1) 注册双语词典（幂等；随插件卸载自动移除）
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-router: dictionaries')
          const t = ctx.locale.bind(NS)

          // 2) 系统设置「技能路由」栏目（settings.section，list slot）：
          //    label 用惰性求值（locale 变化时宿主重新拉取）；order 61
          //    避开官方栏目编号与 SIMDT 的 60。对齐官方 ui-agent-preset
          //    与 simdt-consult 的注册模式。
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            locale: NS,
            label: () => ctx.locale.bind(NS)('settings.nav'),
            inject: () => ({ t }),
          }, SettingsRoot))
        },
      }
    },
  })
})()
