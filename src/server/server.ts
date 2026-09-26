import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { runDiagnostic } from '../diagnostics/run.js';
import { SourceInfo } from '../types.js';
import { PLATFORMS } from '../platforms/index.js';
import { ENABLED_PLATFORMS, PullConfig, runPullRound } from './pull.js';
import {
  AnalysisProgress,
  ANALYSIS_ROOT,
  createAnalysisStatus,
  listTasks,
  readTaskFile,
  runSourceAnalysis,
} from './sourceAnalysis.js';
import {
  LOGIN_DRIVERS,
  allocateAccount,
  setAccountEnabled,
  confirmLogin,
  cancelLogin,
  resetStaleWaiting,
  syncAccountLoginState,
  deleteAccount,
  listViews,
  loginBusy,
  logoutAccount,
  proxyOf,
  releaseAccount,
  startLogin,
  testAccount,
  closeTestAccount,
  listTestSessions,
  updateRemark,
} from './loginRegistry.js';
import { adminPageHtml } from './loginUI.js';
import { config, paths, describeConfig } from '../config/index.js';
import { accountRepo, Account, profileDirOf, accountDirOf } from '../storage/accountRepo.js';
import { proxyRepo, splitProxyHost } from '../storage/proxyRepo.js';
import { pingDb, releaseStaleLeases } from '../db/pool.js';
import { identityRepo } from '../storage/identityRepo.js';

const PORT = config.port;
const TIMEOUT_MS = config.timeoutMs;

// 平台标识统一为下层 modeId（qwen/wenxiaoyan/hunyuan/doubao/deepseek），对外接口直接透传，
// 不再做别名映射（2026-09-08 对齐：消除双命名导致的回推错位 bug）。

// 失败原因摘要（取错误/警告类备注）
function summarize(notes: string[]): string {
  const hits = notes.filter((n) => n.includes('❌') || n.includes('⚠️'));
  const picked = hits.length ? hits : notes;
  return picked.join('；').slice(0, 500) || '未知原因';
}

