// capability_stats 只读统计工具单测：漏斗露出、预热命中记账（loadPreheated）、
// Top 热度、熔断状态，以及「纯读不写」的只读性。
// 假运行时与 tools.test.mjs 同款：静态索引 + 假 ctx，不触宿主真服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as indexer from '../src/host/indexer.js'
import * as scorer from '../src/host/scorer.js'
import * as usageModule from '../src/host/usage.js'
import * as briefModule from '../src/host/brief.js'
import * as statsModule from '../src/host/stats.js'
import * as tools from '../src/host/tools.js'

const INDEX = {
  signature: 'sig-stats',
  items: [
    { kind: 'skill', name: '图表生成', description: '生成统计图表与学术配图', whenToUse: '用户要画图时', detail: '' },
    { kind: 'skill', name: '数据清洗', description: 'Excel 数据清理', whenToUse: '', detail: '' },
    { kind: 'mcp', name: 'promptx', description: 'MCP server (stdio)', whenToUse: '', detail: 'npx promptx' },
  ],
}

function fakeRuntime() {
  const registered = []
  // state 形状与 index.js createRuntime 一致（漏斗四键中 loadPreheated 由
  // usage 模块按需创建，初值缺失时读取侧按 0 处理）。
  const rt = {
    ctx: { tools: { register: tool => registered.push(tool) } },
    state: { usage: {}, funnel: { search: 0, load: 0, use: 0 } },
  }
  indexer.install(rt)
  scorer.install(rt)
  usageModule.install(rt)
  briefModule.install(rt)
  statsModule.install(rt)
  rt.saveState = () => {} // 测试不落盘
  rt.index = INDEX
  rt.getIndex = async () => rt.index
  rt.readSkillContent = async name => (name === '图表生成' ? '## 用法\n生成图表的步骤。' : '')
  rt.readSkillRef = async () => null
  // 预热视图默认空（等价基础模式）；预热判定默认未命中——相关用例自行覆写。
  rt.preheatView = {}
  rt.preheatNames = new Set()
  rt.preheatOf = () => false
  tools.install(rt)
  return { rt, find: name => registered.find(tool => tool.name === name) }
}

test('install: capability_stats 注册为只读元工具（零参数）', async () => {
  const { find } = fakeRuntime()
  const tool = find('capability_stats')
  assert.ok(tool, 'capability_stats 未注册')
  assert.equal(typeof tool.execute, 'function')
  // 零参数：properties 为空对象；defineTool 在无必填时不产出 required 键。
  assert.deepEqual(tool.parameters.properties, {})
  assert.equal(tool.parameters.required, undefined)
  const text = await tool.execute({}, { agent: { id: 's1' } })
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
})

test('capability_stats: 纯读不写——执行前后 state 快照不变且不计漏斗', async () => {
  const { rt, find } = fakeRuntime()
  rt.state.funnel = { search: 3, load: 1, use: 0 }
  const before = JSON.stringify(rt.state)
  await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.equal(JSON.stringify(rt.state), before)
  assert.equal(rt.state.funnel.search, 3) // stats 自己不进漏斗
})

test('capability_stats: 空状态不抛错且如实显示 0 与无预热', async () => {
  const { find } = fakeRuntime()
  const text = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.ok(text.includes('0 searches'))
  assert.ok(text.includes('0 loads'))
  assert.ok(text.includes('none')) // 预热集/Top 使用为空的兜底表述
})

test('capability_stats: 漏斗数字与转化率正确', async () => {
  const { rt, find } = fakeRuntime()
  rt.state.funnel = { search: 8, load: 2, use: 0 }
  const text = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.ok(text.includes('8 searches'))
  assert.ok(text.includes('2 loads'))
  assert.ok(text.includes('25.0%'))
})

test('capability_stats: 预热命中率 = loadPreheated / load，load=0 时 n/a', async () => {
  const { rt, find } = fakeRuntime()
  rt.state.funnel = { search: 8, load: 2, use: 0, loadPreheated: 1 }
  const hit = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.ok(hit.includes('1/2'))
  assert.ok(hit.includes('50.0%'))
  // load=0：除零保护，显示 n/a 而非 NaN/0%。
  rt.state.funnel = { search: 8, load: 0, use: 0, loadPreheated: 0 }
  const none = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.ok(none.includes('n/a'))
  assert.ok(!none.includes('NaN'))
})

test('usage.recordLoad: 预热集内技能的 load 同时记入 loadPreheated', async () => {
  const { rt, find } = fakeRuntime()
  // 只有「图表生成」在预热集内：同会话各 load 一次，验证记账分流。
  rt.preheatOf = name => name === '图表生成'
  const load = find('capability_load')
  await load.execute({ name: '图表生成' }, { agent: { id: 's1' } })
  await load.execute({ name: '数据清洗' }, { agent: { id: 's1' } })
  assert.equal(rt.state.funnel.load, 2)
  assert.equal(rt.state.funnel.loadPreheated, 1)
})

test('capability_stats: Top 使用按近 7 天热度降序', async () => {
  const { rt, find } = fakeRuntime()
  const now = Date.now()
  // 图表生成 = 3+3 = 6（跨会话聚合），数据清洗 = 5 → 排序在前。
  rt.state.usage = {
    s1: { 图表生成: { count: 3, lastAt: now }, 数据清洗: { count: 5, lastAt: now } },
    s2: { 图表生成: { count: 3, lastAt: now } },
  }
  const text = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  const chartAt = text.indexOf('图表生成 ×6')
  const cleanAt = text.indexOf('数据清洗 ×5')
  assert.ok(chartAt !== -1, '缺少 图表生成 ×6 行')
  assert.ok(cleanAt !== -1, '缺少 数据清洗 ×5 行')
  assert.ok(chartAt < cleanAt, 'Top 排序应按热度降序')
})

test('capability_stats: 预热集现状按 Bot 展示', async () => {
  const { rt, find } = fakeRuntime()
  rt.preheatView = { botA: ['office-xlsx', 'office-docx'], botB: ['pdf-tools'] }
  const text = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.ok(text.includes('botA: office-xlsx, office-docx'))
  assert.ok(text.includes('botB: pdf-tools'))
})

test('capability_stats: 只列熔断中（未过期）的技能，索引规模如实显示', async () => {
  const { rt, find } = fakeRuntime()
  rt.state.circuit = {
    'botA|被熔断技能': { fails: 3, blockedUntil: Date.now() + 60_000 },
    'botB|已过期技能': { fails: 3, blockedUntil: Date.now() - 1 },
  }
  const text = await find('capability_stats').execute({}, { agent: { id: 's1' } })
  assert.ok(text.includes('被熔断技能'))
  assert.ok(!text.includes('已过期技能'))
  assert.ok(text.includes('3 capabilities indexed'))
})
