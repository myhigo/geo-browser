// 平台登录账号管理（2026-09-03 用户定稿；2026-09-25 存储层对齐 geo-ui-browser）：
//  - 不同平台登录各自驱动，互不混用；纯人工扫码/验证码，不导入 cookie。
//  - 每个账号 = 固定 id + 专属目录（.profiles/<platform>-<n>）+ 台账记录，id→dir 唯一映射，
//    登录/退出/问答全程按 accountId 操作，绝不猜默认目录 → 多账号信息不串。
//  - 台账：accountRepo()（file=.profiles/<platform>.accounts.json / mysql=geo_ui_platform_account）。
//  - 问答侧：allocateAccount() 挑号（只挑 active+enabled、冷却/禁用排除）→ 执行 → releaseAccount() 回写。
//  - 不抽昵称（2026-09-23 用户定版）：登录态以「磁盘可还原」为准，页面只留备注。
//  - 本地 Chrome 版：登录/测试窗口直接开本机系统 Chrome（channel:'chrome'），无 noVNC/iframe。

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { resolvePlatform } from '../platforms/index.js';
import { accountRepo, Account, accountDirOf } from '../storage/accountRepo.js';
import { proxyRepo, isDirectIp } from '../storage/proxyRepo.js';
import { paths, config } from '../config/index.js';
import { raiseWindow } from '../windowRaise.js';

/** 传给 Playwright 的代理选项（直连/不存在/未启用 → undefined 表示不注入） */
export type ProxyOpts = { server: string; username?: string; password?: string; bypass?: string };

/** 按账号对象解析采集代理：仅 static 走绑定静态代理；local 直连；dynamic 由采集层（server.ts）截留走快代理。
 *  以 ipMode 为准，不再按 proxyId 隐式判定——未配置视为 local（直连） */
export async function proxyOfAccount(acc: Account): Promise<ProxyOpts | undefined> {
  if (acc.ipMode !== 'static') return undefined; // local/dynamic 不在此解析
  if (acc.proxyId == null) return undefined;
  return proxyOfId(acc.proxyId);
}

/** 按 proxyId 解析代理：直连 / 不存在 / 未启用 → undefined（不注入） */
export async function proxyOfId(proxyId: number): Promise<ProxyOpts | undefined> {
  const ip = await proxyRepo().get(proxyId);
  if (!ip || ip.enabled === false || isDirectIp(ip)) return undefined;
  const server = (ip.protocol === 'socks5' ? 'socks5://' : 'http://') + ip.host + ':' + ip.port;
  return { server, username: ip.username, password: ip.password };
}

/** 按平台 + 账号 id 解析代理（execute 等仅有 accountId 时方便调用） */
export async function proxyOf(platformId: string, accountId: string): Promise<ProxyOpts | undefined> {
  const acc = await accountRepo().get(platformId, accountId);
  return acc ? proxyOfAccount(acc) : undefined;
}

/** 改账号关联代理：proxyId 传 undefined → 回到本地IP（直连） */
export async function assignProxy(
  platformId: string,
  accountId: string,
  proxyId?: number
): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
  await accountRepo().patch(platformId, accountId, { proxyId });
  const label =
    proxyId == null
      ? '本地IP（直连）'
      : (await proxyRepo().get(proxyId))?.note || (await proxyRepo().get(proxyId))?.host || String(proxyId);
  return { ok: true, msg: `已关联代理：${label}（更改后需重新登录/重开窗口才生效）` };
}

export interface PlatformLoginDriver {
  platformId: string;
  label: string;
  loginRequired: true;
  loginWaitMs?: number;
  hint?: string;
  /** 登录凭证 cookie 特征（正则匹配 cookie 名）：有匹配 = 已登录。
   *  注意：匿名追踪/会话 cookie（ttwid/bd_sso/csrf/ds_session 等）未登录时也存在，绝不能命中。 */
  loginCookiePattern?: RegExp;
  /** 登录凭证 localStorage 键：存在且值非空 = 已登录。
   *  字符串 = 键存在且字符串值非空；{ key, jsonPath } = 键存在且 JSON.parse 后 jsonPath 字段值非空。
   *  （DeepSeek 的 userToken 未登录时键也在，值是 {"value":null}，必须解析后看 value 字段） */
  loginStorageKeys?: (string | { key: string; jsonPath?: string })[];
}

