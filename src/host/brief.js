// L1 brief 抽取·路线 B（SPEC §3.2）：规则机械精简——标题树 + 各节首句，
// 丢代码块注释与铺陈段落。零依赖纯文本处理。
//
// 实施顺序（SPEC v1.1 增补）：路线 A（模型按五段模板抽取）依赖宿主 LLM 通道
// （第 1 步 V1 验证项，尚未接线），故先落本路线 B——它本就是规格定义的降级
// 态；路线 A 接入后本实现自动退为 A 失败时的兜底，两者共用同一缓存键
// （全文内容 hash，见 indexer 的 readSkillContent 缓存）。
//
// 硬规则（SPEC §3.2）：
//   1. 目录树必须完整保留（capability_load 的 section 模式靠它点名）；
//   2. 首句截断只丢铺陈、不改写任何词——参数名/命令/路径原样保留；
//   3. 尺寸目标带 300-800 token：原文 ≤800 直接全文返回（精简得不偿失）；
//      精简结果 <300 且原文 ≤1600 也退回全文（信息密度不划算）。
const CJK = /[\u4e00-\u9fff]/

const SHORT_LIMIT = 800    // 全文 ≤ 此 token 数：原文返回
const BUDGET = 800         // brief 目标上限（超预算从尾部丢节首句）
const FLOOR = 300          // brief 下限：低于此且原文 ≤1600 时退回全文
const FALLBACK_FULL = 1600 // 「退回全文」允许的原文上限
const FIRST_SENT_MAX = 60  // 节首句截断长度（字符，约等于 token 上界）

// token 粗估：中文字 ≈1 token、其余字符 ≈1/4 token（英文词均长 ~4）。
// 不追求精确——只用于精简收益判断与预算带控制。
export function estTokens(text) {
  const s = String(text ?? '')
  if (s === '') return 0
  let cjk = 0
  for (const ch of s) if (CJK.test(ch)) cjk += 1
  return cjk + Math.ceil((s.length - cjk) / 4)
}

// 路线 B 主入口：SKILL.md 全文 → 机械精简 brief。
export function extractBrief(content) {
  const s = String(content ?? '')
  if (estTokens(s) <= SHORT_LIMIT) return s
  // 逐行扫描：跟踪代码块栅栏（``` / ~~~），栅栏内与栅栏行不参与首句；
  // 标题行进目录树，正文行只取每节第一行（首句），其余铺陈丢弃。
  const headings = []          // [{ level, text }]：目录树素材，保序
  const sections = new Map()   // 标题文本 → 首句（'' 表示该节暂无/纯代码）
  let inFence = false
  let current = '__preamble__' // 第一个标题之前的正文归入「总述」
  sections.set(current, '')
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const heading = line.match(/^(#{1,6})\s+(.*\S)?\s*$/)
    if (heading) {
      const text = (heading[2] ?? '').trim()
      headings.push({ level: heading[1].length, text })
      current = text
      if (!sections.has(current)) sections.set(current, '')
      continue
    }
    if (line.trim() === '') continue
    // 节内首个有效正文行即首句候选；截断不改写（硬规则 2）。
    if (!sections.get(current)) sections.set(current, line.trim().slice(0, FIRST_SENT_MAX))
  }
  // 组装一：目录树——按标题级别缩进两格，完整保留（硬规则 1）。
  const tree = headings.map(h => '  '.repeat(h.level - 1) + '#'.repeat(h.level) + ' ' + h.text)
  // 组装二：各节首句速览（总述在最前）。
  const body = []
  const pre = sections.get('__preamble__')
  if (pre) body.push(`- （总述）${pre}`)
  for (const [key, first] of sections) {
    if (key === '__preamble__' || !first) continue
    body.push(`- ${key} → ${first}`)
  }
  const tail = '> 本摘要为规则机械精简（不含铺陈与代码）。完整原文用 full:true；按节点名用 section:"标题"。'
  // 预算控制：从尾部丢节首句直到 ≤ BUDGET；目录树永不丢。
  let kept = body.length
  const join = n => [...tree, '', tail, ...body.slice(0, n)].join('\n')
  while (estTokens(join(kept)) > BUDGET && kept > 0) kept -= 1
  const brief = join(kept)
  // 下限：精简后 < FLOOR 且原文不大 → 全文返回更划算（硬规则 3）。
  if (estTokens(brief) < FLOOR && estTokens(s) <= FALLBACK_FULL) return s
  return brief
}

// install：挂到运行时（与 scorer/usage 同款装配模式，tools.js 经 rt 调用）。
export function install(rt) {
  rt.extractBrief = extractBrief
}
