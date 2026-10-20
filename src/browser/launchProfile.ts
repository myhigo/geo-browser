// 浏览器启动画像：登录 / 采集 / 登录态探测 / 代理测试共用同一份启动参数与反自动化注入（2026-10-20 用户定）。
//
// 前提：本机运行 → 直接用系统 Chrome，且**所有入口一律有头**（不存在无头模式，也没有开关）。
// 背景：同一账号若「登录时有头、采集时无头」，平台看到的是两台不同设备——
// UA 从 Chrome/155 变成 HeadlessChrome/155、窗口从真实桌面变成 800x600、GPU/语言/核数全变。
// 这种自相矛盾的环境特征比「多账号同指纹」更容易触发风控。故启动参数只保留这一份，
// 任何入口都不许自己拼 args。

import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { config } from '../config/index.js';
import { nextWindowPosition } from '../windowRaise.js';

/** launchPersistentContext 的选项集合 = 启动参数 + 上下文参数，两个入口共用同一类型 */
export type ChromeOptions = Parameters<typeof chromium.launchPersistentContext>[1];

/** 采集/登录用的代理描述（与 loginRegistry 的 ProxyOpts 同形，避免反向依赖） */
export type ProxySpec = { server: string; username?: string; password?: string };

/** 窗口几何：GEO_WINDOW 决定尺寸与基准位置（多窗口按基准位级联错开）；
 *  未配置时 Windows 强制最大化——后台进程拉起的窗口常被系统最小化。
 *  ⚠️ 登录与采集必须走同一段逻辑，否则 screen/outerWidth 不一致即设备指纹不一致。 */
function windowArgs(): string[] {
  const w = config.windowSize;
  if (!w) return process.platform === 'win32' ? ['--start-maximized'] : [];
  const args = [`--window-size=${w.width},${w.height}`];
  if (w.x != null && w.y != null) {
    const pos = nextWindowPosition({ x: w.x, y: w.y, width: w.width });
    args.push(`--window-position=${pos.x},${pos.y}`);
  }
  return args;
}

/** 上下文选项：登录与采集一致——关闭视口模拟（固定 1280x800 本身就是模拟痕迹）、禁止下载 */
export function contextOptions(): ChromeOptions {
  return { viewport: null, acceptDownloads: false };
}

/** 统一的 Chromium 启动参数（只有启动项，不含 viewport/acceptDownloads 这类上下文项）。
 *  headless 恒为 false：本机运行直接开真实窗口，登录/采集/探测/代理测试的设备特征完全一致。
 *  不覆写 UA：系统 Chrome 的 UA 与 navigator.platform、sec-ch-ua 天然一致。
 *  持久上下文调用方还需合并 contextOptions()（launchPersistentContext 同时接受两类选项）。 */
export function chromeOptions(proxy?: ProxySpec, chromePath?: string): ChromeOptions {
  const o: ChromeOptions = {
    headless: false,
    slowMo: 20, // 有头模式下放慢，便于人工可视监控与点击稳定
    args: [
      '--disable-blink-features=AutomationControlled',
      // WebRTC 只允许走「代理 UDP」：页面自带公共 STUN 时会用 UDP 直连拿 srflx 候选，
      // 实测能拿到本机真实公网 IP（221.221.157.188），与账号绑定的静态/动态代理无关 →
      // 所有账号共用一枚真实 IP，是最强的跨账号关联信号。
      // ⚠️ 生效的是 --webrtc-ip-handling-policy（无 force- 前缀）。实测带 force- 前缀的
      //    --force-webrtc-ip-handling-policy=disable_non_proxied_udp 在本机 Chrome 155 上无效
      //    （srflx 照旧泄漏），两者不要混用。
      // 代价：直连（local 出口）拿不到任何候选 = 页面可探测「WebRTC 不可用」；国内网络下
      // 企业防火墙/代理环境本就常见此形态，远优于泄漏真实 IP。
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ...windowArgs(),
    ],
    // 去掉 Playwright 默认注入的 --enable-automation（会留下 cdc_ 钩子与 webdriver 标记）
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (chromePath ?? config.chromePath) {
    o.executablePath = (chromePath ?? config.chromePath) as string;
  } else {
    // 登录/采集统一用本机系统 Chrome：版本与真实用户一致，避免 Playwright 自带 chromium 的版本差异
    o.channel = 'chrome';
  }
  if (proxy) {
    o.proxy = config.proxyBypass ? { ...proxy, bypass: `${config.proxyBypass}, <-loopback>` } : proxy;
  }
  return o;
}

/** 反自动化注入：登录/采集/探测同一份。
 *  只做两件确实有效的事：
 *   ① 抹掉 navigator.webdriver（Playwright 的自动化标记）；
 *   ② 预留滚动条槽位（滚动条出现/消失引起的布局抖动会污染点击坐标）。
 *  ⚠️ 不伪造 languages/hardwareConcurrency/deviceMemory：这几个字段在 Chrome 里是
 *     Navigator.prototype 上的只读 getter，实例级 defineProperty 静默失效（2026-10-20 实测
 *     Chrome 155 仍是真实值 4），硬改只会制造与实际 CPU/系统语言矛盾的新特征。
 *     只是「看起来像真人浏览器」，不破解、不绕过任何验证码或登录。 */
const antiDetectScript = (): void => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  } catch {
    /* ignore */
  }
  try {
    // 预留滚动条槽位：滚动条出现/消失引起的布局宽度变化是「页面猛的一缩」抖动的根源
    const st = document.createElement('style');
    st.textContent = 'html{scrollbar-gutter:stable;}';
    (document.head || document.documentElement).appendChild(st);
  } catch {
    /* ignore */
  }
};

/** 给上下文挂上反自动化注入（每个新文档最早时机生效，含跨域 iframe） */
export async function applyAntiDetect(context: BrowserContext): Promise<void> {
  await context.addInitScript(antiDetectScript).catch(() => {});
}
