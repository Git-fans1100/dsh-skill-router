// 统一评分器（SPEC §6）：search 在线检索与预热集离线挑选共用的同一函数。
//
// 两段式漏斗：
//   粗排（纯召回门槛）——任一字段命中 ≥1 个 query bigram 才入围，按相关度
//   降序截 Top 20（护栏 1 的候选池上限：N 大时精排不全量算）；
//   精排（Top 20 → Top 5）——公式（SPEC 定稿）：
//     score = 0.50 × 相关度
//           + 0.25 × 频率        （log1p 归一；第 1 步唯一启用的行为项）
//           + 0.15 × 预热加成    （第 1 步恒 0：预热集第 2 步才有）
//           + 0.10 × 群协同      （第 1 步恒 0：ds-bot 群信号第 2 步接入）
//           − 失败惩罚           （软失败计数线性惩罚、封顶 0.2；第 1 步
//                                  数据位已就绪、无人写入，恒 0）
//
// 相关度（SPEC §6.2）：字符 bigram 免分词——中文不需要词典即可切词，
// 英文按空白分段后在段内滑窗，词边界不跨段组 bigram（防「web search」
// 误配「b s」这类噪声）。字段加权：name ×3 > whenToUse ×2 > description ×1
// （名字是作者显式起的、最可信；触发条件次之；描述最泛）。

// 中文字符判定：CJK 统一表意文字区。命中时额外把每个字作为单字 token 入集，
// 兜底「图」「画」这类单字中文查询（单字组不出 bigram，否则永远零命中）。
const CJK = /[\u4e00-\u9fff]/

// 文本 → bigram 集合。规则：小写归一 → 空白压成单词分隔 → 每段字符滑窗取
// 相邻二元组；CJK 段每个字额外入集；英文单字母不入集（无检索价值）。
export function bigrams(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const grams = new Set()
  if (normalized === '') return grams
  for (const word of normalized.split(' ')) {
    if (CJK.test(word)) for (const char of word) grams.add(char)
    if (word.length === 1) continue
    for (let i = 0; i < word.length - 1; i++) grams.add(word.slice(i, i + 2))
  }
  return grams
}

// 字段权重表与总权重（归一分母 = 6）。
const FIELDS = [['name', 3], ['whenToUse', 2], ['description', 1]]
const TOTAL_WEIGHT = FIELDS.reduce((sum, [, weight]) => sum + weight, 0)

// 字段加权相关度：每个字段算「query bigram 命中率」（命中数 / query bigram
// 总数），按权重求和后除以总权重，落 [0,1]。字段缺失/空文本按 0 命中计。
export function relevance(item, queryGrams) {
  const total = queryGrams.size
  if (total === 0) return 0
  let weighted = 0
  for (const [field, weight] of FIELDS) {
    const grams = bigrams(item?.[field])
    let hits = 0
    for (const gram of queryGrams) if (grams.has(gram)) hits += 1
    weighted += weight * (hits / total)
  }
  return weighted / TOTAL_WEIGHT
}

// 粗排：任一字段命中 ≥1 个 query bigram 即入围；返回 [{ item, relevance }]
// 按相关度降序、截 limit（默认 20）。queryGrams 为空（空查询）直接返回空。
export function coarsePass(items, queryGrams, limit = 20) {
  const total = queryGrams.size
  if (total === 0) return []
  const scored = []
  for (const item of items) {
    let any = false
    for (const [field] of FIELDS) {
      const grams = bigrams(item?.[field])
      for (const gram of queryGrams) {
        if (grams.has(gram)) { any = true; break }
      }
      if (any) break
    }
    if (any) scored.push({ item, relevance: relevance(item, queryGrams) })
  }
  scored.sort((a, b) => b.relevance - a.relevance)
  return scored.slice(0, limit)
}

// 频率项归一：log1p(heat) / log1p(maxHeat)。取对数压制头部垄断——
// count 10 与 100 的差距远小于线性（SPEC §6.3）；maxHeat 为 0（全库无
// 使用记录）或 heat ≤ 0 时按 0 处理。
export function frequencyNorm(heat, maxHeat) {
  if (!(maxHeat > 0) || !(heat > 0)) return 0
  return Math.log1p(heat) / Math.log1p(maxHeat)
}

// 失败惩罚：0.05 × 软失败次数，封顶 0.2（4 次即触顶——软失败是「load 后
// 同轮重试 ≥2 次」这类弱信号，不该永久判死刑，第 3 步接 U 型修正曲线）。
export function failPenalty(fails) {
  return Math.min(0.2, 0.05 * Math.max(0, fails ?? 0))
}