function siteFromUrl(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

class ApiError extends Error {
  constructor(
    public status: number,
    public msg: string
  ) {
    super(msg);
  }
}

// 身份策略（2026-09-03 定稿，用户 12:43 拍板）：
//  - 文心：匿名身份轮换 .profiles/wenxiaoyan-rotating（quota 4）。匿名仍可用（loginRequired=false、
//    sources 22~30），保留计数轮换。
//  - 千问：**单一匿名持久身份** .profiles/qwen。两种重生：①撞登录墙清空重生并自动重试一次；
//    ②**按对话数主动重生**（每 QIANWEN_CONVERSATION_LIMIT 个成功对话清空一次），在平台"约 5 新对话后弹登录提示"
//    的软阈值出现前就刷新，避免被标记。⚠️ 教训：不做多身份轮换——同 IP 快速轮换触发风控短限
//    （12:34 实测连新身份都要登录；12:40 冷却后单个干净匿名身份直接可用）。单身份低频清 cookie 最像真人。
// 计数/轮换状态存 identityRepo（file=.profiles/identity/<key>.json / mysql=geo_ui_kv，2026-09-25 对齐 geo-ui-browser）。
const ROTATIONS: Record<string, { dir: string; quota: number }> = {
  wenxiaoyan: { dir: path.join(paths.profilesRoot, 'wenxiaoyan-rotating'), quota: 4 },
};
// 撞墙才重生的平台（不预清空，撞登录墙时清空 + 自动重试一次）
const REACTIVE_RESET_PLATFORMS = new Set(['qwen']);
const QWEN_PROFILE_DIR = path.join(paths.profilesRoot, 'qwen');
// 千问匿名身份阈值：约 5 个新对话后平台弹登录提示（软阈值，不一定阻断回答），达到即主动清空重生，
// 避免提示出现——也契合「约 5 问一次清 cookie」的设计意图（非多身份轮换，单身份低频清 cookie 不触发风控）。
const QIANWEN_CONVERSATION_LIMIT = 5;
const QWEN_COUNT_KEY = 'qwen-conv-count';

async function readQwenCount(): Promise<number> {
  const st = await identityRepo().get(QWEN_COUNT_KEY);
  return (st?.count as number) ?? 0;
}

async function writeQwenCount(n: number): Promise<void> {
  await identityRepo().set(QWEN_COUNT_KEY, { count: n });
}

async function resetQwenIdentity(reason: string): Promise<void> {
  fs.rmSync(QWEN_PROFILE_DIR, { recursive: true, force: true });
  await writeQwenCount(0);
  console.log(`[qwen身份] ${reason}`);
}

type RotationState = { count: number };

const rotationKeyOf = (dir: string): string => `rotation:${dir}`;

async function readRotationState(dir: string): Promise<RotationState> {
  const st = await identityRepo().get(rotationKeyOf(dir));
  return (st as RotationState | null) ?? { count: 0 };
}

async function writeRotationState(dir: string, s: RotationState): Promise<void> {
  await identityRepo().set(rotationKeyOf(dir), s as unknown as Record<string, unknown>);
}

// 取身份：计数到额度 → 清空 profile 目录（新身份）并归零
async function acquireIdentity(platform: string): Promise<void> {
  const cfg = ROTATIONS[platform];
  const st = await readRotationState(cfg.dir);
  if (st.count >= cfg.quota) {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
    await writeRotationState(cfg.dir, { count: 0 });
    console.log(`[${platform}身份] 已用满 ${cfg.quota} 次，清空 storage 重生匿名身份`);
  }
}

// 归还身份：计数 +1；撞到登录墙（异常消耗/口径变化）→ 立即清空重生，不等计数
async function releaseIdentity(platform: string, loginRequired: boolean): Promise<void> {
  const cfg = ROTATIONS[platform];
  if (loginRequired) {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
    await writeRotationState(cfg.dir, { count: 0 });
    console.log(`[${platform}身份] 检测到登录墙，提前清空 storage 重生匿名身份`);
    return;
  }
  const st = await readRotationState(cfg.dir);
  await writeRotationState(cfg.dir, { count: st.count + 1 });
}

// 组装响应：截图 base64 + 回答 + 信源
export async function execute(
  platform: string,
  keyword: string,
  headed: boolean,
  accountId?: string
): Promise<{ screenshot: string; answer: string; sources: { title: string; url: string; siteName: string }[] }> {
  let userDataDir: string | undefined = path.join(paths.profilesRoot, platform);
  let waitLoginMs = 0;
  let ledgerAccountId: string | undefined;
  // 登录制平台统一走 /admin 账号台账（与 cli.ts 同一套逻辑，避免"CLI 能跑、服务端拿不到账号"）。
  // 判定用 LOGIN_DRIVERS 而非硬编码平台名：新增台账平台（DeepSeek 等）自动生效。
  const loginDriver = LOGIN_DRIVERS[platform];
  // 全平台登录制（2026-09-07：千问/文心由匿名切换为登录，所有大模型走登录台账）。
  // 登录制平台不参与任何匿名身份机制（轮换/重生），以下两标志对其强制失效。
  const isLoginPlatform = !!loginDriver?.loginRequired;
  const rotation = isLoginPlatform ? undefined : ROTATIONS[platform];
  const reactive = isLoginPlatform ? false : REACTIVE_RESET_PLATFORMS.has(platform);
  if (loginDriver?.loginRequired) {
    if (accountId) {
      // 调度器已挑好账号：直接用，跳过 allocateAccount（避免重复占用）
      const acc = await accountRepo().get(platform, accountId);
      if (!acc) throw new ApiError(404, `账号不存在：${accountId}`);
      if (acc.status !== 'active' || acc.enabled === false) throw new ApiError(409, `账号 ${accountId} 不可用（status=${acc.status} enabled=${acc.enabled}）`);
      if (!fs.existsSync(accountDirOf(accountId))) throw new ApiError(409, `账号 ${accountId} 本地无 profile`);
      ledgerAccountId = accountId;
      userDataDir = acc.dir;
      waitLoginMs = 0;
    } else {
      const ready = await allocateAccount(platform);
      if (!ready.ok) throw new ApiError(409, ready.reason ?? `${platform} 没有可用登录账号`);
      ledgerAccountId = ready.accountId;
      userDataDir = ready.dir;
      waitLoginMs = 0;
    }
  } else if (rotation) {
    await acquireIdentity(platform);
    userDataDir = rotation.dir;
  } else if (reactive) {
    userDataDir = QWEN_PROFILE_DIR;
  } else {
    waitLoginMs = headed ? 120_000 : 0; // 登录态平台：有头窗口内等人工登录
  }
  let result = await runDiagnostic(keyword, {
    platform,
    useSystemChrome: true,
    userDataDir,
    headless: !headed,
    waitLoginMs,
    proxy: ledgerAccountId ? await proxyOf(platform, ledgerAccountId) : undefined,
  });
  if (rotation) await releaseIdentity(platform, result.loginRequired);
  if (ledgerAccountId) {
    await releaseAccount(platform, ledgerAccountId, !!result.answerText && !result.loginRequired, result.loginRequired);
    // ⚠️ 登录平台：打开登录账号目录后仍检测到登录墙（磁盘登录态失效/从未落盘）→ 明确失败并提示重登，
    // 绝不默默以匿名/未登录态跑完冒充成功（2026-09-07 文心实测：登录目录无 BDUSS，整轮匿名问答还报 ok）。
    // 上面 releaseAccount 的 loginRequired=true 分支已把该账号标 failed，此处抛错终止本轮。
    if (result.loginRequired) {
      throw new ApiError(
        401,
        `「${LOGIN_DRIVERS[platform]?.label ?? platform}」${ledgerAccountId} 登录态失效或未持久化（磁盘上无有效登录会话），本轮已按失败处理。请到 /admin 对该账号点「退出登录」后重新登录，再重试。`
      );
    }
  }
  // 千问：单一匿名持久身份。①撞登录墙 → 清空重生并自动重试；②成功对话累计到阈值 → 主动清空重生，避免触发登录提示
  if (reactive) {
    if (result.loginRequired) {
      await resetQwenIdentity('撞登录墙，重置匿名身份并自动重试一次');
      result = await runDiagnostic(keyword, {
        platform,
        useSystemChrome: true,
        userDataDir: QWEN_PROFILE_DIR,
        headless: !headed,
        waitLoginMs: 0,
      });
    } else if (result.answerText) {
      const c = (await readQwenCount()) + 1;
      if (c >= QIANWEN_CONVERSATION_LIMIT) {
        await resetQwenIdentity(`已用满 ${QIANWEN_CONVERSATION_LIMIT} 个匿名对话，提前清空重生（避免触发登录提示）`);
      } else {
        await writeQwenCount(c);
      }
    }
  }

  if (!result.answerText) {
    throw new ApiError(500, summarize(result.notes));
  }
  // 2026-09-03 17:47 用户定：截图失败/未产出 → 不整页兜底，screenshot 留空（不因缺截图判失败）
  let screenshot = '';
  const shotRel = result.artifacts.qaScreenshot;
  if (shotRel) {
    const shotPath = path.join(result.sampleDir, shotRel);
    if (fs.existsSync(shotPath)) {
      screenshot = `data:image/png;base64,${fs.readFileSync(shotPath).toString('base64')}`;
    } else {
      console.log(`[${platform}] 截图文件缺失但已标记产出，忽略（screenshot 留空）`);
    }
  }
  const toSource = (s: SourceInfo) => ({
    title: s.title ?? '',
    url: s.url ?? '',
    siteName: s.platform ?? siteFromUrl(s.url),
  });
  return { screenshot, answer: result.answerText, sources: (result.sources ?? []).map(toSource) };
}

// 同平台串行、跨平台并行
const queues = new Map<string, Promise<void>>();
function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next);
  return next;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError(504, '超时：3分钟内未完成抓取')), TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// 采集问答
