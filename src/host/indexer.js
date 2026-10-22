// 只读索引器：从宿主两份能力资产构建统一索引（SPEC §1.1 / §3 / 护栏 2、4）。
//   1. SKILL —— ctx.get('skills') 注册表，走「会话视角」读法（借默认预设的
//      scope 租约，否则只能看到全局层、会漏用户级目录），与 ds-bot 的
//      withSkillScope 同款；
//   2. MCP —— 宿主 loader 树上的 @deepseek-ai/dsh-mcp-client 条目（连接器
//      面板/预设/插件挂的都在树里），与 ds-bot 的 systemMcpServers 同款。
// 失效策略（护栏 2）：对 registry.list 的元数据做 sha256 签名，签名不变
// 直接返回缓存索引——send/reconcile 高频路径上零全量 IO；签名变才重建。
// 并发闸（护栏 4）：全文读取统一限 8 并发（骨架只在 load 时读全文）。
import { createHash } from 'node:crypto'

// 宿主 loader 树上 MCP client 条目的插件名（与 ds-bot capabilities.js 一致）。
const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'

// 极简并发闸：返回一个「最多 n 个并发执行」的任务执行器。
function pLimit(n) {
  let active = 0
  const queue = []
  const next = () => {
    active -= 1
    if (queue.length > 0) queue.shift()()
  }
  return async run => {
    if (active >= n) await new Promise(resolve => queue.push(resolve))
    active += 1
    try {
      return await run()
    } finally {
      next()
    }
  }
}

// 「会话视角」读 SKILL 注册表：借默认预设的 scope 租约（同 ds-bot）。
// 宿主缺 skills/agentPresets 服务时降级为无 scope 的全局读法。
async function withSkillScope(ctx, run) {
  const registry = ctx.get?.('skills')
  if (typeof registry?.list !== 'function') return { registry: undefined, result: undefined }
  let lease
  let scope
  try {
    const presets = ctx.get?.('agentPresets')
    if (presets?.defaultId !== undefined && typeof presets?.acquireScope === 'function') {
      lease = await presets.acquireScope(presets.defaultId)
      scope = lease?.key
    }
  } catch { /* 预设损坏：退回全局层读法。 */ }
  try {
    return { registry, result: await run(registry, scope === undefined ? {} : { scope }) }
  } finally {
    const dispose = lease === undefined ? undefined : lease[Symbol.asyncDispose] ?? lease[Symbol.dispose]
    if (typeof dispose === 'function') { try { await dispose.call(lease) } catch { /* 释放失败不影响读取 */ } }
  }
}

