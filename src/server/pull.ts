// 拉模式（pull）：手动触发 → 分页拉关键词 → 调度器分配账号 → 采集 → 结果回推。
// 调度 v2（2026-09-26）：任务池 + (平台,IP) 冷却 + 账号级调度。
//   - 任务 = 词 × 平台，最小执行单元
//   - 同 IP 不同平台可并发，同平台不同 IP 可并发，同平台同 IP 必须间隔
//   - 预检：目标平台无可用账号 → error + 停止本轮
//   - 去掉旧的词间冷却 90-150s 和 PULL_PARALLEL_LIMIT

import { precheck, startScheduler, stopScheduler, enqueueTasks, clearTasks, allDone, getTasks, SchedulerTask } from './scheduler.js';

export interface PullConfig {
  /** 对方服务根地址，如 http://127.0.0.1:8080（服务启动时经 GEO_PULL_HOST 注入） */
  host: string;
  /** 每页条数，默认 20 */
  pageSize: number;
  /** 可选：只拉该时间后创建的词（如 2026-09-01）；不传则不带上 */
  startTime?: string;
  /** 可选：只拉该时间前创建的词（如 2026-09-03）；不传则不带上 */
  endTime?: string;
}

/** 单个词的采集回调（复用 server.ts 的 execute：身份/超时/解析/截图） */
export interface PullCollect {
  (platform: string, keyword: string, accountId?: string): Promise<{
    screenshot: string;
    answer: string;
    sources: { title: string; url: string; siteName: string }[];
  }>;
}

export interface PullSummary {
  pages: number;
  fetched: number;
  success: number;
  failed: number;
  reportFailed: number;
  lastError?: string;
}