export const LOGIN_DRIVERS: Record<string, PlatformLoginDriver> = {
  doubao: {
    platformId: 'doubao',
    label: '豆包',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '在自动打开的浏览器窗口完成登录，完成后点击「我已登录完成，验证」',
    // 豆包（字节系）：登录态载体是 sessionid / sid_tt / uid_tt / sso_uid_tt 等。
    // 未登录只有 ttwid/passport_csrf_token/bd_sso_hi3jfd/s_v_web_id 等匿名追踪，不命中。
    loginCookiePattern: /sessionid|sid_tt|uid_tt|sso_uid_tt|passport_sso/i,
  },
  deepseek: {
    platformId: 'deepseek',
    label: 'DeepSeek',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '在自动打开的浏览器窗口完成登录，完成后点击「我已登录完成，验证」',
    // DeepSeek：登录凭证不在 cookie（ds_session_id/deepseek_session 未登录时也存在，不能作为判据），
    // 在 localStorage 的 userToken，但未登录时键也在（{"value":null}）→ 必须解析 value 字段非空才算已登录
    loginStorageKeys: [{ key: 'userToken', jsonPath: 'value' }],
  },
  qwen: {
    platformId: 'qwen',
    label: '千问',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '在自动打开的浏览器窗口完成登录，完成后点击「我已登录完成，验证」',
    // 千问（通义系）：登录凭证 cookie 是 tongyi_sso_ticket / tongyi_sso_ticket_hash（登录后实测，httpOnly 持久）。
    // 未登录时不存在（未登录仅有 XSRF-TOKEN/cna/UM_distinctid 等匿名 cookie）。
    loginCookiePattern: /tongyi_sso_ticket/i,
  },
  wenxiaoyan: {
    platformId: 'wenxiaoyan',
    label: '百度文心',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '在自动打开的浏览器窗口完成登录，完成后点击「我已登录完成，验证」',
    // 文心（百度系）：BDUSS/STOKEN/PTOKEN/UBID/passid（历史实测登录凭证）
    loginCookiePattern: /bduss|stoken|ptoken|ubid|passid|login_ticket/i,
  },
  hunyuan: {
    platformId: 'hunyuan',
    label: '腾讯元宝',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '在自动打开的浏览器窗口完成登录，完成后点击「我已登录完成，验证」',
    // 元宝（腾讯系）：登录凭证 cookie 是 hy_token（httpOnly，登录后实测）+ hy_user 用户标识。
    // 未登录仅有 _qimei_*/_ga 等匿名 cookie，不命中。
    loginCookiePattern: /hy_token/i,
  },
};

const dirOf = (platformId: string, seq: number): string => accountDirOf(`${platformId}-${seq}`);
const nextSeqOf = (platformId: string, accounts: Account[]): number => {
  let max = 0;
  for (const a of accounts) {
    const m = /-(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
};

/** 本地日期 YYYY-MM-DD（按用户所在时区，不是 UTC） */
const todayStr = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export interface PlatformView {
  platformId: string;
  label: string;
  hint?: string;
  accounts: Account[];
}

export async function listViews(): Promise<PlatformView[]> {
  const today = todayStr();
  const out: PlatformView[] = [];
  for (const d of Object.values(LOGIN_DRIVERS)) {
    out.push({
      platformId: d.platformId,
      label: d.label,
      hint: d.hint,
      // 跨天惰性归零：queryDate 不是今天 → 显示 0（今天还没查过，昨天的次数作废）
      accounts: (await accountRepo().list(d.platformId)).map((a) => ({
        ...a,
        todayQueries: a.queryDate === today ? (a.todayQueries ?? 0) : 0,
      })),
    });
  }
  return out;
}

/** 改备注（2026-09-25 字段 alias→remark，与 geo-ui-browser 对齐） */
export async function updateRemark(platformId: string, accountId: string, remark: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await accountRepo().patch(platformId, accountId, { remark }))) return { ok: false, msg: '账号不存在' };
  return { ok: true, msg: '备注已更新' };
}

/** 启停账号：停用后不参与挑号（已占用的任务跑完为止） */
export async function setAccountEnabled(
  platformId: string,
  accountId: string,
  enabled: boolean
): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  await accountRepo().patch(platformId, accountId, { enabled, note: undefined });
  return { ok: true, msg: `${accountId} 已${enabled ? '启用' : '停用'}` };
}

/** 删除整个账号（清目录 + 台账移除） */
export async function deleteAccount(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (isAccountBusy(accountId) || testSessions.has(testKey(platformId, accountId)))
    return { ok: false, msg: '该账号正在使用中（采集中或测试窗口打开），请先关闭测试窗口后再删' };
  fs.rmSync(acc.dir, { recursive: true, force: true });
  await accountRepo().remove(platformId, accountId);
  return { ok: true, msg: `已删除账号 ${accountId}` };
}

/** 退出登录（清掉磁盘会话 + 关闭仍打开的登录窗口；台账保留、其他账号不受影响） */
export async function logoutAccount(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (isAccountBusy(accountId) || testSessions.has(testKey(platformId, accountId)))
    return { ok: false, msg: '该账号正在使用中（采集中或测试窗口打开），请先关闭测试窗口后再退出' };
  // ⚠️ 登录制平台用持久上下文：仅改台账状态不够——
  //   · 若登录窗口仍开着（status=waiting：用户点了「登录」却还没点「验证」），必须取消登录并关窗，
  //     否则窗口内内存会话会继续显示「已登录对话界面 + 用户信息」，看起来像没退出。
  if (activeLogin && activeLogin.platformId === platformId && activeLogin.accountId === accountId) {
    activeLogin.confirm(false);                       // 解除 startLogin 的等待，使其走 finally 收尾
    activeLogin.context.close().catch(() => {});
    activeLogin = null;
  }
  fs.rmSync(acc.dir, { recursive: true, force: true });
  await accountRepo().patch(platformId, accountId, { status: 'none', note: undefined, lastUsedAt: undefined });
  return { ok: true, msg: `已退出 ${accountId}，登录态已清除` };
}

// ---------- 问答侧：挑号与回写 ----------
const inFlight = new Set<string>(); // 正在使用的账号（防同号并发）

/** (平台,IP) 冷却表：key = "platform:ip" → 冷却到期时间戳。ip = 实际出口（local 127.0.0.1 / static 代理 host）。
 *  dynamic 正常用每次新取的 DPS IP，不进出口冷却；仅回退直连时走独立键 DYN_FALLBACK，与 local 的 127.0.0.1 分开，
 *  避免本地账号跑完冷却把动态账号一起挡住。 */
