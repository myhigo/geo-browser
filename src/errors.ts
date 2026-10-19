// 采集流程专用异常：带上语义供上层按类型分流处理
// 验证码刷新重发用尽仍未通过（本轮任务无法完成，无回答可抽取）
export class CaptchaBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaBlockedError';
  }
}

// 静态出口不可用：账号 ipMode=static 但绑定的代理不存在/已停用/未绑定。
// 必须中断本轮，绝不回退直连——否则会以本机 IP 裸奔采集。
export class StaticProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticProxyUnavailableError';
  }
}

// 发送手势已执行，但在确认窗口内始终没看到页面接受这次提问（输入框仍含原问题、未出现新轮次、
// 发送控件未进入生成态）。慢链路下的正常失败模式，不是登录问题；本轮无回答可抽取，等下一轮重试。
// ⚠️ 不自动重发：千问可在手势后数十秒才清空输入框并开始生成，此时重发会造成同会话重复提问。
export class SendNotConfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendNotConfirmedError';
  }
}