app.post('/api/web-collect', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawPlatform = typeof body.platform === 'string' ? body.platform.toLowerCase().trim() : '';
  const platform = rawPlatform;
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  const headed = body.headed === true;

  if (!platform || !PLATFORMS[platform]) {
    res
      .status(400)
      .json({ msg: `不支持的平台 "${rawPlatform || '(空)'}"，支持：qwen（千问）、wenxiaoyan（百度文心）、hunyuan（腾讯元宝）、doubao（豆包）、deepseek` });
    return;
  }
  if (!keyword) {
    res.status(400).json({ msg: 'keyword 不能为空' });
    return;
  }

  enqueue(platform, async () => {
    const data = await withTimeout(execute(platform, keyword, headed));
    res.status(200).json(data);
  }).catch((e: unknown) => {
    if (res.headersSent) return;
    if (e instanceof ApiError) {
      res.status(e.status).json({ msg: e.msg });
    } else {
      res.status(500).json({ msg: (e as Error).message || '抓取失败' });
    }
  });
});

// 拉模式（pull）：手动触发，分页拉词逐个采集，结果回推。
// 对方服务地址优先级：/api/pull/run 请求体 pullHost（admin 页可填，默认 http://127.0.0.1:8101）
//                  > 环境变量 GEO_PULL_HOST（服务启动时注入，作默认兜底）。
// 时间范围 startTime/endTime 由请求体透传（可选），不带则拉全部。
const envPullHost = process.env.GEO_PULL_HOST?.trim() || '';

const pullStatus = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  pages: 0,
  fetched: 0,
  success: 0,
  failed: 0,
  reportFailed: 0,
  lastError: '',
  host: '',
  stopping: false,
};

/** pull 中断信号：运行中点「停止」置 aborted=true，runPullRound 在分页/逐词节点检测后中断 */
let pullSignal: { aborted: boolean } | null = null;

