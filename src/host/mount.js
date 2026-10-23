// v0.2.0（迁移第 2 步）：预热集挂载引擎（SPEC §3.1 / §4.5 / §5 / §7.2 / 护栏 5）。
//
// 职责：智能调度模式打开时，把每个 Bot 的「预热集」（≤5 项技能）以运行时技能
// 形态挂进该 Bot 的全部会话（L0 目录层——名+描述进会话技能目录，全文按需读），
// 其余技能留在检索索引里由 capability_search 兜底。基础模式（开关关）或 ds-bot
// 缺席时不挂载任何东西（经典会话的宿主原生目录已免费具备 L0，见 SPEC §1.2）。
//
// 与 ds-bot 的交接（防双挂载窗口，SPEC §7.2「先摘后挂」）：
//   关 → 开：ds-bot 摘除全部系统挂载后把 dsbot-signal.json 的 handshake.phase
//           写成 'unmounted'，router 只在该相位出现后才挂预热集；
//   开 → 关：router 读到 systemExpose=false 立即摘除全部预热挂载，并在
//           router-signal.json 写 releasedAt，ds-bot 等到该确认才重新全量挂载。
// 任一时刻任一会话里，同名技能只会被一条链路挂载：
//   router 预热集排除 Bot 团队自有能力名（ds-bot 两种模式下都挂团队自有）。
//
// 与 ds-bot 的通道：信号文件（单写者原则，各自只写自己的文件）——
//   ~/.dsh/skill-router/dsbot-signal.json   ds-bot 写，router 读
//   ~/.dsh/skill-router/router-signal.json  router 写，ds-bot 读
// 生态插件无 provide/inject 先例，文件通道是已验证原语（fs 读写）且可单测；
// fs.watch 提供即时性，30s 收敛轮询兜底（任何瞬时竞态下一轮 tick 自愈）。
import { readFileSync, writeFileSync, mkdirSync, watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { relevance, frequencyNorm, bigrams as bigramsOf } from './scorer.js'

// 常量：预热上限（SPEC §3.1 硬上限 20，预热部分 ≤5）、时间窗、熔断参数。
const PREHEAT_MAX = 5
const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000       // 近 7 天高频（候选来源窗）
const STALE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000      // 连续 14 天零调用移出（SPEC §5）
const CIRCUIT_FAILS = 3                                // 连续挂载失败 N 次 → 熔断（护栏 5）
const CIRCUIT_COOLDOWN_MS = 30 * 60 * 1000             // 熔断冷却 30 分钟，之后重试
const DISPLACEMENT_STREAK = 2                          // 滞回：连续 2 次超现任才换位（SPEC §6.3）
const PROFILE_WEIGHT = 0.5                             // 离线排序：画像相关度权重
const HEAT_WEIGHT = 0.2                                // 离线排序：频率权重（次要有用即可）

// 会话上的预热挂载：与 ds-bot mountOne 的技能分支同款内联插件——
// inject ['skills'] + effect 里 skills.register({ source: 'runtime' })，
// content 为全文（宿主对技能是目录式呈现，全文不进 prompt，按需读）。
function buildSkillPlugin(name, description, content) {
  return {
    name: `skill-router-preheat-${name}`,
    inject: ['skills'],
    apply(c) {
      c.effect(() => c.skills.register({ name, description, source: 'runtime', content }))
    },
  }
}

export function install(rt) {
  const { ctx } = rt
  // 信号文件路径：router 的 home 即 ~/.dsh/skill-router（index.js 已算好），
  // 两个文件都在这里——ds-bot 用同一 DSH_HOME 约定推导出同一路径。
  const botSignalPath = join(rt.home, 'dsbot-signal.json')
  const routerSignalPath = join(rt.home, 'router-signal.json')

  // ── 会话跟踪：WeakRef 表 + agent/created 即时注册 + 每轮 tick 从信号文件
  // 补齐（覆盖 router 后装、宿主重启后会话已存在的场景）。
  rt.mountAgents = new Map()
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent?.ctx) return
    if (rt.mountAgents.get(sessionId)?.deref?.() === agent) return
    rt.mountAgents.set(sessionId, new WeakRef(agent))
    // 会话销毁时清挂载记录（与 ds-bot trackAgent 的 effect 清理同款思路）。
    try {
      agent.ctx.effect(() => () => {
        if (rt.mountAgents.get(sessionId)?.deref?.() === agent) rt.mountAgents.delete(sessionId)
      }, 'skill-router: mount tracking')
    } catch { /* 宿主不支持 effect 的极旧版本：退化为弱引用自然回收。 */ }
  }
  try {
    ctx.on?.('agent/created', agent => trackAgent(agent))
  } catch { /* 事件缺席：tick 轮询兜底。 */ }

  // ── 预热挂载表：`${sessionId}|${name}` → { key, fiber }；key 为内容哈希，
  // 与 ds-bot mountOne 的 config hash 短路同款——稳态重挂零重建。
  const mounts = new Map()
  const disposeMount = async mount => {
    if (!mount) return
    try { await Promise.resolve().then(() => mount.fiber?.dispose?.()) } catch { /* 摘除失败不阻塞收敛 */ }
  }

  // ── 熔断器（护栏 5）：`${botKey}|${name}` → { fails, blockedUntil }，持久化。
  rt.state.circuit ??= {}
  const circuitOf = (botKey, name) => rt.state.circuit[`${botKey}|${name}`] ?? { fails: 0, blockedUntil: 0 }
  const circuitBlocked = (botKey, name) => circuitOf(botKey, name).blockedUntil > Date.now()
  const circuitFail = (botKey, name) => {
    // 注意：circuitOf 对不存在的键返回临时对象（只读场景），这里必须显式
    // 把 entry 落回 state——否则计数加在临时对象上，fails 永远从 0 开始，
    // 永远达不到熔断阈值（此前的 bug）。
    const key = `${botKey}|${name}`
    const entry = rt.state.circuit[key] ?? (rt.state.circuit[key] = { fails: 0, blockedUntil: 0 })
    entry.fails += 1
    if (entry.fails >= CIRCUIT_FAILS) {
      entry.blockedUntil = Date.now() + CIRCUIT_COOLDOWN_MS
      entry.fails = 0
      rt.warn(`skill-router: preheat mount of ${name} failed ${CIRCUIT_FAILS} times; parked for ${Math.round(CIRCUIT_COOLDOWN_MS / 60000)}min`)
    }
    rt.saveState()
  }
  const circuitOk = (botKey, name) => {
    rt.state.circuit[`${botKey}|${name}`] = { fails: 0, blockedUntil: 0 }
    rt.saveState()
  }

  // ── 滞回状态（SPEC §6.3）：`${botKey}` → { [name]: 连续胜过现任的次数 }，持久化。
  rt.state.hysteresis ??= {}

  // 读 ds-bot 信号（损坏/缺失安全降级为 undefined）。
  const readBotSignal = () => {
    try {
      const parsed = JSON.parse(readFileSync(botSignalPath, 'utf8'))
      return parsed?.plugin === 'ds-bot' ? parsed : undefined
    } catch { return undefined }
  }

  // 写 router 信号（心跳 + 预热视图 + 释放确认）。尽力写，失败只告警——
  // ds-bot 读不到时会回落基础模式（fail-safe），不会卡死任何一侧。
  const routerSignal = { releasedAt: 0 }
  const writeRouterSignal = extra => {
    try {
      mkdirSync(rt.home, { recursive: true })
      writeFileSync(routerSignalPath, JSON.stringify({
        plugin: 'dsh-skill-router',
        version: rt.version ?? '0.2.0',
        at: Date.now(),
        indexCount: rt.index?.items?.length ?? 0,
        preheat: rt.preheatView ?? {},
        funnel: rt.state.funnel ?? {},
        releasedAt: routerSignal.releasedAt,
        ...extra,
      }))
    } catch (error) {
      rt.warn('write router signal failed:', error?.message ?? error)
    }
  }

  // ── 预热集计算（统一评分器离线口，SPEC §4.5）：画像文本做 query 的规则
  // 匹配 ∪ 近 7 天高频，滞回换位 + 14 天零调用移出 + 团队自有排除 + 熔断排除。
  // botEntry 形状：{ id, name, instructions, brief, capabilities, rooms }（dsbot-signal）。
  const computePreheat = async botEntry => {
    const botKey = botEntry?.id ?? 'anon'
    // 排除集：Bot 团队自有能力（ds-bot 两种模式下都会挂它们，同名双注册机制上
    // 不可能发生的前提）+ 熔断中的名字（护栏 5：降级到纯检索路径）。
    const excluded = new Set([...(botEntry?.capabilities ?? [])])
    // 候选技能：只挂 skill（MCP 挂载走宿主会话配置，第 2 步不进预热面）。
    const { items } = await rt.getIndex()
    const skills = items.filter(item => item.kind === 'skill' && !excluded.has(item.name) && !circuitBlocked(botKey, item.name))
    // 画像文本：instructions + brief + 群名/群公告——空画像（无 instructions）
    // 时 relevance 全 0，自然只剩频率来源。
    const profileText = [
      botEntry?.instructions ?? '',
      botEntry?.brief ?? '',
      ...(botEntry?.rooms ?? []).flatMap(room => [room?.name ?? '', room?.notice ?? '']),
    ].join('\n')
    const profileGrams = bigramsOf(profileText)
    const heat = rt.freshHeat(FRESH_WINDOW_MS)
    let maxHeat = 0
    for (const value of heat.values()) maxHeat = Math.max(maxHeat, value)
    // 离线分数 = 画像相关度 × 权重 + 频率归一 × 权重（排序口径，确定性可测）。
    const scoreOf = item => {
      const count = heat.get(item.name) ?? 0
      return PROFILE_WEIGHT * relevance(item, profileGrams) + HEAT_WEIGHT * frequencyNorm(count, maxHeat)
    }
    // 候选装配：
    //   1) 规则匹配——画像相关度 > 0 的技能（ITR 式预匹配）；
    //   2) 近 7 天高频——lastAt 落窗内才有资格（陈旧热度不抬人）。
    // 14 天零调用移出（SPEC §5）实现为：现任成员若「14 天无使用 且 画像相关
    // 度为 0」直接移出（纯历史热度不该永久占位；画像仍匹配的保留给滞回裁决）。
    const ranked = skills
      .map(item => ({ item, score: scoreOf(item) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
    const now = Date.now()
    const lastUsed = name => {
      let latest = 0
      for (const bySession of Object.values(rt.state.usage ?? {})) {
        latest = Math.max(latest, bySession[name]?.lastAt ?? 0)
      }
      return latest
    }
    // 现任集合：来自上一轮结果（rt.preheatView[botKey]）。members 统一为
    // { item, score } 包装形状——裸索引项没有 score 字段，混装会让滞回的
    // weakest 比较失效（此前的 bug：skills.find 返回裸项被直接推入）。
    const current = rt.preheatView?.[botKey] ?? []
    const members = []
    for (const name of current) {
      const hit = skills.find(entry => entry.name === name)
      if (hit === undefined) continue // 被排除/被熔断/已从索引消失：立即移出。
      const stale = (now - (lastUsed(name) || 0)) > STALE_WINDOW_MS
      if (stale && relevance(hit, profileGrams) === 0) continue // 14 天零调用且画像不再匹配：移出。
      members.push({ item: hit, score: scoreOf(hit) })
    }
    // 滞回换位：有 filler（成员 < 上限）直接补——不需要 displacing 判定；
    // 满员时挑战者需连续 DISPLACEMENT_STREAK 轮分数高于最弱现任才换入
    // （防一次画像微调导致预热集抖动 → 全队挂载重建，SPEC §6.3）。
    const streaks = rt.state.hysteresis[botKey] ?? (rt.state.hysteresis[botKey] = {})
    const weakest = () => members.reduce((min, entry) => (min === null || entry.score < min.score) ? entry : min, null)
    for (const candidate of ranked) {
      if (members.length >= PREHEAT_MAX) break
      if (members.some(entry => entry.item.name === candidate.item.name)) continue
      members.push(candidate)
      delete streaks[candidate.item.name]
    }
    for (const candidate of ranked) {
      if (members.length < PREHEAT_MAX) break
      if (members.some(entry => entry.item.name === candidate.item.name)) continue
      const worst = weakest()
      if (worst !== null && candidate.score > worst.score) {
        // 连续超现任计数达阈值才真正换位；未达标只记 streak。
        const streak = (streaks[candidate.item.name] ?? 0) + 1
        if (streak >= DISPLACEMENT_STREAK) {
          streaks[candidate.item.name] = 0
          members.splice(members.indexOf(worst), 1)
          members.push(candidate)
        } else {
          streaks[candidate.item.name] = streak
        }
      } else {
        delete streaks[candidate.item.name]
      }
    }
    // 清理已不在候选里的 streak 计数，防字典缓慢膨胀。
    const rankedNames = new Set(ranked.map(entry => entry.item.name))
    for (const name of Object.keys(streaks)) if (!rankedNames.has(name)) delete streaks[name]
    rt.saveState()
    return members.map(entry => entry.item.name)
  }

  // ── 单会话挂载：内容哈希短路（与 ds-bot mountOne 同款）→ 注册内联技能插件。
  const mountOne = async (agent, botKey, name, description) => {
    const key = `${agent.session.id}|${name}`
    // 全文读取也纳入失败处理：registry 故障（读全文抛错）与注册失败一样
    // 走熔断计数——否则一次 registry 异常会击穿整个 tick 的会话循环。
    let content
    try {
      content = await rt.readSkillContent(name)
    } catch (error) {
      rt.warn(`skill-router: preheat read ${name} failed:`, error?.message ?? error)
      circuitFail(botKey, name)
      return
    }
    if (typeof content !== 'string' || content.trim() === '') {
      // 读不到全文：按挂载失败计（熔断路径），下轮再试或冷却后重试。
      circuitFail(botKey, name)
      return
    }
    const nextKey = `${name}:${createHash('sha256').update(content).digest('hex')}`
    const existing = mounts.get(key)
    if (existing?.key === nextKey) return // 内容未变：零重建。
    await disposeMount(existing)
    mounts.delete(key)
    try {
      const fiber = agent.ctx.plugin(buildSkillPlugin(name, description || 'Preheated by skill-router', content))
      await fiber?.await?.()
      mounts.set(key, { key: nextKey, fiber })
      circuitOk(botKey, name)
    } catch (error) {
      rt.warn(`skill-router: preheat mount ${name} on ${agent.session.id} failed:`, error?.message ?? error)
      circuitFail(botKey, name)
    }
  }

  // ── 释放：摘除全部预热挂载并返回是否发生了摘除（供 releasedAt 判定）。
  const releaseAll = async () => {
    if (mounts.size === 0) return false
    const entries = [...mounts.values()]
    mounts.clear()
    await Promise.all(entries.map(disposeMount))
    return true
  }

  // resolveAgent 超时闸（v0.2.0 实测修复）：宿主对冷会话的解析可能做完整
  // 会话启动（连 MCP、重放上下文），耗时以十秒计甚至无限 pending——旧实现
  // 逐会话 await 它，一轮 tick 被 26 个会话的解析拖死，router-signal 心跳
  // 随之停摆。这里给单次解析加 8s 上限：超时按「本会话本轮不可用」跳过
  // （下轮再试），绝不让单个会话拖垮整轮收敛。
  const RESOLVE_TIMEOUT_MS = 8_000
  const withTimeout = (promise, ms, label) => {
    let timer = null
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
  }

  // ── 单轮收敛 tick：读信号 → 判定智能模式 → 按 Bot 计算预热集 → 差异挂/摘
  // → 写 router 信号。任何一步失败都不抛出（下一轮重试），保证 tick 永不中断。
  //
  // 看门狗（v0.2.0 实测修复）：ticking 从纯布尔升级为「布尔 + 开始时间戳」——
  // 实测发现宿主 sessionController.resolveAgent 对冷会话可能 pending 极长
  // （要做会话完整启动），旧实现一旦卡死 ticking 永久为 true，后续所有 tick
  // 被短路、router-signal 心跳随之停摆，ds-bot 侧误判 router 离线引发假回落。
  // 现在超过 TICK_STALE_MS 未见收尾的旧轮视为已死，放行新一轮（旧轮的僵尸
  // promise 挂着无害，其结果无人消费）。
  const TICK_STALE_MS = 120_000
  let ticking = false
  let tickStartedAt = 0
  const tick = async () => {
    // 总开关停摆（v0.4.0）：开关关闭时整轮 tick 直接跳过——不挂载、不收敛。
    // 心跳的停摆在 interval 回调里（见下），这里覆盖 boot/watch/手动驱动
    // 等其余入口。rt.isEnabled && 防御：fakeRuntime 未装配 switch 模块的
    // 单测环境保持原行为。
    if (rt.isEnabled && !rt.isEnabled()) return
    const now = Date.now()
    if (ticking) {
      if (now - tickStartedAt < TICK_STALE_MS) return
      rt.warn(`skill-router: previous mount tick has been running for ${Math.round((now - tickStartedAt) / 1000)}s; starting a new round anyway (the old one looks stuck on a host call)`)
    }
    tickStartedAt = now
    ticking = true
    try {
      const signal = readBotSignal()
      // 智能模式判定：开关开 且 ds-bot 已完成系统挂载摘除（先摘后挂的「挂」闸门）。
      // 信号缺失/损坏/ds-bot 卸载一律视为非智能——释放自家挂载，绝不残留。
      const smart = signal?.systemExpose === true && signal?.handshake?.phase === 'unmounted'
      if (!smart) {
        await releaseAll()
        // 释放确认（releasedAt）无条件刷新：ds-bot 的关闭流程等的是
        // 「router 已放手」的信号（releasedAt > 其关闭时刻），而不是
        // 「摘除动作发生过」——router 从未成功挂载（mounts 空）时旧逻辑
        // 不写 ack，ds-bot 每次关闭都要白等 5s 超时。router 处于非智能
        // 状态的每一轮 tick 都视为一次放手。
        // Unconditional release ack: ds-bot's off-flow waits for
        // "router has let go" (releasedAt > its off timestamp), not for
        // "a teardown actually happened" — an idle router (empty mounts)
        // must ack too, or ds-bot burns the full 5s timeout on every off.
        routerSignal.releasedAt = Date.now()
        rt.preheatView = {}
        rt.preheatNames = new Set()
        writeRouterSignal()
        return
      }
      // 会话补齐：信号里列出的会话若未跟踪，经 sessionController 解析（后装/
      // 重启场景）；解析失败跳过该会话，下轮再试。
      // 注意：本轮回结果先写进局部 preheatView，末尾再整体赋回 rt——
      // computePreheat 读 rt.preheatView[botKey] 作为「上一轮现任成员」，
      // 若提前清空会丢失滞回与 14 天规则的记忆。
      const controller = ctx.get?.('sessionController')
      const bots = Array.isArray(signal.bots) ? signal.bots : []
      const desiredBySession = new Map()
      const preheatView = {}
      for (const botEntry of bots) {
        if (!botEntry || typeof botEntry.id !== 'string') continue
        let preheat
        try {
          preheat = await computePreheat(botEntry)
        } catch (error) {
          rt.warn(`skill-router: preheat for ${botEntry.id} failed:`, error?.message ?? error)
          continue
        }
        preheatView[botEntry.id] = preheat
        for (const sessionId of botEntry.sessions ?? []) {
          if (typeof sessionId !== 'string') continue
          desiredBySession.set(sessionId, { botKey: botEntry.id, preheat })
        }
      }
      // 预热名字并集：tools.js 的行式摘要用它标「已预热」。
      rt.preheatView = preheatView
      rt.preheatNames = new Set(Object.values(preheatView).flat())
      for (const [sessionId, { botKey, preheat }] of desiredBySession) {
        const ref = rt.mountAgents.get(sessionId)
        let agent = ref?.deref?.()
        if (agent === undefined && typeof controller?.resolveAgent === 'function') {
          try {
            // 超时闸内解析：慢/挂起的解析按本轮不可用跳过（warn 留证据），
            // 已成功解析的会话经 trackAgent 缓存（弱引用），后续轮次直接复用、
            // 不再重复解析。
            agent = await withTimeout(controller.resolveAgent(sessionId), RESOLVE_TIMEOUT_MS, `resolveAgent(${sessionId})`)
            trackAgent(agent)
          } catch (error) {
            rt.warn(`skill-router: session ${sessionId} not resolved this round:`, error?.message ?? error)
            continue /* 会话不可解析（已关停/解析超时等）：跳过，下轮再试。 */
          }
        }
        if (agent === undefined) continue
        // 差异挂/摘：desired 之外的预热挂载摘除（如滞回换位后的旧成员）。
        for (const [key, mount] of mounts) {
          if (key.startsWith(`${sessionId}|`) && !preheat.includes(key.split('|')[1])) {
            await disposeMount(mount)
            mounts.delete(key)
          }
        }
        const index = rt.index?.items ?? []
        for (const name of preheat) {
          const meta = index.find(entry => entry.name === name)
          await mountOne(agent, botKey, name, meta?.description)
        }
      }
      // 清理已消亡会话（弱引用被回收）的挂载记录。
      for (const [key, mount] of mounts) {
        const sessionId = key.split('|')[0]
        if (rt.mountAgents.get(sessionId)?.deref?.() === undefined) {
          await disposeMount(mount)
          mounts.delete(key)
        }
      }
      writeRouterSignal()
    } catch (error) {
      rt.warn('skill-router: mount tick failed:', error?.message ?? error)
    } finally {
      ticking = false
    }
  }

  // 挂 rt 上供测试驱动（单测直接调 tick，不依赖定时器）。
  rt.tickMount = tick
  rt.releaseMounts = releaseAll
  // 总开关语义别名（v0.4.0）：switch.setEnabled(false) 经 rt.unmountAll 摘除
  // 全部预热挂载（与卸载清理同一条 releaseAll 链路，不留残挂）。switch 在
  // mount 之前装配时该键尚不存在，setEnabled 内以 rt.unmountAll?.() 防御。
  rt.unmountAll = releaseAll
  // 预热视图/并集：tools.js 的 lineOf 与 router-signal 的数据源。
  rt.preheatView = {}
  rt.preheatNames = new Set()
  // capability_search 结果的「已预热」标记：名字落在当前任一 Bot 的预热集里。
  rt.preheatOf = name => rt.preheatNames.has(name)

  // fs.watch 加速：ds-bot 信号一变立即 tick（300ms 防抖合并连续写入）；
  // watch 失败（目录尚不存在等）不致命——30s 轮询兜底收敛。
  // 测试开关（config.preheatTimers === false）：不装定时器/监视器，测试直接
  // 驱动 rt.tickMount，行为完全确定。
  let watchTimer = null
  let watcher = null
  const bootTimer = { unref: () => {} }
  const timer = { unref: () => {} }
  const autoTimers = rt.config?.preheatTimers !== false
  // 一次性启动日志：确认本模块（含定时器分支）确实被宿主加载执行——
  // 信号文件停摆类问题先看这行有没有出现，再谈行为对错。
  // One-shot boot log: proves this module (and its timer branch) actually
  // loaded in the host; check this line first when signal files go stale.
  if (autoTimers) rt.warn(`mount engine up (home=${rt.home}, tickMs=${rt.config?.preheatTickMs ?? 30_000})`)
  if (autoTimers) {
    try {
      watcher = watch(rt.home, (_event, filename) => {
        if (filename !== 'dsbot-signal.json') return
        clearTimeout(watchTimer)
        watchTimer = setTimeout(() => void tick(), 300)
      })
    } catch (error) {
      rt.warn('skill-router: fs.watch unavailable, falling back to polling:', error?.message ?? error)
    }
    // 收敛轮询 + 心跳：30s 一轮（可配置），任何瞬时竞态下一轮自愈。
    // 心跳与业务 tick 合并在同一 interval 但**先于 tick 执行**：router-signal
    // 的 at 是 ds-bot 判定 router 在线的唯一依据（90s 新鲜窗），不能被业务
    // tick 的卡死/慢解析连坐——即使 tick 一轮拖到分钟级，心跳仍按 30s 节奏
    // 刷新，ds-bot 不会假回落。tick 内部成功后还会再写一次（携带本轮预热
    // 视图），覆盖这份「纯心跳」。
    const tickMs = rt.config?.preheatTickMs ?? 30_000
    const interval = setInterval(() => {
      // 总开关停摆（v0.4.0）：关闭时心跳与调度 tick 一起停——router-signal
      // 的 at 是 ds-bot 判定 router 在线的唯一依据，停写 90s 新鲜窗过期后
      // ds-bot 自动回退原生全量挂载。绝不允许「在线但不调度」导致技能
      // 全量丢失；定时器保留（回调短路），重新打开开关即自行恢复，无需重启。
      if (rt.isEnabled && !rt.isEnabled()) return
      writeRouterSignal()
      void tick()
    }, tickMs)
    interval.unref?.()
    // 安装即先跑一轮（延迟 1s 让宿主服务就绪；失败由轮询兜底）。
    const boot = setTimeout(() => void tick(), 1_000)
    boot.unref?.()
    // 让清理闭包引用真实的句柄（上方占位对象仅在测试关闭定时器时使用）。
    timer._clear = () => clearInterval(interval)
    bootTimer._clear = () => clearTimeout(boot)
  }
  const stopTimers = () => {
    timer._clear?.()
    bootTimer._clear?.()
    clearTimeout(watchTimer)
    try { watcher?.close?.() } catch { /* 已关闭 */ }
  }

  // 卸载清理：停定时器/监视器，摘除全部预热挂载（插件卸载不留残挂）。
  ctx.effect(() => () => {
    stopTimers()
    void releaseAll()
  }, 'skill-router: mount')
}
