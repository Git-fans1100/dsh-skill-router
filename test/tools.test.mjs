// 元工具单测：假运行时（不触 ctx 真服务）验证 search/load 的行为与计数。
// 假 ctx 只提供 tools.register 收集器；索引与全文直接喂静态数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as indexer from '../src/host/indexer.js'
import * as scorer from '../src/host/scorer.js'
import * as usageModule from '../src/host/usage.js'
import * as tools from '../src/host/tools.js'

const INDEX = {
  signature: 'sig-test',
  items: [
    { kind: 'skill', name: '图表生成', description: '生成统计图表与学术配图', whenToUse: '用户要画图时', detail: '' },
    { kind: 'skill', name: '数据清洗', description: 'Excel 数据清理', whenToUse: '', detail: '' },
    { kind: 'mcp', name: 'promptx', description: 'MCP server (stdio)', whenToUse: '', detail: 'npx promptx' },
  ],
}

function fakeRuntime() {
  const registered = []
  // state 形状与 index.js createRuntime 保持一致（真实运行时由入口构建，
  // 假运行时需自备——usage 模块信任它存在）。
  const rt = {
    ctx: { tools: { register: tool => registered.push(tool) } },
    state: { usage: {}, funnel: { search: 0, load: 0, use: 0 } },
  }
  indexer.install(rt)
  scorer.install(rt)
  usageModule.install(rt)
  rt.saveState = () => {} // 测试不落盘
  rt.index = INDEX
  rt.getIndex = async () => rt.index
  rt.readSkillContent = async name => (name === '图表生成' ? '## 用法\n生成图表的步骤。' : '')
  tools.install(rt)
  return { rt, find: name => registered.find(tool => tool.name === name) }
}

test('install: 注册两个元工具且形状完整', () => {
  const { find } = fakeRuntime()
  for (const name of ['capability_search', 'capability_load']) {
    const tool = find(name)
    assert.ok(tool, `${name} 未注册`)
    assert.equal(typeof tool.execute, 'function')
    assert.ok(tool.description)
  }
})

test('install: parameters 编译为 object 根 schema（v0.1.1 修复回归）', () => {
  // 透传字段集合会让 LLM API 报 "schema must be a JSON Schema of
  // 'type: object', got 'type: null'"——defineTool 必须包一层转换。
  const { find } = fakeRuntime()
  for (const name of ['capability_search', 'capability_load']) {
    const schema = find(name).parameters
    assert.equal(schema.type, 'object', `${name} 顶层缺 type: object`)
    assert.equal(typeof schema.properties, 'object')
    assert.ok(Array.isArray(schema.required))
  }
  // required 收集：search 的 query、load 的 name 为必填；其余可选。
  assert.deepEqual(find('capability_search').parameters.required, ['query'])
  assert.deepEqual(find('capability_load').parameters.required, ['name'])
  // required 标志不得泄漏进属性 schema（JSON Schema 无此关键字）。
  const queryProp = find('capability_search').parameters.properties.query
  assert.equal(queryProp.required, undefined)
  assert.equal(queryProp.type, 'string')
  // enum 字段原样保留。
  assert.deepEqual(find('capability_search').parameters.properties.scope.enum, ['all', 'skill', 'mcp'])
})

test('capability_search: 命中技能并列出，未命中被排除，漏斗 +1', async () => {
  const { rt, find } = fakeRuntime()
  const text = await find('capability_search').execute({ query: '画图' }, { agent: { id: 's1' } })
  assert.ok(text.includes('图表生成'))
  assert.ok(!text.includes('数据清洗'))
  assert.ok(text.includes('★'))
  assert.ok(text.includes('capability_load'))
  assert.equal(rt.state.funnel.search, 1)
})

test('capability_search: 同会话同查询走缓存，签名变化即失效', async () => {
  const { rt, find } = fakeRuntime()
  const first = await find('capability_search').execute({ query: '画图' }, { agent: { id: 's1' } })
  const second = await find('capability_search').execute({ query: '画图' }, { agent: { id: 's1' } })
  assert.equal(first, second)
  // 缓存命中不进漏斗：重复查询是转化率校准（search→load 比值）的噪声分母，
  // 只在真实重算时计数（tools.js 中 recordSearch 位于缓存命中 return 之后）。
  assert.equal(rt.state.funnel.search, 1)
  rt.index = { ...rt.index, signature: 'sig-2' } // registry 更新模拟
  const third = await find('capability_search').execute({ query: '画图' }, { agent: { id: 's1' } })
  assert.equal(third, first)
  assert.equal(rt.state.funnel.search, 2) // 签名失效 → 重算 → 重新计数
})

test('capability_search: scope=mcp 只在 MCP 池里找', async () => {
  const { find } = fakeRuntime()
  const text = await find('capability_search').execute({ query: 'promptx', scope: 'mcp' }, { agent: { id: 's1' } })
  assert.ok(text.includes('promptx'))
  assert.ok(!text.includes('图表生成'))
})

test('capability_search: 空查询直接拒绝且不计数', async () => {
  const { rt, find } = fakeRuntime()
  const text = await find('capability_search').execute({ query: '  ' }, { agent: { id: 's1' } })
  assert.ok(text.includes('non-empty'))
  assert.equal(rt.state.funnel.search, 0)
})

test('capability_load: 全文 + 头部提示 + load 计数与热度', async () => {
  const { rt, find } = fakeRuntime()
  const text = await find('capability_load').execute({ name: '图表生成' }, { agent: { id: 's1' } })
  assert.ok(text.includes('## 用法'))
  assert.ok(text.includes('capability_search')) // 头部提示引导改查
  assert.equal(rt.state.funnel.load, 1)
  assert.equal(rt.heatOf('图表生成'), 1)
})

test('capability_load: section 命中只返回该节', async () => {
  const { find } = fakeRuntime()
  const text = await find('capability_load').execute({ name: '图表生成', section: '用法' }, { agent: { id: 's1' } })
  assert.ok(text.includes('Section "用法"'))
  assert.ok(text.includes('生成图表的步骤'))
})

test('capability_load: 未知名给出近似名提示', async () => {
  const { find } = fakeRuntime()
  const text = await find('capability_load').execute({ name: '不存在' }, { agent: { id: 's1' } })
  assert.ok(text.includes('No capability'))
  assert.ok(text.includes('图表生成')) // Available 列表里能看到
})

test('capability_load: MCP 项返回使用指引且同样计数', async () => {
  const { rt, find } = fakeRuntime()
  const text = await find('capability_load').execute({ name: 'promptx' }, { agent: { id: 's1' } })
  assert.ok(text.includes('MCP server'))
  assert.ok(text.includes('mcp__'))
  assert.equal(rt.heatOf('promptx'), 1)
})
