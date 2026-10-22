// 分节读取单测：readSection 的精确/包含/大小写匹配与边界行为。
// readSection 是 indexer.install(rt) 挂出来的纯函数——用空 rt 安装即可测。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as indexer from '../src/host/indexer.js'

const rt = {}
indexer.install(rt)
const readSection = rt.readSection

test('readSection: 精确命中标题（##），取到下一个标题为止', () => {
  const content = ['# 总览', '简介行', '', '## 用法', '第一步', '第二步', '', '## 参数', 'p1'].join('\n')
  const section = readSection(content, '用法')
  assert.ok(section.includes('第一步') && section.includes('第二步'))
  assert.ok(!section.includes('p1'))
  assert.ok(!section.includes('简介行'))
})

test('readSection: 大小写不敏感 + 包含匹配', () => {
  const content = '## Usage Notes\nDo X.\n\n## Other\nY.'
  assert.ok(readSection(content, 'usage').includes('Do X.'))
  // 'age note' 是 'usage notes' 的子串——包含匹配命中。
  assert.ok(readSection(content, 'age note').includes('Do X.'))
})

test('readSection: 标题在文末取到结尾', () => {
  const content = '## Intro\nA\n## 尾节\n最后内容'
  assert.ok(readSection(content, '尾节').includes('最后内容'))
})

test('readSection: 子标题内容跟随本节', () => {
  const content = '## 用法\n### 子节\n子内容\n## 其他\nx'
  const section = readSection(content, '用法')
  assert.ok(section.includes('子内容'))
  assert.ok(!section.includes('x'))
})

test('readSection: 未命中或空标题返回空串', () => {
  assert.equal(readSection('# A\nx', '不存在'), '')
  assert.equal(readSection('# A\nx', ''), '')
  assert.equal(readSection('# A\nx', null), '')
})