// 手动触发一轮 pull：后台跑，202 立即返回；进度看 GET /api/pull/status 与服务日志
app.post('/api/pull/run', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // 对方服务地址：请求体 pullHost 优先，其次环境变量 GEO_PULL_HOST；允许省略 http:// 前缀
  const bodyHost = typeof body.pullHost === 'string' ? body.pullHost.trim() : '';
  let host = bodyHost || envPullHost;
  if (host && !/^https?:\/\//i.test(host)) host = `http://${host}`;
  if (host) {
    try {
      if (!new URL(host).hostname) throw new Error('empty hostname');
    } catch {
      res.status(400).json({ msg: `pullHost 无效：${host}` });
      return;
    }
  }
  if (!host) {
    res
      .status(400)
      .json({ msg: '缺少对方服务地址：请在请求体传 pullHost（admin 页可填），或启动时注入 GEO_PULL_HOST' });
    return;
  }
  if (pullStatus.running) {
    res.status(409).json({ msg: '已有一轮 pull 在运行，请等待其结束（可看 GET /api/pull/status）' });
    return;
  }
  // 平台：默认全部启用平台；勾选哪些就只跑哪些（body.platforms 数组，下层 modeId）。兼容旧的 body.platform 单值。
  const rawPlats = (
    (Array.isArray(body.platforms) ? body.platforms.map(String) : [])
      .concat(typeof body.platform === 'string' && body.platform.trim() ? [body.platform] : [])
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean) as string[]
  ).filter((p) => ENABLED_PLATFORMS.includes(p));
  const forced: string[] | undefined = rawPlats.length ? rawPlats : undefined;
  // 时间范围透传：调用方可带 startTime/endTime（yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss），不带则拉全部
  const startTime = typeof body.startTime === 'string' && body.startTime.trim() ? body.startTime.trim() : undefined;
  const endTime = typeof body.endTime === 'string' && body.endTime.trim() ? body.endTime.trim() : undefined;
  // 格式校验：只放行 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss（T 分隔也认），避免格式写错被静默透传、下层按空处理而拉到全量
  const TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/;
  const badTime: [string, string] | undefined =
    startTime && !TIME_RE.test(startTime)
      ? ['startTime', startTime]
      : endTime && !TIME_RE.test(endTime)
        ? ['endTime', endTime]
        : undefined;
  if (badTime) {
    res.status(400).json({ msg: `${badTime[0]} 格式不正确：应为 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss，当前「${badTime[1]}」` });
    return;
  }
  const headed = body.headed === true; // 默认无头；需要人工盯/首次登录等场景传 true
  pullStatus.running = true;
  pullStatus.startedAt = Date.now();
  pullStatus.finishedAt = 0;
  pullStatus.pages = 0;
  pullStatus.fetched = 0;
  pullStatus.success = 0;
  pullStatus.failed = 0;
  pullStatus.reportFailed = 0;
  pullStatus.lastError = '';
  pullStatus.host = host;
  pullStatus.stopping = false;
  pullSignal = { aborted: false };
  res.status(202).json({ msg: 'pull 轮次已开始，进度见 GET /api/pull/status 与服务日志' });
  const cfg: PullConfig = { host, pageSize: 20, startTime, endTime };
  const stamp = (): string => {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  console.log(`[${stamp()}] [pull] 触发：host=${host} headless=${!headed} platform=${forced ? forced.join(',') : 'auto(全部启用)'} startTime=${startTime ?? '-'} endTime=${endTime ?? '-'}`);
  // execute 自带平台身份策略（千问撞墙重生 / 文心轮换）；headed 由本轮请求决定
  runPullRound(cfg, (platform, keyword, accountId) => execute(platform, keyword, headed, accountId), forced, (line) => console.log(line), pullSignal)
    .then((s) => {
      pullStatus.running = false;
      pullStatus.finishedAt = Date.now();
      pullStatus.stopping = false;
      pullSignal = null;
      Object.assign(pullStatus, s);
      console.log(`[${stamp()}] [pull] 轮次结束：${JSON.stringify(s)}`);
    })
    .catch((e: unknown) => {
      pullStatus.running = false;
      pullStatus.finishedAt = Date.now();
      pullStatus.stopping = false;
      pullSignal = null;
      pullStatus.lastError = (e as Error).message || 'pull 轮次异常';
      console.error('[pull] 轮次异常：', pullStatus.lastError);
    });
});

// 手动中断正在运行的 pull 轮次：置中断信号，runPullRound 在分页/逐词节点检测后停止（已在途的并发采集会跑完）
app.post('/api/pull/stop', (_req, res) => {
  if (!pullSignal) {
    res.status(409).json({ msg: '当前没有运行中的 pull 轮次' });
    return;
  }
  pullSignal.aborted = true;
  pullStatus.stopping = true;
  res.status(200).json({ msg: '已发送停止信号，正在中断（进行中的采集会跑完后停止）' });
});

// pull 轮次进度（内存态，仅当轮）
app.get('/api/pull/status', (_req, res) => {
  res.status(200).json(pullStatus);
});

// ---------- 信源分析（页面输入多关键词 → 全部平台顺序采集 → 每平台一个 JSON 文件） ----------
// 口径见 sourceAnalysis.ts 顶部注释（citeCount 不去重 / 全程串行 / 按平台各自独立聚合）。
let analysisStatus: AnalysisProgress | null = null;

