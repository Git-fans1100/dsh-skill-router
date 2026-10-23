// 只读统计出口（SPEC §3.3 v1.2 / §4.4）：把漏斗、预热有效性、Top 使用与
// 熔断状态露成零参数元工具 capability_stats 的文本输出。
// 设计约束：纯读不写——不触碰 state、不进漏斗；所有数字来自既有持久化
// （rt.state）与内存视图（rt.preheatView），本模块零新增采集。
export function install(rt) {
  // 百分比：分母 ≤0 时给 'n/a'（除零与 NaN 双防护，NaN 不得出现在输出里）。
  const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : 'n/a')

  rt.statsText = () => {
    const funnel = rt.state.funnel ?? {}
    const search = funnel.search ?? 0
    const load = funnel.load ?? 0
    const use = funnel.use ?? 0
    const loadPreheated = funnel.loadPreheated ?? 0

    // 漏斗行：search → load（转化率）→ use。use 的计数源（load 后实际调用）
    // 属后续步骤才接线，如实显示 0 并注明，避免被误读成「没人用」。
    const lines = [
      'Capability router stats (read-only):',
      `- Funnel: ${search} searches → ${load} loads (${pct(load, search)} of searches led to a load) → ${use} uses (use counting is wired in a later step)`,
    ]

    // 预热有效性：loadPreheated/load = 「模型未经检索、直接从预热目录拿走」
    // 的占比——预热层价值的自证数字（SPEC §4.4）。无 load 时无从谈起，给 n/a。
    lines.push(load > 0
      ? `- Preheat effectiveness: ${loadPreheated}/${load} loads (${pct(loadPreheated, load)}) came straight from the preheated directory without a search`
      : '- Preheat effectiveness: n/a (no loads yet)')

    // 预热集现状：读 mount 引擎的内存视图（per Bot 名单）；空 = 基础模式
    // 或 ds-bot 信号未到——如实说，不冒充「预热了 0 个」。
    const view = rt.preheatView ?? {}
    const entries = Object.entries(view).filter(([, names]) => Array.isArray(names) && names.length > 0)
    lines.push(entries.length > 0
      ? `- Preheat set: ${entries.map(([bot, names]) => `${bot}: ${names.join(', ')}`).join('; ')}`
      : '- Preheat set: none right now (base mode, or no ds-bot signal yet)')

    // 索引规模：与 capability_search 输出同口径（items 总数）。
    const indexed = rt.index?.items?.length ?? 0
    lines.push(`- Index: ${indexed} capabilities indexed`)

    // Top 使用：近 7 天窗口（freshHeat 与预热集候选同源，口径一致），降序前 5。
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000
    const heat = rt.freshHeat
      ? [...rt.freshHeat(WEEK_MS)].sort((a, b) => b[1] - a[1]).slice(0, 5)
      : []
    lines.push(heat.length > 0
      ? `- Top used (last 7 days): ${heat.map(([name, count]) => `${name} ×${count}`).join(', ')}`
      : '- Top used (last 7 days): none')

    // 熔断状态：只列仍在冷却期（blockedUntil > now）的条目——过期条目已是
    // 历史噪声，列出来只会误导（挂载引擎冷却后会自动重试并清零）。
    const now = Date.now()
    const parked = Object.entries(rt.state.circuit ?? {})
      .filter(([, entry]) => (entry?.blockedUntil ?? 0) > now)
      .map(([key]) => key)
    lines.push(parked.length > 0 ? `- Circuit breaker: ${parked.join(', ')}` : '- Circuit breaker: clear')

    return lines.join('\n')
  }
}