export function install(rt) {
  const { ctx } = rt
  // 进程内缓存：索引项数组 + 其元数据签名 + 全文缓存（load 用，键 = 技能名，
  // 值 = { signature, content }——签名一致才复用，registry 更新后自动失效）。
  rt.index = { items: [], signature: null }
  const contentCache = new Map()
  const limit = pLimit(8)

  // 读宿主 loader 树上的全部 MCP client 条目（同步、纯内存遍历），
  // 按 serverName 去重取第一条；逻辑与 ds-bot systemMcpServers() 一致。
  rt.systemMcpServers = () => {
    const loader = ctx.get?.('loader')
    const entries = typeof loader?.entries === 'function' ? [...loader.entries()] : []
    const servers = new Map()
    for (const entry of entries) {
      const options = entry?.options ?? {}
      const config = options.config ?? {}
      if (options.name !== MCP_CLIENT_NAME || typeof config.serverName !== 'string') continue
      if (entry.disabled === true) continue
      if (servers.has(config.serverName)) continue
      servers.set(config.serverName, config)
    }
    return servers
  }

  // 重建索引：SKILL 走 registry.list（会话视角）+ MCP 走 loader 树，合并成
  // 统一索引项数组。单服务缺席时该部分留空（互不影响，与 ds-bot 行为一致）。
  // 索引项形状：{ kind, name, description, whenToUse, detail }
  //   - kind: 'skill' | 'mcp'
  //   - description: 技能描述 / MCP 侧为「MCP server: 命令或 URL 摘要」
  //   - whenToUse: 技能的触发条件（注册表可能提供）；MCP 侧为空串
  //   - detail: MCP 的命令/URL 摘要（search 结果行可展示）
  rt.buildIndex = async () => {
    const items = []
    // SKILL 部分：registry.list 返回的行通常含 name/description（可能含
    // whenToUse）。只读元数据——全文延迟到 capability_load 才取（护栏 2）。
    try {
      const { registry, result } = await withSkillScope(ctx, (reg, options) => reg.list(options))
      if (registry && Array.isArray(result)) {
        for (const row of result) {
          const name = String(row?.name ?? '').trim()
          if (name === '') continue
          items.push({
            kind: 'skill',
            name,
            description: String(row?.description ?? '').trim(),
            whenToUse: String(row?.whenToUse ?? row?.when_to_use ?? '').trim(),
            detail: '',
          })
        }
      }
    } catch (error) {
      rt.warn('skill registry unavailable:', error?.message ?? error)
    }
    // MCP 部分：纯同步内存读取。
    for (const [serverName, config] of rt.systemMcpServers()) {
      const isHttp = config.transport === 'streamable-http' || config.transport === 'http'
      items.push({
        kind: 'mcp',
        name: serverName,
        description: `MCP server${isHttp ? ' (http)' : ' (stdio)'}`,
        whenToUse: '',
        detail: isHttp ? String(config.url ?? '') : [config.command, ...(config.args ?? [])].filter(Boolean).join(' ').slice(0, 160),
      })
    }
    // 元数据签名：对「名字+描述+触发条件+详情」序列化后取 sha256。
    // registry 更新（含宿主自修正改写技能内容后 list 元数据变化）→ 签名变
    // → 下次 rebuild 感知。全文级别的变化若不体现在 list 元数据里，则由
    // contentCache 的 signature 二次校验兜底（见 readSkillContent）。
    const signature = createHash('sha256').update(JSON.stringify(items)).digest('hex')
    rt.index = { items, signature }
    return rt.index
  }

  // 取索引（带签名短路）：签名一致直接返回缓存——高频路径零 registry 调用。
  rt.getIndex = async () => {
    try {
      const { registry, result } = await withSkillScope(ctx, (reg, options) => reg.list(options))
      if (registry && Array.isArray(result)) {
        // 只取签名字段做轻量签名（避免全量重算索引项对象）。
        const light = result.map(row => `${row?.name ?? ''}|${row?.description ?? ''}|${row?.whenToUse ?? row?.when_to_use ?? ''}`).join('\n')
        const signature = createHash('sha256').update(light).digest('hex')
        if (signature === rt.index.signature && rt.index.items.length > 0) return rt.index
      }
    } catch { /* registry 异常：落到下面全量重建（内部会再捕获）。 */ }
    return rt.buildIndex()
  }

  // 读技能全文（capability_load 用）：并发闸内 registry.get，全文缓存带
  // 「读全文时的索引签名」——签名变了说明 registry 更新过，缓存作废重读。
  rt.readSkillContent = async name => {
    const cached = contentCache.get(name)
    if (cached && cached.signature === rt.index.signature) return cached.content
    const content = await limit(async () => {
      const { registry, result } = await withSkillScope(ctx, (reg, options) => reg.get(name, options))
      return typeof result?.content === 'string' ? result.content : ''
    })
    if (content.trim() !== '') contentCache.set(name, { signature: rt.index.signature, content })
    return content
  }

  // 按标题切节（L3 分节，第 1 步即提供——纯文本处理，无成本）。
  // 匹配规则：优先精确命中标题行（支持 #/##/### 前缀），其次大小写不敏感
  // 的包含匹配。返回该标题到下一个同级/任意标题之间的文本；找不到返回空串。
  rt.readSection = (content, title) => {
    const lines = content.split('\n')
    const wanted = String(title ?? '').trim().toLowerCase()
    if (wanted === '') return ''
    let start = -1
    let startLevel = 0
    for (let i = 0; i < lines.length; i++) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i])
      if (!heading) continue
      const text = heading[2].trim().toLowerCase()
      if (start === -1 && (text === wanted || text.includes(wanted))) {
        start = i
        startLevel = heading[1].length
        continue
      }
      // 已进入目标节：遇到「同级或更高级」标题才结束——更深的子标题
      // （### 嵌在 ## 下）内容跟随本节，符合「取一节」的文档结构语义。
      if (start !== -1 && heading[1].length <= startLevel) {
        return lines.slice(start, i).join('\n').trim()
      }
    }
    return start === -1 ? '' : lines.slice(start).join('\n').trim()
  }
}
