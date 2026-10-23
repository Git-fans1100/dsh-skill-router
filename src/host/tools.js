// 元工具层（SPEC §5）：capability_search / capability_load。
// 通过 ctx.tools.register 注册到宿主全局工具面——全部会话可见（含经典
// Agent 与 Bot 团队）。第 1 步只做「发现 + 读取」，不引导预热挂载
// （与 ds-bot 的 systemExpose 不重叠，迁移第 2 步才交接）。
//
// 形态约定（护栏 3）：
//   search → 行式摘要 Top 5，每项 40-60 token，不附 brief 全文；
//   load   → 第 1 步返回全文 + 头部提示（brief 抽取层第 3 步接入，
//            届时默认变 brief、full:true 才返全文——接口先占位防破窗）。

// 本地 defineTool：与宿主 @deepseek-ai/dsh-tools 的 defineTool 等价的最小实现。
// 骨架期不 import 宿主包，避免对导出名的硬耦合；execute 透传（参数校验交给
// LLM 端 schema 约束与宿主协议层）。
// 关键差异（v0.1.1 修复）：宿主版会把「字段集合」编译为 JSON Schema 根对象
// （parameterSchemaSpecToJsonSchema：{type:'object', properties, required}）。
// v0.1.0 直接透传字段集合，LLM API 在顶层取 type 得到 null，报
// "schema must be a JSON Schema of 'type: object', got 'type: null'"。
// 这里实现同构的最小转换，覆盖本插件用到的特性：type/required/description/enum。
const defineTool = tool => {
  const properties = {}
  const required = []
  for (const [name, field] of Object.entries(tool.parameters ?? {})) {
    const { required: isRequired, ...schema } = field ?? {}
    properties[name] = schema
    if (isRequired === true) required.push(name)
  }
  return {
    ...tool,
    parameters: required.length > 0
      ? { type: 'object', properties, required }
      : { type: 'object', properties },
  }
}

