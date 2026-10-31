// 宿主路由模块（SPEC §3.4）：经宿主 webServer 注册 3 条 exact 路由，
// 供 client 半的设置栏目读写。蓝本：simdt-consult（ctx.inject(['webServer'],
// (web) => web.webServer.register + 原生 (req,res) handler + 异常 400 包装）。
// 鉴权/端口由宿主承载，本模块不自起任何端口。
//
// 关键（本机实证，多插件一致）：
//   - 'webServer' 是宿主 HTTP 服务器服务；'web' 是 ds-bot 的搜索 seam（ctx.web.fetch），
//     二者不同——访问 ctx.web.webServer 恒为 undefined。
//   - apply 阶段同步读 ctx.get('webServer') 会得到 undefined（服务尚未提供），
//     必须经 ctx.inject(['webServer'], cb) 回调在其就绪时注册。
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 包根：assets/wechat-donate.jpg 相对本文件向上三级（src/host/ → 包根）。
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function install(rt) {
  const ctx = rt.ctx

  // JSON 响应 helper（与 SIMDT 同款形状：{success,data} / {success,message}）。
  const json = (res, code, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }
  // 异常包装：handler 抛错 → 400 JSON，不退宿主进程。
  const route = handler => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      json(res, 400, { success: false, message: String(error?.message || error) })
    }
  }
  // 请求体读取：chunks 拼接 → JSON 解析（空 body 视为 {}）。
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

  // 1) GET /state —— 设置栏目初始状态（statsText 同数据源，只读）。
  // 2) POST /settings/save —— 总开关切换（布尔白名单，非布尔 400 不改状态）。
  // 3) GET /donation-qr —— 微信自愿捐款二维码（全局开发规则；自愿前置声明）。
  ctx.inject(['webServer'], web => {
    const webServer = web?.webServer
    if (!webServer) {
      // 无 webServer（headless/纯对话部署）：设置栏目不可用，工具调度不受影响，软跳过。
      rt.warn?.('skill-router: host webServer not available; settings panel routes skipped')
      return
    }

    webServer.register({
      kind: 'exact',
      path: '/skill-router/api/state',
      handler: route(async (_req, res) => {
        json(res, 200, {
          success: true,
          data: {
            version: rt.version ?? '',
            enabled: rt.isEnabled(),
            indexSize: rt.index?.items?.length ?? 0,
            preheat: rt.preheatView ?? {},
            funnel: rt.state.funnel ?? {},
          },
        })
      }),
    })

    webServer.register({
      kind: 'exact',
      path: '/skill-router/api/settings/save',
      handler: route(async (req, res) => {
        const body = await readBody(req)
        if (typeof body.enabled !== 'boolean') {
          json(res, 400, { success: false, message: 'enabled must be a boolean' })
          return
        }
        rt.setEnabled(body.enabled)
        json(res, 200, { success: true, data: { enabled: rt.isEnabled() } })
      }),
    })

    webServer.register({
      kind: 'exact',
      path: '/skill-router/api/donation-qr',
      handler: route(async (_req, res) => {
        const qr = await readFile(join(PKG_ROOT, 'assets', 'wechat-donate.jpg'))
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(qr)
      }),
    })
  })
}
