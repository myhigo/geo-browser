// 快代理私密代理：IP 缓存复用。getdps 取 IP，getdpsvalidtime 查各 IP 剩余秒。
// getdps 响应：{ code, msg, data: { proxy_list: ["ip:port"], count } }，code=0 才算成功。
// getdpsvalidtime 响应：{ code, data: { "ip:port": 剩余秒 } }。账密走配置，不在响应里。

import { config } from '../config/index.js';

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

interface CachedProxy extends ProxyOpts {
  validAt: number; // getdpsvalidtime 返回的剩余秒数
  checkedAt: number; // 记录 validAt 的时刻（Date.now()）
}

// 模块级 IP 池：进程生命周期内跨任务复用。懒加载——无任务请求不取 IP。
const pool: CachedProxy[] = [];
// 在途 refill 去重：同一时刻只打一次 getdps，并发等待者共享这一次结果
let refillPromise: Promise<CachedProxy[]> | null = null;

function liveRemaining(p: CachedProxy): number {
  return p.validAt - (Date.now() - p.checkedAt) / 1000;
}

async function requestOnce(): Promise<ProxyOpts | null> {
  const { secretId, secretKey, username, password } = config.dps;
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
      console.log(`[dps] HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { code?: number; msg?: string; data?: { proxy_list?: string[] } };
    console.log(`[dps] getdps 响应：${JSON.stringify(j)}`);
    if (j.code !== 0 || !j.data?.proxy_list?.length) {
      console.log(`[dps] code=${j.code} msg=${j.msg ?? ''}`);
      return null;
    }
    const [host, port] = j.data.proxy_list[0].split(':');
    if (!host || !port) return null;
    return {
      server: `http://${host}:${port}`,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch (e) {
    console.log(`[dps] 请求异常：${(e as Error).message}`);
    return null;
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
    console.log(`[dps] getdpsvalidtime 响应：${JSON.stringify(j)}`);
    if (j.code !== 0 || !j.data) return {};
    return j.data;
  } catch {
    return {};
  }
}

/** 把刚取回的 ProxyOpts 播种进池：查真实剩余秒，记录 checkedAt */
async function seed(opts: ProxyOpts[]): Promise<CachedProxy[]> {
  const hosts = opts.map((o) => o.server.replace(/^https?:\/\//, ''));
  const vt = await getDpsValidTime(hosts);
  const now = Date.now();
  return opts.map((o) => {
    const host = o.server.replace(/^https?:\/\//, '');
    const remaining = vt[host] && vt[host] > 0 ? vt[host] : FALLBACK_REMAIN_SEC;
    return { ...o, validAt: remaining, checkedAt: now };
  });
}

/** 取一批新 IP（getdps 一次，失败重试一次）并播种进池 */
async function refill(): Promise<CachedProxy[]> {
  const first = await requestOnce();
  if (!first) {
    const retry = await requestOnce();
    if (!retry) return [];
    return await seed([retry]);
  }
  return await seed([first]);
}

/** 取新一批 IP（并发去重）：已有在途请求则直接复用，不重复打 getdps */
async function ensureFresh(): Promise<CachedProxy[]> {
  if (!refillPromise) {
    refillPromise = (async () => {
      const fresh = await refill();
      if (fresh.length) pool.push(...fresh);
      return fresh;
    })();
    refillPromise.finally(() => { refillPromise = null; }).catch(() => {});
  }
  return refillPromise;
}

/**
 * 取一个可复用代理：优先复用池里剩余 > minTtlSec 的 IP；都没有则取新一批。
 * forceFresh=true 时忽略缓存，直接取新 IP（用于失败重试）。
 * 未配置凭据 / 取不到 → 返回 null（调用方回退到账号绑定代理或直连）。
 */
export async function fetchDpsProxy(forceFresh = false): Promise<ProxyOpts | null> {
  if (!config.dps.secretId || !config.dps.secretKey) return null;
  const minTtl = config.dps.minTtlSec ?? 60;

  if (!forceFresh) {
    // 淘汰真正过期的（live<=0），保留仍有效但 <minTtl 的（已付费，不浪费）
    for (let i = pool.length - 1; i >= 0; i--) {
      if (liveRemaining(pool[i]) <= 0) pool.splice(i, 1);
    }
    // 挑剩余最高的可用 IP 复用
    const usable = pool
      .filter((p) => liveRemaining(p) > minTtl)
      .sort((a, b) => liveRemaining(b) - liveRemaining(a));
    if (usable.length) {
      console.log(`🌐 [dps] 复用缓存代理：${usable[0].server}（剩余约 ${Math.round(liveRemaining(usable[0]))}s）`);
      return usable[0];
    }
  }

  // 无可用缓存 → 取新一批（并发去重：同一在途请求只打一次 getdps）
  const fresh = await ensureFresh();
  if (!fresh.length) return null;
  const pick = fresh.sort((a, b) => liveRemaining(b) - liveRemaining(a))[0];
  console.log(`🌐 [dps] 新取代理：${pick.server}（剩余约 ${Math.round(liveRemaining(pick))}s）`);
  return pick;
}
