# dsh-skill-router 规格文档 v1.0

> 技能调度中心：面向 DeepSeek Harness（DSH）的独立插件——四级渐进披露 + 统一评分器 + 全局会话技能调度。
> 本文档为完整实施方案，自包含，供后续开发会话直接加载执行。
> 产生日期：2026-10-22。前置讨论结论均已并入，除非标注「待验证」，否则按本文档执行。

---

## 0. 一句话定位

把「技能/MCP 怎么被会话使用」从全量挂载改造为**四级按需披露**：目录常驻少量 → 预热集自动匹配 → 摘要(brief)廉价装载 → 检索元工具兜底；以独立插件 `dsh-skill-router` 承载，**全局生效（Bot 团队 + 经典 Agent 会话）**，ds-bot 的 systemExpose 开关升级为双模式入口。

## 1. 背景与现状事实（已实测/已读码确认）

### 1.1 现状机制（ds-bot v0.2.16 的 systemExpose）
- 代码位置：`ds-bot/src/host/capabilities.js`
  - `systemMcpServers()`（L557）：同步读宿主 loader 树上 `@deepseek-ai/dsh-mcp-client` 条目，按 serverName 去重
  - `systemItems()`（L684-731）：MCP（同步）+ SKILL（`withSkillScope` 内 registry.list + 逐项 await registry.get 串行读全文）
  - `reconcileAgent()`（L352）：开关打开时把全部系统项并入 desired → `mountOne()`（L299）逐项挂载
  - SKILL 挂载形态：内联 plugin `c.skills.register({ name, description, source:'runtime', content })`（L331-341），content 为 SKILL.md 全文
  - `systemSkillCache`：进程内全文缓存，仅关开关/重启时失效（无版本感知）
  - `ensureCapabilities()`（L450）：每次 send 前调用，`prepare()` 15s 超时后放行
  - `capabilityStatusesView()`（L230-250）：只遍历团队自有 `bot.capabilities`，**系统项挂载状态对用户不可见（已确认的盲区）**
  - config hash 短路（L326-327）：`key = name:sha256(config)`，相同则跳过重建（稳态零重建，抗规模的既有基础）

### 1.2 实测事实
- 当前宿主技能清单 **17 项**：academic-figures、academic-paper-generator、agent-experience、cordis-composition-reference、cordis-plugin-development、diagnose-windows-sandbox-acl、document-vision-text-recovery、editing-cordis-compositions、office、office-docx、office-export-pdf、office-pptx、office-recalculate、office-render、office-xlsx、pubmed-verifier、reverse-engineer-anything
- loader 树 MCP 条目 = **0**（连接器面板未配置；`mcp__promptx__toolx` 来自 promptx-bot-bridge 插件注册，不走该清单）
- **DSH 对技能是目录式呈现**：实测会话 systemTokens≈4969、toolsTokens≈22694，17 项全文（约 50-100KB）不可能常驻——目录（名+描述）进上下文、全文调用时才读。⇒ 本方案的 L0 目录层现状已免费具备
- 实测 Bot 自主调用 MCP：数据研究员在 shell 0xC0000002 故障后自主切换 `mcp__promptx__toolx` 完成 Excel 任务（读出测试码 XJ7392-BOT）
- 自修正机制：**由宿主（系统）执行，非 Bot**——使用技能后发现与用户要求偏差，系统按对话改写 SKILL 内容（名字不变）；插件对自修正为纯消费方，永不回写

### 1.3 环境插件格局（三插件分工）
| 插件 | 角色 | 与本方案关系 |
|---|---|---|
| dsh-skill-mcp 2.3.8（原 dsh-armory，2026-10-21 自定义构建已删 tool tailor） | 供给/安装面：市场装 MCP（落 loader 树）、OAuth、JSON 导入 | 上下游互补。唯一待验证：其装的 SKILL 是否落 `ctx.get('skills')` 同一 registry |
| ds-bot 0.2.17 | 团队管理面：Bot/群/模型/统一设置 | 开关升级为双模式入口（见 §7），挂载代码保留为基础模式 |
| **dsh-skill-router（本插件，新建）** | 运行时调度面：预热/search/load/评分/升温 | 全局生效 |

## 2. 调研依据（业界成熟方案）

