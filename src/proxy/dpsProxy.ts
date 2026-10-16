// 快代理私密代理：IP 池 + 「账号 ↔ IP」绑定（2026-10-16 用户定的动态出口模型）。
//
// 模型：一枚 IP 承载「每平台 N 个账号」（N = GEO_DPS_ACCOUNTS_PER_IP，默认 2），即一个 IP = 5 平台 × N 个账号位。
//   · 取账号 → 取 IP → 绑定：**串行**执行（模块内单队列串行，不存在并发写文件）。
//   · 账号已有绑定且 IP 未到期 → 直接复用（粘性：出口 IP 不在任务间频繁跳变）。
//   · 绑定的 IP 已到期 → 解散「该 IP + 它的全部绑定」，**先并入其他未满的有效 IP**，都没有才取新 IP。
//   · 账号无绑定 → 找「未到期 && 该平台绑定数 < N」的 IP（绑定数升序 → 剩余时间降序），找不到 → 取新 IP。
//   · IP 到期不做整体迁移：解散即可，账号下次取用时再绑 →「IP ↔ 账号」组合自然打乱。
// 持久化：<数据根>/dps-pool.json（只存 server / expiresAt / bindings；账密读取时由配置注入，不落盘）。
// 取 IP 仍是一次一枚（getdps num=1）+ 在途去重（同一时刻只打一次接口）。

import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { log, warn } from '../log.js';

export interface ProxyOpts {
  server: string;
  username?: string;
  password?: string;
}

const API = 'https://dps.kdlapi.com/api/getdps';
const VALIDTIME_API = 'https://dps.kdlapi.com/api/getdpsvalidtime';
const TIMEOUT_MS = 20000;
// getdps 取回 IP 后，若 getdpsvalidtime 异常/缺值，给一个保守的可用秒数兜底
const FALLBACK_REMAIN_SEC = 120;

/** 池内一枚 IP：有效期 + 它承载的「平台 → 账号」绑定 */
interface IpEntry {
  server: string; // http://host:port
  /** 绝对到期时刻（取 IP 时查一次 getdpsvalidtime 换算而来） */
  expiresAt: number;
  /** platformId → accountId[]（同平台最多 config.dps.accountsPerIp 个） */
  bindings: Record<string, string[]>;
}

// 模块级 IP 池：进程生命周期内跨任务复用。懒加载——无任务请求不取 IP。
let ips: IpEntry[] = [];
// 在途 refill 去重：同一时刻只打一次 getdps，并发等待者共享这一次结果
let refillPromise: Promise<IpEntry[]> | null = null;
// 「账号↔IP」绑定串行队列：绑定的「读文件 → 判定 → 可能取新 IP → 写文件」必须是原子段
let bindQueue: Promise<unknown> = Promise.resolve();

const POOL_FILE = path.resolve(config.dataRoot, 'dps-pool.json');

// ─────────────────────────── 池与绑定（内存 + 文件） ───────────────────────────

/** IP 剩余可用秒（<=0 表示已到期） */
function liveRemaining(ip: IpEntry): number {
  return Math.round((ip.expiresAt - Date.now()) / 1000);
}

function isDead(ip: IpEntry): boolean {
  return liveRemaining(ip) <= 0;
}

/** 该 IP 上某平台的绑定数 */
function countOf(ip: IpEntry, platformId: string): number {
  return (ip.bindings[platformId] ?? []).length;
}

/** 该账号在某 IP 上的绑定（按平台找，账号 id 本身含平台前缀，再按平台收敛一次更保险） */
function findHeld(platformId: string, accountId: string): IpEntry | undefined {
  return ips.find((ip) => (ip.bindings[platformId] ?? []).includes(accountId));
}

function bind(ip: IpEntry, platformId: string, accountId: string): void {
  const list = ip.bindings[platformId] ?? (ip.bindings[platformId] = []);
  if (!list.includes(accountId)) list.push(accountId);
}

/** 清理已到期的 IP（连同它的全部账号绑定）——「到期即解散」 */
function pruneDead(): number {
  const before = ips.length;
  ips = ips.filter((ip) => !isDead(ip));
  return before - ips.length;
}

function savePool(): void {
  try {
    const data = { savedAt: Date.now(), ips };
    fs.writeFileSync(POOL_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    warn(`[ip] 池持久化失败（忽略）：${(e as Error).message}`);
  }
}

function loadPool(): void {
  try {
    if (!fs.existsSync(POOL_FILE)) return;
    const j = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')) as {
      ips?: IpEntry[];
      // 旧格式（2026-10-16 之前）：proxies:[{server,validAt,checkedAt}]，只有池、无绑定
      proxies?: { server: string; validAt: number; checkedAt: number }[];
    };
    for (const p of j.ips ?? []) {
      if (!p?.server) continue;
      ips.push({ server: p.server, expiresAt: p.expiresAt ?? 0, bindings: p.bindings ?? {} });
    }
    for (const p of j.proxies ?? []) {
      if (!p?.server) continue;
      ips.push({ server: p.server, expiresAt: (p.checkedAt ?? 0) + (p.validAt ?? 0) * 1000, bindings: {} });
    }
    const total = ips.length;
    const dropped = pruneDead();
    if (total) {
      log(`🌐 [ip] 从 ${POOL_FILE} 恢复 ${total} 枚 IP（清理已到期 ${dropped} 枚；凭证由配置注入）`);
    }
  } catch (e) {
    warn(`[ip] 池恢复失败（忽略）：${(e as Error).message}`);
  }
}
loadPool();

