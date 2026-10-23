// 总开关模块单测（SPEC §3.4）：enabled 标志的内存/落盘双态、持久性、
// 坏文件兜底，以及关闭时主动摘除预挂的接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as switchModule from '../src/host/switch.js'

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'sr-switch-'))
}

// 极简假运行时：只带 switch 模块需要的字段（home / unmountAll 探针）。
function fakeRuntime(home) {
  const rt = { home, ctx: {}, state: {}, warn: () => {} }
  rt.unmountCalls = 0
  rt.unmountAll = () => { rt.unmountCalls += 1 }
  switchModule.install(rt)
  return rt
}

test('switch: 缺省（无 config.json）为启用', () => {
  const rt = fakeRuntime(freshHome())
  assert.equal(rt.isEnabled(), true)
})

test('switch: setEnabled(false) 内存+落盘双写，isEnabled 立即翻转', () => {
  const home = freshHome()
  const rt = fakeRuntime(home)
  rt.setEnabled(false)
  assert.equal(rt.isEnabled(), false)
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  assert.equal(saved.enabled, false)
  assert.ok(typeof saved.savedAt === 'string')
})

test('switch: 持久性——同一 home 重新 install 读回关闭态', () => {
  const home = freshHome()
  fakeRuntime(home).setEnabled(false)
  const again = fakeRuntime(home)
  assert.equal(again.isEnabled(), false)
})

test('switch: 关闭时主动摘除预挂（unmountAll），打开时不摘', () => {
  const rt = fakeRuntime(freshHome())
  rt.setEnabled(false)
  assert.equal(rt.unmountCalls, 1) // 关 = 清干净，防"残留预挂 + ds-bot 全量回挂"双挂
  rt.setEnabled(true)
  assert.equal(rt.unmountCalls, 1) // 开 = 只翻标志，下一轮 tick 自然恢复
})

test('switch: config.json 坏 JSON 兜底为启用且不抛', () => {
  const home = freshHome()
  writeFileSync(join(home, 'config.json'), '{oops')
  const rt = fakeRuntime(home)
  assert.equal(rt.isEnabled(), true)
})

test('switch: 落盘文件确实存在于 home（便于人工核对）', () => {
  const home = freshHome()
  const rt = fakeRuntime(home)
  rt.setEnabled(true)
  assert.ok(existsSync(join(home, 'config.json')))
})