| 来源 | 要点 | 对本方案的输入 |
|---|---|---|
| Anthropic Agent Skills | 三层渐进披露：元数据常驻(~50-200 tok/项) → 正文按需 → 引用资源按需；正文 <500 行定位为目录 | L0-L3 分层原型；按需加载省 62-87% |
| Anthropic Tool Search Tool（2025-11） | 不预载 schema，挂一个搜索元工具，命中后临时启用 3-5 个；50+ 工具场景省 85%+；**超过 30-50 个工具选择准确率显著下降（硬阈值）** | skill_search 元工具设计；预热集 ≤5 的依据 |
| OpenClaw Skill-Router / workshop | 技能按需路由最高省 89%（20 技能全量≈32K tok/次）；后台自动审查清理未用技能 | 频率升温/冷却；检索化 |
| Letta(MemGPT) | 空闲期 sleep-time compute 整理记忆与技能 | 升温整理在空闲期执行 |
| 论文 ITR（arxiv 2602.17046） | 每步动态检索最小工具子集：上下文 -95%、路由正确率 +32% | 预热集=离线跑同一评分器 |
| 论文 DTDR / SIT-Graph | 检索条件于「初始查询+演进上下文」；从轨迹学工具依赖 | search 查询用任务原文；预留轨迹信号 |

**可借鉴模式 Top3（本方案的骨架）**：①两段式渐进披露（先发现后加载）②搜索元工具兜底（规避 30-50 项阈值）③预匹配+频率升温（ITR + OpenClaw/Letta 已验证）。

## 3. 四级披露架构

```text
L0 目录层（现状保留）：预热集 name+description 常驻 prompt，≤20 项硬上限
L1 摘要层（新增）：brief——技能骨架，300-800 tokens，skill_load 默认返回
L2 全文层：SKILL.md 原文，1-5K tokens，skill_load(full:true) 才取
L3 分节层（并入）：按标题切片，skill_load(section) 点名取节，0.3-1K tokens
```

### 3.1 L0 收敛规则（对 v0.2.16 的关键修正）
- v0.2.16 的「全部系统项进 desired」在大 N 下不可行（N=300 → 15-60K 常驻，且超 30-50 项准确率阈值）
- 新规则：`L0 = 预热集(≤5) + 热门目录(≤15)`，**硬上限 20 项**；溢出自动只留预热集，其余转纯检索（只活在 skill_search 索引里，不进 prompt）
- N 增长只影响检索索引大小，**不影响每步延迟与挂载耗时**（规模化的核心保证）

### 3.2 L1 brief 抽取

> **实施顺序（v1.1 增补）**：路线 B 先行——插件当前无宿主 LLM 通道（第 1 步 V1 验证项未接线），路线 A 的「模型按模板抽取」无从发起；路线 B 本就是规格定义的降级态，先落 B 即可全量生效、零新依赖。路线 A 待模型通道验证后接入，届时 B 自动退为 A 失败时的兜底，两者共享同一套缓存键与硬规则。

- **路线 A（主线）**：技能暴露/导入时用模型按固定五段模板离线抽取一次：
  1. 用途与触发场景 2. 核心能力清单 3. 关键约束/禁忌 4. 参数与路径速查 5. 「本摘要省略了什么、何时必须取全文」
- **路线 B（降级兜底）**：模型通道不可用/抽取失败时，规则机械精简（标题树+各节首句、丢代码块注释与铺陈）
- **硬规则**：
  - 参数名/命令/路径/API 签名**只许原样保留，禁止改写**（防止模型拿残缺知识操作出错→自修正风暴）
  - 第五段（何时取全文）是固定必需段，措辞必须具体
  - brief 缓存键 = **全文内容 hash**，全文变即作废重抽（版本绑定红线）
  - brief 尺寸下限 **300-800 tokens，禁止压到 300 以下**（经济账：brief 省的 ≈ 全文−brief；自修正罚的 ≈ 轮数×0.5-1K；丢硬信息会倒贴）
- 抽取落库后在能力页可展开人工抽查

### 3.3 L2/L3 元工具接口草案

```text
capability_search(query: string, scope?: 'bot'|'global', names_only?: boolean)
  → 返回 Top 5 行式摘要，每项 40-60 tokens：
    name | 一句话描述(≤30字) | ★相关度 | 已预热标记
  → names_only:true 只返回「name [kind]」行（返回体积约降 60%，模型已知
    目标名时用）；此时仍计入 search 漏斗
  → 同会话相同查询返回缓存结果并提示（防死循环重搜）
  → 零结果：返回热门 Top 5 + 「无精确匹配，以下为技能库大类」

capability_load(name: string, full?: boolean, section?: string, ref?: string)
  → 默认返回 brief（300-800 tok）+ 尾部「何时取全文」指引
  → full:true 返回 SKILL.md 原文
  → section:"标题" 返回该节（brief 中必须展示完整目录树供点名）
  → ref:"相对路径" 返回技能声明的单个资源文件内容（SKILL.md 内引用的
    references/scripts 文件）；实现按「registry 能力探测」分级：
    registry 暴露 base 路径 → 直接读文件；不暴露 → 返回明确提示（本技能
    不支持 ref 读取，请用 full）并计一次软失败——ref 未命中不硬失败
  → ref / section / full 互斥：同时给出按 ref > section > full 优先级取一
  → 调用即计数：(sessionId, skillName) 写入使用统计（升温数据源）
```

