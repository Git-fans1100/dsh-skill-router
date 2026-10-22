// dsh-skill-router：DeepSeek Harness 技能调度中心（SPEC.md v1.0，迁移第 2 步）。
//
// 第 2 步范围（接管开关，第 1 步骨架之上新增）：
//   1. 预热集挂载引擎（src/host/mount.js）：智能调度模式下把每个 Bot 的
//      预热集（≤5 项技能）挂进其全部会话；滞回换位 + 14 天零调用移出 + 熔断。
//   2. 与 ds-bot 的信号文件握手（先摘后挂，防双挂载窗口，SPEC §7.2）：
//      dsbot-signal.json（ds-bot 写 / router 读）+ router-signal.json（反向）。
//   3. 统一评分器离线口：预热集用画像文本（instructions+群主题）跑同一评分器，
//      与 capability_search 在线口径一致（SPEC §4.5）。
//
// 沿用第 1 步：只读索引器、capability_search / capability_load 元工具、
// 使用计数 + 漏斗统计。明确不做（第 3 步）：brief 抽取（load 暂返全文）。
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as indexer from './src/host/indexer.js'
import * as scorer from './src/host/scorer.js'
import * as usage from './src/host/usage.js'
import * as tools from './src/host/tools.js'
import * as mount from './src/host/mount.js'

export const name = 'dsh-skill-router'
// 版本：与 package.json 保持一致（router-signal.json 携带给 ds-bot 展示）。
// v0.2.1：预热挂载引擎实测修复——resolveAgent 超时闸 + tick 看门狗 + 心跳
// 独立于业务 tick（详见 mount.js 内注释）。
// v0.2.2：关闭流程 ack 修复——router 进入非智能状态即无条件刷 releasedAt
// （旧逻辑只在真摘除过挂载时写，空闲 router 导致 ds-bot 关闭白等 5s 超时）。
export const version = '0.2.2'

// cordis 服务注入：注册工具需要 'tools' 服务。
// skills / agentPresets / loader 走 ctx.get() 运行时动态获取——与 ds-bot
// capabilities.js 同款做法（get 是动态查询，不需要 inject 声明；直接访问
// ctx.skills 之类才会因缺 inject 抛 "without inject" 错误）。
export const inject = ['tools']

export function apply(ctx, config = {}) {
  return createRuntime(ctx, config)
}

// 独立导出 createRuntime 便于测试环境注入假 ctx。
export function createRuntime(ctx, config = {}) {
  // 数据目录：DSH_HOME 优先（宿主约定），缺省回落 ~/.dsh——与 ds-bot 的
  // folders.dshHomeOf 语义一致但不依赖其内部模块。
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const home = config.home ?? join(dshHome, 'skill-router')
  const rt = {
    ctx,
    config,
    home,
    statePath: join(home, 'state.json'),
    // state：使用计数（会话×技能）与漏斗统计（search/load/use 总次数）。
    // 结构：{ usage: { [sessionId]: { [name]: { count, lastAt } } }, funnel: { search, load, use } }
    // v0.2.0 新增两块持久化：hysteresis（预热集滞回计数）与 circuit（熔断器），
    // 重启后仍延续——滞回连续性被重启打断会引发预热集抖动，违背设计初衷。
    state: { usage: {}, funnel: { search: 0, load: 0, use: 0 }, hysteresis: {}, circuit: {} },
    version,
    // 轻量日志：宿主 stdout 带 [skill-router] 前缀，便于排查（骨架用 console，
    // 若宿主后续提供日志服务可替换）。
    warn: (...args) => console.warn('[skill-router]', ...args),
  }
  // 启动时恢复持久化状态；文件缺失/损坏不阻塞插件加载（静默回默认值）。
  try {
    const saved = JSON.parse(readFileSync(rt.statePath, 'utf8'))
    rt.state = {
      usage: saved.usage ?? {},
      funnel: { search: 0, load: 0, use: 0, ...(saved.funnel ?? {}) },
      hysteresis: saved.hysteresis ?? {},
      circuit: saved.circuit ?? {},
    }
  } catch { /* 首次启动或文件损坏：从空状态开始。 */ }
  // 持久化：尽量写、失败只告警——计数丢失不影响路由正确性，只影响热度精度。
  rt.saveState = () => {
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(rt.statePath, JSON.stringify(rt.state))
    } catch (error) {
      rt.warn('save state failed:', error?.message ?? error)
    }
  }
  // 各模块 install(rt)：索引器 → 使用统计 → 工具 → 预热挂载（挂载依赖前
  // 三者的运行时函数：getIndex / rank / freshHeat / readSkillContent）。
  indexer.install(rt)
  scorer.install(rt)
  usage.install(rt)
  tools.install(rt)
  mount.install(rt)
  return rt
}