// ─────────────────────────── 取新 IP（快代理接口） ───────────────────────────

async function requestOnce(): Promise<string[]> {
  const { secretId, secretKey } = config.dps;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret_id: secretId,
        signature: secretKey,
        num: '1',
        format: 'json',
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      warn(`[ip] getdps HTTP ${res.status}`);
      return [];
    }
    const j = (await res.json()) as { code?: number; msg?: string; data?: { proxy_list?: string[] } };
    log(`[ip] getdps 响应：${JSON.stringify(j)}`);
    if (j.code !== 0 || !j.data?.proxy_list?.length) {
      warn(`[ip] getdps code=${j.code} msg=${j.msg ?? ''}`);
      return [];
    }
    return j.data.proxy_list;
  } catch (e) {
    warn(`[ip] 请求异常：${(e as Error).message}`);
    return [];
  }
}

/** 批量查各 IP 剩余可用秒；proxy 形如 ip:port（与 getdps 返回一致） */
async function getDpsValidTime(proxies: string[]): Promise<Record<string, number>> {
  const { secretId, secretKey } = config.dps;
  const q = new URLSearchParams({ secret_id: secretId, signature: secretKey, proxy: proxies.join(',') });
  try {
    const res = await fetch(`${VALIDTIME_API}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return {};
    const j = (await res.json()) as { code?: number; data?: Record<string, number> };
    log(`[ip] getdpsvalidtime 响应：${JSON.stringify(j)}`);
    if (j.code !== 0 || !j.data) return {};
    return j.data;
  } catch {
    return {};
  }
}

/** 把刚取回的 ip:port 播种成池条目：查一次真实有效期，换算成绝对到期时刻 */
async function seed(hosts: string[]): Promise<IpEntry[]> {
  const vt = await getDpsValidTime(hosts);
  const now = Date.now();
  return hosts.map((host) => {
    const remaining = vt[host] && vt[host] > 0 ? vt[host] : FALLBACK_REMAIN_SEC;
    return { server: `http://${host}`, expiresAt: now + remaining * 1000, bindings: {} };
  });
}

/** 取一枚新 IP（getdps 一次，失败重试一次）并播种；返回新条目（已入池） */
async function refill(): Promise<IpEntry[]> {
  let list = await requestOnce();
  if (!list.length) {
    list = await requestOnce();
    if (!list.length) return [];
  }
  return await seed(list);
}

/** 取新 IP（并发去重）：已有在途请求则直接复用，不重复打 getdps */
async function ensureFresh(): Promise<IpEntry[]> {
  if (!refillPromise) {
    refillPromise = (async () => {
      const fresh = await refill();
      if (fresh.length) {
        ips.push(...fresh);
        savePool();
      }
      return fresh;
    })();
    refillPromise.finally(() => { refillPromise = null; }).catch(() => {});
  }
  return refillPromise;
}

/** 在池中挑一枚「可并入」的 IP：未到期（且剩余 > minTtl）且本平台未满 N。
 *  绑定数少的优先（平衡负载），其次剩余时间长的（用得久）。挑不到返回 undefined。 */
function pickUsable(platformId: string, quota: number, minTtl: number): IpEntry | undefined {
  return ips
    .filter((ip) => liveRemaining(ip) > minTtl && countOf(ip, platformId) < quota)
    .sort((a, b) => countOf(a, platformId) - countOf(b, platformId) || b.expiresAt - a.expiresAt)[0];
}

/** 从配置注入账密：池内条目（含从盘上恢复的）不携带凭证 */
function withCreds(ip: IpEntry): ProxyOpts {
  return {
    server: ip.server,
    ...(config.dps.username ? { username: config.dps.username } : {}),
    ...(config.dps.password ? { password: config.dps.password } : {}),
  };
}

// ─────────────────────────── 对外：为一个账号取出口 IP ───────────────────────────

/**
 * 为一个账号取得出口 IP（串行）。取不到返回 null（调用方回退静态代理/直连，并由账号释放路径记平台熔断）。
 * 判定顺序（2026-10-16 用户定）：已有绑定且未到期 → 复用；绑定已到期 → 解散该 IP 及其全部绑定，
 * **先并入其他未满的有效 IP**，没有才取新 IP；无绑定 → 找未到期且本平台未满的 IP → 仍无 → 取新 IP。
 */
