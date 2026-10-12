# 回答结束判定改造：发送控件状态（getSendState）

> 2026-10-12 ｜ 涉及：src/types.ts + 5 个平台适配器 ｜ tsc 通过，DeepSeek 已端到端验证

## 1. 背景与问题

各平台 `waitForAnswer` 依赖「回答完成」信号判定流式输出结束。现状分三档：

| 信号强度 | 平台 | 依赖 |
|---|---|---|
| 强 | qwen | 官方完成 class `qk-markdown-complete` |
| 中 | doubao / wenxiaoyan | 语义稳定的动作栏按钮（aria-label / cos-icon） |
| 弱 | hunyuan / deepseek | CSS Modules 哈希类（`Repeat_`、`db183363`） |

弱点：**哈希类随前端构建变化即静默失效**，只能回落文本稳定兜底；DeepSeek 甚至完全没有元素级完成信号，风控静默挂死时表现为「空答案照常完成」，无任何诊断信息。

## 2. 改动思路

用户提议：发送前按钮可点击、生成中不可点击，用发送按钮状态判生成结束。

实测修正了这一表述（定标数据见 `analysis/sendstate/REPORT.md`）：

1. **生成中不是「禁用」而是「图标替换」**——发送图标被换成停止/中断图标，多数平台仍可点击（用于中断生成）；
2. **`disabled`/`aria-disabled` 与生成状态无关**——它们只反映输入框是否为空（空输入与完成后输入已清空时都会禁用）；
3. 因此信号定义为 **send 态 / generating 态二分**，锚点用图标形状、aria-label、data-testid 等语义特征，不用哈希类。

由此新增统一钩子 `getSendState()`（可选接口，各平台私有实现），并按平台现状差异化接入，**不替换**已有强信号判定（第二轮迭代后升级为五平台统一的「生成态闸门」，见 §4）。

## 3. 五平台定标锚点（2026-10-12 实测）

| 平台 | 生成中（generating） | 待发送/完成（send） |
|---|---|---|
| deepseek | 发送图标 svg path 切为停止图标 | path 回发送图标（与发送前基线比对，无 aria 状态位） |
| doubao | 发送钮被中断钮替换：`[data-testid="chat_input_local_break_button"]` 在场 | 中断钮消失、发送钮回归 |
| qwen | `button[aria-label="停止回答"]` | `aria-label="发送消息"` |
| hunyuan | `#yuanbao-send-btn` aria-label=「停止回答」 | aria-label=「发送」 |
| wenxiaoyan | `span.ci-submit-button` 内 `img.ci-submit-pause` | 内含 `img[src*="send-icon"]` |

注意：wenxiaoyan 的发送控件是 `span`（非 button/role=button）；豆包 aria-busy 实测全程 false，不可单独依赖。

## 4. 接入方式：统一「生成态闸门」（2026-10-12 第二轮，五平台一致）

用户补充关键场景：**思考/检索阶段文本零增长，但生成并未结束**——纯靠「文本无增长」判定会在这时误判完成、抽到半截或空答案。而发送控件状态是唯一能区分「思考中（generating）」和「真完成（send）」的信号。

因此五平台统一为同一套判定结构：

```
每轮采样：sendState = getSendState() + 文本长度

⓪ 平台明确完成标志（qwen 官方 class / 各家动作栏基线计数）→ 立即完成（保留）
① sendState === 'generating' → 一律不判完成（思考中，文本不增长也继续等）
② 纯文本兜底（流式结束+稳定 / 从未增长 Ns 等）→ 仅 sendState !== 'generating' 时允许触发
硬上限 timeoutMs 防失控；结束时仍 generating → 打「疑似挂死/风控」日志
```

各平台被闸门保护的兜底路径：

| 平台 | 受闸门保护的兜底 | 明确完成标志（不受闸门影响） |
|---|---|---|
| deepseek | 从未增长 45s | 动作行基线计数 + 文本稳定 3s；另保留 ⓪′「见过 generating → 回 send + 稳定 5s」 |
| doubao | 流式后 5s 稳定；从未流式 30s | 动作栏（朗读/更多 aria-label）基线计数 |
| qwen | everGrew 后 8s 稳定；从未增长 40s | 官方 class `qk-markdown-complete` + 稳定 2s |
| hunyuan | everGrew 后 8s 稳定；从未增长 40s | 动作栏（Repeat_/ToolbarSuitable_）基线计数竞速（2026-10-12 实测补基线：残留动作栏曾致 0.04s 假完成） |
| wenxiaoyan | 6s 稳定；20s 强制；从未增长 30s | 动作栏（cos-icon-copy）基线计数 |

降级语义：`getSendState()` 返回 `unknown`（锚点失效/未找到）时不参与闸门，保持原判定行为——**平台改版只会退化为旧行为，不会死等也不会误判**。

挂死日志价值：区分「还在生成」与「流已死但没答案」，风控/服务异常时本轮结果可标记可疑，而非静默空答案。

## 5. 设计边界与已知限制

- **秒回竞态**：生成短于一个轮询周期会错过 generating 态 → 状态机只作停止条件，文本增长基线兜底保留；
- **哈希遗留**：deepseek 基线比对、doubao 中断钮 testid 均为语义级；hunyuan/qwen/wenxiaoyan 现有动作栏信号中的哈希类（`Repeat_` 等）未动，失效时由现有兜底承接；
- **锚点漂移**：平台改版可能更换图标/aria 文案，失效表现为 `getSendState` 恒为 `unknown`（自然退化为原判定），不会误判。

## 6. 验证

- `npx tsc --noEmit` 通过；
- DeepSeek 真实浏览器端到端（`analysis/sendstate/verify-deepseek.mts`）：`getSendState` 现场序列 `generating → send`，`waitForAnswer` 11.2s 完成，答案 1057 字；
- 其余四平台锚点来自定标轮实测（`analysis/sendstate/calibrate.mjs` 可复跑）。

## 7. 相关文件

- `src/types.ts`：`SendState` 类型 + `PlatformAdapter.getSendState?()` 可选钩子
- `src/platforms/*/​*Adapter.ts`：五平台实现与接入
- `analysis/sendstate/REPORT.md`：定标原始数据与方法
- `analysis/sendstate/calibrate.mjs` / `verify-deepseek.mts`：采集与验证脚本
