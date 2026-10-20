import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { log, warn, err, withLogScope } from '../log.js';
import fs from 'fs';
import path from 'path';
import { resolvePlatform, PlatformDef } from '../platforms/index.js';
import { probeElements } from './elementProbe.js';
import { DiagnosticResult, ElementDiagnosisItem, SourceInfo, ScreenshotMode } from '../types.js';
import { paths, config } from '../config/index.js';
import { CaptchaBlockedError, SendNotConfirmedError } from '../errors.js';
import { acquireIpForAccount, discardIp } from '../proxy/dpsProxy.js';
import { raiseWindow } from '../windowRaise.js';
import { chromeOptions, contextOptions, applyAntiDetect } from '../browser/launchProfile.js';

// 浏览器拉起串行（2026-10-16 用户定）：一个拉起完成后再拉起下一个，避免同时冲击代理与网络。
// 并发上限本身由调度器保证（≤ 平台数、同平台严格串行），这里只是把「拉起」这一步排成队列。
// 排队等待上限 60s：单个拉起卡死时不拖住后续任务（超时即不再排队，退化为并发拉起）。
let launchQueue: Promise<unknown> = Promise.resolve();
async function launchSerialized<T>(fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gate = Promise.race([
    launchQueue.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 60_000);
      timer.unref?.();
    }),
  ]);
  const mine = gate.then(fn);
  launchQueue = mine.then(() => undefined, () => undefined);
  try {
    return await mine;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * 代理层故障的错误特征：出口 IP 隧道建不起来 / 被代理拒绝。
 * 必须与「站点首屏慢」严格区分——前者对同一个 IP 重试毫无意义，只能换 IP。
 * （2026-10-16 实测：把 ERR_TUNNEL_CONNECTION_FAILED 当成「页面已渲染，继续后续流程」后，
 *   流程以 ELEMENT_NOT_FOUND 收场，并被上层误报成「登录态失效」，白挂两个正常账号。）
 */
const PROXY_ERR_RE =
  /net::ERR_(?:TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|PROXY_AUTH[A-Z_]*|MANDATORY_PROXY_CONFIGURATION_FAILED|SOCKS[A-Z_]*)/;

/** 出口 IP 不可用（代理层失败）→ 上抛以触发「解散该 IP + 换 IP 重试一次」 */
class IpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpUnavailableError';
  }
}

/**
 * 当前标签是否为浏览器「网络错误页」（而非站点页面）。
 * 为什么不能只看 URL 或内容长度：导航失败时 Playwright 仍保留目标 URL，错误页自身的 HTML 也很长
 * （远超任何「白屏」长度阈值）→ 两者都会把错误页误判成「已渲染」。唯一可靠判据是错误页自身的结构标记。
 */
async function isNetErrorPage(page: Page): Promise<boolean> {
  if (page.url().startsWith('chrome-error://')) return true;
  return await page
    .evaluate(() => {
      if (document.querySelector('#main-frame-error, .neterror')) return true;
      return (document.body?.className ?? '').includes('neterror');
    })
    .catch(() => false);
}

