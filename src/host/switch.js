// 总开关模块（SPEC §3.4）：enabled 标志的内存/落盘双态管理。
// 存储：<home>/config.json，形状 { enabled:boolean, savedAt:iso }；
// 缺文件/坏 JSON/缺字段一律按「启用」兜底（向后兼容：装了就用）。
// 关闭动作联动摘除全部预挂（rt.unmountAll 由 mount 模块提供）——
// 防「残留预挂 + ds-bot 回退全量挂载」的双挂现象。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function install(rt) {
  const configPath = () => join(rt.home, 'config.json')

  // 读持久化开关：任何异常都兜底为启用。
  const readEnabled = () => {
    try {
      const saved = JSON.parse(readFileSync(configPath(), 'utf8'))
      return typeof saved.enabled === 'boolean' ? saved.enabled : true
    } catch {
      return true
    }
  }

  // install 期同步读一次进内存；运行期只读内存（热切换由 setEnabled 维护）。
  rt.enabled = readEnabled()
  rt.isEnabled = () => rt.enabled

  // 热切换：内存先翻（立即生效），再落盘（重启持久）；失败仅告警不回滚——
  // 内存态已是用户意图，落盘失败只影响重启后的初值，下一轮可再切一次。
  rt.setEnabled = value => {
    rt.enabled = value
    if (value === false) rt.unmountAll?.()
    try {
      writeFileSync(configPath(), JSON.stringify({ enabled: value, savedAt: new Date().toISOString() }, null, 2))
    } catch (error) {
      rt.warn?.('skill-router: persist config failed:', error?.message ?? error)
    }
  }
}