const coolMap = new Map<string, number>();
const coolKey = (platform: string, ip: string): string => `${platform}:${ip}`;
/** dynamic 回退直连专用冷却键（与 local 的 127.0.0.1 分离）：读侧 dynamic 只查此键，防连续回退直连（零容忍）。 */
const DYN_FALLBACK = 'dyn-fallback';

/** (平台,IP) 是否在冷却中 */
export function isCooling(platform: string, ip: string): boolean {
  const until = coolMap.get(coolKey(platform, ip));
  return until !== undefined && until > Date.now();
}

/** (平台,IP) 冷却剩余秒数 */
export function cooldownRemainingSec(platform: string, ip: string): number {
  const until = coolMap.get(coolKey(platform, ip));
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** 标记 (平台,IP) 进入冷却（账号使用完成后调用） */
export function markCooldown(platform: string, ip: string): void {
  coolMap.set(coolKey(platform, ip), Date.now() + config.platformIpIntervalSec * 1000);
}

/** 账号读取侧出口（用于读取侧冷却键）：local→127.0.0.1；static→代理 host（未绑/停用/direct 退回 127.0.0.1）；
 *  dynamic→null（实际出口是每次新取 DPS IP，读取侧不查 127.0.0.1，只由 allocateAccount 查 DYN_FALLBACK 防连续回退直连）。 */
async function egressIpOf(acc: Account): Promise<string | null> {
  if (acc.ipMode === 'local') return '127.0.0.1';
  if (acc.ipMode === 'static') {
    if (acc.proxyId == null) return '127.0.0.1';
    const ip = await proxyRepo().get(acc.proxyId);
    if (!ip || ip.enabled === false || isDirectIp(ip)) return '127.0.0.1';
    return ip.host;
  }
  return null; // dynamic：读侧不参与出口冷却
}

function isAccountBusy(accountId: string): boolean {
  return inFlight.has(accountId);
}

export interface ReadyCheck {
  ok: boolean;
  reason?: string;
  accountId?: string;
  dir?: string;
}

/** 分配一个可用的已登录账号（只挑 active+enabled 且空闲；无可用 → 返回原因） */
export async function allocateAccount(platformId: string): Promise<ReadyCheck> {
  const accounts = await accountRepo().list(platformId);
  const usable: Account[] = [];
  let coolingBlocked = 0;
  let coolingMaxRemain = 0;
  const coolDetail: string[] = [];
  for (const a of accounts) {
    if (a.status !== 'active' || a.enabled === false || isAccountBusy(a.id) || !fs.existsSync(accountDirOf(a.id))) continue;
    if (a.ipMode === 'dynamic') {
      // 动态：读侧不查 127.0.0.1（实际出口是每次新 DPS IP），只查 dynamic-fallback 键防连续回退直连
      if (isCooling(platformId, DYN_FALLBACK)) {
        const rem = cooldownRemainingSec(platformId, DYN_FALLBACK);
        coolingBlocked++;
        coolingMaxRemain = Math.max(coolingMaxRemain, rem);
        coolDetail.push(`${a.id}(动态回退冷却剩${rem}s)`);
        continue;
      }
      usable.push(a);
      continue;
    }
    const ip = await egressIpOf(a);
    if (ip && isCooling(platformId, ip)) {
      const rem = cooldownRemainingSec(platformId, ip);
      coolingBlocked++;
      coolingMaxRemain = Math.max(coolingMaxRemain, rem);
      coolDetail.push(`${a.id}(${ip}剩${rem}s)`);
      continue; // (平台,IP) 冷却中 → 不可用
    }
    usable.push(a);
  }
  if (usable.length === 0) {
    const label = LOGIN_DRIVERS[platformId]?.label ?? platformId;
    if (coolingBlocked > 0) {
      console.log(`[allocate] ${platformId} 0 可用：${coolingBlocked} 个出口冷却中（${coolDetail.join(' / ') || '剩约' + coolingMaxRemain + 's'}）`);
      return {
        ok: false,
        reason: `「${label}」${coolingBlocked} 个账号出口冷却中（约剩 ${coolingMaxRemain}s），稍后自动重试`,
      };
    }
    const any = accounts.some((a) => ['failed', 'cooling', 'none'].includes(a.status) || a.enabled === false);
    return {
      ok: false,
      reason: any
        ? `「${label}」没有可用账号（active 缺失或已停用），请到 /admin 查看各账号状态并补登`
        : `「${label}」未登录任何账号，请先到 /admin 登录`,
    };
  }
  const now = Date.now();
  const today = todayStr();
  // score：最近使用越久越优先、今日查询越少越优先、连续失败惩罚、加抖动
  const scored = usable
    .map((a) => ({
      a,
      score:
        (now - (a.lastUsedAt ?? 0)) / 60000
        - (a.queryDate === today ? (a.todayQueries ?? 0) : 0) * 100
        - (a.consecutiveFails ?? 0) * 2000
        + Math.random() * 30,
    }))
    .sort((x, y) => y.score - x.score);
  const pick = scored[0].a;
  inFlight.add(pick.id);
  return { ok: true, accountId: pick.id, dir: pick.dir };
}

export async function releaseAccount(platformId: string, accountId: string, success: boolean, loginRequired: boolean, usedDps = false): Promise<void> {
  inFlight.delete(accountId);
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return;
  // 写侧冷却：
  //  - dynamic 用成动态 IP（usedDps）→ 不冷却（每次新 IP）；
  //  - dynamic 回退直连（!usedDps）→ 冷却 127.0.0.1（保护同平台 local 任务，与 local 共用）
  //    + 冷却 DYN_FALLBACK 键（保护后续 dynamic 任务不再连续回退直连，零容忍）；
  //  - local/static 按 egressIpOf 原逻辑（local→127.0.0.1；static→代理 host）。
  if (acc.ipMode === 'dynamic') {
    if (!usedDps) {
      markCooldown(platformId, '127.0.0.1');
      markCooldown(platformId, DYN_FALLBACK);
      console.log(`[cooldown] ${platformId}/${acc.id} 动态回退直连，冷却 127.0.0.1 + dynamic-fallback（${config.platformIpIntervalSec}s）`);
    } else {
      console.log(`[dps] 动态出口账号（${platformId}/${acc.id}）本次使用动态 IP，跳过冷却`);
    }
  } else {
    const coolIp = await egressIpOf(acc);
    if (coolIp) {
      markCooldown(platformId, coolIp);
      console.log(`[cooldown] ${platformId}/${acc.id} 出口 ${coolIp} 冷却（${config.platformIpIntervalSec}s）`);
    }
  }
  const patch: Partial<Account> = { lastUsedAt: Date.now() };
  if (loginRequired) {
    patch.status = 'failed';
    patch.note = '问答时检测到登录墙/会话失效，需重新登录';
    patch.consecutiveFails = (acc.consecutiveFails ?? 0) + 1;
  } else {
    patch.consecutiveFails = success ? 0 : (acc.consecutiveFails ?? 0) + 1;
    // 跨天归零：queryDate 不是今天则从 0 起算，并记下今天日期
    const today = todayStr();
    const base = acc.queryDate === today ? (acc.todayQueries ?? 0) : 0;
    patch.todayQueries = base + 1;
    patch.queryDate = today;
  }
  await accountRepo().patch(platformId, accountId, patch);
}

// ---------- 登录会话（同一时刻只允许一个平台的一个账号在登） ----------
interface ActiveLogin {
  platformId: string;
  accountId: string;
  dir: string;
  context: BrowserContext;
  confirm: (v: boolean) => void;
}

let activeLogin: ActiveLogin | null = null;

export function loginBusy(): { platformId?: string; accountId?: string } {
  return activeLogin ? { platformId: activeLogin.platformId, accountId: activeLogin.accountId } : {};
}

function launchOpts(proxy?: ProxyOpts): Parameters<typeof chromium.launchPersistentContext>[1] {
  const o: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    // 不覆写 UA：真实系统 Chrome 的 UA 与 navigator.platform、sec-ch-ua 客户端提示天然一致；
    // 硬编码假 UA（mac/Chrome124）与真实环境矛盾，属环境伪造特征，会触发平台风控（选图验证永不过）。
    // viewport null = 关闭视口模拟，页面按真实窗口尺寸渲染，避免固定 1280x800 的模拟痕迹。
    viewport: null,
  };
  if (proxy) {
    o.proxy = config.proxyBypass
      ? { ...proxy, bypass: `${config.proxyBypass}, <-loopback>` }
      : proxy;
  }
  return o;
}

