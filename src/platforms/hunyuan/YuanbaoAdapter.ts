import { Page, BrowserContext } from 'playwright';
import { log, warn } from '../../log.js';
import { TextDecoder } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { YUANBAO_CANDIDATE_SELECTORS } from './selectors.js';
import { firstFound } from '../../diagnostics/elementProbe.js';
import { elementToText } from '../textExtract.js';
import { humanClick } from '../../diagnostics/human.js';
import { randWaitMs } from '../../tuning/delays.js';
import { CandidateSelectors, PlatformAdapter, SendState, SourceInfo, ScreenshotMode } from '../../types.js';
import { config } from '../../config/index.js';

// 元宝引用数据提取（运行在 Node 侧，非浏览器上下文）：聊天 API 响应为 SSE，
// 其中 docs 数组含每条信源的 {index,docId,title,url,quote,...}。用 docId 定位对象、
// brace-match 取出完整对象，再抽取 title/url（过滤元宝/腾讯系域名）。
type RawRef = { title?: string; url: string; quote?: string };
/** 还原 JSON 字符串字面量转义（\uXXXX / \" / \n 等） */
function decodeJsonStr(escaped: string | undefined): string | undefined {
  if (escaped == null) return escaped;
  try {
    const v = JSON.parse('"' + escaped.replace(/"/g, '\\"') + '"') as string;
    return v;
  } catch {
    return escaped.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
  }
}
function extractRefsFromText(txt: string): RawRef[] {
  const out: RawRef[] = [];
  const re = /"docId"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) {
    const start = txt.lastIndexOf('{', m.index);
    let depth = 0;
    let j = m.index;
    for (; j < txt.length; j++) {
      if (txt[j] === '{') depth++;
      else if (txt[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    const obj = txt.slice(start, j + 1);
    const urlM = obj.match(/"url"\s*:\s*"(https?:\/\/[^"]*)"/);
    if (!urlM) continue;
    const url = (decodeJsonStr(urlM[1]) ?? '').trim();
    if (/yuanbao\.tencent\.com|hunyuan\.tencent|tencent\.com|qq\.com/i.test(url)) continue;
    const tM = obj.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const title = tM ? (decodeJsonStr(tM[1]) ?? '').trim() : undefined;
    const qM = obj.match(/"quote"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const quote = qM ? (decodeJsonStr(qM[1]) ?? '').trim() : undefined;
    out.push({ title, url, quote });
  }
  return out;
}
function mergeRefs(a: RawRef[], b: RawRef[]): RawRef[] {
  const seen = new Set(a.map((r) => r.url));
  for (const r of b) if (!seen.has(r.url)) { seen.add(r.url); a.push(r); }
  return a;
}

// 腾讯部分 SSE/JSON 响应存在双重编码：原始 UTF-8 字节先被按 cp1252 解读成字符串，
// 再按 UTF-8 编码返回（例如 /api/chat/ 的 title 字段）。常见症状：中文变成
// "Ã©â\x80\x9c..." / "ç›¸å…³è§†é¢‘" 等 mojibake。detail 端点通常是干净 UTF-8。
// 这里做 cp1252 回退，并以「CJK 字符数更多」作为择优标准，两端都兼容。
const CP1252_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};
/** 双编码回退：原始 UTF-8 字节被按 CP1252/latin1 解读成字符、再按 UTF-8 编码返回时，
 *  把每个字符转回原始字节后按 UTF-8 解码。
 *  ⚠️ 不能只查 CP1252 表：0x81/0x8D/0x8F/0x90/0x9D 等 CP1252 未定义字节必须按 latin1 原值回逆
 *  （否则"理"=E7 90 86 的 0x90 会丢成 '?'）；œ„† 等扩展字符走 CP1252 映射。 */
function fixMojibake(s: string): string {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (CP1252_EXTRA[cp] !== undefined) out.push(CP1252_EXTRA[cp]);
    else if (cp <= 0xff) out.push(cp); // latin1 原值（含 CP1252 未定义的 0x81-0x9F 控制区）
    else out.push(0x3f); // fallback '?'
  }
  try { return Buffer.from(out).toString('utf-8'); } catch { return s; }
}
function decodeBest(buf: Buffer): string {
  const u8 = buf.toString('utf-8');
  const cjkU8 = countCJK(u8);
  const hasFFFD = u8.includes('\uFFFD');
  if (!hasFFFD && cjkU8 > 0) return u8; // 干净 UTF-8
  if (!hasFFFD) {
    // 无中文：尝试 CP1252/latin1 双编码回退
    const back = fixMojibake(u8);
    if (countCJK(back) > 0) return back;
    return u8;
  }
  // 有替换符：原始字节非 UTF-8，按 GBK 直接解码
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    if (countCJK(gbk) > 0) return gbk;
  } catch {
    /* ignore */
  }
  const back = fixMojibake(u8);
  if (countCJK(back) > 0) return back;
  return u8;
}
function countCJK(s: string): number {
  return Array.from(s).filter((ch) => {
    const cp = ch.codePointAt(0)!;
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0x2ceb0 && cp <= 0x2ebef)
    );
  }).length;
}

// 元宝（腾讯 Yuanbao）适配器 —— 2026-09-07 真实 DOM 校准版（用户登录后落盘 finished.html 实测定标）。
//   DOM 结构已据真实页面校准：输入框 contenteditable、发送钮 #yuanbao-send-btn、回答气泡
//   .agent-chat__bubble--ai、引用列表 .hyc-common-markdown__ref-list__item（来源名在 __name）。
//   ⚠️ 元宝引用条目是「内部知识来源」标记：DOM 中【无真实文章 URL】（全页仅埋点外链），
//      故信源以【来源名】归因（platform=来源名），url 留空；信源分析侧按 siteName 归因（见 sourceAnalysis）。
// 设计原则（与千问/文心一致，平台操作全部私有，禁止共享基类/通用函数）：
//    - 交互逻辑独立实现，可独立演进；
//    - getSources / getAnswer 均带 captureDir 落盘探针，便于登录后读 DOM 校准选择器与信源结构；
//    - 可选钩子 captureQaScreenshot / dismissAds / solveCaptcha 初版先不实现（run.ts 对缺失项安全跳过），
//      待元宝真实页面确认需要截图/广告/验证码处理时再补。

// 真人节奏延迟（元宝初版沿用通用区间；后续按元宝实测手感微调，不跨平台引用其它适配器常量）
const FOCUS_SETTLE: [number, number] = [120, 120];
const FOCUS_AFTER: [number, number] = [60, 0];
const PRE_TYPE: [number, number] = [500, 1500];

export class YuanbaoAdapter implements PlatformAdapter {
  constructor(
    private page: Page,
    private context: BrowserContext,
    private selectors: CandidateSelectors = YUANBAO_CANDIDATE_SELECTORS
  ) {
    this.installReferenceCapture();
  }

  // 引用数据捕获：元宝真实信源不在可见 DOM 文本里（引用条目仅图标 + data-idx-list 索引），
  // 而在聊天 API 响应 /api/chat/ 与 /api/user/agent/conversation/v1/detail 的 docs 数组
  // （含 index/docId/title/url/quote）。拦截这两个响应，解析 docs 即可拿到全部真实信源。
  private chatRefs: { title?: string; url: string; quote?: string }[] = [];
  private detailRefs: { title?: string; url: string; quote?: string }[] = [];
  private refCaptureInstalled = false;
  private installReferenceCapture(): void {
    if (this.refCaptureInstalled) return;
    this.refCaptureInstalled = true;
    this.page.on('response', (resp) => {
      const u = resp.url();
      const isChat = /yuanbao\.tencent\.com\/api\/chat\//.test(u);
      const isDetail = /yuanbao\.tencent\.com\/api\/user\/agent\/conversation\/v1\/detail/.test(u);
      if (!isChat && !isDetail) return;
      resp
        .body()
        .then((buf) => {
          if (!buf) return;
          // ⚠️ 元宝 /api/chat/ 等响应编码不统一：干净 UTF-8 / cp1252 双编码 / GBK 三种都可能。
          //   从原始 Buffer 多候选解码（decodeBest：utf-8、cp1252 回退、gbk 择优），
          //   避免先用 toString('utf-8') 把 GBK 字节破坏成 U+FFFD 导致无法恢复。
          const txt = decodeBest(buf);
          const refs = extractRefsFromText(txt);
          if (!refs.length) return;
          if (isChat) this.chatRefs = mergeRefs(this.chatRefs, refs);
          else this.detailRefs = mergeRefs(this.detailRefs, refs);
        })
        .catch(() => {});
    });
  }