async function writeReport(root: string, r: DiagnosticResult, label: string): Promise<void> {
  const elRows = r.elementDiagnosis
    .map(
      (e) =>
        `<tr><td>${e.name}</td><td class="${e.found ? 'ok' : 'miss'}">${e.found ? '✓' : '✗'}</td><td>${e.tag ?? ''}</td><td><code>${e.selector ?? ''}</code></td></tr>`
    )
    .join('');
  const srcRows = r.sources
    ? r.sources
        .map(
          (s) =>
            `<li><a href="${s.url ?? '#'}" target="_blank">${s.title ?? s.url ?? '(无标题)'}</a>${
              s.platform ? ` <span class="miss">· 平台：${s.platform}</span>` : ''
            }</li>`
        )
        .join('')
    : '<li class="miss">未定位到信源区</li>';
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>诊断报告 ${r.timestamp}</title>
  <style>body{font-family:system-ui;margin:24px;color:#222}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}code{color:#c00}.miss{color:#c00}.ok{color:#0a0}pre{background:#f6f6f6;padding:12px;border-radius:6px;white-space:pre-wrap}</style></head>
  <body><h1>${label}采集诊断报告</h1>
  <p>时间：${r.timestamp} ｜ 平台：${r.platform} ｜ 登录墙：${r.loginRequired ? '是' : '否'}</p>
  <p>问题：<b>${r.question}</b></p>
  <h2>页面元素诊断</h2><table><tr><th>元素</th><th>找到</th><th>标签</th><th>Selector</th></tr>${elRows}</table>
  <h2>回复信息</h2><pre>${r.answerText ?? '（未定位到回答区域）'}</pre>
  <h2>信源信息（sourceCount=${r.sourceCount === null ? 'NULL' : r.sourceCount}）</h2><ul>${srcRows}</ul>
  <h2>备注</h2><ul>${r.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
  </body></html>`;
  fs.writeFileSync(path.join(root, 'report.html'), html);
}

export interface LaunchOpts {
  /** 显式指定 Chrome 可执行文件路径（优先于 GEO_CHROME_PATH 与系统 Chrome） */
  executablePath?: string;
  /** 目标平台 id（默认 doubao），见 src/platforms/index.ts 的 PLATFORMS */
  platform?: string;
  /** 覆盖平台默认入口 URL（便于指向具体聊天页） */
  url?: string;
  /** 长屏截图策略（各平台可自选实现；未实现 stitch 的平台会回退并打印警告） */
  screenshotMode?: ScreenshotMode;
  /**
   * 持久用户目录（登录 profile）。有值 → launchPersistentContext 复用真实登录会话；
   * 无值 → 临时匿名上下文（豆包会触发风控，见下）。
   *
   * ⚠️ 2026-08-31 实测：豆包匿名会话**发送即触发风控**，不登录无法提问。
   *    故 V1 阶段的正确用法是「人工登录一次 → 复用 profile 跑诊断」，
   *    匿名路径仅对尚不限制的平台（如文心）保留。
   */
  userDataDir?: string;
  /**
   * 检测到未登录时，等待人工在可见窗口内完成登录的毫秒数（0 = 不等待，直接记结论）。
   * 只在 userDataDir 存在时才有意义——匿名上下文关掉就丢，等了也白等。
   */
  waitLoginMs?: number;
  /** 代理（真实走代理出口，防风控）：server 形如 http://host:port 或 socks5://host:port */
  proxy?: { server: string; username?: string; password?: string };
  /** 出口模式=动态（按账号 ipMode 设置）：开浏览器前按「账号↔IP」绑定取出口 IP；失败回退到 proxy（静态/直连） */
  dynamic?: boolean;
  /** 台账账号 id：动态出口靠它复用「账号↔IP」绑定（同一账号在 IP 有效期内走同一出口） */
  accountId?: string;
}

export async function runDiagnostic(
  question: string,
  opts: LaunchOpts = {}
): Promise<DiagnosticResult> {
  return runDiagnosticInner(question, opts, false);
}

async function runDiagnosticInner(
  question: string,
  opts: LaunchOpts,
  retried: boolean
): Promise<DiagnosticResult> {
  const def: PlatformDef = resolvePlatform(opts.platform || 'doubao');
  // 日志作用域 = 模型名 · 关键词，本轮所有日志自动带此前缀
  return withLogScope(`${def.label}·${question}`, () =>
    runDiagnosticScoped(question, opts, retried, def)
  );
}

async function runDiagnosticScoped(
  question: string,
  opts: LaunchOpts,
  retried: boolean,
  def: PlatformDef
): Promise<DiagnosticResult> {
  const url = opts.url || def.defaultUrl;

  // 诊断产物开关：debug 才落盘截图/HAR/HTML 现场与诊断报告；生产（none）只产出交付物（05 产品图）与结构化结果。
  const dbg = config.artifactMode === 'debug';

  // 动态出口（按账号 ipMode=dynamic）：开浏览器前按「账号↔IP」绑定取得出口 IP——有绑定且未到期即复用，
  // 到期/无绑定则在本平台配额内并入或新建（见 proxy/dpsProxy.ts）。取不到回退传入的静态代理/直连，
  // 由账号释放路径记平台熔断，防本地 IP 连续裸奔。
  let proxy = opts.proxy;
  let usedDps = false;
  // 本次实际使用的动态 IP（用于「确认连不通」时精确解散这一枚，而不是连坐整个池）
  let dpsServer: string | null = null;
  // 代理层故障标记：出口 IP 连不通 → 解散该 IP 并换 IP 重试一次（见文件尾部的重试决策）
  let proxyFailure = false;
  let proxyFailureReason = '';
  if (opts.dynamic) {
    if (!opts.accountId) {
      warn('⚠️ [ip] 动态出口但调用方未提供账号 id，无法建立「账号↔IP」绑定 → 本轮按静态代理/直连处理');
    } else {
      const dps = await acquireIpForAccount(def.id, opts.accountId);
      if (dps) {
        proxy = dps;
        usedDps = true;
        dpsServer = dps.server;
        log(`🌐 [dps] 本次使用动态代理：${dps.server}`);
      } else {
        log(`⚠️ [dps] 取动态代理失败，回退到${opts.proxy ? '账号静态代理' : '直连'}`);
      }
    }
  }
  // 启动参数统一由 browser/launchProfile 提供：与登录窗口、登录态探测共用同一份，
  // 保证同一账号登录与采集时呈现同一台设备（窗口几何/channel/有头模式/自动化标记处理全部一致）。
  const launchOpts = chromeOptions(proxy, opts.executablePath);
  const stamp = ts(); // YYYY-MM-DD_HH-MM-SS（报告内时间字段）
  // 样本目录规则（2026-09-02 用户定）：diagnostics/<平台>/<日>/<时间点>-<查询名称>
  const [day, time] = stamp.split('_');
  const queryName =
    question.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 50) || '未命名';
  let root = path.join(paths.diagnosticsRoot, def.id, day, `${time}-${queryName}`);
  let seq = 2; // 同秒同名去重
  while (fs.existsSync(root)) {
    root = path.join(paths.diagnosticsRoot, def.id, day, `${time}-${queryName}-${seq}`);
    seq++;
  }
  const dirS = path.join(root, 'screenshot');
  const dirP = path.join(root, 'page');
  const dirN = path.join(root, 'network');
  [dirS, dirP, dirN].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  // 上下文选项与登录窗口共用（关闭视口模拟、禁止下载）；debug 模式额外录制 HAR
  const contextOpts: Parameters<Browser['newContext']>[0] = {
    ...contextOptions(),
    ...(dbg ? { recordHar: { path: path.join(dirN, 'network.har') } } : {}),
  };
  // 登录态：给了 profile 目录就走持久上下文（登录态落盘，下次复用）；否则仍是临时匿名上下文。
  // ⚠️ 两种模式共用的只有「上下文选项」，浏览器实例与关闭顺序不同，故分开建。
  // 拉起动作串行（同一时刻只拉起一个浏览器），避免 5 个平台同时拉起冲击代理/网络。
  const { browser, context } = await launchSerialized(
    async (): Promise<{ browser: Browser; context: BrowserContext }> => {
      if (opts.userDataDir) {
        const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
          ...launchOpts,
          ...contextOpts,
        });
        log(`👤 持久登录 profile：${path.resolve(opts.userDataDir)}（首次使用需人工登录一次）`);
        return { browser: ctx.browser() as Browser, context: ctx }; // 持久上下文自带浏览器实例，关闭时一起关
      }
      const b = await chromium.launch(launchOpts);
      return { browser: b, context: await b.newContext(contextOpts) };
    }
  );
  // 反自动化注入与登录窗口共用同一份（browser/launchProfile）
  await applyAntiDetect(context);
  // 持久上下文（launchPersistentContext，走台账/登录 profile 时）自带一个初始空白标签页，
  // 直接复用它，避免出现「一个 blank + 一个业务页」两个标签。
  const page: Page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  // 始终有头：恢复窗口并置前（Windows 上窗口可能最小化且不压其他应用；mac 原生就会置前，此处等价补强）
  await raiseWindow(browser, context, page);
  // 打印目录，便于排查「发送后弹出访达窗口」现象：对比访达标题栏路径是否与下面一致
  log(`📂 工作目录：${process.cwd()}`);
  log(`📂 本次样本库目录：${root}`);
  const adapter = def.create(page, context);

  const notes: string[] = [];
  let result: DiagnosticResult | null = null;
  // 防御：注册 filechooser 处理器本身就会拦截原生文件选择对话框（不再弹出系统窗口，避免遮挡/卡死）。
  // 若页面意外触发（如误点附件入口），仅记录，不做任何 setFiles，对话框已被接管。
  page.on('filechooser', () => {
    notes.push('ℹ️ 检测到页面触发了文件选择对话框，已自动接管（疑似误触附件入口），未选择任何文件。');
  });
  const capturedShots: string[] = [];
  let loginRequired = false;
  let answerText: string | null = null;
  let sources: SourceInfo[] | null = null;
  let elementDiagnosis: ElementDiagnosisItem[] = [];
  let qaOk = false;
  let beforeHtml = '';
  let finishedHtml = '';

  try {
    // 阶段1：打开页面 + 留 before 现场（尽早存盘，确保任何后续失败都有现场可查）
    try {
      // 聊天类网页持续保活连接(SSE/轮询/心跳)，networkidle 几乎永不触发，必须用 domcontentloaded
      // 导航容错：部分 SPA（如元宝门户）首屏资源持续加载会让 domcontentloaded 在 30s 内
      // 迟迟不触发，Playwright 报 net::ERR_TIMED_OUT，但正文往往已渲染。超时只要页面已离开
      // about:blank 空壳（已命中目标域），即视为已加载并继续，避免整轮卡在空白标签。
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
      } catch (ge) {
        const failMsg = (ge as Error).message ?? '';
        const firstLine = failMsg.split('\n')[0];
        // ① 代理层故障（出口 IP 隧道建不起来/被代理拒绝）：立即判「IP 不可用」并上抛，
        //    绝不能走下面的「重试 + 页面已渲染，继续后续流程」——那会把浏览器的网络错误页
        //    当成正常页面，最终以 ELEMENT_NOT_FOUND 收场并被上层误报成「登录态失效」。
        if (PROXY_ERR_RE.test(failMsg)) {
          proxyFailure = true;
          proxyFailureReason = firstLine;
          throw new IpUnavailableError(`出口 IP 连不通：${firstLine}`);
        }
        const curUrl = page.url();
        const isBlank = (await page.content().catch(() => '')).trim().length < 60;
        const targetHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        if (isBlank && !(targetHost && curUrl.includes(targetHost))) {
          // 真·白屏/未命中目标域：可能是站点瞬时慢（首屏资源持续加载），重试一次再判失败，
          // 避免偶发网络慢导致整轮卡在 about:blank 空标签。
          log('⚠️ 导航超时且页面仍空白，等待 3s 重试一次…');
          await page.waitForTimeout(3000);
          await page
            .goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs * 1.5 })
            .catch(() => {});
          await page.waitForTimeout(2000);
          const curUrl2 = page.url();
          const blank2 = (await page.content().catch(() => '')).trim().length < 60;
          // ② 重试后落到浏览器的网络错误页 → 同样按失败处理。URL 与内容长度都判不出来
          //    （导航失败时 URL 仍是目标站、错误页 HTML 也很长），必须查错误页自身的结构标记；
          //    否则「重试成功」的假象会继续往下走（2026-10-16 实测就是这么误报的）。
          if (await isNetErrorPage(page)) {
            proxyFailure = true;
            proxyFailureReason = firstLine;
            throw new IpUnavailableError(`导航落到浏览器网络错误页：${firstLine}`);
          }
          if (blank2 && !(targetHost && curUrl2.includes(targetHost))) {
            throw ge; // 重试仍白屏 → 保留「打开页面失败」语义
          }
          notes.push(`⚠️ 导航首超时但重试成功（${failMsg}），页面已渲染，继续后续流程。`);
        } else {
          // ③ 页面已离开空白且命中目标域，但整页仍可能就是一个错误页（内容长度不可信）→ 仍需排除
          if (await isNetErrorPage(page)) {
            proxyFailure = true;
            proxyFailureReason = firstLine;
            throw new IpUnavailableError(`导航落到浏览器网络错误页：${firstLine}`);
          }
          notes.push(`⚠️ 导航未在 30s 内稳定（${failMsg}），但页面已渲染，继续后续流程。`);
        }
      }
      // 平台降级页恢复（可选钩子）：豆包等在服务端限流/会话异常时首屏直接是降级页
      // （「该页面暂时不可用」+「刷新页面」），输入框永不出现、提交必被拒 → 先自动恢复再往下走。
      if (adapter.recoverPage) {
        try {
          await adapter.recoverPage();
        } catch (e) {
          notes.push(`页面恢复钩子异常：${(e as Error).message}`);
        }
      }
      // 等首屏「就绪」再进 checkLogin：① 平台专属输入框（def.selectors.input，已校准平台精确匹配）；
      // ② 通用输入框兜底（textarea/input/contenteditable）——SPA 水合登录态后渲染出的真实输入框，
      //    不依赖平台候选选择器，避免未校准平台（元宝初版）因占位选择器匹配不到而漏等；
      // ③ 登录入口出现，才算页面加载到位。避免 SPA 壳页瞬间（输入框/登录钮都还没渲染）就误判为「需登录」。
      const readySel = [
        ...def.selectors.input,
        'textarea', 'input', '[contenteditable="true"]',
        'a:has-text("登录")', 'button:has-text("登录")',
      ].join(', ');
      await page
        .waitForSelector(readySel, { timeout: 20000 })
        .catch(() => {});

      // —— 登录态平台：等 SPA 从持久化 cookie 水合登录态 ——
      // 文心（及部分 SPA）首屏会闪现未登录遮罩 `.chat-aside-user-mask.unlogin`，需等其消失才算登录态。
      // 若不等待：首屏以未登录渲染，且 SPA 不会自动重新应用 cookie 登录态 → 整轮问答会话落在未登录态，
      // 已登录账号被白白浪费（实测「测试文心」全程 unlogin，前/后 HTML 均无昵称）。
      // 该缺陷此前藏在 openProbe（登录校验）里——它有 8s 水合等待，但 runDiagnostic（实际问答/信源分析
      // 路径）漏了。非文心平台无该选择器 → querySelector 返回 null → 瞬时通过，零成本。
      if (opts.userDataDir) {
        const waitHydrate = (tag: string): Promise<void> =>
          page
            .waitForFunction(
              () => {
                const m = document.querySelector('.chat-aside-user-mask.unlogin');
                return !m || !(m as HTMLElement).offsetParent;
              },
              { timeout: 8000 }
            )
            .then(() => log(`👤 [${tag}] 登录态水合完成`))
            .catch(() => log(`👤 [${tag}] 登录态水合超时（继续）`));
        await waitHydrate('登录态水合');
        // 超时仍处未登录遮罩 → 重新加载，强制 SPA 重新从 cookie 初始化登录态（首屏未登录加载后不会自动重 hydrate）
        const stillUnlogin = await page
          .evaluate(() => {
            const m = document.querySelector('.chat-aside-user-mask.unlogin');
            return !!m && !!(m as HTMLElement).offsetParent;
          })
          .catch(() => false);
        if (stillUnlogin) {
          log('👤 水合超时仍处未登录，重新加载页面以重新初始化登录态…');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
          await page.waitForTimeout(1500);
          await waitHydrate('重载后水合');
        }
      }

      await page.waitForTimeout(1500);
      if (dbg) {
        await page.screenshot({ path: path.join(dirS, '01-before.png') });
        capturedShots.push('01-before.png');
        beforeHtml = await page.content();
        fs.writeFileSync(path.join(dirP, 'before.html'), beforeHtml);
      }
    } catch (e) {
      notes.push(`❌ 打开页面失败：${(e as Error).message}`);
    }

    try {
      loginRequired = await adapter.checkLogin();
      // 走动态代理后 SPA 水合慢：首查时输入框可能尚未渲染 → 误判「需登录」。
      // 给一个解冻窗口（navTimeoutMs）等输入框出现，出现即视为误判，按已登录继续。
      if (loginRequired) {
        const hydratedLate = await page
          .waitForSelector('textarea, input, [contenteditable="true"]', { timeout: config.navTimeoutMs })
          .then(() => true)
          .catch(() => false);
        if (hydratedLate) {
          loginRequired = false;
          log('⚠️ 首查未见输入框（页面水合慢），等待后已出现 → 视为已登录继续');
        }
      }
      // 不再用账号昵称探测兜底（2026-09-23 按用户要求简化，不抽取昵称）。
      // 注意取舍：文心等无登录墙平台的 checkLogin 恒 false，无法区分「真登录」与「磁盘无登录态」；
      // 该场景由 confirmLogin 里的会话级 cookie 转持久兜底。

      // 未登录且允许等待 → 停在可见窗口等人工登录（浏览器不关，用户直接操作即可）。
      // 轮询「是否已出现输入框」作为登录成功的判定，与平台登录方式（短信/扫码/第三方）无关。
      if (loginRequired && opts.waitLoginMs && opts.waitLoginMs > 0 && opts.userDataDir) {
        const deadline = Date.now() + opts.waitLoginMs;
        // 需要人工操作 → 再确保一次窗口不是最小化且在最上层（Windows 上可能被别的窗口压住）
        await raiseWindow(browser, context, page);
        log(
          `\n🔑 请在弹出的浏览器窗口中手动登录「${def.label}」（最多等待 ${Math.round(opts.waitLoginMs / 1000)}s）…\n` +
            `   登录完成后无需任何操作，本程序会自动继续。\n`
        );
        let loggedAt = 0;
        while (Date.now() < deadline) {
          await page.waitForTimeout(3000);
          if (!(await adapter.checkLogin().catch(() => true))) {
            loggedAt = Date.now();
            break;
          }
        }
        if (loggedAt) {
          loginRequired = false;
          log('✅ 登录已生效，等待页面稳定后继续诊断');
          // 登录后页面通常会跳转/刷新 → 回到目标聊天页，再补一份「已登录」的 before 现场
          await page.waitForTimeout(2000);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
          await page
            .waitForSelector('textarea, input, [contenteditable="true"]', { timeout: 20000 })
            .catch(() => {});
          await page.waitForTimeout(2500);
          if (dbg) {
            await page.screenshot({ path: path.join(dirS, '01-before.png') });
            beforeHtml = await page.content();
            fs.writeFileSync(path.join(dirP, 'before.html'), beforeHtml);
          }
        } else {
          notes.push(
            `⚠️ 等待人工登录超时（${Math.round(opts.waitLoginMs / 1000)}s），本次按未登录继续。`
          );
        }
      }

      if (loginRequired)
        notes.push(
          opts.userDataDir
            ? '⚠️ 仍未检测到登录态（未找到输入框/出现登录入口）。请加 --wait-login 后重跑并在窗口内完成登录。'
            : '⚠️ 检测到可能需要登录（未找到输入框/出现登录入口）。匿名路径不可行，请加 --profile 走登录 profile。'
        );
    } catch (e) {
      notes.push(`登录检测异常：${(e as Error).message}`);
    }

    // 阶段1.5：关闭平台自带干扰弹层（首页引导/营销广告/活动浮层等）。
    // 由各平台私有实现 dismissAds()（页面结构私有，不假通用）。在定位输入框之前调用，
    // 避免弹层挡住后续交互。无实现（豆包等）则跳过。
    try {
      if (adapter.dismissAds) {
        const dismissed = await adapter.dismissAds();
        if (dismissed) notes.push('🛡️ 已自动关闭平台首页弹窗/广告。');
        await page.waitForTimeout(800); // 等关闭动画/重排稳定
      }
    } catch (e) {
      notes.push(`关闭弹窗异常（不影响后续）：${(e as Error).message}`);
    }

    // 阶段2：交互流程（独立容错，失败不中断，仍产出报告）
    let asked = false;
    try {
      await adapter.sendQuestion(question);
      asked = true;

      // 阶段2.5：滑动验证（千问等平台发送后可能弹风控滑块）。平台私有实现 solveCaptcha()，
      // 在等待回答之前处理，避免滑块挡住回答。自动不过则进入「等待人工滑动」模式（run 不卡死）。
      try {
        if (adapter.solveCaptcha) {
          // 「刷新重开」回调：用户 2026-09-02 实操经验——连滑失败后刷新页面重开，一次基本能过。
          // ⚠️ 刷新会丢掉已输入的问题，所以重开 = 重新导航 + 重发问题。
          //    重发是编排职责（只有 run.ts 知道目标 URL 与问题文本），故在此提供；
          //    适配器仍然只负责滑块本身（平台操作私有）。
          const restart = async (): Promise<void> => {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
            const readySel = [
              ...def.selectors.input,
              'a:has-text("登录")',
              'button:has-text("登录")',
            ].join(', ');
            await page.waitForSelector(readySel, { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await adapter.sendQuestion(question);
          };
          const solved = await adapter.solveCaptcha(root, restart);
          if (solved) notes.push('🔓 已自动/人工通过滑动验证。');
        }
      } catch (e) {
        notes.push(`滑动验证处理异常（不影响后续）：${(e as Error).message}`);
      }

      if (dbg) {
        await page.screenshot({ path: path.join(dirS, '02-question.png') });
        capturedShots.push('02-question.png');
      }
      // 03 截图前等「回答开始渲染」：元素驱动（平台声明的回答容器 / 加载胶囊出现），替代固定 1.5s——
      // 不同问题思考时间不同，固定时间会不适配。最多轮询 15 次（整体保护）后仍没开始就截现状。
      // ⚠️ 仅调试模式执行（2026-10-16 修）：这段等待的唯一作用是给下面的 03-answering.png 选时机；
      //   生产模式（artifactMode=none）不落 01~04 截图，它就成了纯耗时。且原判据写死了文心专属类
      //   （.chat-search-answer-generate/.answer-box），千问等平台永不命中 → 每轮白等满 15×1s。
      //   实测（10-16 千问日志）：captcha 结束 → waitForAnswer 开始之间恒为 15s，而 waitForAnswer
      //   自身只用 2s 就发现「回答早已输出完」——即答案结束后脚本还在空等。
      if (dbg) {
        const answerReadySel = def.selectors.answerContainer.join(', ');
        for (let i = 0; i < 15; i++) {
          const started = await page
            .evaluate((sel) => {
              const cap = document.querySelector('[class*="capsule-loading"]');
              if (cap && (cap as HTMLElement).getBoundingClientRect().width > 0) return true;
              const core = document.querySelector(sel);
              return core ? (core.textContent || '').length > 20 : false;
            }, answerReadySel)
            .catch(() => false);
          if (started) break;
          await page.waitForTimeout(1000);
        }
        await page.screenshot({ path: path.join(dirS, '03-answering.png') });
        capturedShots.push('03-answering.png');
      }

      // 豆包等无文字级"生成结束"标志的平台：生成中途落盘一份 DOM，用于定标结束标志
      await adapter.waitForAnswer(config.answerTimeoutMs, dbg ? path.join(root, 'page', 'answering.html') : undefined, question);
      if (dbg) {
        await page.screenshot({ path: path.join(dirS, '04-finished.png') });
        capturedShots.push('04-finished.png');
      }
    } catch (e) {
      // 本轮无法完成的失败（如验证码用尽）直接上抛终止，不走抽取
      if (e instanceof CaptchaBlockedError) throw e;
      if (e instanceof SendNotConfirmedError) {
        // 提问未被页面接受（慢链路）→ 如实记一条并跳过后续抽取，**不要**混进「元素未定位」那类文案。
        //   asked 保持 false：不再白等 waitForAnswer、不再产出「未定位到回答区域」等误导性 note
        //   （那些 note 会把提交/加载问题带偏成"选择器失效"）。
        // 走完 sendQuestion 说明输入框已存在且文本已录入 → 不可能是登录墙，清掉可能的慢水合误判，
        //   避免上层把它报成「登录态失效，请退出登录后重新登录」（2026-10-16 用户要求如实归因）。
        loginRequired = false;
        notes.push(`⚠️ 提问未被页面接受：${(e as Error).message}`);
      } else {
        notes.push(`⚠️ 交互流程中断（多为元素未定位）：${(e as Error).message}`);
      }
    }

    if (asked) {
      try {
        answerText = await adapter.getAnswer();
        if (answerText === null)
          notes.push('未定位到回答区域（answerContainer 候选均不匹配）→ 需人工在 finished.html 中确认结构。');
      } catch (e) {
        notes.push(`抽取回答异常：${(e as Error).message}`);
      }
      // 拿到真实答案 = 登录态必然有效（匿名路径无输入框可发问）。
      // 早前慢水合期的 checkLogin 误判在此推翻，避免完整成功结果被「登录态失效」作废。
      if (answerText) loginRequired = false;

      // 关键交付物：真实页面的「问题 + 完整问答」长屏截图。
      // 截图放在「展开信源」之前 → 信源保持折叠态即可，无需为截图特意展开。
      //
      // ⚠️ 截图实现**不共用**（2026-08-31 用户定）：各平台页面结构与渲染技巧差异极大，
      //    统一实现必然要引用平台专属元素名（气泡/内容根…）→ 与其假通用，不如各平台
      //    Adapter 自己实现 `captureQaScreenshot(outPath, mode)` 并自己演进；
      //    本层只做编排：何时截、输出到哪、失败兜底。诊断日志在实现内部打印。
      //    **2026-09-03 17:47 用户定：截图失败/未实现 → 不整页兜底（不许截当前屏），
      //    本轮无 Q&A 截图（留空）**。成功判定 = 文件存在且 >3KB。
      const outPath = path.join(dirS, '05-qa-block.png');
      if (typeof adapter.captureQaScreenshot === 'function') {
        try {
          await adapter.captureQaScreenshot(outPath, opts.screenshotMode || 'expand');
        } catch (e) {
          notes.push(`Q&A 块截图异常：${(e as Error).message}（按要求不整页兜底）`);
        }
        try {
          const st = fs.statSync(outPath);
          if (st.size > 3000) {
            qaOk = true;
            capturedShots.push('05-qa-block.png');
          } else {
            fs.rmSync(outPath, { force: true });
            notes.push('⚠️ Q&A 截图未产出有效图（按要求不整页兜底），本轮无 Q&A 截图');
          }
        } catch {
          notes.push('⚠️ Q&A 截图未产出文件（按要求不整页兜底），本轮无 Q&A 截图');
        }
      } else {
        notes.push(
          `⚠️ 平台「${def.label}」尚未实现 captureQaScreenshot（按要求不整页兜底），本轮无 Q&A 截图`
        );
      }

      try {
        await adapter.expandSources();
      } catch (e) {
        notes.push(`展开信源异常：${(e as Error).message}`);
      }
      try {
        sources = await adapter.getSources(root);
        if (sources === null)
          notes.push('未定位到信源区域（sourceArea 候选均不匹配）→ 匿名路径可能不展示信源，或需登录。');
      } catch (e) {
        notes.push(`抽取信源异常：${(e as Error).message}`);
      }
    } else {
      notes.push('未成功发送问题，跳过回答/信源抽取。请检查 sendButton 候选 selector。');
    }

    if (dbg) {
      finishedHtml = (await page.content().catch(() => beforeHtml)) || beforeHtml;
      fs.writeFileSync(path.join(dirP, 'finished.html'), finishedHtml); // 现场留档（诊断用，非截图来源）
    }

    try {
      elementDiagnosis = await probeElements(page, def.selectors);
    } catch (e) {
      notes.push(`元素诊断异常：${(e as Error).message}`);
    }

    // 出口 IP 中途失效：导航成功、问答途中隧道断掉 → 页面被浏览器替换成网络错误页。
    // 放在这里覆盖「ask 之后才发现连不通」的场景；只针对没拿到答案的轮次，避免误伤正常结果。
    if (usedDps && !answerText && !proxyFailure && (await isNetErrorPage(page))) {
      proxyFailure = true;
      proxyFailureReason = '页面在流程中被浏览器替换为网络错误页';
      throw new IpUnavailableError(proxyFailureReason);
    }

    // 阶段3：始终产出报告（即使中途失败也留现场 + 元素诊断）
    result = {
      platform: def.id,
      url,
      question,
      timestamp: stamp,
      loginRequired,
      usedDps,
      answerText,
      sources,
      sourceCount: sources === null ? null : sources.length,
      elementDiagnosis,
      sampleDir: root,
      artifacts: {
        screenshots: capturedShots.map((f) => `screenshot/${f}`),
        qaScreenshot: qaOk ? 'screenshot/05-qa-block.png' : undefined,
        beforeHtml: dbg ? 'page/before.html' : undefined,
        finishedHtml: dbg ? 'page/finished.html' : undefined,
        har: dbg ? 'network/network.har' : undefined,
        reportHtml: dbg ? 'report.html' : undefined,
      },
      notes,
    };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    if (dbg) await writeReport(root, result, def.label);
    log(`✅ 诊断完成（部分失败也会留现场），样本库：${path.relative(process.cwd(), root)}`);
  } catch (e) {
    notes.push(`❌ 诊断异常：${(e as Error).message}`);
    err('诊断异常：', (e as Error).message);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  notes.forEach((n) => log(n));

  // 代理层故障优先处理：出口 IP 连不通时「同 IP 重试」毫无意义（那枚 IP 已经死了）。
  // 先解散它（discardIp）再重试 —— 重试时 acquireIpForAccount 找不到绑定，就会并入/取到新 IP。
  if (proxyFailure && usedDps && !retried && dpsServer) {
    await discardIp(dpsServer);
    log(`⚠️ [dps] 出口 IP 连不通（${proxyFailureReason}）→ 已解散该 IP 的全部绑定，换 IP 重试一次`);
    return runDiagnosticInner(question, opts, true);
  }

  if (!result) {
    if (usedDps && !retried) {
      // 不换 IP：出口由「账号↔IP」绑定决定，且本轮失败与 IP 无关（页面/网络瞬断）→ 同 IP 重开一次。
      log('⚠️ [dps] 任务未完成，同 IP 重试一次');
      return runDiagnosticInner(question, opts, true);
    }
    throw new Error(notes.filter((n) => n.includes('❌')).join('；') || '诊断未完成');
  }
  return result;
}
