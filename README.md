# dsh-skill-router

DeepSeek Harness（DSH）技能调度中心插件——把「全部技能/MCP 元数据常驻每个会话上下文」改为「按需检索、按需加载」的渐进披露调度。全局生效（覆盖全部会话），技能越多，节省的上下文 token 越多。

## 功能说明

| 能力 | 说明 |
| --- | --- |
| 只读索引 | 从宿主 skills registry 与 loader 树构建统一的技能/MCP 索引；元数据签名做失效感知（签名不变则零 registry 调用） |
| `capability_search` | 按任务原文检索技能/MCP，返回行式摘要 Top 5（每项约 40-60 token）；同会话同查询走带签名校验的缓存 |
| `capability_load` | 按名称读取技能全文或单节（`section` 参数）；MCP 项返回使用指引；调用即计数 |
| 统一评分器 | bigram 字段加权相关度（name×3 / whenToUse×2 / description×1）+ 两段式漏斗（粗排 Top 20 → 精排 Top 5） |
| 使用统计 | 会话×技能调用计数与漏斗（search→load→use）持久化到 `state.json`，作为预热排序依据 |
| 预热集挂载 | 按近 7 天高频 + 使用画像，为每个 Bot 会话预挂 ≤5 项常用技能（含防双挂载握手、失败熔断与滞回换位），目录硬上限 20 |
| 开关双模式 | 跟随宿主智能调度开关：关闭=保持宿主原生全量挂载；打开=切换到本插件的按需调度 |
| brief 抽取层 | load 默认返回 300-800 token 五段模板摘要，`full:true` 才返全文（规划中） |

## 实现机制（为什么省 token）

传统做法是把所有技能的名称、描述与使用时机全量注入每个会话：技能一多，仅元数据就常驻数千 token，而绝大多数会话根本用不到它们。

本插件把同一份信息组织成四级渐进披露，token 消耗随「实际使用」递增，而不是随「技能数量」线性膨胀：

1. **目录层**——会话技能目录只保留「名称 + 一行描述」；
2. **检索层**——模型遇到任务先 `capability_search`：bigram 粗排取 Top 20，字段加权精排取 Top 5，只花几十 token 就能定位正确技能；
3. **加载层**——确需使用时 `capability_load` 才读取全文，支持按节读取；MCP 工具只返回使用指引；
4. **预热层**——高频常用技能按使用画像自动预挂到对应会话，常用路径零检索开销，低频技能留在索引里由检索兜底。

索引与统计都是只读旁路：元数据签名不变则零 registry 调用；调用计数落盘 `state.json`，重启不丢，越用越准。

## 安装步骤

环境要求：Node.js ≥ 22（与 DSH 宿主一致），无第三方运行时依赖。

```powershell
# 在插件目录直接做语法检查与单测
npm run check
npm test

# 打包为 tgz 后装入 DSH profile
npm pack
```

装入 profile 的标准流程：

1. `npm pack` 得到 `dsh-skill-router-0.2.2.tgz`；
2. 在 `~/.dsh/profiles/desktop/` 安装该 tgz；
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

典型场景：技能/MCP 数量多、全量挂载撑大上下文时，用检索替代常驻；打开智能调度开关即切换到本插件的调度模式（常用技能自动预热挂载，其余靠检索兜底）。

## 配置说明

| 配置项 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `home` | string | `$DSH_HOME/skill-router`（无 `DSH_HOME` 时 `~/.dsh/skill-router`） | 数据目录，存放 `state.json`（使用计数 + 漏斗统计）与握手信号文件 |

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

Apache-2.0，见 [LICENSE](LICENSE)。

## 自愿捐款

如果您觉得本插件对您有帮助，欢迎微信扫码自愿请作者喝杯咖啡：

<p align="center">
  <img src="assets/wechat-donate.jpg" alt="微信捐款二维码" width="220" />
</p>

**捐款完全自愿，不捐款不影响任何功能**——本插件全部功能对所有人无条件开放，没有任何付费解锁、试用期或功能限制。详见 [DONATE.md](DONATE.md)。