/** launchPersistentContext 容错包装：profile 残留 Chromium 锁（浏览器被 kill/重启后
 *  SingletonLock/Socket/Cookie 未清除）会让 Chrome 误以为目录被占用而立即退出，表现为
 *  「测试/登录窗口打不开」。启动失败时自动清锁重试一次。 */
async function launchPersistentRetry(
  dir: string,
  opts: Parameters<typeof chromium.launchPersistentContext>[1]
): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(dir, opts);
  } catch (e) {
    try {
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
      return await chromium.launchPersistentContext(dir, opts);
    } catch (e2) {
      throw e2;
    }
  }
}

/** 一次性打开目录探测：登录墙 / 登录态判定（登录与测试窗口固定本地 IP，不代理） */
async function openProbe(
  platformId: string,
  dir: string,
  proxy?: ProxyOpts
): Promise<{ ok: boolean; loginRequired?: boolean; error?: string }> {
  let context: BrowserContext;
  try {
    context = await launchPersistentRetry(dir, { ...launchOpts(proxy), headless: true });
  } catch (e) {
    return { ok: false, error: `打开会话失败：${(e as Error).message}` };
  }
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      } catch {
        /* ignore */
      }
    });
    const page = await context.newPage();
    const def = resolvePlatform(platformId);
    await page.goto(def.defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const readySel = [...def.selectors.input, 'a:has-text("登录")', 'button:has-text("登录")'].join(', ');
    await page.waitForSelector(readySel, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // ✅ 登录态判定唯一依据 = 登录凭证（loginCredentialsOf：cookie 匹配 / localStorage 键有值）。
    // 不依赖 DOM 遮挡/输入框（有的平台没有遮罩，元素判定不可靠；用户 2026-09-26 定）。
    // 持久化 cookie 在 launchPersistentContext 时已从磁盘加载；localStorage 随目录持久化，
    // 无头重开同一目录即可读到。真登录 → 非空 → 已登录；未登录 → 空 → 未登录。
    // 轮询上限：等待磁盘凭证稳定可读（localStorage 在页面加载后才有，需等 SPA 水合）。
    const HYDRATE_MS = 12000;
    const t0 = Date.now();
    let creds = await loginCredentialsOf(context, page, platformId);
    while (creds.cookies.length === 0 && creds.storageKeys.length === 0 && Date.now() - t0 < HYDRATE_MS) {
      await page.waitForTimeout(500);
      creds = await loginCredentialsOf(context, page, platformId);
    }
    const loginRequired = creds.cookies.length === 0 && creds.storageKeys.length === 0;
    if (loginRequired) {
      // 诊断落盘：无头重开未读到登录凭证 cookie 时，dump 现场排查（cookie 名/localStorage）
      try {
        fs.mkdirSync(paths.diagnosticsRoot, { recursive: true });
        const ts = Date.now();
        const html = await page.content();
        fs.writeFileSync(path.join(paths.diagnosticsRoot, `login-${platformId}-probe-fail-${ts}.html`), html, 'utf8');
        const ls = await page.evaluate(() => {
          const o: Record<string, string> = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) o[k] = localStorage.getItem(k) || '';
          }
          return o;
        });
        fs.writeFileSync(path.join(paths.diagnosticsRoot, `login-${platformId}-probe-fail-${ts}.ls.json`), JSON.stringify(ls, null, 2), 'utf8');
        const cookies = await context.cookies();
        fs.writeFileSync(
          path.join(paths.diagnosticsRoot, `login-${platformId}-probe-fail-${ts}.cookies.json`),
          JSON.stringify(
            cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, expires: c.expires, secure: c.secure })),
            null,
            2,
          ),
          'utf8',
        );
      } catch {
        /* ignore */
      }
      return { ok: true, loginRequired };
    }
    return { ok: true, loginRequired };
  } catch (e) {
    return { ok: false, error: `登录态探测异常：${(e as Error).message}` };
  } finally {
    await context.close().catch(() => {});
  }
}