app.post('/api/source-analysis/run', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // 关键词：可接受数组，也可直接把 textarea 整段文本丢进来（按行切、去空行）
  const rawKw = body.keywords;
  const keywords = (Array.isArray(rawKw) ? rawKw.map(String) : String(rawKw ?? '').split('\n'))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keywords.length) {
    res.status(400).json({ msg: '请至少填一个关键词（每行一个）' });
    return;
  }
  if (analysisStatus?.running) {
    res.status(409).json({ msg: '已有一轮信源分析在运行，请等待其结束（可看 GET /api/source-analysis/status）' });
    return;
  }
  // 平台：默认全部启用平台；可传数组或逗号分隔串（直接传下层 modeId：qwen/wenxiaoyan/hunyuan/doubao/deepseek）
  const rawPlat = body.platforms;
  const wanted = (Array.isArray(rawPlat) ? rawPlat.map(String) : String(rawPlat ?? '').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const platforms = (wanted.length
    ? ENABLED_PLATFORMS.filter((p) => wanted.includes(p))
    : [...ENABLED_PLATFORMS]
  ).map((p) => ({ platform: p, modelId: p }));
  if (!platforms.length) {
    res.status(400).json({ msg: `没有匹配的平台，可选：${ENABLED_PLATFORMS.join(', ')}` });
    return;
  }
  const headed = body.headed === true; // 默认无头
  const name = typeof body.name === 'string' ? body.name : undefined;
  const mode: 'serial' | 'parallel' = body.mode === 'parallel' ? 'parallel' : 'serial';
  const status = createAnalysisStatus(keywords, platforms, name, mode);
  analysisStatus = status;
  res.status(202).json({ msg: '信源分析已开始，进度见 GET /api/source-analysis/status', taskId: status.taskId });
  console.log(
    `[信源分析] 触发：taskId=${status.taskId} 模式=${mode} 词数=${keywords.length} 平台=${platforms.map((p) => p.modelId).join(',')} headless=${!headed}`
  );
  runSourceAnalysis(status, keywords, (p, kw) => execute(p, kw, headed), (p) => p, (l) =>
    console.log(`[信源分析] ${l}`)
  ).catch((e: unknown) => {
    status.running = false;
    status.finishedAt = Date.now();
    status.lastError = (e as Error).message || '信源分析异常';
    console.error('[信源分析] 异常：', status.lastError);
  });
});

app.get('/api/source-analysis/status', (_req, res) => {
  res.status(200).json(analysisStatus ?? { running: false });
});

// 历史任务（倒序），页面回看/下载用
app.get('/api/source-analysis/tasks', (_req, res) => {
  res.status(200).json({ tasks: listTasks() });
});

// 产物文件；加 ?download=1 走附件下载
app.get('/api/source-analysis/file/:taskId/:file', (req, res) => {
  const content = readTaskFile(req.params.taskId, req.params.file);
  if (content === null) {
    res.status(404).json({ msg: '文件不存在' });
    return;
  }
  if (req.query.download === '1') {
    res.setHeader('content-disposition', `attachment; filename="${req.params.taskId}-${req.params.file}"`);
  }
  res.type('json').send(content);
});

// 打开产物目录（点击历史任务名称时调用）：macOS 用 open 唤起 Finder 选中目录，其余平台仅返回路径
app.post('/api/source-analysis/open', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const taskId = String(body.taskId ?? '').trim();
  // taskId 即产物目录名（允许中文/常见字符）；仅拦截路径穿越
  if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
    res.status(400).json({ msg: '非法任务 ID' });
    return;
  }
  const dir = path.join(ANALYSIS_ROOT, taskId);
  if (!dir.startsWith(ANALYSIS_ROOT) || !fs.existsSync(dir)) {
    res.status(404).json({ msg: '目录不存在' });
    return;
  }
  const target = JSON.stringify(dir); // 引号包裹，目录含空格也安全
  if (process.platform === 'darwin') {
    exec(`open ${target}`, (e) => {
      if (e) console.error('[信源分析] 打开目录失败：', e.message);
    });
  }
  res.status(200).json({ ok: true, msg: '已尝试打开目录', dir });
});

// ---------- 平台登录管理（页面 + 接口；账号级操作，id→dir 台账唯一映射防串） ----------
app.get('/admin', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.type('html').send(adminPageHtml());
});

app.get('/api/login/platforms', async (_req, res) => {
  const busy = loginBusy();
  const testing = new Set(listTestSessions());
  res.status(200).json({
    platforms: (await listViews()).map((p) => ({
      platformId: p.platformId,
      label: p.label,
      hint: p.hint,
      accounts: p.accounts.map((a) => ({
        ...a,
        busy: busy.accountId === a.id,
        testing: testing.has(`${p.platformId}/${a.id}`),
      })),
    })),
  });
});

// 已打开的测试窗口列表（platformId/accountId），前端轮询回显按钮状态
app.get('/api/login/test/sessions', (_req, res) => {
  res.status(200).json({ sessions: listTestSessions() });
});

