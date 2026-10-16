// ⚠️ 候选 Selector —— 未经人工在诊断中确认，仅作起点。
// V1 诊断的目的就是验证/修正这些。找不到时程序标记 found=false，绝不崩溃、绝不误报。
// 命名尽量覆盖常见模式；真要在 finished.html 里研究结构，请以诊断输出的元素诊断报告为准。

import { CandidateSelectors } from '../../types.js';

export const DOUBAO_CANDIDATE_SELECTORS: CandidateSelectors = {
  // 输入框（豆包是 contenteditable 富文本编辑器，非 textarea）
  input: [
    '[contenteditable="true"]',
    'p[data-placeholder]',
    'div.guidance-input-editor-viewport',
    'textarea',
    'textarea[placeholder]',
  ],
  // 发送按钮：2026-10-15 DOM 实测——语义 testid 最稳（data-testid="chat_input_send_button"），
  // class 候选兜底。禁用态 = disabled 属性与 aria-disabled="true" 同步翻转。
  // ⚠️ 严禁 Playwright 专属语法（如 >>）——选择器可能被拼进 page.evaluate 交浏览器原生
  //    querySelectorAll 执行，遇到专属语法直接抛 SyntaxError（2026-10-15 实测踩坑）。
  sendButton: [
    '[data-testid="chat_input_send_button"]',
    '.guidance-input-actions button[class*="rounded-full"]',
    'button[class*="rounded-full"]',
  ],
  // 会话区「真正挂载」标记：2026-10-15 DOM diff 实测（门齐基线 vs 提交后快照）——
  // 「发送钮可用 + upload_file_button 在场」时页面仍处引导页状态（flow_chat_guidance_page 在场、
  // 仅 13 个按钮），随后 30~35s 才挂载出会话组件；在此之前 Enter 是死键（无响应）或被拒（系统异常）。
  // 下列晚期标记（模式选择器/技能栏/文件输入）出现即为真正可提交。软条件：超时告警后继续（防布局差异死等）。
  inputAreaReady: [
    '[data-testid="chat_input_action_model"]',
    '[data-testid="skill_bar_button_more"]',
    '[data-testid="upload-file-input"]',
  ],
  // 回答区域（容器）
  answerContainer: [
    '.answer-content',
    '.message-content',
    '[class*="answer"]',
    '[class*="message"]',
    '[class*="response"]',
  ],
  // 信源区域
  sourceArea: [
    'ol[data-testid="references"]',
    '[class*="source"]',
    '[class*="reference"]',
    '[class*="citation"]',
    '[class*="cite"]',
  ],
  // 展开信源按钮
  expandSourceButton: [
    'button:has-text("展开")',
    'button:has-text("信源")',
    'button:has-text("引用")',
    '[class*="expand"]',
  ],
  // 「问题+回答」整组对话容器：豆包真实结构待诊断定标，先用通用猜测，后续以真实 DOM 修正。
  qaBlock: ['.chat-turn', '[class*="chat-turn"]', '[class*="conversation-item"]', '[class*="qa-item"]'],
};