- 设计决策：**capability_load 默认返回 brief 而非全文/热注册**——不依赖 DSH 轮次中途热注册技能的不确定性（风险归零），完全复刻 Claude Code Skill 工具「返回内容即读即用」的行为
- MCP 与 SKILL 同场检索：统一索引，MCP 项的「brief」= 其工具清单摘要

## 4. 统一评分器（排序策略）

### 4.1 两段式漏斗
```text
粗排：文本相关度 ≥ 门槛（bigram 命中至少一处有效词）→ 取 Top 20
精排：score = 0.50×相关度 + 0.25×频率(log1p 归一)
              + 0.15×预热加成(命中=1) + 0.10×群协同(log 归一)
              − 失败惩罚（乘法降权，见 4.3）
      → 返回 Top 5
```
- 权重为初始值，依 4.4 转化率数据校准；预热加成用加法 boost，避免角色匹配项无条件压过明显更相关的结果
- 字段权重：name 命中 > description > whenToUse（whenToUse 本身就是「任务→技能」映射，权重不低于 description）

### 4.2 信号清单
| 信号 | 来源 | 版本 |
|---|---|---|
| 文本相关度 | 查询 ↔ name/description/whenToUse/brief，bigram（中文免分词） | v1 ✅ |
| 同义扩展 | 查询经同义/中英词典展开后并入 bigram 集合（内置高频表 + config.synonyms 用户词典） | v1.1 ✅ |
| 使用频率 | (botId/sessionId, skill) 计数 | v1 ✅ |
| 预热加成 | 角色匹配命中的预热集 | v1 ✅ |
| 群协同 | 同群其他成员近 7 天用过 | v1 ✅ |
| 失败惩罚 | load 后同轮重试 ≥2 次 = 软失败 | v1 ✅（自修正确认后纳入） |
| 修正频率（U型） | 见 §6 | v1 ✅ |
| embedding 语义 | 向量相似度 | 预留接口 |

### 4.3 修正频率的 U 型信号（自修正红利）
| 修正次数 | 解读 | 动作 |
|---|---|---|
| 0 | 冷技能 | 中性 |
| 1-2 | 有真实流量、在被磨合 | 微加分 |
| ≥3/周 | 持续对不齐 = 质量问题 | 降权 + 结果行标注「近期频繁修订」 |

### 4.4 评估闭环
记录漏斗 `search 次数 → load 次数 → 实际调用次数`；搜而不 load = 排序失败信号；load 而不调用 = brief 误导。定期回流校准权重。

### 4.5 统一评分器的两个消费口（一份实现两处生效）
```text
score(query, skill, ctx)
├─ 在线：capability_search 传入任务原文
└─ 离线：reconcile 时传「角色画像」(instructions+群名)，Top-N 即预热集
```
保证预热集与 search 口径永远一致。

## 5. 升温/冷却机制

- 预热集 = 规则匹配 Top-N ∪ 近 7 天高频 Top-N（合计受 ≤5 约束，超限时按 score 排序取优）
- 连续 14 天零调用自动移出预热集（仍在检索索引，不删除）
- 整理在宿主空闲期执行（sleep-time compute），不占任务时间

## 6. 自修正感知（宿主执行，插件纯消费方）

- **版本语义**：hash 比对放在 reconcile——修正只影响**下一次 reconcile/新会话，当前轮继续用旧版**（保守语义，与 Claude Code 同款；禁止「修正立即全队重挂」）
- **四个设计点**：
  1. brief 重抽节流：修正落库标记 dirty，**不立即重抽**；下次 reconcile（或 10 分钟窗口）合并重抽
  2. 修正频率 U 型信号进评分器（§4.3）
  3. 预热集滞回：新评分**连续 2 次**超过现任成员才换位（防一次修正导致预热集抖动→全队挂载重建）
  4. 检索即时性红利：修正一落库，下一次 capability_search 即见新版摘要（反馈周期从会话生命周期缩到一次搜索）
