// v0.2.0 预热集挂载引擎（src/host/mount.js）的单元测试。
// 用最小假 ctx 驱动真实 createRuntime（config.home 指向临时目录，
// config.preheatTimers=false 关掉定时器/fs.watch，测试直接 await rt.tickMount）：
//   1. ds-bot 信号缺失/相位未到（unmounting）→ 不挂载（先摘后挂的「挂」闸门）
//   2. 智能模式（systemExpose+unmounted）→ 按画像+频率挑预热集挂载（≤5），
//      skills.register 收到 name/description/content，rt.preheatOf 打标
//   3. 团队自有能力（botEntry.capabilities）排除——同名双注册机制上不可能
//   4. 滞回换位：满员后挑战者需连续 2 轮分数高于最弱现任才换入
//   5. 熔断：registry.get 持续失败 3 轮 → blockedUntil 置位、停止尝试
//   6. 开关关闭 → 全部摘除并写 releasedAt（ds-bot 等 ack 的依据）
//   7. 14 天零调用且画像不再匹配 → 移出预热集
// Unit tests for the preheat mount engine. Drives the real createRuntime with
// a fake ctx (temp home, timers off, manual rt.tickMount).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'

// ── 假环境 ────────────────────────────────────────────────────────────────
// 假技能注册表：list 返回元数据行、get 返回全文；failNames 里的名字抛错
// （熔断测试用）。索引签名基于 list 行——行不变时 getIndex 短路。
function makeRegistry(rows, failNames = new Set()) {
  return {
    list: async () => rows,
    get: async name => {
      if (failNames.has(name)) throw new Error('registry read failed')
      const row = rows.find(entry => entry.name === name)
      return { name, description: row?.description ?? '', content: `FULL CONTENT OF ${name}\nstep one\nstep two` }
    },
  }
}

// 假 Agent：ctx.plugin 同步执行内联插件（apply 收到假插件作用域，effect 立即
// 运行 → skills.register 落进 registered），返回带 await 的假 fiber。
function makeAgent(id) {
  const registered = []
  const agent = {
    session: { id },
    ctx: {
      plugin: plugin => {
        plugin.apply({ effect: fn => fn(), skills: { register: row => registered.push(row) } })
        return { await: async () => {} }
      },
      effect: () => {}, // trackAgent 的清理 effect：测试里无需执行。
    },
  }
  return { agent, registered }
}

// 组装运行时：临时 home + 关定时器 + 假服务（skills/sessionController）。
function makeEnv({ rows, failNames, agents = new Map() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'skill-router-test-'))
  const services = {
    skills: makeRegistry(rows ?? [], failNames),
    sessionController: {
      resolveAgent: async id => {
        const hit = agents.get(id)
        if (!hit) throw new Error('no such session')
        return hit
      },
    },
  }
  const ctx = {
    get: name => services[name],
    on: () => {},
    effect: () => {}, // 记录即弃：测试不触发插件卸载。
    tools: { register: () => {} }, // tools.install 注册元工具用，测试不执行。
  }
  const rt = createRuntime(ctx, { home, preheatTimers: false })
  return { rt, home, agents }
}

// 写 ds-bot 信号（router 的读入口）。
const writeBotSignal = (home, signal) => writeFileSync(join(home, 'dsbot-signal.json'), JSON.stringify(signal))
// 读 router 信号（ds-bot 的读入口，releasedAt 断言用）。
const readRouterSignal = home => JSON.parse(readFileSync(join(home, 'router-signal.json'), 'utf8'))

const ROWS = [
  { name: 'office-xlsx', description: 'Excel spreadsheet editing and formulas', whenToUse: 'spreadsheet tables' },
  { name: 'office-docx', description: 'Word document editing', whenToUse: 'documents' },
  { name: 'paper-figures', description: 'academic chart generation for papers', whenToUse: 'figures' },
  { name: 'web-scraper', description: 'scrape web pages', whenToUse: '' },
  { name: 'db-admin', description: 'database administration', whenToUse: '' },
  { name: 'pdf-tools', description: 'pdf merge split', whenToUse: '' },
  { name: 'music-theory', description: 'music composition theory', whenToUse: '' },
]

