// 使用统计：会话×技能的调用计数、软失败、漏斗（search→load→use）。
// 这是第 3 步「频率升温 / 失败惩罚 / 转化率校准」的数据源；第 1 步骨架
// 先把数据记全——只记不用（评分器第 1 步只消费频率项）。
export function install(rt) {
  // 会话维度的计数：rt.state.usage[sessionId][name] = { count, lastAt }。
  const bump = (sessionId, name) => {
    rt.state.usage ??= {}
    const bySession = rt.state.usage[sessionId] ?? (rt.state.usage[sessionId] = {})
    const entry = bySession[name] ?? (bySession[name] = { count: 0, lastAt: 0 })
    entry.count += 1
    entry.lastAt = Date.now()
    rt.saveState()
    return entry
  }

  // 漏斗计数（聚合口径，供转化率校准：search→load 的比值 = 排序失败信号）。
  const funnel = key => {
    rt.state.funnel ??= { search: 0, load: 0, use: 0 }
    rt.state.funnel[key] = (rt.state.funnel[key] ?? 0) + 1
    rt.saveState()
  }

  // 记一次 load（= 「use」信号的第 1 步近似：load 即视为启用意图；
  // 第 3 步可细分「load 后实际调用」再拆分）。
  rt.recordLoad = (sessionId, name) => {
    funnel('load')
    bump(sessionId, name)
  }

  // 记一次 search（不计技能维度——search 是查询行为，技能维度命中由 load 记）。
  rt.recordSearch = () => funnel('search')

  // 某技能的「近期热度」：跨会话聚合 count（第 1 步简单聚合，第 3 步加
  // 时间衰减——近 7 天窗口）。供评分器的频率项使用。
  rt.heatOf = name => {
    let total = 0
    for (const bySession of Object.values(rt.state.usage ?? {})) {
      total += bySession[name]?.count ?? 0
    }
    return total
  }

  // 全库最高热度（频率归一化分母；0 时评分器跳过频率项）。
  rt.maxHeat = () => {
    let max = 0
    for (const bySession of Object.values(rt.state.usage ?? {})) {
      for (const entry of Object.values(bySession)) max = Math.max(max, entry.count)
    }
    return max
  }

  // v0.2.0（第 2 步）：近 windowMs 毫秒内有调用记录的技能热度聚合。
  // 预热集的「近 7 天高频」数据源（SPEC §5）：只统计 lastAt 落在时间窗内的
  // 会话计数——陈旧热度（14 天前用过一次）不得把技能抬进预热集。
  // 返回 Map<name, count>；窗口为 0/负数时返回空 Map（测试与防御）。
  // v0.2.0 (step 2): aggregated heat per skill over the last windowMs. This is
  // the "top-frequency over the past 7 days" data source for the preheat set
  // (SPEC §5): only sessions whose lastAt falls inside the window count — stale
  // usage must not carry a skill into the preheat set. Returns Map<name, count>.
  rt.freshHeat = windowMs => {
    const fresh = new Map()
    if (!(windowMs > 0)) return fresh
    const since = Date.now() - windowMs
    for (const bySession of Object.values(rt.state.usage ?? {})) {
      for (const [name, entry] of Object.entries(bySession)) {
        if ((entry?.lastAt ?? 0) < since) continue
        fresh.set(name, (fresh.get(name) ?? 0) + (entry?.count ?? 0))
      }
    }
    return fresh
  }

  // 软失败记录（第 3 步接线：capability_load 后同轮重试 ≥2 次时由调用方标）。
  // 第 1 步先落 API 与存储位（softFails 挂内存，第 3 步再持久化——失败数据
  // 丢了可重来，不必为它增加每次 send 的写盘）。
  rt.softFails = new Map() // `${sessionId}|${name}` -> count
  rt.recordSoftFail = (sessionId, name) => {
    const key = `${sessionId}|${name}`
    rt.softFails.set(key, (rt.softFails.get(key) ?? 0) + 1)
  }
  rt.softFailOf = (sessionId, name) => rt.softFails.get(`${sessionId}|${name}`) ?? 0
}
