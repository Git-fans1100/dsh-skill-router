# dsh-skill-router

> [中文说明](README.md) | English

A skill dispatch center plugin for DeepSeek Harness (DSH) — it replaces "all skill/MCP metadata permanently mounted into every session context" with progressive disclosure: search on demand, load on demand. Works globally (covers all sessions); the more skills you have installed, the more context tokens it saves.

## Features

| Capability | Description |
| --- | --- |
| Read-only index | Builds a unified skill/MCP index from the host skills registry and the loader tree; metadata signatures drive invalidation awareness (a stable signature means zero registry rebuilds) |
| `capability_search` | Searches skills/MCP by the task text and returns the top 5 line summaries (about 40-60 tokens each); `names_only:true` returns bare name lines (~60% smaller); same-session repeat queries are served from a signature-checked cache |
| `capability_load` | Reads a skill by name: a condensed 300-800 token brief by default (TOC + per-section first lines), `section` for one section, `full:true` for the complete text, `ref` for a referenced file; MCP entries return usage guidance; every call is counted |
| Unified scorer | Bigram field-weighted relevance (name×3 / whenToUse×2 / description×1) plus a two-stage funnel (coarse top 20 → fine top 5) |
| Usage stats | Per-session × per-skill call counts and the search→load→use funnel, persisted to `state.json` as the preheat ranking basis |
| Preheat mounting | Pre-mounts up to 5 frequently used skills per Bot session based on the last 7 days of usage and the Bot profile (with an anti-double-mount handshake, failure circuit breaker and hysteresis-based displacement); directory hard cap is 20 |
| Dual-mode switch | Follows the host smart-scheduling switch: off = keep the host's native full mounting; on = switch to this plugin's on-demand dispatch |
| Synonym expansion | Queries are expanded through built-in Chinese-English synonym groups plus a user `synonyms` dictionary before bigram matching, so paraphrased and mixed-language queries no longer miss (v0.3.0) |
| Brief extraction layer | `load` returns a condensed 300-800 token brief by default (route B: TOC + per-section first lines, filler and code excluded); `full:true` returns the entire text; route A (model-generated five-section summaries) activates once the host LLM channel is wired up |
| `capability_stats` | Read-only statistics outlet (v0.3.1): search→load funnel with conversion rate, preheat hit ratio (`loadPreheated` — the share of loads taken straight from the preheated directory without a search, the self-evidencing number for the preheat layer), the current per-Bot preheat set, top used skills of the last 7 days, and circuit-breaker state; pure read, never counted into the funnel |
| Settings section & master switch | A native "Skill Router" section in the settings UI (v0.4.0, same settings.section protocol as SIMDT): plugin intro, live read-only stats (version / index / preheat / funnel) and a master switch — turning it off parks the plugin entirely (tools go offline, preheated mounts are released, the heartbeat stops writing, ds-bot falls back to the native full catalog), and turning it back on takes effect instantly with no restart; includes the WeChat voluntary donation notice (entirely voluntary, not donating affects no feature) |

## How it works (why it saves tokens)

The conventional approach injects every skill's name, description and usage timing into every session: as skills pile up, metadata alone permanently occupies thousands of tokens, and most sessions never touch most of them.

This plugin organizes the same information into four levels of progressive disclosure, so token consumption grows with actual usage instead of linearly with the number of skills:

1. **Directory layer** — the session skill directory keeps only "name + one-line description";
2. **Search layer** — when facing a task, the model calls `capability_search` first: bigram coarse ranking picks top 20, field-weighted fine ranking picks top 5; locating the right skill costs only tens of tokens;
3. **Load layer** — only when a skill is actually needed does `capability_load` read the full text, with per-section reading supported; MCP entries return usage guidance only;
4. **Preheat layer** — frequently used skills are automatically pre-mounted into matching sessions based on the usage profile: common paths cost zero search overhead, while low-frequency skills stay in the index covered by search as a fallback.

Both the index and the stats are read-only bypasses: a stable metadata signature means zero registry rebuilds; call counts are persisted to `state.json` and survive restarts, so the system gets more accurate the more it is used.

## Installation

Requirements: Node.js ≥ 22 (same as the DSH host), no third-party runtime dependencies.

```powershell
# Syntax check and unit tests inside the plugin directory
npm run check
npm test

# Pack as a tgz, then install into a DSH profile
npm pack
```

Standard procedure to install into a profile:

1. `npm pack` produces `dsh-skill-router-0.4.0.tgz`;
2. Install that tgz under `~/.dsh/profiles/desktop/`;
3. Add the entry declared by `cordis.patch.yml` (`id: skill-router` / `name: dsh-skill-router`) to the profile's cordis manifest;
4. Restart the host and confirm the plugin loads on stdout without errors.

## Usage

After installation the plugin automatically registers two meta tools for all sessions (both classic Agents and Bot teams); the model calls them on its own:

```
capability_search(query: "draw a survival curve", scope: "skill")
→ Top 5 of 12 candidates (17 indexed):
  - Chart Generation [skill] — generates statistical charts and academic figures ★0.67 [preheated]
  ...
→ Use capability_load with the exact name to read the full instructions.

capability_load(name: "Chart Generation", section: "Usage")
→ [skill: Chart Generation] Section "Usage"
  ...
```

Typical scenario: when skill/MCP counts grow and full mounting bloats the context, replace persistence with search. Turn on the smart-scheduling switch to switch into this plugin's dispatch mode (frequently used skills are preheated automatically; everything else falls back to search).

## Configuration

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `home` | string | `$DSH_HOME/skill-router` (falls back to `~/.dsh/skill-router` without `DSH_HOME`) | Data directory holding `state.json` (usage counts + funnel stats) and the handshake signal files |
| `synonyms` | string[][] | 10 built-in Chinese-English synonym groups | Extra custom groups (e.g. `[["生存曲线","km"]]`): when any word of a group appears in the query, the remaining words join the search |

cordis configuration example:

```yaml
- id: skill-router
  name: dsh-skill-router
  config:
    home: D:/some/path/skill-router
```

## Contributing

1. Changes must pass `npm run check` and `npm test` (35 unit tests currently green);
2. Design changes go to `SPEC.md` first (the single source of truth), then the code — scorer weights, guardrail caps and the brief template are finalized in the SPEC;
3. Commit messages: one line explaining "why", in Chinese;
4. New behavior must come with unit tests (files under `test/` split by module, Node's built-in test runner).

## License

Apache-2.0, see [LICENSE](LICENSE).

## Donation

If you find this plugin helpful, you are welcome to buy the author a coffee via WeChat:

<p align="center">
  <img src="assets/wechat-donate.jpg" alt="WeChat donation QR code" width="220" />
</p>

**Donating is entirely voluntary — not donating does not affect any feature.** All functionality is unconditionally available to everyone: there are no paid unlocks, trials or feature limits. See [DONATE.md](DONATE.md) for details.