test('信号缺失：不挂载，但写出 router 信号（心跳 + 释放确认）', async () => {
  const { rt, home } = makeEnv({ rows: ROWS })
  await rt.tickMount()
  assert.equal(rt.preheatNames.size, 0)
  assert.ok(existsSync(join(home, 'router-signal.json')), 'router 信号应已写出')
  const signal = readRouterSignal(home)
  assert.equal(signal.plugin, 'dsh-skill-router')
  // v0.2.2：非智能分支无条件写 releasedAt（释放确认）——ds-bot 的关闭流程
  // 等的是「router 已放手」的信号而非「摘除动作发生过」，空闲 router 也必须
  // ack，否则 ds-bot 每次关闭都白等 5s 超时。信号缺失同样视为放手。
  // v0.2.2: the non-smart branch always stamps releasedAt — an idle router
  // must ack too, or ds-bot burns its full 5s timeout on every off.
  assert.ok(signal.releasedAt > 0, '非智能状态即应写释放确认（无条件 ack）')
})

test('相位闸门：unmounting 不挂载；unmounted 才挂载（先摘后挂）', async () => {
  const { agent, registered } = makeAgent('sess-1')
  const { rt, home } = makeEnv({ rows: ROWS, agents: new Map([['sess-1', agent]]) })
  const bot = { id: 'bot-1', name: 'A', instructions: 'Excel 表格 电子表格', capabilities: [], sessions: ['sess-1'], rooms: [] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounting' }, bots: [bot] })
  await rt.tickMount()
  assert.equal(registered.length, 0, 'ds-bot 尚未摘完系统挂载，router 不得抢挂')
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [bot] })
  await rt.tickMount()
  assert.ok(registered.length > 0 && registered.length <= 5, '智能模式下挂载预热集（≤5）')
  for (const row of registered) {
    assert.match(row.name, /^[\w-]+$/)
    assert.equal(row.source, 'runtime')
    assert.ok(String(row.content).includes('FULL CONTENT OF'), 'content 应为技能全文')
  }
  assert.equal(rt.preheatOf(registered[0].name), true, '预热集成员应带已预热标记')
})

test('画像排序：instructions 匹配 office 的 Bot 预热到 office-xlsx', async () => {
  const { agent, registered } = makeAgent('sess-2')
  const { rt, home } = makeEnv({ rows: ROWS, agents: new Map([['sess-2', agent]]) })
  const bot = { id: 'bot-1', name: '表姐', instructions: '负责 Excel 表格公式与电子表格处理', capabilities: [], sessions: ['sess-2'], rooms: [{ name: '数据组', notice: '' }] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [bot] })
  await rt.tickMount()
  const names = registered.map(row => row.name)
  assert.ok(names.includes('office-xlsx'), `画像强匹配 office-xlsx，实际: ${names.join(',')}`)
})

test('团队自有排除：capabilities 里的名字不进预热集（防双挂载）', async () => {
  const { agent, registered } = makeAgent('sess-3')
  const { rt, home } = makeEnv({ rows: ROWS, agents: new Map([['sess-3', agent]]) })
  // 画像同时匹配 office-xlsx 与 pdf-tools，但 office-xlsx 是团队自有——
  // ds-bot 会挂它，router 只能挂 pdf-tools。
  const bot = { id: 'bot-1', name: 'A', instructions: 'Excel 表格 pdf 合并拆分', capabilities: ['office-xlsx'], sessions: ['sess-3'], rooms: [] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [bot] })
  await rt.tickMount()
  assert.equal(registered.some(row => row.name === 'office-xlsx'), false, 'ds-bot 会挂团队自有 office-xlsx，router 不得重复挂')
  assert.equal(registered.some(row => row.name === 'pdf-tools'), true, '其余匹配项正常进预热集')
})