- 失效感知手段：registry 元数据签名比对（描述/mtime/hash），见护栏 2；若宿主未来暴露变更事件则替换为事件监听（待验证项 V3）

## 7. ds-bot 开关双模式设计（用户拍板：选项 a）

### 7.1 开关语义（UI 位置不动，改名「智能技能调度」）
```text
关（默认）＝ 基础模式
   等同现状 v0.2.16：宿主已装技能全量挂载（当前 17 项），
   无检索/预热/brief——已验证行为原样保留
开 ＝ 智能调度模式
   ds-bot 停止自行挂载；预热/search/load/brief 全部由 dsh-skill-router 接管；
   画像信号（Bot instructions/群主题）开放给评分器
```
- **核心约束：代码并存、运行互斥**——两套挂载链路都在，开关保证任一时刻只有一条活跃，同名双注册机制上不可能发生
- **作用域**：本开关只裁决 Bot 团队；router 对经典会话的调度由 router 自身全局设置控制
- **选项 a（已拍板）**：接受语义缺口——原「关=完全不挂任何系统技能」的隔离态取消；真有隔离需求将来在 router 侧做团队 opt-out

### 7.2 切换交接（防双挂载窗口）
```text
关 → 开：ds-bot 先摘除全部系统挂载（现有关闭分支现成）→ router 读到状态变化 → 挂预热集
开 → 关：router 先停为团队服务 → ds-bot 重新全量挂载
```
顺序固定「先摘后挂」；交接期最坏「短暂无技能」（下次 send 前 reconcile 补齐），绝不双挂。

### 7.3 动态小字（写清当前状态，用户明确要求）
```text
关：「基础模式：已挂载系统技能 17 项（office-xlsx 等）。无检索与预热，
     安装并开启技能调度中心后可按群智能分配。」
开：「智能调度已接管：预热 5 项（office-xlsx、office-docx…），
     其余 12 项按需检索（skill_search）。画像信号已共享给调度中心。」
```
数据源：挂载数=registry 清单数、预热集=router 上报、其余数=总−预热。状态变化即刷新（顺带修复 capabilityStatusesView 盲区——状态归挂载方 router 上报）。

### 7.4 ds-bot 侧改动清单
| 改动 | 内容 | 规模 |
|---|---|---|
| 开关端点 `system-expose` | true 时不再自行 reconcile 挂载，改为：摘载 → 置 prefs → 通知 router；false 时走现有全量挂载 | 小改 |
| 挂载代码 | **保留不删**（基础模式用） | 0 |
| 画像导出 | 新增 `rt.profileSignal()`：Bot 画像+群主题只读视图，router 经 ctx 服务发现读取；关=导出空信号 | +30 行 |
| 能力页 | 「系统暴露」区改名+双模式小字+router 状态展示 | client.js 改造 |
| 探测 | router 缺席时开=置灰或提示「需安装 dsh-skill-router」（关仍可用基础模式） | 小 |

## 8. 五条规模化护栏（实现时内建）

| # | 护栏 | 内容 |
|---|---|---|
| 1 | 目录硬上限 | L0 预热+热门 ≤20 项，溢出转纯检索 |
| 2 | send 路径零全量 IO | systemItems() 结果缓存，失效条件 = registry 元数据签名（描述/mtime/hash）；reconcile 稳态只剩内存比对 |
| 3 | brief 抽取后台化 | 独立队列限流 2-3 并发、幂等（hash 同跳过）、失败落路线 B；抽取期间 send 照常（该技能暂走全文兜底） |
| 4 | 全量 IO 并发闸 | 并行 registry.get 统一限 8 并发（修复现有串行 await） |
| 5 | 熔断 | 预热集某项连续挂载失败 N 次自动摘出、降级到检索路径 |

既有抗规模基础（保留不动）：reconcile 按 Agent 串行链+单等待队列；mountOne config hash 短路。

## 9. Token 账（汇总）

| 项 | 尺寸 | 说明 |
|---|---|---|
| 排序/评分本身 | **0 token**（宿主 CPU） | 模型只见结果 |
| 工具 schema 常驻 | ≈200 tok | search+load 两个工具 |
| 一次 search 往返 | 发起~50 + 结果~250（Top5 行式） | 按需 |
| 一次 load(brief) | 300-800 | 多数任务到此为止 |
| 完整发现链 | <1K，一次性进历史（后续走缓存） | vs 全量目录常驻 |
| 对比：全量目录 N=17 | ~1.7K 常驻 | N 小时 search 略亏（平衡点附近） |
| 对比：全量目录 N≥50 | 5-60K 常驻+超准确率阈值 | search 是唯一可行解 |
| 自修正（宿主自带） | 输入 2-6K + 输出 1-5K/次 | 与本方案无关的既有成本 |
| brief 重抽（节流后） | ≈1-3K/次修正 | 本方案对自修正的唯一增量 |
| 自修正红利 | 修正即时可见 → 减少带过时技能跑的无效轮次 | 方案反向减负 |

