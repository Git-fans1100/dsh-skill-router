# dsh-skill-router

DeepSeek Harness（DSH）技能调度中心插件——把「全量技能元数据常驻上下文」改为「按需检索、按需加载」的四级渐进披露调度面（SPEC.md v1.0，迁移第 2 步：预热挂载已落地）。

## 功能说明

| 能力 | 说明 | 迁移阶段 |
| --- | --- | --- |
| 只读索引 | 从宿主 skills registry + loader 树构建统一的技能/MCP 索引，元数据签名做失效感知（签名不变零 registry 调用） | 第 1 步（本版） |
| `capability_search` | 按任务原文检索技能/MCP，返回行式摘要 Top 5（每项 40-60 token）；同会话同查询带签名校验的缓存 | 第 1 步（本版） |
| `capability_load` | 读技能全文或分节（`section` 参数）；MCP 项返回使用指引；调用即计数（升温数据源） | 第 1 步（本版） |
| 统一评分器 | bigram 字段加权相关度（name×3 / whenToUse×2 / description×1）+ 两段式漏斗（粗排 Top 20 → 精排 Top 5） | 第 1 步（本版） |
| 使用统计 | 会话×技能计数、漏斗（search→load→use）持久化到 `state.json` | 第 1 步（本版） |
| 预热集挂载 | 智能调度模式下按近 7 天高频+画像为每个 Bot 预挂 ≤5 项技能（含与 ds-bot 的防双挂载握手、熔断与滞回换位），目录硬上限 20 | 第 2 步（本版） |
| brief 抽取层 | load 默认返回 300-800 token 五段模板摘要，`full:true` 才返全文 | 第 3 步 |
| 开关双模式 | 接管 ds-bot systemExpose：关闭=原全量挂载，打开=本插件调度 | 第 2 步（本版） |

## 安装步骤

环境要求：Node.js ≥ 22（与 DSH 宿主一致），无第三方运行时依赖。

```powershell
# 在插件目录直接做语法检查与单测
npm run check
npm test

# 打包为 tgz 后装入 DSH profile（第 1 步骨架默认不安装，验证阶段再装）
npm pack
```

装入 profile 的标准流程（与 ds-bot 相同）：

1. `npm pack` 得到 `dsh-skill-router-0.2.2.tgz`；
2. 在 `C:\Users\Administrator\.dsh\profiles\desktop\` 安装该 tgz；
3. 在 profile 的 cordis 清单中加入 `cordis.patch.yml` 声明的条目（`id: skill-router` / `name: dsh-skill-router`）；
4. 重启宿主，确认 stdout 出现插件加载且无报错。

## 使用方法

安装后插件自动向全部会话（含经典 Agent 与 Bot 团队）注册两个元工具，模型自主调用：

```
capability_search(query: "画一张生存曲线", scope: "skill")
→ Top 5 of 12 candidates (17 indexed):
  - 图表生成 [skill] — 生成统计图表与学术配图 ★0.67 [已预热]
  ...
→ Use capability_load with the exact name to read the full instructions.

capability_load(name: "图表生成", section: "用法")
→ [skill: 图表生成] Section "用法"
  ...
```

典型场景：技能/MCP 数量多、全量挂载撑大上下文时，用检索替代常驻；打开 ds-bot 的「系统暴露」开关即切换到本插件的调度模式（Bot 常用技能自动预热挂载，其余靠检索兜底）。

## 配置说明

| 配置项 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `home` | string | `$DSH_HOME/skill-router`（无 `DSH_HOME` 时 `~/.dsh/skill-router`） | 数据目录，存放 `state.json`（使用计数 + 漏斗统计） |

cordis 配置示例：

```yaml
- id: skill-router
  name: dsh-skill-router
  config:
    home: D:/some/path/skill-router
```

## 贡献指南

1. 修改代码后必须通过 `npm run check` 与 `npm test`（当前 35 项单测全绿）；
2. 设计变更先改 `SPEC.md`（唯一规格依据），再动代码——评分器权重、护栏上限、brief 模板等定稿值都在 SPEC 里；
3. 提交信息用一行说明「为什么」，中文；
4. 新增行为必须带单测（`test/` 下按模块分文件，Node 内置 test runner）。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。自愿捐款说明见 [DONATE.md](DONATE.md)——完全自愿，不捐款不影响任何功能。
