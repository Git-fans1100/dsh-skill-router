// 宿主路由单测（SPEC §3.4）：3 条 exact 路由的状态/开关/捐款二维码行为，
// 布尔白名单、异常 400 包装，以及宿主 web 服务缺席时的软跳过。
// handler 是宿主 web 服务的原生 (req,res)——用最小 fake 还原读写契约。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as switchModule from '../src/host/switch.js'
import * as routesModule from '../src/host/routes.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fakeRuntime(home, withWeb = true) {
  const registered = []
  const rt = {
    home,
    ctx: withWeb
      ? { web: { webServer: { register: def => registered.push(def) } } }
      : {},
    state: { funnel: { search: 8, load: 2, use: 0, loadPreheated: 1 } },
    index: { items: [{}, {}, {}] },
    preheatView: { botA: ['office-xlsx'] },
    version: '0.4.0',
    warn: () => {},
  }
  rt.unmountCalls = 0
  rt.unmountAll = () => { rt.unmountCalls += 1 }
  switchModule.install(rt)
  routesModule.install(rt)
  return { rt, registered }
}

// 最小 fake：host 路由读 body 用 on('data'/'end')，写响应用 writeHead/end。
function fakeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    on(ev, cb) {
      if (ev === 'data') chunks.forEach(c => cb(c))
      if (ev === 'end') cb()
    },
  }
}

function fakeRes() {
  const out = {
    code: 0,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(code, headers) { out.code = code; out.headers = headers },
    end(chunk) { if (chunk) out.body = Buffer.concat([out.body, Buffer.from(chunk)]) },
  }
  return out
}

const byPath = registered => Object.fromEntries(registered.map(d => [d.path, d]))

test('routes: 宿主 web 服务缺席时软跳过（不抛）', () => {
  const { registered } = fakeRuntime(mkdtempSync(join(tmpdir(), 'sr-rt-')), false)
  assert.equal(registered.length, 0)
})

test('routes: 注册 3 条 exact 路由', () => {
  const { registered } = fakeRuntime(mkdtempSync(join(tmpdir(), 'sr-rt-')))
  const defs = byPath(registered)
  for (const p of ['/skill-router/api/state', '/skill-router/api/settings/save', '/skill-router/api/donation-qr']) {
    assert.ok(defs[p], `缺路由 ${p}`)
    assert.equal(defs[p].kind, 'exact')
  }
})

test('routes: GET /state 返回版本/开关/索引/预热/漏斗', async () => {
  const { rt, registered } = fakeRuntime(mkdtempSync(join(tmpdir(), 'sr-rt-')))
  const handler = byPath(registered)['/skill-router/api/state'].handler
  const res = fakeRes()
  await handler(fakeReq('GET'), res)
  assert.equal(res.code, 200)
  const payload = JSON.parse(res.body.toString())
  assert.equal(payload.success, true)
  assert.equal(payload.data.version, '0.4.0')
  assert.equal(payload.data.enabled, true)
  assert.equal(payload.data.indexSize, 3)
  assert.deepEqual(payload.data.preheat, { botA: ['office-xlsx'] })
  assert.equal(payload.data.funnel.loadPreheated, 1)
})

test('routes: POST /settings/save 布尔生效（落盘+翻转），非布尔 400', async () => {
  const { rt, registered } = fakeRuntime(mkdtempSync(join(tmpdir(), 'sr-rt-')))
  const handler = byPath(registered)['/skill-router/api/settings/save'].handler
  // 合法布尔 false：翻转 + unmountAll 摘预挂。
  const res1 = fakeRes()
  await handler(fakeReq('POST', { enabled: false }), res1)
  assert.equal(res1.code, 200)
  assert.equal(rt.isEnabled(), false)
  assert.equal(rt.unmountCalls, 1)
  // 非布尔（字符串/缺字段）一律 400，状态不被污染。
  const res2 = fakeRes()
  await handler(fakeReq('POST', { enabled: 'yes' }), res2)
  assert.equal(res2.code, 400)
  const res3 = fakeRes()
  await handler(fakeReq('POST', {}), res3)
  assert.equal(res3.code, 400)
  assert.equal(rt.isEnabled(), false) // 400 不改状态
  // 非法 JSON body → parse 异常被 route 包装为 400。
  const raw = fakeRes()
  const badReq = fakeReq('POST')
  badReq.on = (ev, cb) => { if (ev === 'data') cb(Buffer.from('{oops')); if (ev === 'end') cb() }
  await handler(badReq, raw)
  assert.equal(raw.code, 400)
  // 恢复 true：翻回且不再摘挂。
  const res4 = fakeRes()
  await handler(fakeReq('POST', { enabled: true }), res4)
  assert.equal(rt.isEnabled(), true)
  assert.equal(rt.unmountCalls, 1)
})

test('routes: GET /donation-qr 返回包内二维码（image/jpeg 非空）', async () => {
  const { registered } = fakeRuntime(mkdtempSync(join(tmpdir(), 'sr-rt-')))
  const handler = byPath(registered)['/skill-router/api/donation-qr'].handler
  const res = fakeRes()
  await handler(fakeReq('GET'), res)
  assert.equal(res.code, 200)
  assert.equal(res.headers['Content-Type'], 'image/jpeg')
  // 与包内源文件逐字节一致（一致性回归：换图必须同步）。
  const src = readFileSync(join(PKG_ROOT, 'assets', 'wechat-donate.jpg'))
  assert.ok(res.body.length > 0)
  assert.ok(Buffer.compare(res.body, src) === 0)
})