## 10. 迁移路径（三步，每步可独立交付、中断均停在可用态）

```text
第 1 步  router 骨架（只读 + 发现）
  - 新建 dsh-skill-router 插件（打包 tgz → profile bundles 声明，同 dsh-skill-mcp 接入方式）
  - registry 只读索引 + capability_search / capability_load 元工具（全局会话）
  - 不做预热挂载 → 与 ds-bot systemExpose 功能不重叠（router 只发现、ds-bot 只挂载）
  - 顺带验证：V1 插件级 LLM 通道、V2 工具注册可见性、V4 registry 落点
第 2 步  接管开关（挂载权交接）
  - ds-bot：system-expose 端点改双模式（§7.4）；画像导出；小字 UI
  - router：预热集挂载（统一评分器离线口）+ 交接防抖 + 熔断
第 3 步  深化
  - brief 抽取（后台队列）+ L3 分节 + 升温/冷却 + 失败惩罚/修正 U 型信号 + 转化率校准
```

## 11. 待验证清单（第 1 步内完成）

| # | 验证项 | 方法 | 失败退路 |
|---|---|---|---|
| V1 | 插件后台能否直接调模型（brief 抽取路线 A） | 查宿主 ctx 是否暴露 llm/网关服务（openai-gateway、our-free-model 设施） | 路线 B 规则精简先上 |
| V2 | 插件注册的自定义工具对经典会话与 Bot 会话均可见 | delete_bot（Bot 会话）+ dsh-skill-mcp 工具（经典会话）先例复核；实测注册后两会话工具列表 | 仅 Bot 会话可见则经典会话暂缺元工具（可接受，Phase 2 补） |
| V3 | 宿主 registry 是否有变更事件（watch） | 查 dsh-skill / skills 服务 API | 元数据签名轮询（护栏 2）兜底 |
| V4 | dsh-skill-mcp 装的 SKILL/MCP 落点是否 = ctx.get('skills') 同一 registry | 装一个测试技能后 registry.list 对比 | 不同 registry 则 adapter 适配 |
| V5 | skills.register 同名重复注册的宿主行为 | 实测两次同名注册 | 依赖「先摘后挂」互斥已规避，但需知道行为以做防御 |

## 12. 验收标准（按步）

- **第 1 步**：任意经典会话与 Bot 会话中，模型可调用 capability_search 返回相关技能行式摘要；capability_load 返回 brief；N=17 时 search→load 全链 <1K tokens；send 路径无新增全量 IO
- **第 2 步**：开关开→关闭态（基础）与开启态（调度）各执行 3 次 send，capabilityStatuses/小字状态正确；切换全程无同名双挂载（日志验证）；预热集 ≤5 且与画像匹配合理
- **第 3 步**：brief 命中率（load brief 后无 full 回退）≥70%；修正后 dirty→下次 reconcile 重抽生效；14 天零调用技能移出预热集；转化率面板数据完整

## 13. 风险与缓解汇总

| 风险 | 缓解 |
|---|---|
| brief 丢硬信息 → 自修正风暴 | 硬信息原样保留规则 + 300-800 下限 + 抽查 UI |
| 版本漂移（brief/缓存与全文不一致） | 全文 hash 作缓存键（红线） |
| 切换双挂载 | 先摘后挂 + 运行互斥 |
| N 增长卡顿 | 目录硬上限 + send 零全量 IO + 并发闸 + 熔断（§8） |
| 误修技能越改越歪 | U 型降权 + 修正频率标注 + brief 抽查（修正判定本身属宿主职责，本方案只消费） |
| 模型死循环重搜 | 同会话查询缓存 + 提示 |

## 14. 明确不做（v1 范围外）

- embedding 语义检索（留接口）
- 修正建议回写宿主原件的通道（自修正归宿主）
- 团队 opt-out 隔离态（选项 a 已接受的缺口，将来 router 侧补）
- 经典会话的预热挂载（v1 元工具已覆盖经典会话的发现需求，预热暂仅 Bot 团队）

---
*文档结束。开发会话请按 §10 顺序执行，先完成 §11 验证清单再动第 2 步。*