// 精排权重表（与文件头公式一一对应，改权重只动这里）。
const WEIGHTS = { relevance: 0.50, frequency: 0.25, preheat: 0.15, synergy: 0.10 }

// 精排总分。signals 缺席的信号按中性值处理（频率 0、预热 false、协同 0、
// 无失败）——第 1 步只喂 heatOf/maxHeat/softFailOf，预热与群协同占位恒 0。
export function precisionScore(entry, queryGrams, signals = {}) {
  const rel = entry.relevance ?? relevance(entry.item, queryGrams)
  const heat = signals.heatOf?.(entry.item.name) ?? 0
  const maxHeat = signals.maxHeat?.() ?? 0
  const preheat = signals.preheatOf?.(entry.item.name) ?? false
  const synergy = signals.synergyOf?.(entry.item.name) ?? 0
  const fails = signals.softFailOf?.(entry.item.name) ?? 0
  return WEIGHTS.relevance * rel
    + WEIGHTS.frequency * frequencyNorm(heat, maxHeat)
    + WEIGHTS.preheat * (preheat ? 1 : 0)
    + WEIGHTS.synergy * Math.min(1, Math.max(0, synergy))
    - failPenalty(fails)
}

// 同义扩展（SPEC §4.2 v1.1）：词法 bigram 的已知弱点是「查询词 ≠ 描述词」
// （意译/中英混用漏检）。内置高频同义组 + config.synonyms 用户词典，组内任一
// 词命中查询时，组内其余词并入查询集合参与检索。克制原则：只收「查询侧词 ↔
// 技能描述侧词」确实双向常见的对，词典污染比缺口更伤精度。
const BUILT_IN_SYNONYMS = [
  ['生存曲线', 'km', 'kaplan-meier'],
  ['热图', 'heatmap', '热力图'],
  ['图表', 'chart', 'plot'],
  ['森林图', 'forest plot'],
  ['检索', 'search', '查找'],
  ['统计', 'statistics'],
  ['导出', 'export'],
  ['下载', 'download'],
  ['转换', 'convert'],
  ['图片', 'image', 'figure'],
]

// 正则元字符转义（英文词要拼进 \b 词边界正则）。
const escapeRe = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 词命中判定：纯中文词无边界概念用 includes；含英文的词必须整词命中
// （防 'km' 误配 'bookmark' 这类子串）。
const hasWord = (normalized, word) =>
  /^[\u4e00-\u9fff]+$/.test(word)
    ? normalized.includes(word)
    : new RegExp(`\\b${escapeRe(word)}\\b`).test(normalized)

// 查询扩展：返回追加同义变体后的查询串（原词在前——命中率分母变大是已知
// 代价，换来同义命中进入分子；粗排召回与精排口径因此一致，实现最简）。
// dict 形如 [['a','b'], ['c','d']]，组内任一词命中 → 其余未出现词追加。
export function expandQuery(query, dict = []) {
  const normalized = String(query ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (normalized === '') return normalized
  const extras = []
  for (const group of dict) {
    if (!Array.isArray(group) || group.length === 0) continue
    if (group.some(word => hasWord(normalized, String(word).toLowerCase()))) {
      for (const word of group) {
        const lower = String(word).toLowerCase()
        if (!hasWord(normalized, lower) && !extras.includes(lower)) extras.push(lower)
      }
    }
  }
  return extras.length > 0 ? `${normalized} ${extras.join(' ')}` : normalized
}

// 统一入口：query 原文 → 粗排 Top 20 → 精排 Top 5。
// 返回 { matches: [{ item, relevance, score }], total, matched }：
//   - matches：精排后的前 5（分数降序），工具层直接格式化；
//   - total：索引总量；matched：粗排入围数（转化率校准的观察指标）。
export function rank(items, query, signals = {}) {
  const queryGrams = bigrams(query)
  const coarse = coarsePass(items, queryGrams)
  const matches = coarse
    .map(entry => ({ ...entry, score: precisionScore(entry, queryGrams, signals) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  return { matches, total: items.length, matched: coarse.length }
}

// install：挂到运行时（保持 index.js 的 MODULES 装配模式一致——
// tools.js 通过 rt.rank 调用，测试也可绕过 rt 直接用纯函数）。
// 词典在 install 时一次性合并（内置表 + config.synonyms 用户词典），
// rank 闭包先 expandQuery 再检索——调用方无感知。
export function install(rt) {
  const userDict = Array.isArray(rt.config?.synonyms) ? rt.config.synonyms : []
  const dict = [...BUILT_IN_SYNONYMS, ...userDict.filter(group => Array.isArray(group) && group.length > 0)]
  rt.rank = (items, query, signals) => rank(items, expandQuery(query, dict), signals)
}