// 采集平台清单（信源分析页勾选用）：平台 modeId / 中文名 / 是否登录制
app.get('/api/platforms', (_req, res) => {
  res.status(200).json({
    platforms: ENABLED_PLATFORMS.map((id) => ({
      platformId: id,
      label: PLATFORMS[id]?.label ?? id,
      modelId: id,
      loginRequired: !!LOGIN_DRIVERS[id]?.loginRequired,
    })),
  });
});

function bodyAccountId(req: { body?: unknown }): string | undefined {
  const b = (req.body ?? {}) as Record<string, unknown>;
  return typeof b.accountId === 'string' && b.accountId.trim() ? b.accountId.trim() : undefined;
}

// 新增账号（只建卡片不登录；选好代理后点卡片「登录」才开窗口）——2026-09-24 与 geo-ui-browser 对齐
app.post('/api/accounts/:platform', async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  if (!LOGIN_DRIVERS[platform]) {
    res.status(400).json({ msg: `未注册的登录平台：${platform}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rawProxyId = b.proxyId;
  const proxyId = rawProxyId == null || rawProxyId === '' || Number(rawProxyId) === 0 ? null : Number(rawProxyId);
  let ip: { host: string; port: number; protocol: string } | undefined;
  if (proxyId !== null) {
    if (!Number.isInteger(proxyId)) {
      res.status(400).json({ msg: 'proxyId 无效' });
      return;
    }
    const found = await proxyRepo().get(proxyId);
    if (!found) {
      res.status(404).json({ msg: '代理不存在' });
      return;
    }
    if (found.enabled === false) {
      res.status(400).json({ msg: '该代理已停用，请先在代理管理里启用' });
      return;
    }
    ip = found;
  }
  const accounts = await accountRepo().list(platform);
  let maxSeq = 0;
  for (const a of accounts) {
    const mm = /-(\d+)$/.exec(a.id);
    if (mm) maxSeq = Math.max(maxSeq, Number(mm[1]));
  }
  const seq = maxSeq + 1;
  const acc: Account = {
    id: `${platform}-${seq}`,
    dir: profileDirOf(platform, seq),
    remark: typeof b.remark === 'string' && b.remark.trim() ? b.remark.trim() : `账号${seq}`,
    status: 'none',
    enabled: true,
    ...(ip ? { proxyId, proxyHost: ip.host, proxyPort: ip.port } : {}),
    note: ip ? `已绑定代理 ${ip.host}:${ip.port}（${ip.protocol}）` : undefined,
  };
  await accountRepo().add(platform, acc);
  res.status(200).json({
    ok: true,
    msg: `已添加账号 ${acc.id}${ip ? `，绑定代理 ${ip.host}:${ip.port}` : ''}，点卡片「登录」开始登录`,
    accountId: acc.id,
  });
});

// 账号绑定 / 解绑代理 IP：绑定或换绑（含解绑）后账号必须重新登录（旧登录态归属旧出口，换出口即失效）
// 2026-09-22：宿主机直连也是池内一行（127.0.0.1:0, protocol=direct），账号绑它即走宿主机出口；
// 解绑（proxyId=null）= 不绑任何 IP，不参与词级调度。
app.post('/api/accounts/:platform/:accountId/proxy', async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  const accountId = String(req.params.accountId);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rawProxyId = b.proxyId;
  const proxyId = rawProxyId == null ? null : Number(rawProxyId);
  const acc = await accountRepo().get(platform, accountId);
  if (!acc) {
    res.status(404).json({ msg: '账号不存在' });
    return;
  }
  try {
    if (proxyId === null) {
      // 解绑：回到宿主机出口（proxyId 置 undefined 即写入 NULL）
      await accountRepo().patch(platform, accountId, {
        proxyId: undefined,
        proxyHost: undefined,
        proxyPort: undefined,
        status: 'none',
        note: `已解除代理绑定（${acc.proxyHost ?? '-'}），需重新登录`,
      });
      res.status(200).json({ ok: true, msg: '已解绑，该账号需重新登录' });
      return;
    }
    if (!Number.isInteger(proxyId)) {
      res.status(400).json({ msg: 'proxyId 无效（传 null 解绑）' });
      return;
    }
    const ip = await proxyRepo().get(proxyId);
    if (!ip) {
      res.status(404).json({ msg: '代理不存在' });
      return;
    }
    if (ip.enabled === false) {
      res.status(400).json({ msg: '该代理已停用，请先在代理管理里启用' });
      return;
    }
    await accountRepo().patch(platform, accountId, {
      proxyId,
      proxyHost: ip.host,
      proxyPort: ip.port,
      status: 'none',
      note: `已绑定代理 ${ip.host}:${ip.port}（${ip.protocol}），需重新登录`,
    });
    res.status(200).json({ ok: true, msg: `已绑定 ${ip.host}:${ip.port}，该账号需重新登录` });
  } catch (e) {
    res.status(500).json({ msg: `绑定失败：${(e as Error).message}` });
  }
});

app.post('/api/login/:platform/start', (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  if (!(id in LOGIN_DRIVERS)) {
    res.status(404).json({ msg: `未注册的登录平台：${id}` });
    return;
  }
  // 不带 accountId → 新开账号槽；带 → 指定账号（重新）登录
  startLogin(id, bodyAccountId(req))
    .then((r) => res.status(r.ok ? 200 : 409).json({ msg: r.msg, accountId: r.accountId }))
    .catch((e: unknown) => res.status(500).json({ msg: (e as Error).message }));
});

app.post('/api/login/:platform/verify', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await confirmLogin(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

// 取消登录：释放登录会话并重置状态（服务重启后残留的 waiting 也能在这里清理）
app.post('/api/login/:platform/cancel', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await cancelLogin(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

app.post('/api/login/:platform/logout', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await logoutAccount(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

app.post('/api/login/:platform/delete', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await deleteAccount(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

app.post('/api/login/:platform/remark', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const remark = typeof b.remark === 'string' ? b.remark.trim().slice(0, 30) : '';
  if (!accountId || !remark) {
    res.status(400).json({ msg: '缺少 accountId/remark' });
    return;
  }
  const r = await updateRemark(id, accountId, remark);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

// 启停账号：停用后不参与挑号
app.post('/api/accounts/:platform/:accountId/toggle', async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  const accountId = String(req.params.accountId);
  const want = (req.body ?? {}) as { enabled?: unknown };
  const acc = await accountRepo().get(platform, accountId);
  if (!acc) { res.status(404).json({ msg: '账号不存在' }); return; }
  const enabled = want.enabled === undefined ? acc.enabled === false : want.enabled === true;
  const r = await setAccountEnabled(platform, accountId, enabled);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg, enabled });
});

// ─────────────────── 代理 IP 管理 ───────────────────
app.get('/api/proxies', async (_req, res) => {
  try {
    const ips = await proxyRepo().list();
    const out = [];
    for (const ip of ips) {
      const n = await proxyRepo().countAccountsByProxy(ip.id).catch(() => 0);
      out.push({ ...ip, accounts: n });
    }
    res.status(200).json({ proxies: out });
  } catch (e) {
    res.status(500).json({ msg: `代理列表查询失败：${(e as Error).message}` });
  }
});

app.post('/api/proxies', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rawHost = typeof b.host === 'string' ? b.host.trim() : '';
  if (!rawHost) {
    res.status(400).json({ msg: '缺少 IP 或域名' });
    return;
  }
  const parsed = splitProxyHost(rawHost);
  // 端口优先取独立字段（前端 host/port 分开传，与 DB 两列对应）；未传时兼容旧的「IP:端口」合并写法
  const portFromBody =
    typeof b.port === 'number'
      ? b.port
      : typeof b.port === 'string' && b.port.trim()
        ? Number(b.port.trim())
        : undefined;
  const port = portFromBody ?? parsed.port;
  // 协议优先取独立字段；未传时按 host 前缀推断（socks5:// → socks5，否则 http）
  // port=0 表示「直连、不设代理」，协议统一记为 direct（端口 0 不是合法监听端口）
  const protocol =
    port === 0 ? 'direct' : b.protocol === 'socks5' || b.protocol === 'http' ? b.protocol : parsed.protocol;
  if (!parsed.host || !Number.isInteger(port) || port < 0 || port > 65535) {
    res.status(400).json({ msg: 'IP 与端口无效：端口需为 0-65535 的整数（0=直连不代理）' });
    return;
  }
  try {
    const p = await proxyRepo().add({
      host: parsed.host,
      port,
      protocol,
      username: typeof b.username === 'string' ? b.username.trim() || undefined : undefined,
      password: typeof b.password === 'string' ? b.password || undefined : undefined,
      note: typeof b.note === 'string' ? b.note.trim() || undefined : undefined,
    });
    res.status(200).json({ ok: true, msg: `已添加代理 ${p.host}:${p.port}（${p.protocol}）`, id: p.id });
  } catch (e) {
    res.status(500).json({ msg: `添加失败：${(e as Error).message}` });
  }
});

app.patch('/api/proxies/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ msg: 'id 无效' });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  if (typeof b.username === 'string') patch.username = b.username.trim();
  if (typeof b.password === 'string') patch.password = b.password;
  if (typeof b.note === 'string') patch.note = b.note.trim();

  // 出口字段（host/port/protocol）编辑：host 支持「IP:端口」或独立端口字段，校验与添加一致
  let exitChanged = false;
  if (typeof b.host === 'string' || typeof b.port === 'number' || typeof b.port === 'string' || typeof b.protocol === 'string') {
    const cur = await proxyRepo().get(id);
    if (!cur) {
      res.status(404).json({ msg: '代理不存在' });
      return;
    }
    const rawHost = typeof b.host === 'string' ? b.host.trim() : String(cur.host);
    const parsed = splitProxyHost(rawHost);
    const portFromBody =
      typeof b.port === 'number'
        ? b.port
        : typeof b.port === 'string' && b.port.trim()
          ? Number(b.port.trim())
          : cur.port;
    const port = portFromBody ?? parsed.port ?? cur.port;
    const protocol =
      port === 0
        ? 'direct'
        : b.protocol === 'socks5' || b.protocol === 'http'
          ? b.protocol
          : cur.protocol;
    if (!parsed.host || !Number.isInteger(port) || port < 0 || port > 65535) {
      res.status(400).json({ msg: 'IP 与端口无效：端口需为 0-65535 的整数（0=直连不代理）' });
      return;
    }
    if (parsed.host !== cur.host || port !== cur.port || protocol !== cur.protocol) {
      patch.host = parsed.host;
      patch.port = port;
      patch.protocol = protocol;
      exitChanged = true;
    }
  }

  try {
    const p = await proxyRepo().patch(id, patch);
    if (!p) {
      res.status(404).json({ msg: '代理不存在' });
      return;
    }
    // 出口变更 → 绑定账号的登录态归属旧出口，提示重新登录
    if (exitChanged) {
      for (const pid of Object.keys(LOGIN_DRIVERS)) {
        const accs = await accountRepo().list(pid).catch(() => [] as never[]);
        for (const a of accs as Array<{ id: string; proxyId?: number | null }>) {
          if (a.proxyId === id) {
            await accountRepo().patch(pid, a.id, { note: '代理已变更，需重新登录' }).catch(() => {});
          }
        }
      }
    }
    res.status(200).json({ ok: true, msg: '已更新' });
  } catch (e) {
    res.status(500).json({ msg: `更新失败：${(e as Error).message}` });
  }
});

app.delete('/api/proxies/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ msg: 'id 无效' });
    return;
  }
  try {
    const n = await proxyRepo().countAccountsByProxy(id);
    if (n > 0) {
      res.status(409).json({ msg: `该 IP 还有 ${n} 个账号绑定，请先解绑账号再删除` });
      return;
    }
    await proxyRepo().remove(id);
    res.status(200).json({ ok: true, msg: '已删除' });
  } catch (e) {
    res.status(500).json({ msg: `删除失败：${(e as Error).message}` });
  }
});

// 打开某账号的测试窗口（手动聊天，不跑自动化）
app.post('/api/login/:platform/test', (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  if (!(id in LOGIN_DRIVERS)) {
    res.status(404).json({ msg: `未注册的登录平台：${id}` });
    return;
  }
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  testAccount(id, accountId)
    .then((r) => res.status(r.ok ? 200 : 409).json({ msg: r.msg }))
    .catch((e: unknown) => res.status(500).json({ msg: (e as Error).message }));
});

// 关闭某账号的测试窗口
app.post('/api/login/:platform/test-close', (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  closeTestAccount(id, accountId)
    .then((r) => res.status(r.ok ? 200 : 400).json({ msg: r.msg }))
    .catch((e: unknown) => res.status(500).json({ msg: (e as Error).message }));
});

// /api/ 未匹配路由统一返回 JSON（Express 默认 404 是 HTML，前端解析会报错）
app.use('/api', (_req, res) => {
  res.status(404).json({ msg: '接口不存在' });
});
// /api/ 异常统一返回 JSON
app.use('/api', (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ msg: err.message || '服务器内部错误' });
});

// 启动 API 服务
export async function startServer(): Promise<void> {
  console.log(`[config] ${describeConfig()}`);
  if (config.storage === 'mysql') {
    // 连不上就在这里炸掉：绝不静默降级到文件存储（会导致"以为写库了其实写文件"）
    await pingDb();
    const recycled = await releaseStaleLeases(config.nodeId);
    console.log(`[db] 连接正常 (${config.db.host}:${config.db.port}/${config.db.database})${recycled ? `，回收脏占用 ${recycled} 条` : ''}`);
  }
  // 确保宿主机直连行存在（seed，幂等）：host=127.0.0.1 port=0 protocol=direct，与代理 IP 一样参与调度
  await proxyRepo().ensureDirectIp();
  // 清理服务重启后的 waiting 残留：内存登录会话已随进程丢失，waiting 账号无法再「验证登录」，
  // 统一重置为 none，避免账号卡在「登录窗口已打开，等待人工操作」无法手动清理
  await resetStaleWaiting();
  // 校验各账号本地登录态并回写库：本地无 profile（换机/目录被删）→ status=none（未登录）
  const { marked } = await syncAccountLoginState();
  if (marked > 0) console.log(`[login] 启动校验：${marked} 个账号本地无登录信息，已标记需重新登录`);
  app.listen(PORT);
}