/** 判定登录凭证是否存在（唯一依据）：cookie 匹配 或 localStorage 键有值，任一命中 = 已登录。
 * 不依赖 DOM 遮挡（有的平台没有遮罩，元素判定不可靠）。
 * 注意：cookie 特征只匹配「登录后才有」的凭证 cookie；匿名/会话 cookie 未登录时也存在，不能命中。 */
export async function loginCredentialsOf(
  context: BrowserContext,
  page: Page | undefined,
  platformId: string
): Promise<{ cookies: { name: string; domain: string; expires: number }[]; storageKeys: string[] }> {
  const driver = LOGIN_DRIVERS[platformId];
  const result: { cookies: { name: string; domain: string; expires: number }[]; storageKeys: string[] } = {
    cookies: [],
    storageKeys: [],
  };
  try {
    if (driver?.loginCookiePattern) {
      const cookies = await context.cookies().catch(() => []);
      result.cookies = cookies
        .filter((c) => driver.loginCookiePattern!.test(c.name))
        .map((c) => ({ name: c.name, domain: c.domain, expires: c.expires }));
    }
  } catch {
    /* cookie 读取失败不影响 storage 判定 */
  }
  try {
    if (driver?.loginStorageKeys?.length && page) {
      result.storageKeys = await page
        .evaluate((specs) => {
          const hits: string[] = [];
          for (const spec of specs) {
            const key = typeof spec === 'string' ? spec : spec.key;
            try {
              const v = localStorage.getItem(key);
              if (v == null) continue;
              if (typeof spec === 'string') {
                if (v.trim().length > 0) hits.push(key);
              } else {
                let parsed: unknown = v;
                if (spec.jsonPath) {
                  try {
                    parsed = JSON.parse(v);
                    for (const part of spec.jsonPath.split('.')) {
                      if (parsed == null) break;
                      parsed = (parsed as Record<string, unknown>)[part];
                    }
                  } catch {
                    parsed = null;
                  }
                }
                if (parsed != null && String(parsed).trim().length > 0) hits.push(key);
              }
            } catch {
              /* ignore */
            }
          }
          return hits;
        }, driver.loginStorageKeys as (string | { key: string; jsonPath?: string })[])
        .catch(() => []);
    }
  } catch {
    /* storage 读取失败不影响 cookie 判定 */
  }
  return result;
}

/** 登录后校验：无头重开同一目录，未撞登录墙且可提问 → ok（不抽昵称；2026-09-23 按用户要求简化） */
async function verifySession(
  platformId: string,
  dir: string,
  proxy?: ProxyOpts
): Promise<{ ok: boolean; note?: string }> {
  const p = await openProbe(platformId, dir, proxy);
  if (!p.ok) return { ok: false, note: p.error };
  if (p.loginRequired) return { ok: false, note: '未获取到登录凭证 cookie' };
  return { ok: true };
}

/** 新增账号槽（只建卡片不登录）：2026-09-24 与 geo-ui-browser 对齐——点「新增账号」只加卡，
 *  选好代理后再点卡片「登录」才开浏览器窗口。proxyId 可选（选代理后直接绑定）。 */
export async function addAccountSlot(platformId: string, proxyId?: number): Promise<{ ok: boolean; msg: string; accountId?: string }> {
  const accounts = await accountRepo().list(platformId);
  const seq = nextSeqOf(platformId, accounts);
  const acc: Account = {
    id: `${platformId}-${seq}`,
    dir: dirOf(platformId, seq),
    remark: `账号${seq}`,
    status: 'none',
    enabled: true,
    proxyId: proxyId ?? undefined,
  };
  await accountRepo().add(platformId, acc);
  return { ok: true, msg: `已新增账号 ${acc.id}（点卡片「登录」开始登录）`, accountId: acc.id };
}

