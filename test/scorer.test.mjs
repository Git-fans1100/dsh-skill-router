// 评分器单测：bigram 化、字段加权相关度、粗排、精排公式各分量与统一入口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { bigrams, relevance, coarsePass, frequencyNorm, failPenalty, precisionScore, rank, expandQuery, install as scorerInstall } from '../src/host/scorer.js'

test('bigrams: 中文滑窗 + 单字兜底', () => {
  const grams = bigrams('图表')
  assert.ok(grams.has('图') && grams.has('表') && grams.has('图表'))
  assert.equal(grams.size, 3)
  assert.equal(bigrams('').size, 0)
  assert.equal(bigrams(null).size, 0)
})

test('bigrams: 英文词边界不跨段组 bigram', () => {
  const grams = bigrams('web search')
  assert.ok(grams.has('we') && grams.has('eb') && grams.has('se'))
  // 词边界（空格）两侧不得成组——「b s」是噪声配对。
  assert.ok(!grams.has('b '))
})

test('bigrams: 大小写归一', () => {
  assert.deepEqual([...bigrams('Web')], [...bigrams('web')])
})

test('relevance: name 命中权重高于 description 命中', () => {
  const query = bigrams('图表')
  const byName = relevance({ name: '图表', whenToUse: '', description: 'other stuff' }, query)
  const byDesc = relevance({ name: 'unrelated', whenToUse: '', description: '图表生成' }, query)
  assert.ok(byName > byDesc)
  assert.ok(byName > 0 && byDesc > 0)
  // 完全命中 name 字段：3×1 / 6 = 0.5。
  assert.ok(Math.abs(byName - 0.5) < 1e-9)
})

test('relevance: 全不命中为 0', () => {
  assert.equal(relevance({ name: 'abc', whenToUse: '', description: 'def' }, bigrams('xyz')), 0)
  assert.equal(relevance({ name: 'abc', whenToUse: '', description: 'def' }, bigrams('')), 0)
})

test('coarsePass: 只留命中项并按相关度降序', () => {
  const items = [
    { name: '图表', whenToUse: '', description: '' },
    { name: '无关', whenToUse: '', description: '' },
    { name: '图表导出', whenToUse: '', description: '' },
    { name: '表格式样', whenToUse: '', description: '' },
  ]
  const passed = coarsePass(items, bigrams('图表'))
  assert.equal(passed.length, 3)
  assert.ok(!passed.some(entry => entry.item.name === '无关'))
  assert.ok(passed[0].relevance >= passed[1].relevance)
  assert.ok(passed.some(entry => entry.item.name === '图表'))
})

test('coarsePass: limit 截断生效（默认 20）', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ name: `技能${i}图表`, whenToUse: '', description: '' }))
  assert.equal(coarsePass(items, bigrams('图表')).length, 20)
  assert.equal(coarsePass(items, bigrams('图表'), 5).length, 5)
})

test('frequencyNorm: log1p 归一与零分母保护', () => {
  assert.equal(frequencyNorm(5, 0), 0)   // 全库无使用记录
  assert.equal(frequencyNorm(0, 10), 0)  // 该项零热度
  assert.equal(frequencyNorm(10, 10), 1) // 最高热度 → 1
  // log 压缩：count 5 不至于腰斩到 0.5（5/10 线性值），但显著低于 1。
  const half = frequencyNorm(5, 10)
  assert.ok(half > 0.5 && half < 1)
})

test('failPenalty: 线性增长封顶 0.2', () => {
  assert.equal(failPenalty(0), 0)
  assert.equal(failPenalty(2), 0.1)
  assert.equal(failPenalty(4), 0.2)
  assert.equal(failPenalty(99), 0.2)
  assert.equal(failPenalty(undefined), 0)
})