test('滞回换位：挑战者连续 2 轮高于最弱现任才换入', async () => {
  // 第一轮：画像 A 占满 5 席；随后给全部成员记新鲜使用（否则 14 天零调用 +
  // 画像不再匹配会直接触发「移出」——那是另一条规则，滞回测的是「画像仍然
  // 有效时的换位防抖」）。画像切到 B 后挑战者 music-theory 分数高于最弱
  // 现任：第 1 轮只记 streak，第 2 轮才换位。
  const { agent, registered } = makeAgent('sess-4')
  const { rt, home } = makeEnv({ rows: ROWS, agents: new Map([['sess-4', agent]]) })
  // 画像 A 召出 5 个候选：pdf-tools、db-admin、paper-figures、web-scraper、office-xlsx。
  const botA = { id: 'bot-1', name: 'A', instructions: 'pdf merge split 合并 拆分 db-admin 数据库管理 academic chart figures 论文图 Excel 表格', capabilities: [], sessions: ['sess-4'], rooms: [] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [botA] })
  await rt.tickMount()
  const first = [...rt.preheatView['bot-1']]
  assert.ok(first.length === 5, `第一轮应挂满 5 项，实际 ${first.length}: ${first.join(',')}`)
  // 现任成员记新鲜使用且热度不均（一席 6、其余 1）：让最弱现任的频率分
  // （0.2×log1p(1)/log1p(6)≈0.07）显著低于挑战者，滞回断言不受边界影响。
  rt.state.usage['sess-4'] = Object.fromEntries(first.map((name, index) => [name, { count: index === 0 ? 6 : 1, lastAt: Date.now() }]))
  // 画像切到 music-theory 强匹配。
  const botB = { ...botA, instructions: 'music composition theory 作曲 和声 乐理' }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [botB] })
  await rt.tickMount()
  assert.equal(rt.preheatView['bot-1'].includes('music-theory'), false, '第 1 轮挑战者不得换入（滞回）')
  assert.ok((rt.state.hysteresis['bot-1']?.['music-theory'] ?? 0) >= 1, 'streak 应已累计')
  await rt.tickMount()
  assert.equal(rt.preheatView['bot-1'].includes('music-theory'), true, '第 2 轮连续超现任 → 换入')
})

test('开关关闭：全部摘除并写 releasedAt（交接 ack）', async () => {
  const { agent, registered } = makeAgent('sess-5')
  const { rt, home } = makeEnv({ rows: ROWS, agents: new Map([['sess-5', agent]]) })
  const bot = { id: 'bot-1', name: 'A', instructions: 'Excel 表格', capabilities: [], sessions: ['sess-5'], rooms: [] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [bot] })
  await rt.tickMount()
  assert.ok(registered.length > 0)
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: false, handshake: { phase: 'off' }, bots: [bot] })
  await rt.tickMount()
  assert.equal(rt.preheatNames.size, 0)
  const signal = readRouterSignal(home)
  assert.ok(signal.releasedAt > 0, '应写 releasedAt，ds-bot 收到后才重新全量挂载')
})

test('熔断：registry.get 连续失败 3 轮 → blockedUntil 置位、停止尝试', async () => {
  const { agent, registered } = makeAgent('sess-6')
  // registry.list 正常、get 全部失败：索引里有名，挂载必败。
  const { rt, home } = makeEnv({ rows: ROWS, failNames: new Set(ROWS.map(row => row.name)), agents: new Map([['sess-6', agent]]) })
  const bot = { id: 'bot-1', name: 'A', instructions: 'Excel 表格', capabilities: [], sessions: ['sess-6'], rooms: [] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [bot] })
  await rt.tickMount()
  await rt.tickMount()
  await rt.tickMount()
  assert.equal(registered.length, 0, '全文读不到就不该注册')
  const entry = rt.state.circuit['bot-1|office-xlsx']
  assert.ok(entry && entry.blockedUntil > Date.now(), `三次失败后应熔断，实际 ${JSON.stringify(entry)}`)
  await rt.tickMount()
  // deepEqual 而非 equal：equal 是引用比较，两个独立空数组永不相等。
  assert.deepEqual(rt.preheatView['bot-1'] ?? [], [], '熔断成员降级出预热集（纯检索路径兜底）')
})

test('14 天零调用且画像不再匹配 → 移出预热集', async () => {
  const { agent, registered } = makeAgent('sess-7')
  const { rt, home } = makeEnv({ rows: ROWS, agents: new Map([['sess-7', agent]]) })
  const botWithProfile = { id: 'bot-1', name: 'A', instructions: 'Excel 表格电子表格', capabilities: [], sessions: ['sess-7'], rooms: [] }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [botWithProfile] })
  await rt.tickMount()
  assert.ok(rt.preheatView['bot-1'].includes('office-xlsx'))
  // 画像清空 + 使用记录推到 15 天前：频率与画像两条路都断了。
  rt.state.usage['sess-7'] = { 'office-xlsx': { count: 3, lastAt: Date.now() - 15 * 24 * 60 * 60 * 1000 } }
  const botEmpty = { ...botWithProfile, instructions: '' }
  await writeBotSignal(home, { plugin: 'ds-bot', systemExpose: true, handshake: { phase: 'unmounted' }, bots: [botEmpty] })
  await rt.tickMount()
  assert.equal(rt.preheatView['bot-1'].includes('office-xlsx'), false, '14 天零调用且画像不匹配应移出')
  assert.equal(registered.some(row => row.name === 'office-xlsx'), true, '本轮仍保留旧挂载（下一轮差异摘除后自然消失）——视图先行')
})