/** 发起某平台某账号（或新账号）的登录：有头窗口等人工。幂等：一次只允许一个登录会话 */
export async function startLogin(
  platformId: string,
  accountId?: string,
  proxyId?: number
): Promise<{ ok: boolean; msg: string; accountId?: string }> {
  const driver = LOGIN_DRIVERS[platformId];
  if (!driver) return { ok: false, msg: `未注册的登录平台：${platformId}` };
  if (activeLogin) {
    return { ok: false, msg: `已有登录会话进行中（${activeLogin.platformId}/${activeLogin.accountId}），请先完成或等待超时` };
  }
  let accounts = await accountRepo().list(platformId);
  let acc: Account;
  if (accountId) {
    acc = accounts.find((a) => a.id === accountId)!;
    if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
    if (acc.status === 'waiting') return { ok: false, msg: '该账号已在登录中' };
  } else {
    // 未指定 → 新开一个账号槽
    const seq = nextSeqOf(platformId, accounts);
    acc = {
      id: `${platformId}-${seq}`,
      dir: dirOf(platformId, seq),
      remark: `账号${seq}`,
      status: 'none',
      enabled: true,
      proxyId: proxyId ?? undefined,
    };
    await accountRepo().add(platformId, acc);
  }
  await accountRepo().patch(platformId, acc.id, { status: 'waiting', note: undefined });
  const waitMs = driver.loginWaitMs ?? 6 * 60 * 1000;

  const task = (async () => {
    let context: BrowserContext;
    try {
      // 登录窗口固定本地 IP（用户 2026-10-08 定：登录/测试窗口不代理，登录态不依赖出口 IP）
      context = await launchPersistentRetry(acc.dir, launchOpts());
    } catch (e) {
      await accountRepo().patch(platformId, acc.id, { status: 'failed', note: `打开登录窗口失败：${(e as Error).message}` });
      return;
    }
    let confirmResolve: (v: boolean) => void = () => {};
    const confirm = new Promise<boolean>((r) => (confirmResolve = r));
    activeLogin = { platformId, accountId: acc.id, dir: acc.dir, context, confirm: confirmResolve };
    let done = false;
    try {
      const page = context.pages()[0];
      // 有头窗口：Windows 下后台服务拉起的窗口会继承隐藏态被最小化 → 恢复并置前（等人工登录必须可见）
      const browser = context.browser();
      if (browser) await raiseWindow(browser, context, page);
      const def = resolvePlatform(platformId);
      await page.goto(def.defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      // 区分三种结果：确认（true）→ 校验登录态；取消（false）→ 直接收尾不回写（cancelLogin 已置 none）；
      // 超时 → 标记 failed。绝不能用 .then(() => true) 把取消误当成完成（会导致 active 覆盖 none）。
      const result = await Promise.race([
        confirm.then((v) => (v ? 'confirm' : 'cancel')),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), waitMs)),
      ]);
      done = result === 'confirm';
      if (result === 'cancel') {
        return; // 取消登录：cancelLogin 已把状态置 none，这里不再回写任何状态
      }
    } catch (e) {
      await accountRepo().patch(platformId, acc.id, { status: 'failed', note: `登录窗口异常：${(e as Error).message}` });
    } finally {
      activeLogin = null;
      await context.close().catch(() => {});
    }
    // 登录进行中账号被主动退出（logoutAccount 已把状态置 none、删目录）——不再回写登录结果，避免覆盖成 failed
    if ((await accountRepo().get(platformId, acc.id))?.status === 'none') {
      return;
    }
    if (done) {
      // active 以「磁盘登录态可还原」为准（verifySession = 无头重开同一目录验证登录墙/输入框）。
      // 不再抽昵称（2026-09-23 按用户要求简化）；文心等无登录墙平台的"磁盘未持久化"兜底
      // 由 confirmLogin 里的会话级 cookie 转持久（重种 365 天）承担。
      const v = await verifySession(platformId, acc.dir);
      if (v.ok) {
        await accountRepo().patch(platformId, acc.id, {
          status: 'active',
          note: undefined,
          createdAt: acc.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
          todayQueries: 0,
          consecutiveFails: 0,
        });
      } else {
        // 无头探测未通过 → 未登录（用户语义：需重新登录 = 未登录，不新增 failed 状态）
        await accountRepo().patch(platformId, acc.id, {
          status: 'none',
          note: `登录态校验未通过：${v.note ?? ''}`,
        });
      }
    } else {
      await accountRepo().patch(platformId, acc.id, { status: 'failed', note: '登录等待超时，未完成登录' });
    }
  })();
  // 收尾是异步 fire-and-forget：任意 DB 写入失败都收敛为日志，绝不变成 unhandledRejection 拖垮进程
  task.catch((e) => console.error('[startLogin] 登录异步收尾异常（已忽略，不影响服务进程）：', e));
  return { ok: true, msg: `登录窗口已打开（${acc.id}），请在窗口内完成登录后回到管理页点击「我已登录完成，验证」`, accountId: acc.id };
}

