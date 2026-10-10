// 有头浏览器窗口「弹出到最上层」（仅 Windows 需要，mac 原生就把新窗口置前）。
//
// 背景：服务以隐藏窗口后台进程运行，Windows 的 STARTF_USESHOWWINDOW 会被子进程继承，
// 后台拉起的 Chrome 窗口既可能最小化，又因系统前台锁定不会自动置前——要点任务栏图标才显示。
//
// 手段（两层，均精确作用于本次拉起的实例，不误伤别的 Chrome 窗口）：
//   ① CDP：Browser.getWindowForTarget 读状态，最小化则 setWindowBounds(normal) 恢复（不强制最大化）；
//   ② user32：CDP SystemInfo.getProcessInfo 拿本实例 browser 进程 PID →
//      模拟按一下 ALT（keybd_event）绕过前台锁 → SetForegroundWindow 真正置前。
// CDP/user32 不可用时静默降级 page.bringToFront（只激活标签页，解不了 OS 层置前）。

import { spawnSync } from 'child_process';
import { Browser, BrowserContext, Page } from 'playwright';
import { log } from './log.js';

type Bounds = { windowState?: string };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 同步休眠（spawnSync 重试间隔用）：Atomics.wait 不阻塞事件循环外的定时器 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** spawnSync 偶发 EBUSY（杀软/沙箱瞬时锁文件）：重试 8 次、间隔 250ms */
function spawnSyncRetry(cmd: string, args: string[]): { stdout?: string } {
  for (let i = 0; i < 8; i++) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (!r.error) return r;
    if (i < 7) sleepSync(250);
  }
  return {};
}

/** OS 层置前：ShowWindow 显示/恢复 + ALT 技巧绕过前台锁 + SetForegroundWindow */
function osForeground(pids: number[]): void {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$t = Get-Process -Id ${pids.join(',')} | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
    'if (-not $t) { Write-Output NOHWND; exit }',
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte v,byte s,uint f,UIntPtr e); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);' -Name W -Namespace N",
    '$h = $t.MainWindowHandle',
    'if ([N.W]::IsIconic($h)) { [N.W]::ShowWindow($h,9) | Out-Null } else { [N.W]::ShowWindow($h,5) | Out-Null }',
    '[N.W]::keybd_event(0x12,0,0,[UIntPtr]::Zero)',
    '[N.W]::keybd_event(0x12,0,2,[UIntPtr]::Zero)',
    '[N.W]::SetForegroundWindow($h) | Out-Null',
    'Write-Output RAISED',
  ].join('\n');
  const r = spawnSyncRetry('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  log(`🪟 [window] osForeground: ${(r.stdout || '').trim() || 'no output'}`);
}

async function raiseWindow(browser: Browser, context: BrowserContext, page: Page): Promise<void> {
  if (process.platform !== 'win32') {
    await page.bringToFront().catch(() => {});
    return;
  }
  let pids: number[] = [];
  try {
    const bcdp = await browser.newBrowserCDPSession();
    const pcdp = await context.newCDPSession(page);
    const { targetInfo } = (await pcdp.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    // ① 恢复最小化：读回状态确认已恢复才罢手（窗口/CDP 就绪时机不保证，最多 5 次）
    for (let i = 0; i < 5; i++) {
      const { windowId, bounds } = (await bcdp.send('Browser.getWindowForTarget', {
        targetId: targetInfo.targetId,
      })) as { windowId: number; bounds?: Bounds };
      if (!bounds || bounds.windowState !== 'minimized') break;
      await bcdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await sleep(400);
    }
    // ② 本实例 browser 进程 PID（OS 层只置前这个窗口，不碰其他 Chrome）
    //    注意：CDP SystemInfo.ProcessInfo 里进程 ID 字段是 id 不是 pid
    try {
      const { processInfo } = (await bcdp.send('SystemInfo.getProcessInfo')) as unknown as {
        processInfo: { type: string; id: number }[];
      };
      pids = processInfo
        .filter((p) => p.type === 'browser' && typeof p.id === 'number')
        .map((p) => p.id);
    } catch {
      /* 版本差异拿不到 PID → 只能靠 CDP 恢复 + bringToFront 兜底 */
    }
  } catch {
    /* CDP 不可用（无头/版本差异）→ 交给 bringToFront 兜底 */
  }
  if (pids.length > 0) osForeground(pids);
  await page.bringToFront().catch(() => {});
}

export { raiseWindow };
