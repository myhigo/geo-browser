// 快代理私密代理：IP 缓存复用。getdps 取 IP（返回几枚存几枚），getdpsvalidtime 查各 IP 剩余秒。
// getdps 响应：{ code, msg, data: { proxy_list: ["ip:port"], count } }，code=0 才算成功。
// getdpsvalidtime 响应：{ code, data: { "ip:port": 剩余秒 } }。账密走配置，不在响应里。

import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { log } from '../log.js';

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

// 池持久化：<数据根>/dps-pool.json。重启后未到期的 IP 继续可用（不落凭证，读取时从配置注入）。
const POOL_FILE = path.resolve(config.dataRoot, 'dps-pool.json');

function savePool(): void {
  try {
    const data = {
      savedAt: Date.now(),
      // 只存 server 与时效，凭证不入盘
      proxies: pool.map((p) => ({ server: p.server, validAt: p.validAt, checkedAt: p.checkedAt })),
    };
    fs.writeFileSync(POOL_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`[dps] 池持久化失败（忽略）：${(e as Error).message}`);
  }
}

function loadPool(): void {
  try {
    if (!fs.existsSync(POOL_FILE)) return;
    const j = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')) as {
      proxies?: { server: string; validAt: number; checkedAt: number }[];
    };
    let restored = 0;
    for (const p of j.proxies ?? []) {
      const c: CachedProxy = { server: p.server, validAt: p.validAt, checkedAt: p.checkedAt };
      if (liveRemaining(c) > 0) {
        pool.push(c);
        restored++;
      }
    }
    if (restored) log(`🌐 [dps] 从 ${POOL_FILE} 恢复 ${restored} 枚未到期 IP（凭证由配置注入）`);
  } catch (e) {
    log(`[dps] 池恢复失败（忽略）：${(e as Error).message}`);
  }
}
loadPool();

function liveRemaining(p: CachedProxy): number {
  return p.validAt - (Date.now() - p.checkedAt) / 1000;
}

async function requestOnce(): Promise<ProxyOpts[]> {
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
      log(`[dps] HTTP ${res.status}`);
      return [];
    }
    const j = (await res.json()) as { code?: number; msg?: string; data?: { proxy_list?: string[] } };
    log(`[dps] getdps 响应：${JSON.stringify(j)}`);
    if (j.code !== 0 || !j.data?.proxy_list?.length) {
      log(`[dps] code=${j.code} msg=${j.msg ?? ''}`);
      return [];
    }
    // 返回几枚存几枚（当前套餐 num=1 只回一枚，代码按多枚通用处理）
    const opts: ProxyOpts[] = [];
    for (const entry of j.data.proxy_list) {
      const [host, port] = entry.split(':');
      if (!host || !port) continue;
      opts.push({
        server: `http://${host}:${port}`,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      });
    }
    return opts;
  } catch (e) {
    log(`[dps] 请求异常：${(e as Error).message}`);
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
    log(`[dps] getdpsvalidtime 响应：${JSON.stringify(j)}`);
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
  let batch = await requestOnce();
  if (!batch.length) {
    batch = await requestOnce();
    if (!batch.length) return [];
  }
  return await seed(batch);
}

/** 取新一批 IP（并发去重）：已有在途请求则直接复用，不重复打 getdps */
async function ensureFresh(): Promise<CachedProxy[]> {
  if (!refillPromise) {
    refillPromise = (async () => {
      const fresh = await refill();
      if (fresh.length) {
        pool.push(...fresh);
        savePool();
      }
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
    savePool();
    // 池内随机挑一枚剩余 >minTtl 的：均匀分散使用，不总是打剩余最高的那一枚
    const usable = pool.filter((p) => liveRemaining(p) > minTtl);
    if (usable.length) {
      const pick = usable[Math.floor(Math.random() * usable.length)];
      log(`🌐 [dps] 复用缓存代理：${pick.server}（剩余约 ${Math.round(liveRemaining(pick))}s，池内可用 ${usable.length} 枚）`);
      return withCreds(pick);
    }
  }

  // 无可用缓存 → 取新一批（并发去重：同一在途请求只打一次 getdps）
  const fresh = await ensureFresh();
  if (!fresh.length) return null;
  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  log(`🌐 [dps] 新取代理：${pick.server}（剩余约 ${Math.round(liveRemaining(pick))}s）`);
  return withCreds(pick);
}

/** 从配置注入账密：池内条目（含从盘上恢复的）不携带凭证 */
function withCreds(p: CachedProxy): ProxyOpts {
  return {
    server: p.server,
    ...(config.dps.username ? { username: config.dps.username } : {}),
    ...(config.dps.password ? { password: config.dps.password } : {}),
  };
}