// 用户在可见登录窗口点「验证」→ confirmLogin 确认，随后 startLogin 异步收尾 verifySession 校验磁盘。
export async function confirmLogin(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  if (!activeLogin || activeLogin.platformId !== platformId || activeLogin.accountId !== accountId) {
    return { ok: false, msg: '当前没有进行中的该账号登录会话（可能已结束或超时）' };
  }
  // 直接在用户刚登录完成的可见窗口上操作：等 SPA 水合登录态 + 诊断落盘 + 会话级 cookie 转持久。
  // 不再抽昵称（2026-09-23 按用户要求简化）。
  try {
    const pg = activeLogin.context.pages()[0];
    if (pg) {
      // 窗口内真实登录态判定（不弹提示框）：唯一依据 = 窗口内能否读到登录凭证（cookie/localStorage）。
      // 已登录才重种 cookie 落盘；未登录 → 不重种（重种匿名 cookie 会把无登录态误持久化，
      // 导致无头重开被误判已登录），由收尾 verifySession 无头探测做最终裁决，未通过回写 none。
      let windowLoggedIn = false;
      try {
        const creds = await loginCredentialsOf(pg.context(), pg, platformId);
        windowLoggedIn = creds.cookies.length > 0 || creds.storageKeys.length > 0;
        if (!windowLoggedIn) {
          console.log(
            `[confirmLogin] ${platformId}/${accountId} 窗口内未读到登录凭证（cookie ${creds.cookies.length} / storage ${creds.storageKeys.length}），判定未登录`
          );
        }
      } catch {
        windowLoggedIn = false;
      }
      // 等页面稳定（诊断用 html 落盘前页面已渲染）
      await pg.waitForTimeout(1500).catch(() => {});
      const html = await pg.content().catch(() => '');
      if (html) {
        try {
          fs.mkdirSync(paths.diagnosticsRoot, { recursive: true });
          fs.writeFileSync(path.join(paths.diagnosticsRoot, `login-${platformId}-${Date.now()}.html`), html, 'utf8');
        } catch {
          /* ignore */
        }
      }
      // ⚠️ 登录态落盘自证：dump 当前窗口 context 的 cookies，确认登录态载体与可持久化性。
      // 曾踩坑（文心 2026-09-07）：窗口 DOM 显示已登录 → 台账标 active，但 BDUSS 等登录 cookie
      // 从未落盘 .profiles/wenxiaoyan-1 → execute 打开仍是未登录、整轮匿名问答。
      try {
        const cookies = await pg.context().cookies().catch(() => []);
        const loginish = cookies
          .filter((c) => /bduss|stoken|passid|ubid|login_ticket/i.test(c.name))
          .map((c) => ({ name: c.name, domain: c.domain, expires: c.expires, httpOnly: c.httpOnly, len: (c.value || '').length }));
        fs.writeFileSync(
          path.join(paths.diagnosticsRoot, `login-${platformId}-cookies-${Date.now()}.json`),
          JSON.stringify(
            { url: pg.url().slice(0, 200), cookieTotal: cookies.length, loginish, all: cookies.map((c) => `${c.domain} ${c.name}`) },
            null,
            2
          ),
          'utf8'
        );
      } catch {
        /* 诊断落盘失败不影响登录 */
      }
      // 🍪 会话级登录 cookie 转持久：仅在窗口内判定已登录时执行。
      // 未登录时窗口里只有匿名 cookie（ttwid/csrf/bd_sso 追踪等），一旦重种持久化，
      // 无头重开会误认为"已有会话"不弹登录墙 → verifySession 误判已登录。
      // 因此未登录（windowLoggedIn=false）一律不重种，交给收尾探测裁决。
      if (windowLoggedIn) {
        try {
          const ctx = pg.context();
          const sess = (await ctx.cookies().catch(() => []))
            .filter((c) => c.expires <= 0)
            .map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              httpOnly: c.httpOnly,
              secure: c.secure,
              sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
              expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // 365 天
            }));
          if (sess.length > 0) {
            await ctx.addCookies(sess).catch(() => {});
            console.log(`🍪 已把 ${sess.length} 个会话级登录 cookie（${sess.map((c) => c.name).join('/')}）转为 365 天持久，防止关闭窗口后丢失`);
          }
        } catch {
          /* 持久化失败：登录仍完成，但下次打开可能未登录 */
        }
      } else {
        console.log(`[confirmLogin] ${platformId}/${accountId} 窗口内未检测到登录态，不重种 cookie，交由收尾探测裁决`);
      }
    }
  } catch {
    /* 窗口操作失败不影响确认 */
  }
  activeLogin.confirm(true);
  return { ok: true, msg: '收到确认，正在校验登录态…' };
}

/** 取消某账号的进行中登录：释放活动会话（若有）+ 把状态重置回 none（服务重启后的 waiting 残留也适用）。 */
export async function cancelLogin(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
  // 1) 若该账号正占着登录会话：resolve(false) 让 startLogin 异步收尾走完并关窗；
  //    随后把状态置 none——startLogin 收尾看到 status==='none' 的守卫不会回写 failed。
  if (activeLogin && activeLogin.platformId === platformId && activeLogin.accountId === accountId) {
    const lg = activeLogin;
    activeLogin = null;
    try { lg.confirm(false); } catch { /* 已 settle */ }
    try { await lg.context.close(); } catch { /* 窗口已关 */ }
  }
  // 2) 状态重置（无活动会话时同样生效：重启残留在此清理）
  await accountRepo().patch(platformId, accountId, { status: 'none', note: undefined });
  return { ok: true, msg: `已取消 ${accountId} 的登录` };
}

/** 服务启动时清理 waiting 残留：内存登录会话随进程重启必然丢失，waiting 账号无法再「验证登录」，统一重置为 none。 */
/**
 * 启动后校验各账号本地登录态并回写数据库：
 *  - 本地 profile 目录存在 → 维持原状态（active/cooling 视为已登录）；
 *  - 本地无 profile（换机/目录被删）→ 库内 status 回写为 none（未登录，等同需重新登录），
 *    避免「数据库标已登录、实际本地无登录信息」被挑号/采集误用。
 */
