# 三省六部制流程优化插件（dsh-san-sheng-liu-bu）

按「任务难度」自动切换推理档位的 DSH 插件（三省六部制：中书省定策 → 门下省审议 → 尚书省六部执行）。目标是解决同一个模型下 DSH 比其它工具慢好几倍的问题：慢的主因不是模型或缓存，而是**每一步都带着 13–15 万 token 的上下文 + high 推理 + 全部 51 个工具往返一次**。这个插件让简单任务少想、少带工具，只在真正复杂的任务上保留 high。

## 档位映射

| 判定 | 推理档位（reasoningEffort） | 工具 |
| --- | --- | --- |
| 简单 simple | `off`（可配 `low`） | 隐藏约 50 个重工具（web/子代理/团队/终端/任务/会话检索/hindsight/媒体渲染等） |
| 中等 medium | `low` | 全部保留 |
| 复杂 complex | `high` | 全部保留 |
| 不确定 ask | 先弹出带倒计时的提问卡（简单/中等/复杂），超时按中等 | 按回答处理 |

> 说明：DeepSeek 的 `deepseek-flash` 只支持 `off / low / high / max`，**没有 `medium`**。所以“中等”落地为 `low`，这是配置项可改的取舍，而不是插件 bug。

## 判定规则（启发式，纯本地、零开销）

`lib/classify.js` 对用户消息做加权打分，不调用任何模型：

- 简单信号：短（<60 字 +2、<160 字 +1）、事实类动词（查一下/翻译/多少钱/等于…）、短问句、出现“简单/快速/一句话”。
- 复杂信号：长（>320 字 +1、>700 字 +2、多于 2 行 +1）、代码围栏 +2、路径/URL +1、≥2 个项目符号 +1、复杂动词（分析/排查/调试/优化/重构/改造/设计/实现/开发/部署/评估/报告/方案…，最多 +3）、连接词（然后/接着/分别…）。
- 问候语、"继续/好的/ok" → 延续上一轮档位（`continuationReuse`）。
- 含糊短句（"帮我看看"）或双方分数接近 → `ask`，交给用户决定。
- 子代理（`parentSession` 存在）的消息完全忽略，避免子任务误触发提问。

## 实现位置（为什么这么挂）

- `agent/inbox/claimed`（同步、先于本步工具表生成）：只有在这里施加 `agent.ctx.tools.restrict()` 才能影响**本步**的工具 schema；放在 pre-step 只能影响后续步。
- `agent/request`（waterfall）：改写每步请求的 `reasoningEffort`。改写前用 `ctx.llm.resolveModelInfo()` 校验模型是否支持该档位，不支持就不改，避免 `UNSUPPORTED_REASONING_EFFORT` 让整轮请求失败。`complex` 档默认显式写回 `high`（否则会继承上一轮的 `off`）。
- `agent/pre-step`：处理“不确定”时的 `userQuestions.askTimed()` 提问，带倒计时卡片，超时/失败回退 medium。
- `agent/status`（idle）与 `agent/disposed`：兜底解除工具限制，保证不会有残留。

## 安装

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "D:\Program Files (x86)\deepseek harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:"C:\Users\55061\Documents\deepseek-harness\default-workspace\plugins\dsh-san-sheng-liu-bu"
```

插件带 `dsh.bundle.patch`，装完会自动登记进 profile 的 `dsh.profile.bundles` 并在下次加载时生效（GUI 需重启或重连才能拉起重载后的组合）。卸载：

```powershell
& "...\dsh.cmd" plugin --profile desktop remove dsh-san-sheng-liu-bu
```

## 配置

在 `C:\Users\55061\.dsh\profiles\desktop\cordis.patch.yml` 里给 `san-sheng-liu-bu` 加 `config:`（字段见 `lib/index.js` 的 `Config`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `simpleEffort` | `"off"` | 简单档推理强度；`""` 表示不改请求 |
| `mediumEffort` | `"low"` | 中等档 |
| `complexEffort` | `"high"` | 复杂档 |
| `modeOverride` | `""` | 强制 `simple` / `medium` / `complex`，跳过判定 |
| `restrictSimpleTools` | true | 简单档是否隐藏重工具 |
| `denyTools` | 约 50 个 | 简单档隐藏清单（未知工具名会被忽略） |
| `askOnUncertain` | true | 不确定时是否提问；关掉则直接按中等 |
| `askTimeoutMs` | 90000 | 提问卡倒计时（毫秒） |
| `continuationReuse` | true | “继续/好的”复用上一轮档位 |
| `debug` | false | 输出判定与档位切换日志（`ctx.logger.debug`） |

示例：

```yaml
- id: san-sheng-liu-bu
  name: 'dsh-san-sheng-liu-bu'
  config:
    simpleEffort: low
    askTimeoutMs: 60000
    debug: true
```

## 验证

1. 装完后 `C:\Users\55061\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 应出现 `dsh-san-sheng-liu-bu`。
2. 新开会话发一句“1+1等于几”，应看到请求的 `reasoningEffort=off` 且工具数量明显减少（可对比 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里的 request header）。
3. 发一句“帮我看看”，应出现倒计时提问卡；不回答则 90 秒后按中等继续。
4. 复杂任务（多步骤、代码、部署）应保持 `high`。

## 已知边界

- 判定是启发式的，个别任务会偏轻或偏重；不确定时会问一次，或把 `modeOverride` 设成固定档位。
- 提问卡只在“第 1 步”出现；同一轮后续步骤沿用已选档位。
- `agent/inbox/claimed` 之后才组装工具表，因此 tool 限制对本步生效；effort 在 `agent/request` 生效，两者都在同一轮内。
- 若 `agent/disposed` 事件不存在，状态表会随会话增长；每个 agent 仅一条小对象，可忽略。
