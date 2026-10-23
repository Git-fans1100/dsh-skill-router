// brief 抽取单测（SPEC §3.2 路线 B）：token 估算、短文短路、机械精简
// 结构、目录树硬保证、预算带（300-800）与降级顺序。
import test from 'node:test'
import assert from 'node:assert/strict'
import { estTokens, extractBrief } from '../src/host/brief.js'

// 合成 SKILL.md 样式文档：标题 + 铺陈段落 + 代码块 + n 个二级节。
function makeDoc(nSections, paraLen = 60) {
  let md = '# 图表生成技能\n\n' + '这是文档开头的总述段落，介绍技能定位。'.repeat(paraLen) + '\n\n'
  for (let i = 0; i < nSections; i++) {
    md += `## 节${i}标题\n\n首句：这是节${i}的第一句话，概括本节内容。\n\n`
    md += '铺陈段落内容补充说明细节。'.repeat(paraLen) + '\n\n'
    md += '```\ncode line ' + i + '\n```\n\n'
  }
  return md
}

test('estTokens: 中文按字计、英文按四分之一字符计', () => {
  assert.equal(estTokens('图表'), 2)
  assert.equal(estTokens('abcdefgh'), 2) // 8 字符 / 4
  assert.equal(estTokens('图a图b'), 3) // 2 中文 + ceil(2 英文/4)
  assert.equal(estTokens(''), 0)
  assert.equal(estTokens(null), 0)
})

test('extractBrief: 短全文（≤800 token）原样返回，精简得不偿失', () => {
  const short = '# 小技能\n\n直接用就行。\n'
  assert.equal(extractBrief(short), short)
})

test('extractBrief: 长文档 → 目录树 + 各节首句，铺陈与代码不全文带入', () => {
  const doc = makeDoc(8)
  const brief = extractBrief(doc)
  // 目录树硬保证（SPEC：brief 必须展示完整目录树供 section 点名）。
  assert.ok(brief.includes('# 图表生成技能'))
  assert.ok(brief.includes('## 节7标题'))
  // 各节首句保留。
  assert.ok(brief.includes('这是节0的第一句话'))
  // 铺陈不全文带入（机械精简的核心收益）。
  assert.ok(!brief.includes('铺陈段落内容'))
  // 代码块内容不进首句。
  assert.ok(!brief.includes('code line'))
  // 预算带上限。
  assert.ok(estTokens(brief) <= 800, `brief 超预算：${estTokens(brief)}`)
})

test('extractBrief: 目录树保留层级缩进（三级标题可见层级）', () => {
  const doc = makeDoc(2) + '### 子节细节\n\n子节首句。\n\n' + '填充内容。'.repeat(80) + '\n'
  const brief = extractBrief(doc)
  const treeLine = brief.split('\n').find(l => l.includes('子节细节'))
  assert.ok(treeLine, '三级标题必须出现在目录树')
  assert.ok(/^\s+\S/.test(treeLine), '三级标题应有缩进以体现层级')
})

test('extractBrief: 精简结果 <300 token 且原文 ≤1600 时退回全文', () => {
  // 原文略超 800（触发精简）但 ≤1600：精简后必然不足 300，直返全文更划算。
  const doc = '# 技能\n\n' + '内容段。'.repeat(300) + '\n' // ≈900+ token，结构简单
  const brief = extractBrief(doc)
  assert.equal(brief, doc)
})

test('extractBrief: 巨长文档逐级降级——先丢首句，目录树永在', () => {
  const doc = makeDoc(40)
  const brief = extractBrief(doc)
  assert.ok(estTokens(brief) <= 800, `降级后仍超预算：${estTokens(brief)}`)
  // 目录树是硬保证：40 个节标题全部保留。
  for (let i = 0; i < 40; i++) assert.ok(brief.includes(`## 节${i}标题`))
  // 首句按预算裁掉（40 节首句远超 800），只保留前若干节。
  assert.ok(!brief.includes('这是节39的第一句话'))
})

test('extractBrief: 节体只有代码块时该节仅出现在目录树', () => {
  // 原文 >1600 token：避开「精简后 <300 且原文 ≤1600 退回全文」的经济规则带，
  // 确保走精简路径来验证代码块排除行为本身。
  const md = '# 脚本技能\n\n总述。' + '铺陈。'.repeat(300) + '\n\n## 用法\n\n```\nrun.cmd\n```\n\n' + '尾部铺陈。'.repeat(300) + '\n'
  assert.ok(estTokens(md) > 1600)
  const brief = extractBrief(md)
  assert.ok(brief.includes('## 用法'))
  assert.ok(!brief.includes('run.cmd'), '纯代码节不产生首句，代码内容不带入')
})

test('extractBrief: 空与异常输入安全', () => {
  assert.equal(extractBrief(''), '')
  assert.equal(extractBrief(null), '')
})