export async function syncAccountLoginState(): Promise<{ marked: number }> {
  let marked = 0;
  try {
    for (const pid of Object.keys(LOGIN_DRIVERS)) {
      const accounts = await accountRepo().list(pid);
      for (const a of accounts) {
        if (!fs.existsSync(accountDirOf(a.id))) {
          if (a.status === 'active' || a.status === 'cooling') {
            await accountRepo().patch(pid, a.id, { status: 'none' });
            marked++;
            console.warn(`[login] ${pid}/${a.id} 本地无 profile，重置为未登录`);
          }
        }
      }
    }
  } catch (e) {
    console.error('[login] 启动校验登录态失败（不阻断启动）：', e);
  }
  return { marked };
}

export async function resetStaleWaiting(): Promise<void> {
  try {
    for (const pid of Object.keys(LOGIN_DRIVERS)) {
      const accounts = await accountRepo().list(pid);
      for (const a of accounts) {
        if (a.status === 'waiting') {
          await accountRepo().patch(pid, a.id, { status: 'none', note: undefined });
          console.warn(`[login] 清理等待残留：${pid}/${a.id} -> none（服务重启）`);
        }
      }
    }
  } catch (e) {
    console.error('[login] 启动清理 waiting 残留失败（不阻断启动）：', e);
  }
}

// ---------- 测试窗口：手动打开该账号的大模型聊天页，全程人工操作 ----------
// 设计：用账号专属 profile 目录起一个「有头 + 人类化」持久上下文，打开 defaultUrl（聊天页），
// 不跑任何自动化，窗口常驻供用户手动提问 / 管理历史对话。
// 窗口打开期间把账号加入 inFlight：① 阻止采集挑到该号（两个上下文不能共用一个 userDataDir，否则报
//   "already in use"）；② 阻止重复开测试窗口。用户手动关窗或点「关闭测试」→ 从 inFlight 与 testSessions 移除。
const testSessions = new Map<string, BrowserContext>();

function testKey(platformId: string, accountId: string): string {
  return `${platformId}/${accountId}`;
}

/** 当前所有打开的测试窗口 key（platformId/accountId） */
export function listTestSessions(): string[] {
  return Array.from(testSessions.keys());
}

/** 打开某账号的测试窗口（手动聊天）。已开 / 采集中 / 登录中 / 目录不存在 → 返回明确错误 */
export async function testAccount(
  platformId: string,
  accountId: string
): Promise<{ ok: boolean; msg: string }> {
  const driver = LOGIN_DRIVERS[platformId];
  if (!driver) return { ok: false, msg: `未注册的登录平台：${platformId}` };
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
  // 只有处于登录态的账号才能测试（none=未登录 / waiting=登录中 / failed=不可用 一律禁止）
  if (acc.status !== 'active' && acc.status !== 'cooling') {
    return { ok: false, msg: `账号 ${accountId} 未处于登录态（当前：${acc.status}），无法测试` };
  }
  // 目录必须存在（至少登录过一次才会创建；纯未登录槽位无 profile 目录）
  if (!fs.existsSync(acc.dir)) {
    return { ok: false, msg: `账号 ${accountId} 还没有 profile 目录（请先登录一次）` };
  }
  // 采集中（inFlight）或被占用 → 不开，避免抢同一 userDataDir
  if (isAccountBusy(accountId)) {
    return { ok: false, msg: `账号 ${accountId} 正在采集中或被占用，暂不能开测试窗口` };
  }
  // 该账号正在走登录流程 → 等完成
  if (loginBusy().accountId === accountId) {
    return { ok: false, msg: `账号 ${accountId} 正在登录中，请先完成登录` };
  }
  const key = testKey(platformId, accountId);
  if (testSessions.has(key)) {
    return { ok: false, msg: `账号 ${accountId} 的测试窗口已打开` };
  }
  let context: BrowserContext;
  try {
    // 测试窗口固定本地 IP（用户 2026-10-08 定：登录/测试窗口不代理）
    context = await launchPersistentRetry(acc.dir, launchOpts());
  } catch (e) {
    return { ok: false, msg: `打开测试窗口失败：${(e as Error).message}` };
  }
  // 隐藏自动化特征，免得平台把手动窗口当成脚本
  void context
    .addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
  const def = resolvePlatform(platformId);
  const page = context.pages()[0] || (await context.newPage());
  // 有头窗口：恢复置前（Windows 下后台服务拉起的窗口会继承隐藏态被最小化）
  const browser = context.browser();
  if (browser) await raiseWindow(browser, context, page);
  await page.goto(def.defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  testSessions.set(key, context);
  // 标记占用：阻止采集挑到它（两个上下文不能共用一个 userDataDir）
  inFlight.add(accountId);
  // 用户手动点 X 关窗 → 清理
  context.on('close', () => {
    testSessions.delete(key);
    inFlight.delete(accountId);
  });
  return {
    ok: true,
    msg: `已为 ${accountId} 打开测试窗口（${driver.label}），可手动提问 / 管理历史对话；关窗即结束。`,
  };
}

/** 关闭某账号的测试窗口 */
export async function closeTestAccount(
  platformId: string,
  accountId: string
): Promise<{ ok: boolean; msg: string }> {
  const key = testKey(platformId, accountId);
  const ctx = testSessions.get(key);
  if (!ctx) return { ok: false, msg: `账号 ${accountId} 没有打开的测试窗口` };
  testSessions.delete(key);
  inFlight.delete(accountId);
  // 浏览器可能已被 kill（崩溃/残留），close() 可能长时间挂起 → 最多等 8s，宁可放进程稍后回收
  await Promise.race([
    ctx.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  return { ok: true, msg: `已关闭 ${accountId} 的测试窗口` };
}
