// 收录检测调度器 v2：任务池 + (平台,IP) 冷却 + 账号级调度。
//
// 核心规则：
//   - 任务 = 词 × 平台，最小执行单元
//   - 调度单元 = 账号（IP 是账号的绑定属性）
//   - 冷却键 = (平台, IP)，该组合使用后进入 GEO_PLATFORM_IP_INTERVAL 秒冷却
//   - 槽位 = 同时运行的浏览器数 = 启用平台数（GEO_MAX_SLOTS=0 时自动）
//   - 同 IP 不同平台可并发，同平台不同 IP 可并发，同平台同 IP 必须间隔
//   - 任务在池里等冷却，无到期时间；冷却到期自动被扫描捞起
//   - 预检：目标平台无可用账号 → error + 停止本轮
//
// 账号占用/释放/冷却标记由 loginRegistry.allocateAccount / releaseAccount 负责，
// 调度器只维护任务池和槽位计数。

import fs from 'fs';
import { accountRepo, Account, accountDirOf } from '../storage/accountRepo.js';
import { allocateAccount } from './loginRegistry.js';
import { config } from '../config/index.js';

export interface SchedulerTask {
  wordId: string;
  keyword: string;
  platform: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  enqueuedAt: number;
  accountId?: string;
  failReason?: string;
}

export type TaskExecutor = (task: SchedulerTask, acc: Account) => Promise<void>;
export type SchedulerLog = (line: string) => void;

// ─────────────────────────── 内部状态 ───────────────────────────

let taskPool: SchedulerTask[] = [];
let slotCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;
let executor: TaskExecutor | null = null;
let logger: SchedulerLog = console.log;

// ─────────────────────────── 挑账号 ───────────────────────────

/** 现场申请一个可用账号：调 allocateAccount（含 active+enabled+未占用+有profile+(平台,IP)未冷却 检查） */
async function tryAcquire(platform: string): Promise<Account | null> {
  const ready = await allocateAccount(platform);
  if (!ready.ok || !ready.accountId) return null;
  // allocateAccount 只返回 accountId/dir，拿完整账号信息（含 proxyId）用于日志
  const acc = await accountRepo().get(platform, ready.accountId);
  return acc ?? null;
}

// ─────────────────────────── 扫描循环 ───────────────────────────

async function scanOnce(maxSlots: number): Promise<void> {
  for (const task of taskPool) {
    if (task.state !== 'pending') continue;
    if (slotCount >= maxSlots) break;
    const acc = await tryAcquire(task.platform);
    if (!acc) continue;
    task.state = 'running';
    task.accountId = acc.id;
    slotCount++;
    const ipLabel = acc.ipMode === 'dynamic' ? '动态IP' : acc.proxyId ? `proxy#${acc.proxyId}` : '宿主机';
    logger(`[scheduler] 词${task.wordId}「${task.keyword}」×${task.platform} 开始（账号 ${acc.id}，${ipLabel}）`);
    const exec = executor;
    if (!exec) {
      task.state = 'failed';
      task.failReason = '调度器未配置 executor';
      slotCount--;
      continue;
    }
    // 账号释放和 (平台,IP) 冷却标记由 execute 内部的 releaseAccount 负责，
    // 调度器只在 finally 里归还槽位
    exec(task, acc)
      .then(() => {
        task.state = 'done';
        slotCount--;
        logger(`[scheduler] 词${task.wordId}×${task.platform} 完成`);
      })
      .catch((e: unknown) => {
        task.state = 'failed';
        task.failReason = e instanceof Error ? e.message : String(e);
        slotCount--;
        logger(`[scheduler] 词${task.wordId}×${task.platform} 失败：${task.failReason}`);
      });
  }
}

// ─────────────────────────── 对外 API ───────────────────────────

/** 启动调度器（常驻扫描，任务池空时空转）。maxSlots=同时运行的浏览器上限。 */
export function startScheduler(exec: TaskExecutor, maxSlots: number, log?: SchedulerLog): void {
  executor = exec;
  if (log) logger = log;
  if (timer) return;
  timer = setInterval(async () => {
    if (scanning) return;
    scanning = true;
    try {
      await scanOnce(maxSlots);
    } catch (e) {
      logger(`[scheduler] 扫描异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      scanning = false;
    }
  }, config.schedulerTickSec * 1000);
}

/** 停止调度器 */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 任务入池 */
export function enqueueTasks(tasks: SchedulerTask[]): void {
  taskPool.push(...tasks);
}

/** 清空任务池（新一轮开始前调用） */
export function clearTasks(): void {
  taskPool = [];
}

/** 当前任务池快照 */
export function getTasks(): SchedulerTask[] {
  return [...taskPool];
}

/** 池内所有任务都已完成（done/failed）且池非空 */
export function allDone(): boolean {
  return taskPool.length > 0 && taskPool.every((t) => t.state === 'done' || t.state === 'failed');
}

/** 预检：每个目标平台是否至少有一个可用账号（active+enabled+有profile）。
 *  不检查冷却——冷却会到期，是可等待的资源。 */
export async function precheck(platforms: string[]): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const p of platforms) {
    const accounts = await accountRepo().list(p);
    const usable = accounts.filter(
      (a) => a.status === 'active' && a.enabled !== false && fs.existsSync(accountDirOf(a.id))
    );
    if (usable.length === 0) missing.push(p);
  }
  return { ok: missing.length === 0, missing };
}

/** 重置调度器全部内存状态（测试/重启用） */
export function resetScheduler(): void {
  stopScheduler();
  taskPool = [];
  slotCount = 0;
  scanning = false;
}