// 平台标识统一使用下层系统的 modeId（qwen / wenxiaoyan / hunyuan / doubao / deepseek）。
export const ENABLED_PLATFORMS = ['qwen', 'wenxiaoyan', 'doubao', 'deepseek', 'hunyuan'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function ts(): string {
  const d = new Date();
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(
  cfg: PullConfig,
  page: number
): Promise<{ id: string; keyword: string; raw: Record<string, unknown> }[]> {
  const qs = new URLSearchParams({ current: String(page), size: String(cfg.pageSize) });
  if (cfg.startTime) qs.set('startTime', cfg.startTime);
  if (cfg.endTime) qs.set('endTime', cfg.endTime);
  const query = qs.toString().replace(/\+/g, '%20');
  const res = await fetch(`${cfg.host}/geoWebCollect/page?${query}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`拉词接口 HTTP ${res.status}`);
  const body = (await res.json()) as {
    code: number;
    msg?: string;
    data?: { records?: { id: string; keyWord: string }[] };
  };
  if (body.code !== 0) throw new Error(`拉词接口返回 code=${body.code} msg=${body.msg ?? ''}`);
  return (body.data?.records ?? []).map((r) => ({
    id: r.id,
    keyword: r.keyWord,
    raw: r as unknown as Record<string, unknown>,
  }));
}

// 已收录平台列表：对方服务 /geoWebCollect/page 的 record 中由 `collectedModels` 字段给出。
function collectedPlatformsOf(raw: Record<string, unknown>): string[] {
  const v = raw['collectedModels'];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

// 回推结果（对方接口收数组）；失败休眠 3 分钟后重试，最多重试 3 次（共 4 次尝试）
async function reportItems(
  cfg: PullConfig,
  items: unknown[],
  onLine?: (line: string) => void,
  platform?: string
): Promise<void> {
  const tag = platform ?? 'report';
  const log = (l: string): void => {
    const line = `[${ts()}][${tag}] ${l}`;
    if (onLine) onLine(line);
    else console.log(line);
  };
  let lastErr: unknown = null;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 3 * 60 * 1000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${cfg.host}/geoWebCollect/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(items),
      });
      if (!res.ok) throw new Error(`回推 HTTP ${res.status}`);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) {
        log(`⚠️ 回推失败（第 ${attempt + 1} 次尝试出错：${msg}）；休眠 3 分钟后重试（剩 ${MAX_RETRIES - attempt} 次）`);
        await sleep(RETRY_DELAY);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('回推失败');
}

function sourcesTextOf(sources: { title: string; url: string; siteName: string }[]): string {
  return sources.map((s) => [s.title, s.url].filter(Boolean).join(' ')).join('\n');
}

/**
 * 跑一整轮：从第 1 页起分页拉词，某页拉空即结束。
 * 每个词的目标平台：forcedPlatform > 词上自带 platform > 全部启用平台（ENABLED_PLATFORMS），
 * 每个目标平台独立采集、独立回推一条（modelId 用对方标识）。
 * 调度 v2：任务入池后由调度器自动分配账号执行，(平台,IP) 冷却控制节奏。
 * @param forcedPlatform 平台 id 数组（下层 modeId）；指定且非空则整轮只用这些平台；为空/不传则对全部启用平台采集
 * @param onLine 进度回调（打日志用）
 */
export async function runPullRound(
  cfg: PullConfig,
  collect: PullCollect,
  forcedPlatform?: string[],
  onLine?: (line: string) => void,
  signal?: { aborted: boolean }
): Promise<PullSummary> {
  const summary: PullSummary = { pages: 0, fetched: 0, success: 0, failed: 0, reportFailed: 0 };
  const log = (l: string): void => {
    const line = `[${ts()}][pull] ${l}`;
    if (onLine) onLine(line);
    else console.log(line);
  };

  // 目标平台集合
  const picked = forcedPlatform && forcedPlatform.length ? forcedPlatform.filter((p) => ENABLED_PLATFORMS.includes(p)) : [];
  const targets: string[] = picked.length ? picked : [...ENABLED_PLATFORMS];

  // 预检：每个目标平台是否至少有一个可用账号
  const check = await precheck(targets);
  if (!check.ok) {
    const labels = check.missing.map((p) => {
      const m: Record<string, string> = { qwen: '千问', wenxiaoyan: '文心', doubao: '豆包', deepseek: 'DeepSeek', hunyuan: '元宝' };
      return m[p] ?? p;
    });
    log(`[error] 以下平台无可用账号：${labels.join('、')}，停止本次收录检测`);
    summary.lastError = `无可用账号：${labels.join('、')}`;
    return summary;
  }
  log(`预检通过：${targets.join('/')} 均有可用账号`);

  // 槽位 = 启用平台数（GEO_MAX_SLOTS>0 时用配置值）
  const { config } = await import('../config/index.js');
  const maxSlots = config.maxSlots > 0 ? config.maxSlots : targets.length;

  // 调度器 executor：执行单个任务（调 execute + 回推）
  startScheduler(
    async (task, acc) => {
      const modelId = task.platform;
      const base = { keywordId: task.wordId, modelId };
      try {
        const r = await collect(task.platform, task.keyword, acc.id);
        const item = {
          ...base,
          success: true,
          answer: r.answer,
          sourcesText: sourcesTextOf(r.sources),
          references: r.sources,
          screenshot: r.screenshot || null,
          msg: null,
        };
        await reportItems(cfg, [item], onLine, task.platform);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        try {
          await reportItems(cfg, [{ ...base, success: false, answer: null, sourcesText: null, references: [], screenshot: null, msg: errMsg }], onLine, task.platform);
        } catch (pe) {
          summary.reportFailed += 1;
          summary.lastError = `#${task.wordId} ${modelId} 回推失败：${(pe as Error).message}`;
        }
      }
    },
    maxSlots,
    log
  );

  clearTasks();

  try {
    for (let page = 1; page <= 1000; page++) {
      if (signal?.aborted) { log('⚠️ 收到停止信号，中断本轮'); break; }
      let records: { id: string; keyword: string; raw: Record<string, unknown> }[] = [];
      try {
        records = await fetchPage(cfg, page);
      } catch (e) {
        summary.lastError = `第 ${page} 页拉词失败：${(e as Error).message}`;
        log(`⚠️ ${summary.lastError}`);
        break;
      }
      if (records.length === 0) {
        log(`第 ${page} 页为空，本轮结束`);
        break;
      }
      summary.pages = page;
      summary.fetched += records.length;
      log(`第 ${page} 页拉取 ${records.length} 词（累计 ${summary.fetched}）`);

      // 生成任务：词 × 平台（已收录的平台跳过）
      const tasks: SchedulerTask[] = [];
      for (const rec of records) {
        const collected = collectedPlatformsOf(rec.raw);
        const checkTargets = targets.filter((p) => !collected.includes(p));
        if (checkTargets.length === 0) {
          log(`#${rec.id} ${rec.keyword} 全部平台已收录（${collected.join('/') || '无'}），跳过检查`);
          continue;
        }
        log(`#${rec.id} ${rec.keyword} 已收录：${collected.join('/') || '无'}；本次检查：${checkTargets.join('/')}`);
        for (const platform of checkTargets) {
          tasks.push({ wordId: rec.id, keyword: rec.keyword, platform, state: 'pending', enqueuedAt: Date.now() });
        }
      }

      if (tasks.length === 0) {
        log(`第 ${page} 页全部已收录，无待检查任务`);
        continue;
      }

      enqueueTasks(tasks);
      log(`本页 ${tasks.length} 个任务入池，等待调度执行…`);

      // 等待本页所有任务完成（或中断信号）
      while (!allDone() && !signal?.aborted) {
        await sleep(2000);
      }

      // 统计本页结果
      const done = getTasks().filter((t) => t.state === 'done');
      const failed = getTasks().filter((t) => t.state === 'failed');
      summary.success += done.length;
      summary.failed += failed.length;
      log(`第 ${page} 页完成：成功 ${done.length} 失败 ${failed.length}（本轮累计 成功 ${summary.success} 失败 ${summary.failed}）`);
      clearTasks();
    }
  } finally {
    stopScheduler();
  }

  if (signal?.aborted) summary.lastError = '已手动停止';
  log(`本轮结束：${summary.fetched} 词 / 采集结果 成功 ${summary.success} 失败 ${summary.failed} / 回推失败 ${summary.reportFailed}`);
  return summary;
}