test('precisionScore: 频率项把同相关度项抬上去', () => {
  const query = bigrams('图表')
  const entry = { item: { name: '图表', whenToUse: '', description: '' }, relevance: 1 }
  const cold = precisionScore(entry, query, {})
  const hot = precisionScore(entry, query, { heatOf: () => 10, maxHeat: () => 10 })
  // relevance 1 + 频率 1 → 0.50 + 0.25 = 0.75（预热/协同/失败全中性）。
  assert.ok(Math.abs(hot - 0.75) < 1e-9)
  assert.ok(hot > cold)
  // 预热信号：+0.15。
  const preheated = precisionScore(entry, query, { preheatOf: () => true })
  assert.ok(Math.abs(preheated - (cold + 0.15)) < 1e-9)
  // 软失败信号：−惩罚。
  const failing = precisionScore(entry, query, { softFailOf: () => 2 })
  assert.ok(Math.abs(failing - (cold - 0.1)) < 1e-9)
})

test('rank: 精排取 Top5 且分数降序', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `图表技能${i}`, whenToUse: '', description: '' }))
  const { matches, total, matched } = rank(items, '图表')
  assert.equal(total, 12)
  assert.equal(matched, 12)
  assert.equal(matches.length, 5)
  for (let i = 1; i < matches.length; i++) assert.ok(matches[i - 1].score >= matches[i].score)
})

test('expandQuery: 中文词命中同义组后追加其余变体', () => {
  const expanded = expandQuery('画生存曲线', [['生存曲线', 'km', 'kaplan-meier']])
  assert.ok(expanded.startsWith('画生存曲线'))
  assert.ok(expanded.includes(' km ') && expanded.includes('kaplan-meier'))
  // 无命中时不追加（保持原查询，避免词典污染）。
  assert.equal(expandQuery('画图', [['生存曲线', 'km']]), '画图')
})

test('expandQuery: 英文词按词边界命中，不误配子串', () => {
  // 'bookmark' 含 'km' 子串但不是独立词——不得触发同义组。
  assert.equal(expandQuery('bookmark manager', [['生存曲线', 'km']]), 'bookmark manager')
  // 独立词 'km' 触发，追加中文变体。
  assert.ok(expandQuery('draw km', [['生存曲线', 'km']]).includes('生存曲线'))
})

test('expandQuery: 大小写归一 + 用户词典过滤坏组', () => {
  assert.ok(expandQuery('KM', [['生存曲线', 'km']]).includes('生存曲线'))
  const dict = [['a', 'b'], 'not-an-array', [], ['chart', 'plot']]
  assert.ok(expandQuery('chart', dict).includes('plot'))
  // 空查询安全。
  assert.equal(expandQuery('', [['a', 'b']]), '')
})

test('rank × expandQuery: 同义扩展救回措辞不同的漏检技能', () => {
  // 技能元数据只写 'KM'，查询用中文「生存曲线」——词法 bigram 零命中，
  // 扩展后（追加 km/kaplan-meier）粗排召回该技能。
  const items = [{ name: 'KM Plot', whenToUse: '', description: 'kaplan-meier survival charts' }]
  assert.equal(rank(items, '生存曲线').matched, 0, '扩展前应零命中')
  const expanded = rank(items, expandQuery('生存曲线', [['生存曲线', 'km']]))
  assert.ok(expanded.matched > 0 && expanded.matches.length > 0, '扩展后应召回')
})

test('expandQuery + install: rt.rank 组装（用户词典经 config 注入）', () => {
  // install 层验证：rt.config.synonyms 用户词典与内置表合并后生效——
  // 「问候」不在内置表，只有用户词典里有。
  const rt = { config: { synonyms: [['问候', 'greeting']] } }
  scorerInstall(rt)
  assert.ok(rt.rank([{ name: 'Greet', whenToUse: '', description: 'say hello' }], '问候').matches.length > 0)
})

test('rank: 全不命中返回空 matches', () => {
  const { matches, matched } = rank([{ name: 'abc', whenToUse: '', description: '' }], '完全无关的查询')
  assert.equal(matched, 0)
  assert.equal(matches.length, 0)
})