export function acquireIpForAccount(platformId: string, accountId: string): Promise<ProxyOpts | null> {
  if (!config.dps.secretId || !config.dps.secretKey) return Promise.resolve(null);
  const run = bindQueue.then(() => acquireLocked(platformId, accountId));
  // 队列只关心「上一个跑完了」，前面的失败不阻断后续绑定
  bindQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function acquireLocked(platformId: string, accountId: string): Promise<ProxyOpts | null> {
  const quota = config.dps.accountsPerIp;
  const minTtl = config.dps.minTtlSec;

  // 先取该账号的绑定（可能是已到期的），再清理过期条目 —— 顺序不能反，否则「到期 → 另取新 IP」判不出来
  const held = findHeld(platformId, accountId);
  const cleared = pruneDead();
  if (cleared) log(`🧹 [ip] 清理已到期 IP ${cleared} 枚（连同其全部账号绑定）`);

  if (held) {
    if (liveRemaining(held) > minTtl) {
      log(
        `🌐 [ip] 复用绑定：${platformId}/${accountId} → ${held.server}` +
          `（剩余 ${liveRemaining(held)}s，本平台 ${countOf(held, platformId)}/${quota}）`
      );
      return withCreds(held);
    }
    // 已到期（或剩余不足以跑完一轮 → 一并按到期处理，避免任务跑到一半 IP 就没了）
    log(
      `🌐 [ip] ${platformId}/${accountId} 的绑定 IP ${
        isDead(held) ? '已到期' : `仅剩 ${liveRemaining(held)}s（不足一轮）`
      } → 解散该 IP 及其全部绑定`
    );
    // 真正删掉它（不能只打日志）：既落实「解散」，也把「持有 IP 数上限」的名额让出来，
    // 否则刚判定的这枚仍被计入上限 → 新 IP 取不回来（实测踩坑）。
    ips = ips.filter((ip) => ip.server !== held.server);
    savePool();

    // 解散后优先并入其他未满的有效 IP（省 IP：不因一枚到期就再取一枚）；都没有才取新 IP。
    const cand = pickUsable(platformId, quota, minTtl);
    if (cand) {
      bind(cand, platformId, accountId);
      savePool();
      log(
        `🌐 [ip] 绑定转移（原 IP 已解散）：${platformId}/${accountId} → ${cand.server}` +
          `（剩余 ${liveRemaining(cand)}s，本平台 ${countOf(cand, platformId)}/${quota}）`
      );
      return withCreds(cand);
    }
    return await fetchNew(platformId, accountId, quota);
  }

  // 无绑定：找「未到期 && 本平台未满 N」的 IP，绑定数少的优先、剩余时间长的次之
  const cand = pickUsable(platformId, quota, minTtl);
  if (cand) {
    bind(cand, platformId, accountId);
    savePool();
    log(
      `🌐 [ip] 绑定并入：${platformId}/${accountId} → ${cand.server}` +
        `（剩余 ${liveRemaining(cand)}s，本平台 ${countOf(cand, platformId)}/${quota}）`
    );
    return withCreds(cand);
  }

  return await fetchNew(platformId, accountId, quota);
}

/**
 * 解散一枚「已确认连不通」的 IP（连同它的全部平台/账号绑定），并把持有名额让出来。
 *
 * 为什么需要它（2026-10-16 实测）：快代理的短效 IP 会**提前失效**——`getdpsvalidtime` 仍报「还剩 1510s」，
 * 实际 CONNECT 已被拒绝（不带凭证 407 / 带凭证 516 Proxy Failed）。而本模块的判定是「绑定未到期即复用」，
 * 于是从该 IP 失效起，所有复用到它的账号都会失败，直到 TTL 到期才自愈（实测空转 25 分钟 + 误报登录态失效）。
 * 因此当调用方**已确认**该 IP 连不通时，必须立刻解散它，让下一次 acquire 走 pickUsable/取新 IP。
 *
 * 走同一条 bindQueue 串行（与取 IP/绑定互斥）；找不到该 server 时静默返回（幂等）。
 */
export function discardIp(server: string): Promise<void> {
  const run = bindQueue.then(() => {
    const before = ips.length;
    ips = ips.filter((ip) => ip.server !== server);
    if (ips.length !== before) {
      savePool();
      log(`🧹 [ip] 解散不可用 IP ${server}（连同其全部账号绑定）`);
    }
  });
  bindQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** 取一枚全新的 IP 并绑定当前账号（受「同时持有 IP 数上限」约束） */
async function fetchNew(platformId: string, accountId: string, quota: number): Promise<ProxyOpts | null> {
  const liveCount = ips.filter((ip) => !isDead(ip)).length;
  if (liveCount >= config.dps.maxIps) {
    warn(
      `⚠️ [ip] 持有 IP 数已达上限 ${config.dps.maxIps}（正常不该出现：浏览器数 ≤ 平台数，请检查配额与清理逻辑）→ 本次不再取新 IP`
    );
    return null;
  }
  const fresh = await ensureFresh();
  if (!fresh.length) return null;
  const ip = fresh[0];
  bind(ip, platformId, accountId);
  savePool();
  log(
    `🌐 [ip] 新建并绑定：${platformId}/${accountId} → ${ip.server}` +
      `（有效期 ${liveRemaining(ip)}s，本平台 ${countOf(ip, platformId)}/${quota}）`
  );
  return withCreds(ip);
}
