import fs from 'fs';
import path from 'node:path';
import { paths } from '../config/index.js';

/**
 * 采集失败记录（本轮任务无法完成、无结果可交付时留痕）：
 * 写 <数据根>/collect-fails/<platform>-YYYY-MM-DD.jsonl，一行一条 JSON。
 * 只记录不回推——上层「有回推就处理」，失败推上去反而污染；等下轮拉词自然重试。
 */
export function appendCollectFail(rec: {
  platform: string;
  accountId: string;
  keyword: string;
  reason: string;
}): void {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const dir = paths.collectFailsRoot;
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    time: `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    platform: rec.platform,
    accountId: rec.accountId,
    keyword: rec.keyword,
    reason: rec.reason,
  });
  fs.appendFileSync(path.join(dir, `${rec.platform}-${day}.jsonl`), line + '\n');
}
