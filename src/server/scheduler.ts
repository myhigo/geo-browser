// 收录检测调度器 v2：任务池 + (平台,IP) 冷却 + 账号级调度。
//
// 核心规则：
//   - 任务 = 词 × 平台，最小执行单元
//   - 调度单元 = 账号（IP 是账号的绑定属性）
//   - 冷却键 = (平台, 实际出口IP)：local→127.0.0.1，static→代理 host，dynamic 不参与；同出口同平台须间隔 GEO_PLATFORM_IP_INTERVAL 秒
//   - 槽位 = 同时运行的浏览器数上限 = 启用平台数（GEO_MAX_SLOTS=0 时自动）
//   - 每平台同时只运行一个浏览器（无论账号模式），同平台严格串行
//   - 同 IP 不同平台可并发；同平台同 IP 必须间隔（按出口冷却 120s）
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
/** 每平台同时运行的浏览器上限（=1：同平台严格串行，无论账号模式） */
const MAX_PER_PLATFORM = 1;
/** 各平台正在运行的采集任务数（per-platform 并发护栏） */
const runningByPlatform = new Map<string, number>();
/** 每平台"无可用账号"告警节流：避免每个 pending 任务每轮都刷日志（最多每 60s 一次） */
const lastNoAccountWarn = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;
let executor: TaskExecutor | null = null;
let logger: SchedulerLog = console.log;

/** 平台任务完成：归还 per-platform 计数 */
function decPlatformRunning(p: string): void {
  const n = (runningByPlatform.get(p) ?? 0) - 1;
  if (n <= 0) runningByPlatform.delete(p);
  else runningByPlatform.set(p, n);
}

// ─────────────────────────── 挑账号 ───────────────────────────

/** 现场申请一个可用账号：调 allocateAccount（含 active+enabled+未占用+有profile+(平台,IP)未冷却 检查） */
async function tryAcquire(platform: string): Promise<{ acc: Account | null; reason?: string }> {
  const ready = await allocateAccount(platform);
  if (!ready.ok || !ready.accountId) return { acc: null, reason: ready.reason };
  // allocateAccount 只返回 accountId/dir，拿完整账号信息（含 proxyId）用于日志
  const acc = await accountRepo().get(platform, ready.accountId);
  return { acc: acc ?? null };
}

// ─────────────────────────── 扫描循环 ───────────────────────────

async function scanOnce(maxSlots: number): Promise<void> {
  for (const task of taskPool) {
    if (task.state !== 'pending') continue;
    if (slotCount >= maxSlots) break;
    // 每平台并发护栏：同平台已有任务在跑则跳过（一个平台同时只开一个浏览器）
    if ((runningByPlatform.get(task.platform) ?? 0) >= MAX_PER_PLATFORM) continue;
    const { acc, reason } = await tryAcquire(task.platform);
    if (!acc) {
      const now = Date.now();
      const last = lastNoAccountWarn.get(task.platform) ?? 0;
      if (now - last > 60_000) {
        logger(`[scheduler] 「${task.platform}」暂无可派发账号：${reason ?? '未知原因'}（任务保持等待，下个周期重试）`);
        lastNoAccountWarn.set(task.platform, now);
      }
      continue;
    }
    task.state = 'running';
    task.accountId = acc.id;
    slotCount++;
    runningByPlatform.set(task.platform, (runningByPlatform.get(task.platform) ?? 0) + 1);
    const ipLabel = acc.ipMode === 'dynamic' ? '动态IP' : acc.ipMode === 'static' ? (acc.proxyId ? `proxy#${acc.proxyId}` : '静态(未绑代理)') : '本地IP';
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
        decPlatformRunning(task.platform);
        logger(`[scheduler] 词${task.wordId}×${task.platform} 完成`);
      })
      .catch((e: unknown) => {
        task.state = 'failed';
        task.failReason = e instanceof Error ? e.message : String(e);
        slotCount--;
        decPlatformRunning(task.platform);
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
  runningByPlatform.clear();
  lastNoAccountWarn.clear();
  scanning = false;
}
