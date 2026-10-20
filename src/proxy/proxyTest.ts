// 静态代理连通性测试：用与采集同源的浏览器画像（系统 Chrome、有头）经代理打开取 IP 页面，
// 返回真实出口 IP 与耗时。只验证出口可用性，不读写任何账号 profile。
import { chromium } from 'playwright';
import { chromeOptions } from '../browser/launchProfile.js';

export interface ProxyTestInput {
  server: string;
  username?: string;
  password?: string;
}

export interface ProxyTestResult {
  ok: boolean;
  ms: number;
  exitIp?: string;
  detail?: string;
  error?: string;
}

const IP_URLS = ['https://myip.ipip.net', 'https://api.ipify.org?format=json'];
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const PAGE_TIMEOUT_MS = 12_000;

export async function testProxy(p: ProxyTestInput, timeoutMs = 30_000): Promise<ProxyTestResult> {
  const t0 = Date.now();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let lastErr = '';
  try {
    // 与登录/采集同一份启动画像（系统 Chrome、有头、同一套自动化标记处理），只是不挂 profile
    browser = await chromium.launch(chromeOptions(p));
    const page = await browser.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    for (const url of IP_URLS) {
      if (Date.now() - t0 > timeoutMs) {
        lastErr = `总耗时超过 ${Math.round(timeoutMs / 1000)}s`;
        break;
      }
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        const text = ((await page.evaluate(() => (document.body ? document.body.innerText : ''))) || '').trim();
        const exitIp = text.match(IP_RE)?.[0];
        if (exitIp) {
          return {
            ok: true,
            ms: Date.now() - t0,
            exitIp,
            detail: text.replace(/\s+/g, ' ').slice(0, 160),
          };
        }
        lastErr = `页面已打开但未取到出口 IP（${url}）`;
      } catch (e) {
        lastErr = String((e as Error)?.message ?? e).split('\n')[0];
      }
    }
    return { ok: false, ms: Date.now() - t0, error: lastErr || '未知错误' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).split('\n')[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
