// 快代理私密代理：每次调用取一个新 IP（Java 侧参考 ProxyUtils.getDpsWithOkHttp）。
// 响应：{ code, msg, data: { proxy_list: ["ip:port"], count } }，code=0 才算成功。
// 账密走配置，不在响应里。

import { config } from '../config/index.js';

export interface ProxyOpts {
  server: string;
  username?: string;
  password?: string;
}

const API = 'https://dps.kdlapi.com/api/getdps';
const TIMEOUT_MS = 20000;

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

/** 取一个新代理 IP；未配置凭据 / 失败 → 返回 null（失败重试一次） */
export async function fetchDpsProxy(): Promise<ProxyOpts | null> {
  if (!config.dps.secretId || !config.dps.secretKey) return null;
  const first = await requestOnce();
  if (first) return first;
  return await requestOnce();
}