  // 登录墙检测（初版启发式）：有输入框 → 视为可对话（登录态/匿名可用）；否则看有无登录入口。
  // ⚠️ 元宝真实登录墙结构未知，待登录落盘后校准（例如某些登录墙仍渲染输入框但禁发，到时需在
  //    这里补元宝专属登录墙 marker 判定）。
  // 登录墙检测（初版）：用「通用输入框」判定而非未校准的占位候选选择器——
  // 元宝对话页（已登录）必有可对话输入框（contenteditable/textarea/input），命中即视为可对话（已登录）；
  // 否则看有无登录入口，都没有则兜底视为需登录。⚠️ 待落盘真实 DOM 后若有特例再补元宝专属 marker。
  // 发送控件状态（2026-10-12 定标）：#yuanbao-send-btn 的 aria-label 在「发送 ↔ 停止回答」间切换
  async getSendState(): Promise<SendState> {
    const label = await this.page
      .locator('#yuanbao-send-btn')
      .first()
      .getAttribute('aria-label')
      .catch(() => null);
    if (label === '停止回答') return 'generating';
    if (label === '发送') return 'send';
    return 'unknown';
  }

  /** 本轮 AI 是否「输出中」——元宝官方状态属性 data-conv-outputting（2026-10-15 实测）：
   *  比类名哈希稳定；必须限定 data-conv-speaker="ai"（实测发送失败时用户条 outputting=true、
   *  AI 条 false，只看 outputting 会误判）。 */
  private async aiOutputting(): Promise<boolean> {
    return this.page
      .evaluate(() => !!document.querySelector('[data-conv-speaker="ai"][data-conv-outputting="true"]'))
      .catch(() => false);
  }

