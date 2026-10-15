// 采集流程专用异常：带上语义供上层按类型分流处理
// 验证码刷新重发用尽仍未通过（本轮任务无法完成，无回答可抽取）
export class CaptchaBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaBlockedError';
  }
}