// 输出形状与 ds-bot tools.js 相同：字符串结果渲染为单段 text。
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function install(rt) {
  const { ctx } = rt

  // 同会话同查询缓存（护栏 3 变体）：search 结果文本按「会话|范围|查询」
  // 缓存，索引签名变则失效（签名进缓存值，命中时校验）；FIFO 上限 50 条
  // 防止长会话膨胀。挂 rt 上便于测试隔离（每个 createRuntime 一份）。
  rt.searchCache = new Map()
  const SEARCH_CACHE_LIMIT = 50

  // 评分信号（第 1 步）：频率（usage 计数）+ 会话级软失败；预热与群协同
  // 第 2 步接线（rt.preheatOf / rt.synergyOf 出现后 signalsFor 自动生效）。
  const signalsFor = sessionId => ({
    heatOf: name => rt.heatOf(name),
    maxHeat: () => rt.maxHeat(),
    softFailOf: name => rt.softFailOf(sessionId, name),
  })

  // 行式摘要：`- name [kind] — ≤30字描述 ★相关度[ 已预热]`。
  // 预热标记读 rt.preheatOf（第 2 步提供）；第 1 步无此函数恒不带标记。
  const lineOf = match => {
    const { item, relevance: rel } = match
    const desc = (item.description || item.detail || '').replace(/\s+/g, ' ').slice(0, 30)
    const preheated = typeof rt.preheatOf === 'function' && rt.preheatOf(item.name) === true
    return `- ${item.name} [${item.kind}] — ${desc} ★${rel.toFixed(2)}${preheated ? ' [已预热]' : ''}`
  }

  // names_only 行：只有「name [kind]」，返回体积约降 60%（SPEC §3.3）——
  // 模型已知目标名（如模型自述要用某技能）时无需描述与分数。
  const nameLineOf = match => `- ${match.item.name} [${match.item.kind}]`

  ctx.tools.register(defineTool({
    name: 'capability_search',
    description: 'Search the capability directory (skills + MCP servers) for ones relevant to a task. Call it before doing specialized work the base tools may not cover, then use capability_load on the best match to read its instructions.',
    parameters: {
      query: { type: 'string', required: true, description: 'The task or need, in natural language (Chinese or English)' },
      scope: { type: 'string', enum: ['all', 'skill', 'mcp'], description: '"all" (default) searches skills and MCP servers; "skill" or "mcp" limits the kind' },
      names_only: { type: 'boolean', description: 'true = return only "name [kind]" lines (~60% smaller). Use when you already know roughly which capability you want and just need the exact name.' },
    },
    output,
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (query === '') return 'capability_search needs a non-empty query describing the task.'
      const sessionId = exec?.agent?.id ?? 'anon'
      const kind = args.scope === 'skill' || args.scope === 'mcp' ? args.scope : 'all'
      const namesOnly = args.names_only === true
      const cacheKey = `${sessionId}|${kind}|${namesOnly ? 'n' : 'f'}|${query}`
      const { items, signature } = await rt.getIndex()
      // 缓存命中：签名一致才复用（registry 更新 → 签名变 → 自动重算）。
      const cached = rt.searchCache.get(cacheKey)
      if (cached && cached.signature === signature) return cached.text
      rt.recordSearch()
      const pool = kind === 'all' ? items : items.filter(item => item.kind === kind)
      const { matches, total, matched } = rt.rank(pool, query, signalsFor(sessionId))
      // FIFO 淘汰：超上限删最早写入的一条（Map 迭代序 = 插入序）。
      const store = text => {
        rt.searchCache.set(cacheKey, { signature, text })
        if (rt.searchCache.size > SEARCH_CACHE_LIMIT) {
          rt.searchCache.delete(rt.searchCache.keys().next().value)
        }
      }
      if (matches.length === 0) {
        const text = `No capability matches "${query}" (${total} indexed). Rephrase with different keywords.`
        store(text)
        return text
      }
      const line = namesOnly ? nameLineOf : lineOf
      const text = [
        `Top ${matches.length} of ${matched} candidates (${total} indexed):`,
        ...matches.map(line),
        'Use capability_load with the exact name to read the full instructions.',
      ].join('\n')
      store(text)
      return text
    },
  }))

  ctx.tools.register(defineTool({
    name: 'capability_load',
    description: 'Read a skill\'s instructions after capability_search picks it: by default a condensed brief (TOC + per-section first lines), optionally the full text, one section, or a referenced file. For MCP servers it explains how their tools are exposed instead.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact capability name from capability_search' },
      section: { type: 'string', description: 'Optional section title to load only that part of the skill' },
      full: { type: 'boolean', description: 'true = return the full SKILL.md instead of the condensed brief (use when the brief is not enough)' },
      ref: { type: 'string', description: 'Relative path of a file the skill references (e.g. references/foo.md, scripts/x.cmd). Only works when the host exposes the skill\'s base path.' },
    },
    output,
    async execute(args, exec) {
      const name = String(args.name ?? '').trim()
      if (name === '') return 'capability_load needs the exact capability name from capability_search.'
      const sessionId = exec?.agent?.id ?? 'anon'
      const { items } = await rt.getIndex()
      const item = items.find(entry => entry.name === name)
      if (item === undefined) {
        // 未知名不硬失败：给出包含匹配的近似名，其次列前 10 个名字引导回 search。
        const lower = name.toLowerCase()
        const close = items.filter(entry => entry.name.toLowerCase().includes(lower)).map(entry => entry.name).slice(0, 8)
        const names = items.map(entry => entry.name)
        const listing = close.length > 0
          ? `Closest names: ${close.join(', ')}.`
          : names.length > 0
            ? `Available: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` … (${names.length} total; use capability_search)` : ''}`
            : 'The capability index is empty.'
        return `No capability named "${name}". ${listing}`
      }
      // MCP 项没有「技能全文」可读：给使用指引即可（工具以 mcp__<server>__<tool>
      // 形式出现在模型工具列表，load 的意义是确认这个 server 是干什么的）。
      if (item.kind === 'mcp') {
        rt.recordLoad(sessionId, name)
        return [
          `MCP server: ${name}`,
          item.description,
          item.detail ? `Endpoint/command: ${item.detail}` : '',
          'Its tools appear in your tool list as mcp__<server>__<tool>; call them directly.',
        ].filter(Boolean).join('\n')
      }
      // 计数（升温数据源）：load 即启用意图（usage.recordLoad）。
      rt.recordLoad(sessionId, name)
      // ref 模式（优先级 ref > section > full，SPEC §3.3）：读技能声明的单个
      // 资源文件。registry 未暴露 base 路径/文件不存在 → 降级提示 + 软失败，
      // 不硬失败——模型可改走 full/section，省一轮报错重试。
      const ref = String(args.ref ?? '').trim()
      if (ref !== '') {
        const refContent = await rt.readSkillRef(name, ref)
        if (refContent === null) {
          rt.recordSoftFail(sessionId, name)
          return `Skill "${name}" does not support ref:"${ref}" (host does not expose the skill's base path, or the file does not exist). Use section or full:true instead.`
        }
        return [`[skill: ${name}] ref:${ref}`, '', refContent].join('\n')
      }
      const content = await rt.readSkillContent(name)
      if (content.trim() === '') return `Skill "${name}" is indexed but its content is empty or unreadable.`
      const section = String(args.section ?? '').trim()
      if (section !== '') {
        const part = rt.readSection(content, section)
        // 节名未命中不硬失败：返回全文并提示——模型可改用 full 语义（默认已是
        // brief）或换个节名再试，比抛错省一轮重试。
        if (part === '') {
          return [`[skill: ${name}] Section "${section}" not found; full content below instead.`, '', content].join('\n')
        }
        return [`[skill: ${name}] Section "${section}"`, '', part].join('\n')
      }
      // full:true：SKILL.md 原文（brief 不足时的兜底，头部提示引导回检索）。
      if (args.full === true) {
        const head = `[skill: ${name}] If this skill does not fit the task after reading, call capability_search again with different keywords.`
        return [head, '', content].join('\n')
      }
      // 默认路径：brief（300-800 token 机械精简：目录树 + 各节首句，SPEC §3.2
      // 路线 B）——单次 load 的 token 从 1-5K 降到 ~800 以内。
      const head = `[skill: ${name}] Condensed brief. Use full:true for the complete text, section:"title" for one section, ref:"path" for a referenced file.`
      return [head, '', rt.extractBrief(content)].join('\n')
    },
  }))

  // capability_stats（v0.3.1，SPEC §3.3 v1.2）：只读统计出口。零参数——
  // 数字全部来自持久化状态与内存视图，文本由 stats 模块生成（rt.statsText），
  // 工具本体不做计算外的事，也不进任何漏斗计数。
  ctx.tools.register(defineTool({
    name: 'capability_stats',
    description: 'Read-only usage statistics for this router: the search-to-load funnel, how many loads came straight from the preheated directory (no search needed), the current preheat set per bot, top used skills of the last 7 days, and circuit-breaker state. Call it when the user asks how skill routing or preheating is performing.',
    parameters: {},
    output,
    async execute() {
      return rt.statsText()
    },
  }))
}