  /** 发送确认（2026-10-15 重写）：**唯一判据 = AI 真的开始输出**（官方属性 data-conv-outputting）。
   *  ⚠️ 两个假阳性信号必须排除（均实测踩坑）：
   *    ① 「AI 气泡元素存在」——request abort 时元宝也会立即创建空气泡；
   *    ② 「发送钮=停止回答」——abort 后按钮同样停在停止态，据此判成功会漏掉刷新重试。
   *  → 两者都只代表前端 UI 进入生成态，不代表服务端在生成。 */
  private async confirmSent(waitMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (await this.aiOutputting()) return true;
      await this.page.waitForTimeout(800);
    }
    return false;
  }

  /** 页面可用性恢复（run.ts 在导航后、登录检测前调用；2026-10-15 用户反馈：挂代理启动浏览器
   *  有时进入登录页、需刷新）。
   *  ⚠️ 就绪判据必须用「会话页特征元素」（发送钮 / 输入区容器），**不能用 textarea 是否存在**：
   *     实测登录页上同样有 textarea/contenteditable，用后者会把登录页误判为正常页 → 永不刷新
   *     （2026-10-15 19:18 实测踩坑）。真登录态失效时刷新救不了 → 放弃，交 checkLogin 判定。 */
  async recoverPage(): Promise<void> {
    // 会话页特征：元宝输入区容器或发送钮（登录页不存在）
    const chatReady = async (): Promise<boolean> => {
      const l = this.page.locator('#yuanbao-send-btn, [class*="agent-chat__input-box"]').first();
      return (await l.count().catch(() => 0)) > 0 && (await l.isVisible().catch(() => false));
    };
    // 异常页迹象（2026-10-15 用户定：登录页或任何异常页都刷新）：
    //   URL 命中登录/错误路由，或页面出现登录类、页面级错误类文案。
    //   会话特征在场时不判异常（waitChat 里 chatReady 优先，双保险防误刷）。
    const abnormalPage = async (): Promise<boolean> => {
      if (/login|passport|signin|sso|error/i.test(this.page.url())) return true;
      return this.page
        .evaluate(() =>
          /扫码登录|手机号登录|验证码登录|立即登录|登录\/注册|请先登录|请登录|页面不存在|页面暂时不可用|网页无法访问|网络连接异常|加载失败/.test(
            document.body ? document.body.innerText : ''
          )
        )
        .catch(() => false);
    };
    const waitChat = async (ms: number): Promise<boolean> => {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        if (await chatReady()) return true;
        if (await abnormalPage()) return false;
        await this.page.waitForTimeout(1000);
      }
      return false;
    };
    // 阶段1：正常水合 15~20s；给 30s 上限（不打断正在进行的挂载）
    if (await waitChat(Math.min(config.navTimeoutMs, 30000))) return;
    // 阶段2：刷新恢复（≤5 轮；登录页/异常页一律刷新）
    for (let i = 1; i <= 5; i++) {
      warn(`⚠️ 未进入会话页（登录页/异常页/未加载完）→ 刷新页面恢复（第 ${i}/5 次）`);
      await this.page
        .reload({ waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs })
        .catch(() => {});
      if (await waitChat(Math.min(config.navTimeoutMs, 45000))) {
        log('✅ 页面已恢复（会话页就绪）');
        return;
      }
    }
    warn('⚠️ 刷新 5 次仍未进入会话页（可能登录态已失效），继续后续流程由登录检测判定');
  }

  async checkLogin(): Promise<boolean> {
    const hasInput = await this.page
      .locator('textarea, input, [contenteditable="true"]')
      .count()
      .catch(() => 0);
    if (hasInput > 0) return false; // 有可对话输入框 → 已登录可聊
    const loginBtn = this.page.locator('a:has-text("登录"), button:has-text("登录")');
    if ((await loginBtn.count()) > 0) return true;
    return true; // 兜底：没输入框就没法问答
  }

  // 输入并发送问题：聚焦可编辑区 → 逐字真人打字 → 点一次发送钮 → 以「助手气泡出现」确认发送。
  // ⚠️ 关键修复（2026-09-07）：元宝发送后【不立即清空输入框】，旧逻辑用「输入框是否清空」判断
  //    是否发送成功会误判为未发送 → 触发兜底二次点击 → 而发送钮在回答生成中是「停止」切换，
  //    二次点击即中断回答。故改为：只点一次发送钮，确认标志是「.agent-chat__bubble--ai 出现」，
  //    Enter 仅作为「发送钮未生效」的兜底（且仅一次），绝不重复点钮，杜绝双发中断。
  async sendQuestion(question: string): Promise<void> {
    // 2026-10-15 重构：限时尝试 + 刷新重来（与豆包同构）。
    //   背景（实测 + 用户反馈）：挂代理时元宝页面加载不完整/中途整体重载 → 提交可能 request abort；
    //   且元宝前端会「乐观渲染」空的 AI 气泡，使「气泡存在」式确认把失败误判为已发送。
    const MAX_REFRESH = 3;
    for (let round = 0; round <= MAX_REFRESH; round++) {
      if (round > 0) {
        warn(`⚠️ 上一轮未确认发送 → 刷新页面重试（第 ${round}/${MAX_REFRESH} 次）`);
        await this.page
          .reload({ waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs })
          .catch(() => {});
        await this.recoverPage(); // 刷新后可能又是登录页/未加载完
      }
      if (await this.attemptSend(question, Date.now() + config.navTimeoutMs)) return;
    }
    warn(`⚠️ 刷新重试 ${MAX_REFRESH} 次仍未确认发送，交由回答等待阶段处理`);
  }

  /** 单轮发送：门1（输入区就绪）→ 聚焦打字 → 门2（发送钮可用）→ 点发送 → 官方状态确认。
   *  全部等待受 deadline 约束；确认成功返回 true，未确认返回 false（交外层刷新重来）。 */
  private async attemptSend(question: string, deadline: number): Promise<boolean> {
    const rem = (): number => Math.max(3000, deadline - Date.now());
    const sendSel = this.selectors.sendButton.join(', ');

    // 门1：等发送钮元素出现（= 输入区应用已挂载；代理慢时输入框可能先出现但应用还没挂载完）。
    //   上限 20s（不占满整轮预算）：未出现说明页面不在会话态（登录页/未加载完）→ 立即放弃交外层刷新。
    const gate1 = await this.page
      .waitForSelector(sendSel, { timeout: Math.min(rem(), 20000), state: 'visible' })
      .then(() => true)
      .catch(() => false);
    if (!gate1) {
      warn('⚠️ 门1超时：发送钮未出现（疑似仍在登录页/未挂载完）→ 本轮放弃，交外层刷新重来');
      return false;
    }

    const input = await firstFound(this.page, this.selectors.input);
    if (!input) {
      warn('⚠️ 未找到输入框，本轮放弃（交外层刷新重来）');
      return false;
    }

    await humanClick(this.page, this.selectors.input.join(', ')).catch(() => {});
    await this.page.waitForTimeout(randWaitMs(FOCUS_SETTLE));
    await input.locator.focus().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(FOCUS_AFTER));

    const focusedEditable = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (
            !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
          );
        })
        .catch(() => false);
    if (!(await focusedEditable())) {
      warn('⚠️ 编辑器未获焦点，尝试 textarea 兜底聚焦');
      const ta = this.page.locator('textarea').first();
      await ta.click().catch(() => {});
      await ta.focus().catch(() => {});
      if (!(await focusedEditable())) await input.locator.focus().catch(() => {});
    }

    await this.page.waitForTimeout(randWaitMs(PRE_TYPE));
    await this.humanType(question);

    const enteredText = async (): Promise<string> =>
      this.page
        .evaluate(() => {
          const ce = document.querySelector('[contenteditable="true"]');
          const ta = document.querySelector('textarea');
          return ((ce && ce.textContent) || '') + ((ta && (ta as HTMLTextAreaElement).value) || '');
        })
        .catch(() => '');
    const probe = question.slice(0, Math.max(1, Math.floor(question.length / 2)));
    if (!(await enteredText()).includes(probe)) {
      warn('⚠️ 输入校验失败：问题文本未进入输入框（见 02-question.png）');
    }

    // 门2：等发送钮「可用」（文字进应用状态后按钮才由禁用转可用）。
    //   代理慢时文字可能已进 DOM 但应用状态未同步 → 此时点击无效（实测 request abort 的诱因之一）。
    const btnEnabled = (): Promise<boolean> =>
      this.page
        .locator('#yuanbao-send-btn')
        .first()
        .evaluate((el) => {
          const e = el as HTMLElement;
          const dis = e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true';
          return !dis && !/SendButton_disabled/.test(String(e.className || ''));
        })
        .catch(() => false);
    if (!(await btnEnabled())) {
      log('⏳ 发送钮未就绪（应用仍在挂载），等待其可用…');
      const g2 = Date.now();
      let ok = false;
      while (Date.now() < deadline) {
        if (await btnEnabled()) {
          ok = true;
          break;
        }
        await this.page.waitForTimeout(1000);
      }
      ok
        ? log(`✅ 发送钮已就绪（等待 ${Math.round((Date.now() - g2) / 1000)}s）`)
        : warn('⚠️ 发送钮未转可用（超时），仍尝试提交');
    }

    // 提交：点击发送钮（实测点击比 Enter 可靠；Enter 有时完全无反应）
    await humanClick(this.page, sendSel);
    if (await this.confirmSent(Math.min(30000, rem()))) return true;

    // 兜底：Enter 一次（不重复点钮，避免双发中断）
    warn('⚠️ 点发送钮未确认，尝试 Enter 兜底');
    await this.page.keyboard.press('Enter').catch(() => {});
    if (await this.confirmSent(Math.min(15000, rem()))) return true;

    warn('⚠️ 本轮发送未确认（未见 AI 输出状态）');
    return false;
  }

  // 模拟真人逐字输入
  private async humanType(text: string): Promise<void> {
    const punctuations = '，。、；：？！,.!?;:';
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      let d = 180 + Math.floor(Math.random() * 270);
      if (punctuations.includes(ch)) d += 200 + Math.floor(Math.random() * 300);
      if (Math.random() < 0.08) d += 400 + Math.floor(Math.random() * 500);
      await this.page.waitForTimeout(d);
    }
  }

  // 等待流式回答完整输出。
  //   元宝专属完成信号（2026-09-08 用户确认）：AI 回答操作栏中的「重新生成（Repeat_）」/
  //   「赞/踩（ToolbarSuitable_）」按钮【只在回答完整后才渲染】。比「文本长度稳定 8s」更稳更快
  //   （视频卡片/秒答/纯图片答案也能立即判定）。两个信号并行竞速，任意一个命中即视为完成。
  //   ⚠️ 区分：用户的「复制/编辑问题」操作栏（ToolbarCopy_/agent-chat__conv--human__toolbar）
  //      在发问前就存在，不能用作信号；元宝专属的 Repeat_/ToolbarSuitable_ 是回答完成后才出现。
  //   evaluate 内一律匿名。

  /**
   * 元宝「问题确认 / 澄清（Clarify）」卡：回答输出前会弹澄清卡，卡上【跳过所有】带 60s 倒计时，
   * 不点就要等倒计时走完（onCountdownEnd）才会继续输出回答。
   * 采集场景只要答案、不需要澄清 → 命中即点掉，让回答立即继续。
   *
   * ⚠️ 按钮 class 是 CSS Modules 哈希值（形如 ClarifySkipButton_skip__xxx，每次前端构建都会变），
   *    不能按 class 定位；改用稳定文本定位，兼容「跳过所有」与倒计时态「跳过所有 (Ns)」。
   * @returns 是否成功点掉（false = 没这张卡或点击失败）
   */
  private async trySkipClarify(): Promise<boolean> {
    const sel = 'button:has-text("跳过所有")';
    const btn = this.page.locator(sel).first();
    // ⚠️ 本方法是「非阻塞探测」，绝不等待澄清卡出现——绝大多数场景没有这张卡，必须瞬时返回。
    //    count() / isVisible() 都立即返回（不等待元素出现），只有确实看到可见按钮才走 humanClick；
    //    因为 humanClick 内部是 boundingBox({ timeout: 5000 })，按钮不存在/不可见时会等满 5s，
    //    在每秒轮询下会把整个等待循环拖垮。两道过滤缺一不可。
    if ((await btn.count().catch(() => 0)) === 0) return false;
    if (!(await btn.isVisible().catch(() => false))) return false;
    const clicked = await humanClick(this.page, sel).catch(() => false);
    if (clicked) log('⏭️ [元宝] 检测到「问题确认/澄清」卡，已点【跳过所有】，继续等待回答输出');
    return clicked;
  }

  async waitForAnswer(timeoutMs = 180000): Promise<void> {
    const start = Date.now();

    // 动作栏计数：残留上一轮回答的动作栏会让裸判在发送后瞬间命中，须超过基线才算本轮。
    const countActionBar = async (): Promise<number> =>
      this.page
        .evaluate(() => {
          return Array.from(
            document.querySelectorAll('[class*="Repeat_"], [class*="ToolbarSuitable_"]')
          ).filter((b) => (b as HTMLElement).getBoundingClientRect().width > 0).length;
        })
        .catch(() => 0);
    const actionBaseline = await countActionBar();

    // 正文长度监控：多候选取「文本最长」——代理慢时 .agent-chat__bubble--ai 可能是空壳，
    //   正文只出现在 [data-conv-speaker="ai"] / .hyc-common-markdown 等候选里。
    const growthSels = this.selectors.answerContainer;
    const getAnswerLen = async (): Promise<number | null> =>
      this.page
        .evaluate((sels) => {
          let best = -1;
          for (const s of sels) {
            const nodes = document.querySelectorAll(s);
            if (!nodes.length) continue;
            const el = nodes[nodes.length - 1];
            const len = (el.textContent || '').length;
            if (len > best) best = len;
          }
          return best < 0 ? null : best;
        }, growthSels)
        .catch(() => null);

    let lastLen: number | null = null;
    let everGrew = false;
    let noGrowth = 0;
    let lastProgressLog = Date.now();
    let hungStreak = 0; // 「按钮停在生成态但 AI 无输出」的连续秒数（request abort / 挂死识别）
    let winner: 'action-bar' | 'text-stable' | 'text-stable-cache' | 'hung' | 'text-timeout' =
      'text-timeout';

    // 单循环判据（2026-10-19 合并）：动作栏原先走独立 Promise.race 且无任何正文约束，
    //   而元宝工具栏在正文渲染前就挂出 → 实测 20% 轮次在 1~10s 判完成、只抽到「源」。
    //   合并后动作栏与文本兜底共享同一份增长状态，判据才能叠加「正文已出现且稳定」。
    while (Date.now() - start < timeoutMs) {
      // 元宝澄清卡会中断回答并挂 60s 倒计时：每轮先探测并点【跳过所有】。
      // 点掉后重置稳定计数 → 给真正的回答重新计时，避免把澄清卡误判成「回答已完成」。
      if (await this.trySkipClarify()) {
        lastLen = null;
        everGrew = false;
        noGrowth = 0;
      }

      const len = await getAnswerLen();
      // 生成中信号（两条，任一成立即不得判完成）：
      //   ① 发送控件生成态（aria-label=停止回答）；② 官方属性 AI 条 data-conv-outputting="true"
      const st = await this.getSendState();
      const outputting = await this.aiOutputting();

      // 挂死识别（2026-10-15 实测）：按钮停在「停止回答」但官方属性显示 AI 根本没在输出——
      //   request abort 后元宝前端仍把按钮留在停止态，旧逻辑因此一路死等到硬上限（180s）。
      if (st === 'generating' && !outputting) {
        hungStreak += 1;
        if (hungStreak >= 45) {
          log(
            `[${((Date.now() - start) / 1000).toFixed(1)}s] ⚠️ 发送控件停在生成态但 AI 无输出 ${hungStreak}s（疑似 request abort/挂死）→ 提前结束本轮`
          );
          winner = 'hung';
          break;
        }
      } else {
        hungStreak = 0;
      }

      if (len !== null) {
        if (lastLen === null) {
          lastLen = len;
          // 首轮就有正文即视为「正文已出现」：极短答案后续不再增长，否则动作栏判据永远不成立，
          //   只能退到 40s 兜底。
          if (len > 0) everGrew = true;
        } else if (len > lastLen + 2) {
          lastLen = len;
          everGrew = true;
          noGrowth = 0;
        } else {
          noGrowth += 1;
        }
      } else {
        noGrowth += 1;
      }

      // ⓪ 动作栏 + 正文已稳定 = 明确完成（正文未出现前不得视为完成）
      if (
        (await countActionBar()) > actionBaseline &&
        everGrew &&
        noGrowth >= 3 &&
        st !== 'generating' &&
        !outputting
      ) {
        log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 检测到回答动作栏 + 文本已稳定，回答已完成（当前 ${lastLen ?? 0} 字）`
        );
        winner = 'action-bar';
        break;
      }

      // 兜底 A：正文先增长后连续 8s 稳定
      if (everGrew && noGrowth >= 8 && st !== 'generating' && !outputting) {
        log(
          `[${(Date.now() - start) / 1000}s] 🏁 元宝回答文本连续 8s 无增长（兜底），当前 ${lastLen ?? 0} 字`
        );
        winner = 'text-stable';
        break;
      }
      // 兜底 B：从未增长/增长后长时间静默
      if (noGrowth >= 40 && st !== 'generating' && !outputting) {
        log(
          `[${(Date.now() - start) / 1000}s] 🏁 元宝文本连续 40s 无增长（可能缓存/瞬时答案），当前 ${lastLen ?? 0} 字`
        );
        winner = 'text-stable-cache';
        break;
      }

      if (Date.now() - lastProgressLog > 10000) {
        const phase = everGrew ? '📝 回答流式输出中…' : '⏳ 检索/思考中…';
        log(
          `[${(Date.now() - start) / 1000}s] ${phase}（容器 ${len === null ? '未出现' : len + ' 字'}）`
        );
        lastProgressLog = Date.now();
      }
      await this.page.waitForTimeout(1000);
    }

    log(`[${(Date.now() - start) / 1000}s] ✅ 元宝回答输出完成（信号: ${winner}），开始抽取`);
    // 挂死识别：等待结束时发送控件仍处于生成态（流未断但无输出，疑似风控/服务异常）。
    // 动作栏明确完成退出时不提示——退出瞬间控件可能尚未翻回发送态，属误报（2026-10-12 实测）。
    if (winner !== 'action-bar' && winner !== 'hung' && (await this.getSendState()) === 'generating') {
      log('⚠️ 等待结束时发送控件仍处于生成态（疑似挂死/风控），本轮结果可能为空');
    }
    await this.page.waitForTimeout(500);
  }

  // 抽取回答正文；定位不到 → null。取最后一个助手气泡（最新回答），克隆后剔除噪音再读文本。
  async getAnswer(): Promise<string | null> {
    return this.page
      .evaluate((arg: { sels: string[]; src: string }) => {
        const { sels, src } = arg;
        const toText = eval('(' + src + ')') as (n: Node) => string;
        // 多候选取「文本最长」（2026-10-15 实测）：首个命中的候选可能是空壳气泡（正文在其它候选里）
        let el: Element | null = null;
        let bestLen = -1;
        for (const s of sels) {
          const nodes = document.querySelectorAll(s);
          if (!nodes.length) continue;
          const cand = nodes[nodes.length - 1];
          const len = (cand.textContent || '').length;
          if (len > bestLen) {
            bestLen = len;
            el = cand;
          }
        }
        if (!el) return null;
        const clone = el.cloneNode(true) as HTMLElement;
        // 先剔除气泡内的 UI / 过程区块（2026-10-19 实测归档 DOM）：思考面板「已处理」、
        //   深度搜索过程时间线、过程卡片、「快速回答」按钮、信源区。
        //   顺序很重要——过程时间线内部也含 .hyc-content-md，不先删会干扰下面的正文定位。
        clone
          .querySelectorAll(
            'script, style, noscript, template, iframe, ' +
              '[class*="reference"], [class*="card_video"], [class*="video_note"], ' +
              '[class*="agent-process-timeline"], [class*="card-box-process-list"], ' +
              '[class*="think-container"], [class*="__think"], [class*="DirectAnswerButton"]'
          )
          .forEach((n) => n.remove());

        // 正文根取「文本最长」的正文容器：动作栏「源」、推荐追问、下载推广位都在正文之外，
        //   以正文容器的文本为界即可天然排除（比删整气泡更稳）。
        //   ⚠️ 不能按 [class*="deep-search-agent"] 删——实测 .hyc-content-md 是它的子节点。
        let root: Element = clone;
        let rootLen = -1;
        clone.querySelectorAll('.hyc-content-md, .hyc-common-markdown').forEach((n) => {
          const len = (n.textContent || '').length;
          if (len > rootLen) {
            rootLen = len;
            root = n;
          }
        });

        // 剔除「纯空白文本节点」（2026-10-16 实测定位）：元宝在块级 </div> 与 </span> 之间留了**字面
        //   换行文本节点**——原文片段：`…复购型电商。</div>\n</span>`。结构遍历把这个 "\n" 当内容，
        //   于是每个列表条目尾部多出一个空行（用户反馈「多了一些没用的换行」）。
        //   实测对应关系：气泡内 `>\n<` 出现 36 次，抽取结果正好 36 个空行 → 一一对应。
        //   ⚠️ 只在元宝做：豆包/文小言的空行来自真实的块级嵌套（是其可读性来源，用户已认可现状），
        //     放进通用 elementToText 会把它们压成一堵墙。
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const blanks: Text[] = [];
        let node = walker.nextNode();
        while (node) {
          const t = node.nodeValue || '';
          if (t.trim() === '' && t.indexOf('\n') >= 0) blanks.push(node as Text);
          node = walker.nextNode();
        }
        blanks.forEach((n) => {
          if (n.parentNode) n.parentNode.removeChild(n);
        });

        const txt = toText(root);
        return txt || null;
      }, { sels: this.selectors.answerContainer, src: elementToText.toString() })
      .catch(() => null);
  }

  // 展开信源（仅作 DOM 兜底展开；主路径是 API 拦截，见 installReferenceCapture）。
  //   ⚠️ 用户反馈：运行中浏览器被打开了几个信源地址（新标签页）——元宝的 ref trigger / 「查看来源」
  //      按钮点击后会打开对应外部信源页。而真实信源已由 /api/chat/ 与 conversation/v1/detail 的
  //      docs 数组拦截拿到（chatRefs/detailRefs），DOM 展开点击完全多余且有害。
  //   ⇒ API 已拿到信源时【跳过一切点击】；仅 API 未命中（罕见兜底）才展开，且不点被 <a href=外链>
  //      包裹的元素，避免误开外部页。
  async expandSources(): Promise<void> {
    const page = this.page;
    if (this.chatRefs.length || this.detailRefs.length) {
      log(
        `⏭️ [元宝] 信源已由 API 拦截拿到（chat=${this.chatRefs.length}/detail=${this.detailRefs.length}），跳过 DOM 展开点击（避免误开外链新标签）`
      );
      return;
    }
    const triggers = this.page.locator('.hyc-common-markdown__ref-list__trigger');
    const tCount = await triggers.count().catch(() => 0);
    for (let i = 0; i < Math.min(tCount, 12); i++) {
      const extWrap = await triggers
        .nth(i)
        .evaluate((n) => {
          const link = n.closest('a[href^="http"]');
          return !!link && !/yuanbao\.tencent\.com/.test(link.getAttribute('href') || '');
        })
        .catch(() => true);
      if (extWrap) continue; // 被外链 <a> 包裹 → 点击会开新页，跳过
      await triggers.nth(i).click({ timeout: 3000 }).catch(() => {});
      await this.page.waitForTimeout(400);
    }
    const txtBtns = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /展开|查看来源|查看引用|查看信源|信源|参考|来源/ });
    const bCount = await txtBtns.count().catch(() => 0);
    for (let i = 0; i < Math.min(bCount, 8); i++) {
      const extWrap = await txtBtns
        .nth(i)
        .evaluate((n) => {
          const link = n.closest('a[href^="http"]');
          return !!link && !/yuanbao\.tencent\.com/.test(link.getAttribute('href') || '');
        })
        .catch(() => true);
      if (extWrap) continue;
      await txtBtns.nth(i).click({ timeout: 3000 }).catch(() => {});
      await this.page.waitForTimeout(300);
    }
    await this.page.waitForTimeout(3000);
  }

  // 抽取信源列表（URL + 标题 + 平台）。初版分层兜底：
  //   ① 旧结构引用胶囊 a[class*=bg-option]；② reference 容器内 <a>；③ 回答卡片内 <a>；
  //   ④ 外层 wrap 兜底（全部外链）；⑤ 新版内嵌 JSON norm_url（多平台新结构并存，先覆盖）。
  // 外链过滤元宝自身域名（yuanbao.tencent.com）；其余真实来源站点留待校准后细化。
  // 语义约定（与 run.ts 的 sourceCount 对齐）：信源区存在但 0 条 → []；连信源区都定位不到 → null。
  async getSources(captureDir?: string): Promise<SourceInfo[] | null> {
    type Attempt = { found: boolean; items: { title?: string; url?: string; platform?: string }[]; diag: Record<string, unknown> };
    let last: Attempt = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      last = await this.page
        .evaluate((areaSel: string) => {
          try {
          const diag = {
            bgOptions: document.querySelectorAll('a[class*="bg-option"]').length,
            refAreas: document.querySelectorAll('[class*="reference"]').length,
            refListAreas: document.querySelectorAll('.hyc-common-markdown__ref-list').length,
            refTriggers: document.querySelectorAll('.hyc-common-markdown__ref-list__trigger').length,
            refWrapExists: !!document.querySelector(areaSel),
            refWrapAnchors: document.querySelector(areaSel)?.querySelectorAll('a').length ?? 0,
            cardAnchors:
              document.querySelector('[class*="answer"]')?.querySelectorAll('a').length ?? 0,
            wrapAnchors:
              document.querySelector('[class*="message"]')?.querySelectorAll('a').length ?? 0,
          };
          // ① 旧结构：bg-option 胶囊
          const m1 = Array.from(document.querySelectorAll('a[class*="bg-option"]'))
            .map((a) => ({ title: ((a.querySelector('.truncate')?.textContent || a.textContent || '') as string).trim() || undefined, url: a.getAttribute('href') || undefined }))
            .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
          if (m1.length) return { found: true, items: m1, diag };
          // ② reference 容器内 <a>
          for (const area of Array.from(document.querySelectorAll('[class*="reference"]'))) {
            const anc = Array.from(area.querySelectorAll('a'))
              .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ③ 回答卡片内全部外链
          const card = document.querySelector('[class*="answer"]');
          if (card) {
            const anc = Array.from(card.querySelectorAll('a'))
              .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ④ 外层 wrap 兜底
          const wrapEl = document.querySelector('[class*="message"]');
          if (wrapEl) {
            const anc = Array.from(wrapEl.querySelectorAll('a'))
              .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ④½ 元宝信源：source 容器内引用条目可能非 <a>，URL 藏在 data-url / data-href
          const srcWrap = document.querySelector('[class*="source"]');
          if (srcWrap) {
            const sitems = Array.from(srcWrap.querySelectorAll('a, [data-url], [data-href]'))
              .map((n) => {
                const eln = n as HTMLElement;
                const href =
                  (n as HTMLAnchorElement).getAttribute?.('href') ||
                  eln.getAttribute('data-url') ||
                  eln.getAttribute('data-href') ||
                  '';
                return { title: (eln.textContent || '').trim() || undefined, url: href || undefined };
              })
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (sitems.length) return { found: true, items: sitems, diag: { ...diag, sourceItems: sitems.length } };
          }
          // ⑤ 新版结构：内嵌 JSON 的 norm_url 真实地址字段
          const html5 = document.documentElement.innerHTML;
          const normUrls = Array.from(html5.matchAll(/"norm_url"\s*:\s*"([^"]*)"/g))
            .map((mm) => mm[1].replace(/\\\//g, '/'))
            .filter((u) => /^https?:\/\//i.test(u) && !/yuanbao\.tencent\.com/i.test(u));
          if (normUrls.length) return { found: true, items: normUrls.map((u) => ({ url: u })), diag: { ...diag, normUrls: normUrls.length } };

          // ⑥ 元宝引用面板（点击 trigger 展开后）将真实来源以 <a href> 渲染于文档任意处。
          //   展开前全文档无外链（仅框架资源），故展开后出现的外链即引用来源——全文档扫描兜底。
          const allExt = Array.from(document.querySelectorAll('a[href^="http"]'))
            .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
            .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
          if (allExt.length) return { found: true, items: allExt, diag: { ...diag, allExt: allExt.length } };
          // ⑦ 元宝真实引用条目（来源名，可能无 URL）：.hyc-common-markdown__ref-list__item__name。
          //   ⚠️ 元宝引用是「内部知识来源」标记，DOM 中无真实文章 URL（全页仅埋点外链），
          //      故以【来源名】作为有效信源（platform=来源名），url 留空；信源分析侧按 siteName 归因。
          const refItems = Array.from(document.querySelectorAll('.hyc-common-markdown__ref-list__item'));
          const named: { title?: string; url?: string; platform?: string }[] = [];
          const seenName = new Set<string>();
          for (const ri of refItems) {
            const nm = ri.querySelector('.hyc-common-markdown__ref-list__item__name');
            const title = ((nm?.textContent) || ri.textContent || '').trim();
            if (!title || seenName.has(title)) continue; // 图标/占位项跳过
            seenName.add(title);
            const href =
              ri.getAttribute('data-url') ||
              ri.getAttribute('data-href') ||
              (ri.querySelector('a')?.getAttribute('href') || '');
            named.push({
              title,
              url: /^https?:\/\//i.test(href) && !/yuanbao\.tencent\.com/i.test(href) ? href : undefined,
              platform: title,
            });
          }
          if (named.length) return { found: true, items: named, diag: { ...diag, namedRefs: named.length } };
          return { found: diag.refWrapExists || diag.refListAreas > 0, items: [], diag };
          } catch (e) {
            return { found: false, items: [], diag: { error: (e as Error).message, stack: (e as Error).stack } };
          }
        }, this.selectors.sourceArea.join(', '))
        .catch((e) => {
          if (attempt === 0) log(`[信源诊断] evaluate 异常：${(e as Error).message}`);
          return null;
        });
      if (last && last.found && last.items.length > 0) break;
      await this.page.waitForTimeout(800);
    }
    const attemptErr =
      (last && (last.diag as Record<string, unknown>)?.error) || (last ? null : 'evaluate_rejected_all_attempts');
    log(`[信源诊断] ${JSON.stringify(last?.diag ?? { none: true })}，抽到 ${last?.items.length ?? 0} 条`);

    // 全量扫描落盘：无论是否定位到/是否抛错都落盘（之前静默失败无落盘，导致排查无据），便于校准与定位根因
    if (captureDir) {
      const scan = await this.page
        .evaluate((cnt: number) => {
          const ref = document.querySelector('[class*="reference"]');
          const srcWrap = document.querySelector('[class*="source"]');
          const extAnchors = Array.from(document.querySelectorAll('a[href^="http"]'))
            .map((a) => {
              const anc: string[] = [];
              let p = a.parentElement;
              for (let i = 0; p && i < 8; i++) {
                anc.push((p.className || '').toString().slice(0, 90));
                p = p.parentElement;
              }
              const href = a.getAttribute('href') || '';
              return {
                text: (a.textContent || '').trim().slice(0, 80),
                href: href.slice(0, 140),
                external: /^https?:\/\//i.test(href) && !/yuanbao\.tencent\.com/i.test(href),
                ancestors: anc,
              };
            });
          const refAll = Array.from(document.querySelectorAll('[class*="reference"]')).map((e) => e.outerHTML.slice(0, 6000));
          const sourceContainers = Array.from(document.querySelectorAll('[class*="source"]'))
            .slice(0, 5)
            .map((e) => e.outerHTML.slice(0, 4000));
          // 元宝引用列表展开后面板（真实来源在此）
          const refListContainers = Array.from(document.querySelectorAll('.hyc-common-markdown__ref-list'))
            .slice(0, 5)
            .map((e) => e.outerHTML.slice(0, 6000));
          return {
            ts: Date.now(),
            found: !!ref || !!srcWrap || document.querySelectorAll('.hyc-common-markdown__ref-list').length > 0,
            items: cnt,
            refHTML: ref ? ref.outerHTML.slice(0, 8000) : '',
            sourceContainers,
            refListContainers,
            docExtAnchors: extAnchors,
            refAllHTML: refAll,
          };
        }, (last?.items.length ?? 0))
        .catch((e) => ({ error: (e as Error).message }));
      const scanOut = { ts: Date.now(), attemptError: attemptErr, scan };
      const p = path.join(captureDir, 'sources-scan.json');
      fs.writeFileSync(p, JSON.stringify(scanOut, null, 2));
      log(`[信源诊断] 全量扫描已落盘：${path.relative(process.cwd(), p)}`);
    }
    // 优先用 API 拦截拿到的真实引用：元宝信源不在可见 DOM 文本里，全靠 chat/detail 响应的 docs 数组。
    const apiRefs = this.chatRefs.length ? this.chatRefs : this.detailRefs;
    if (apiRefs.length) {
      log(
        `[元宝信源] 经 API 拦截拿到 ${apiRefs.length} 条真实信源（chat=${this.chatRefs.length}/detail=${this.detailRefs.length}）`
      );
      const seen = new Set<string>();
      const items = apiRefs.filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      });
      return items.map((s) => ({ title: s.title, url: s.url, platform: this.derivePlatform(s.title, s.url) }));
    }

    if (!last) return null;

    // 校准落盘：信源区在但最终 0 条 → 抓现场
    if (last.found && last.items.length === 0 && captureDir) {
      const dump = await this.page
        .evaluate(() => {
          const ref = document.querySelector('[class*="reference"]');
          const srcWrap = document.querySelector('[class*="source"]');
          const extAnchors = Array.from(document.querySelectorAll('a[href^="http"]'))
            .slice(0, 10)
            .map((a) => {
              const anc: string[] = [];
              let p = a.parentElement;
              for (let i = 0; p && i < 6; i++) {
                anc.push((p.className || '').toString().slice(0, 90));
                p = p.parentElement;
              }
              return { text: (a.textContent || '').trim().slice(0, 60), href: (a.getAttribute('href') || '').slice(0, 90), ancestors: anc };
            });
          return {
            ts: Date.now(),
            refHTML: ref ? ref.outerHTML.slice(0, 8000) : '',
            sourceContainers: srcWrap ? [srcWrap.outerHTML.slice(0, 8000)] : [],
            docExtAnchors: extAnchors,
          };
        })
        .catch(() => null);
      if (dump) {
        const p = path.join(captureDir, 'sources-debug.json');
        fs.writeFileSync(p, JSON.stringify(dump, null, 2));
        log(`[信源诊断] 0 条现场已落盘：${path.relative(process.cwd(), p)}`);
      }
    }
    if (!last.found) return null;
    if (last.items.length === 0) return [];
    const seen = new Set<string>();
    const items = last.items.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
    return items.map((s) => ({ title: s.title, url: s.url, platform: s.platform ?? this.derivePlatform(s.title, s.url) }));
  }

  private derivePlatform(title?: string, url?: string): string | undefined {
    if (title) {
      const idx = Math.max(title.lastIndexOf('—'), title.lastIndexOf('–'), title.lastIndexOf('-'));
      if (idx > 0 && idx < title.length - 1) {
        const suffix = title.slice(idx + 1).trim();
        if (suffix.length > 0 && suffix.length <= 10) return suffix;
      }
    }
    if (url) {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }

  // 长屏截图（策略 A：clip 裁剪）。
  //   元宝回答形态复杂：可能是长文本（.hyc-common-markdown）、视频卡片（.ybc-chat-videoBoxV2-v3Card）
  //   或气泡卡片；且对话列表常带虚拟滚动 / content-visibility，导致回答容器量出来 0 高。策略：
  //   ① 多候选锚点（按真实高度择优，避开 0 尺寸占位项）；② 滚入视图；③ 强制可见并覆盖子树
  //     （!important 以压住可能带权重的 content-visibility:auto）；④ 隐藏问答块外浮层；
  //   ⑤ page.screenshot({ clip }) 按绝对坐标裁剪，不做可见性/稳定性检查。
  //   若主策略仍量不到，兜底裁剪「最后一条用户问题 → 对话列表底部」的对话区域（仍非整页）。
  //   ⚠️ evaluate 内一律内联，禁止具名/变量赋值函数（esbuild keepNames 注入 __name → 页面报错）。
  async captureQaScreenshot(outPath: string, mode: ScreenshotMode = 'expand'): Promise<void> {
    if (mode === 'stitch') {
      log('⚠️ 策略 B（滚动分段拼接）尚未实现，本次回退到策略 A（clip 裁剪）');
    }
    const page = this.page;
    const aiCands = [
      '.agent-chat__list__item--ai',
      '.agent-chat__bubble--ai',
      '[class*="videoBoxV2-v3Card"]', // 视频答案卡片（如「相关视频」）
      '.ybc-chat-videoBoxV2-v3Card',
      '.hyc-common-markdown', // 文本答案 markdown
      '.agent-chat__list__item__content',
    ];
    const fbCands = [
      '.agent-chat__list__content',
      '.agent-chat__list',
      '[class*="message"]',
      '.agent-dialogue__content--common__content',
    ];

    // 主策略：单次 evaluate 内选锚、滚入视图、强制可见、量取 clip（避免跨 evaluate 状态丢失）
    const main = await page
      .evaluate(
        (args: { ai: string[]; fb: string[] }) => {
          const st = document.createElement('style');
          st.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.head.appendChild(st);

          const docH0 = document.documentElement.scrollHeight;
          // ⚠️ 本 evaluate 全程匿名：esbuild keepNames 会给「具名 const 箭头/具名函数」注入 __name，
          //    浏览器页面无 __name → ReferenceError（已在线上踩坑：qa-shot-v3 eval-error）。
          //    故一律内联匿名回调，禁止 const setImportant/measureAll/forceVisible 这类定义。
          const measured: { sel: string; el: Element; h: number; w: number; sh: number; ch: number; cv: string }[] = [];
          args.ai.forEach((s) => {
            document.querySelectorAll(s).forEach((el) => {
              const r = el.getBoundingClientRect();
              measured.push({ sel: s, el, h: r.height, w: r.width, sh: (el as HTMLElement).scrollHeight, ch: (el as HTMLElement).clientHeight, cv: getComputedStyle(el).contentVisibility });
            });
          });
          const aiSummary = measured.map((x) => ({ sel: x.sel, h: Math.round(x.h), sh: x.sh, ch: x.ch, cv: x.cv }));

          measured.sort((x, y) => y.h - x.h);
          let best = measured[0] || null;
          let from = 'ai';
          if (!best || best.h < 8) {
            args.fb.forEach((s) => {
              document.querySelectorAll(s).forEach((el) => {
                const r = el.getBoundingClientRect();
                measured.push({ sel: s, el, h: r.height, w: r.width, sh: (el as HTMLElement).scrollHeight, ch: (el as HTMLElement).clientHeight, cv: getComputedStyle(el).contentVisibility });
              });
            });
            let fbBest: (typeof measured)[number] | null = null;
            measured.forEach((x) => {
              if (args.fb.includes(x.sel) && (!fbBest || x.h > fbBest.h)) fbBest = x;
            });
            if (fbBest && fbBest.h > best.h) {
              best = fbBest;
              from = 'fallback';
            }
          }
          if (!best || best.h < 8) {
            return { ok: false, reason: best ? 'zero-measure' : 'no-anchor', diag: { docH0, aiSummary, fbN: args.fb.length } };
          }

          const a = best.el as HTMLElement;
          // 滚入视图，让虚拟列表 / content-visibility 有渲染机会
          a.scrollIntoView({ block: 'center', inline: 'nearest' });

          // ① 强制可见：自身 + 祖先（!important 压住带权重的 content-visibility:auto）
          const chain: HTMLElement[] = [a];
          let pp: HTMLElement | null = a.parentElement;
          while (pp && pp !== document.documentElement) {
            chain.push(pp);
            pp = pp.parentElement;
          }
          chain.forEach((el) => {
            const cs = getComputedStyle(el);
            if (cs.contentVisibility && cs.contentVisibility !== 'visible') el.style.setProperty('content-visibility', 'visible', 'important');
            if (cs.visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
            if (cs.opacity === '0') el.style.setProperty('opacity', '1', 'important');
            if (cs.display === 'contents') el.style.setProperty('display', 'block', 'important');
            if (cs.display === 'none') el.style.setProperty('display', 'block', 'important');
            el.style.setProperty('max-height', 'none', 'important');
            el.style.setProperty('overflow', 'visible', 'important');
          });
          //    全部后代
          a.querySelectorAll('*').forEach((el) => {
            const he = el as HTMLElement;
            const cs = getComputedStyle(he);
            if (cs.contentVisibility && cs.contentVisibility !== 'visible') he.style.setProperty('content-visibility', 'visible', 'important');
            if (cs.visibility === 'hidden') he.style.setProperty('visibility', 'visible', 'important');
            if (cs.opacity === '0') he.style.setProperty('opacity', '1', 'important');
            if (cs.display === 'contents') he.style.setProperty('display', 'block', 'important');
            if (cs.display === 'none') he.style.setProperty('display', 'block', 'important');
            he.style.setProperty('max-height', 'none', 'important');
            he.style.setProperty('overflow', 'visible', 'important');
          });

          // ② 撑开所有「内容溢出」的裁剪容器（定高 / max-height / overflow 会把长回答截成一屏）
          //    迭代到稳定，让完整回答参与布局，才能量到真实全高。
          let changed = true;
          let guard = 0;
          let expandedN = 0;
          while (changed && guard++ < 30) {
            changed = false;
            let n: HTMLElement | null = a;
            while (n && n !== document.documentElement) {
              if (n.scrollHeight > n.clientHeight + 1) {
                n.style.setProperty('height', n.scrollHeight + 'px', 'important');
                n.style.setProperty('max-height', 'none', 'important');
                n.style.setProperty('overflow', 'visible', 'important');
                expandedN++;
                changed = true;
              }
              n = n.parentElement;
            }
            a.querySelectorAll('*').forEach((el) => {
              const he = el as HTMLElement;
              if (he.scrollHeight > he.clientHeight + 1) {
                he.style.setProperty('height', he.scrollHeight + 'px', 'important');
                he.style.setProperty('max-height', 'none', 'important');
                he.style.setProperty('overflow', 'visible', 'important');
                expandedN++;
                changed = true;
              }
            });
          }

          // 强制 reflow，确保新样式生效
          void a.offsetHeight;

          // ③ 隐藏问答块外 fixed/absolute/sticky 浮层。⚠️ 只隐藏「旁支浮层」：
          //    必须跳过锚点的后代（a.contains）与【祖先】（el.contains(a)）——
          //    聊天面板容器（SplitPane 等）常是 position:absolute，若把祖先也 display:none，
          //    整个回答块会变 0×0（线上 postH 1793→0 已踩坑，离线复刻确认）。
          document.querySelectorAll('*').forEach((el) => {
            if (a.contains(el) || el.contains(a)) return;
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') {
              (el as HTMLElement).style.setProperty('display', 'none', 'important');
            }
          });
          const selObj = window.getSelection();
          if (selObj) selObj.removeAllRanges();

          const r = a.getBoundingClientRect();
          // ④ 上边界抬到「最后一条用户问题」顶部：Q&A 块 = 问题 + 回答（当前锚点只是回答块）。
          //    若问题在回答上方且已渲染，就从问题顶部开始裁；否则退化为纯回答块。
          const topAbs = r.top + window.scrollY;
          const bottomAbs = r.bottom + window.scrollY;
          let clipTop = topAbs;
          const hCands = '.agent-chat__list__item--human, .agent-chat__bubble--human';
          const hAll = document.querySelectorAll(hCands);
          if (hAll.length) {
            const h = hAll[hAll.length - 1] as HTMLElement;
            const hr = h.getBoundingClientRect();
            if (hr.height > 4 && hr.top + window.scrollY < clipTop) {
              clipTop = hr.top + window.scrollY;
            }
          }
          // ⑤ 下边界 = 真实输入框（composer）顶部 - 8px：截取「用户问题 → 页面最底部输入框之前」的
          //    全部信息（AI 块 + 其后相关内容），但不把输入框截进来。
          //    ⚠️ 输入框必须位于【文档最底部】（下缘贴近 doc 底）才算，避免回答内容中部同名字段
          //       （chat-input/input-editor 等）把回答尾巴裁掉。优先校准过的 composer 结构：
          //       .agent-dialogue__content--common__input-box / [class*="__input-box"] / [class*="input-box"]。
          //    取贴底候选中 abs top 最小者（=输入框最上沿）。候选坐标全部进 diag 便于核对。
          const inputCands =
            '.agent-dialogue__content--common__input-box, [class*="__input-box"], [class*="input-box"], textarea, ' +
            '[contenteditable="true"], [class*="chat-input"], [class*="input-editor"], [class*="AgentInput"], [class*="composer"]';
          const inputList = document.querySelectorAll(inputCands);
          const docBottomAbs = document.documentElement.scrollHeight;
          const inputCandDiag: { cls: string; top: number; h: number; nearBottom: boolean }[] = [];
          let composerTopAbs: number | null = null;
          let composerEl: HTMLElement | null = null;
          for (let k = 0; k < inputList.length; k++) {
            const ip = inputList[k] as HTMLElement;
            const ir = ip.getBoundingClientRect();
            const inTop = ir.top + window.scrollY;
            const inBottom = ir.bottom + window.scrollY;
            const nearBottom = inBottom >= docBottomAbs - 80;
            if (ir.height > 8) {
              inputCandDiag.push({
                cls: (ip.className || '').toString().slice(0, 60) || ip.tagName,
                top: Math.round(inTop),
                h: Math.round(ir.height),
                nearBottom,
              });
            }
            if (ir.height > 8 && inTop >= clipTop - 1 && nearBottom) {
              if (composerTopAbs === null || inTop < composerTopAbs) {
                composerTopAbs = inTop;
                composerEl = ip; // 候选最外层（.agent-dialogue__content--common__input-box）
              }
            }
          }
          let finalBottomAbs =
            composerTopAbs !== null ? Math.max(composerTopAbs - 8, clipTop + 8) : bottomAbs;

          // ⑥ 隐藏 composer（输入框整块）以露出其上方的「操作栏/相关问题/下载提示」等元宝尾部信息。
          //    元宝「下载元宝电脑版」banner (agent-chat__conv--ai__promptHintV2--hint--main / download_hint__wrap)
          //    是独立元素，不在 composer 内部；藏 composer 不影响它。doc 收缩后 clip 底自动到 banner 处，
          //    信息全部进图，composer 完全排除。⚠️ 截图完本页就关/下一轮重建，无需恢复。
          let composerHidden = false;
          let newDocBottomAbs: number | null = null;
          if (composerEl) {
            composerEl.style.setProperty('display', 'none', 'important');
            composerHidden = true;
            void document.body.offsetHeight;
            newDocBottomAbs = document.documentElement.scrollHeight;
            const r2 = a.getBoundingClientRect();
            const anchorBottom2 = r2.bottom + window.scrollY;
            finalBottomAbs = Math.max(
              Math.min(newDocBottomAbs, Math.max(anchorBottom2, finalBottomAbs)),
              clipTop + 8
            );
          }
          return {
            ok: r.height >= 8 && r.width >= 8,
            reason: r.height >= 8 ? 'ok' : 'zero-after-expand',
            diag: {
              pickedSel: best.sel,
              pickedFrom: from,
              preH: Math.round(best.h),
              preW: Math.round(best.w),
              postH: Math.round(r.height),
              postW: Math.round(r.width),
              scrollY: Math.round(window.scrollY),
              docH0,
              docH1: document.documentElement.scrollHeight,
              expandedN,
              aiSummary,
              anchorTextLen: (a.innerText || '').length,
              anchorTextHead: (a.innerText || '').slice(0, 40),
              humanMergedTop: clipTop !== topAbs ? Math.round(clipTop) : null,
              humanCount: hAll.length,
              anchorBottomAbs: Math.round(bottomAbs),
              composerCapAbs: composerTopAbs !== null ? Math.round(composerTopAbs - 8) : null,
              composerHidden,
              newDocBottomAbs: newDocBottomAbs !== null ? Math.round(newDocBottomAbs) : null,
              inputCandDiag,
            },
            clip: { x: Math.round(r.left + window.scrollX), y: Math.round(clipTop), width: Math.round(r.width), height: Math.round(finalBottomAbs - clipTop) },
          };
        },
        { ai: aiCands, fb: fbCands }
      )
      .catch((e) => ({ ok: false, reason: 'eval-error', error: String(e) }));

    // 落盘诊断（平台私有）：写到截图旁的 .diag.json，不依赖服务 stdout，便于离线读取真实现场
    const diagPath = outPath.replace(/\.png$/, '.diag.json');
    try {
      fs.writeFileSync(diagPath, JSON.stringify({ version: 'qa-shot-v8-20260908', main }, null, 1));
    } catch {
      /* 诊断落盘失败不影响截图 */
    }

    let clip: { x: number; y: number; width: number; height: number } | null =
      (main as any).ok && (main as any).clip ? (main as any).clip : null;

    // 兜底 1：按「最后一条用户问题 → 对话列表底部」区域裁剪，仍属对话区域（非整页）
    if (!clip || clip.height < 8 || clip.width < 8) {
      const region = await page
        .evaluate(() => {
          const lastHuman =
            document.querySelector('.agent-chat__list__item--human, .agent-chat__bubble--human') as HTMLElement | null;
          const list = document.querySelector('.agent-chat__list, .agent-chat__list__content') as HTMLElement | null;
          if (!lastHuman || !list) return null;
          const rQ = lastHuman.getBoundingClientRect();
          const rL = list.getBoundingClientRect();
          const y = Math.min(rQ.top, rL.top) + window.scrollY;
          const h = rL.bottom - Math.min(rQ.top, rL.top);
          if (h < 8 || rL.width < 8) return null;
          return { x: Math.round(rL.left + window.scrollX), y: Math.round(y), width: Math.round(rL.width), height: Math.round(h) };
        })
        .catch(() => null);
      if (region) {
        // 仅 debug 打印：region 本身是兜底裁剪依据（clip = region），evaluate 不能跳过
        if (config.artifactMode === 'debug') log('📐 截图兜底区域（问题→列表底部）:', JSON.stringify(region));
        clip = region;
      }
    }

    if (!clip || clip.height < 8 || clip.width < 8) {
      throw new Error(`Q&A 块无有效渲染尺寸，无法裁剪截图（clip=${JSON.stringify(clip)}，主策略=${JSON.stringify(main)}）`);
    }

    await page.waitForTimeout(200);
    // ⚠️ 关键：page.screenshot({ clip }) 【不带 fullPage】时只会截到视口高度（长回答被截成一屏）。
    //   实测同一 clip：不带 fullPage → 1014x776；带 fullPage:true → 1014x4544（完整长图）。
    //   故长屏截图必须 fullPage:true + clip（仍按坐标裁剪，非整页兜底）。
    await page.screenshot({ path: outPath, clip, fullPage: true, animations: 'disabled', timeout: 60000 });
    const sz = fs.statSync(outPath).size;
    log(`✂️ Q&A 长屏截图完成（策略A clip 裁剪 + fullPage，${clip.width}x${clip.height}，${sz} bytes）`);
  }
}
