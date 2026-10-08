// 账号台账仓储层（MySQL 实现）。
//
// 上层 Account.id 即库里的 account_code（如 doubao-1），自增 id 仅库内使用。

import path from 'path';
import { paths, config } from '../config/index.js';
import { dbPool } from '../db/pool.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export type AccountStatus = 'none' | 'waiting' | 'active' | 'cooling' | 'failed';

export interface Account {
  id: string; // = account_code（如 doubao-1）
  /** 专属 profile 目录：由 account_code 派生（path.join(paths.profilesRoot, id)），不落库 */
  dir: string;
  remark?: string;
  /** 登录后抓取的账号昵称 */
  nickname?: string;
  status: AccountStatus;
  note?: string;
  createdAt?: number;
  lastUsedAt?: number;
  todayQueries?: number;
  /** 最后更新 todayQueries 的本地日期 YYYY-MM-DD，用于跨天自动归零 */
  queryDate?: string;
  consecutiveFails?: number;
  /** 停用后不参与挑号 */
  enabled?: boolean;
  proxyHost?: string;
  proxyPort?: number;
  /** 绑定代理 IP 的 id（geo_ui_proxy_ip.id）；null/未填 = 不绑代理（走宿主机出口） */
  proxyId?: number;
  /** 出口模式：local=本地IP直连；static=绑定静态代理(proxy_id)；dynamic=每次采集取快代理动态IP。
   *  必填，默认 local（直连）；不允许 null，需显式选择 static/dynamic */
  ipMode?: 'local' | 'static' | 'dynamic';
  /** 占用者（instanceId）；null/空 = 空闲。跨重启可据此回收脏占用 */
  leasedBy?: string | null;
}

export interface AccountRepo {
  list(platformId: string): Promise<Account[]>;
  get(platformId: string, accountId: string): Promise<Account | undefined>;
  /** 局部更新；不存在返回 undefined */
  patch(platformId: string, accountId: string, patch: Partial<Account>): Promise<Account | undefined>;
  add(platformId: string, account: Account): Promise<void>;
  remove(platformId: string, accountId: string): Promise<void>;
}

/** 账号 profile 目录：由 account_code 派生，本机路径与代码/环境变量一致，换机后 GEO_DATA_ROOT 一致即正确 */
export const profileDirOf = (platformId: string, seq: number): string =>
  path.join(paths.profilesRoot, `${platformId}-${seq}`);
export const accountDirOf = (accountId: string): string =>
  path.join(paths.profilesRoot, accountId);


// ─────────────────────────── MySQL 实现 ───────────────────────────

/** 上层字段 → 列名白名单（防注入：只认这些 key；dir 不落库，由 account_code 派生） */
const FIELD_MAP: Record<string, string> = {
  id: 'account_code',
  remark: 'remark',
  nickname: 'nickname',
  status: 'status',
  note: 'note',
  createdAt: 'created_at',
  lastUsedAt: 'last_used_at',
  todayQueries: 'today_queries',
  queryDate: 'query_date',
  consecutiveFails: 'consecutive_fails',
  enabled: 'enabled',
  proxyHost: 'proxy_host',
  proxyPort: 'proxy_port',
  proxyId: 'proxy_id',
  ipMode: 'ip_mode',
  leasedBy: 'leased_by',
};

/** note 列写入长度保护：浏览器启动失败等报错可能很长（含 ASCII 提示框），超长截断，
 *  避免 ER_DATA_TOO_LONG 让一次本该写入的失败状态反过来拖垮进程。 */
const NOTE_MAX = 500;
const clipNote = (v: unknown): unknown =>
  typeof v === 'string' && v.length > NOTE_MAX ? v.slice(0, NOTE_MAX) : v;

const SELECT_COLS = `account_code AS id, remark, nickname, status, note,
  enabled,
  UNIX_TIMESTAMP(created_at) * 1000 AS createdAt,
  UNIX_TIMESTAMP(last_used_at) * 1000 AS lastUsedAt,
  today_queries AS todayQueries, query_date AS queryDate,
  consecutive_fails AS consecutiveFails,
  proxy_host AS proxyHost, proxy_port AS proxyPort, proxy_id AS proxyId, ip_mode AS ipMode, leased_by AS leasedBy`;

interface Row extends RowDataPacket {
  id: string;
  remark?: string | null;
  nickname?: string | null;
  status: AccountStatus;
  note?: string | null;
  enabled: number;
  createdAt?: number | string | null;
  lastUsedAt?: number | string | null;
  todayQueries?: number | null;
  queryDate?: string | null;
  consecutiveFails?: number | null;
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyId?: number | null;
  ipMode?: string;
  leasedBy?: string | null;
}

const toAccount = (r: Row): Account => ({
  id: r.id,
  dir: accountDirOf(r.id),
  remark: r.remark ?? undefined,
  nickname: r.nickname ?? undefined,
  status: r.status,
  note: r.note ?? undefined,
  createdAt: r.createdAt == null ? undefined : Number(r.createdAt),
  lastUsedAt: r.lastUsedAt == null ? undefined : Number(r.lastUsedAt),
  todayQueries: r.todayQueries ?? 0,
  queryDate: r.queryDate ?? undefined,
  consecutiveFails: r.consecutiveFails ?? 0,
  enabled: r.enabled === 1,
  proxyHost: r.proxyHost ?? undefined,
  proxyPort: r.proxyPort ?? undefined,
  proxyId: r.proxyId == null ? undefined : Number(r.proxyId),
  ipMode: (r.ipMode as 'local' | 'static' | 'dynamic') ?? 'local',
  leasedBy: r.leasedBy ?? null,
});

/** 值转换：时间戳→FROM_UNIXTIME、布尔→0/1、其余原样 */
const toColumnValue = (key: string, v: unknown): unknown => {
  if (key === 'createdAt' || key === 'lastUsedAt') {
    return v == null ? null : new Date(v as number);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? null;
};

export class MysqlAccountRepo implements AccountRepo {
  async list(platformId: string): Promise<Account[]> {
    const [rows] = await dbPool().query<Row[]>(
      `SELECT ${SELECT_COLS} FROM geo_ui_platform_account
        WHERE node_id = ? AND platform_id = ?
        ORDER BY created_at DESC, id DESC`,
      [config.nodeId, platformId]
    );
    return rows.map(toAccount);
  }

  async get(platformId: string, accountId: string): Promise<Account | undefined> {
    const [rows] = await dbPool().query<Row[]>(
      `SELECT ${SELECT_COLS} FROM geo_ui_platform_account
        WHERE node_id = ? AND platform_id = ? AND account_code = ?`,
      [config.nodeId, platformId, accountId]
    );
    return rows.length ? toAccount(rows[0]) : undefined;
  }

  async patch(
    platformId: string,
    accountId: string,
    patch: Partial<Account>
  ): Promise<Account | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = FIELD_MAP[k];
      if (!col || k === 'id') continue; // 主键不参与更新
      sets.push(`${col} = ?`);
      vals.push(toColumnValue(k, k === 'note' ? clipNote(v) : v));
    }
    if (!sets.length) return this.get(platformId, accountId);
    const [res] = await dbPool().query<ResultSetHeader>(
      `UPDATE geo_ui_platform_account SET ${sets.join(', ')}
        WHERE node_id = ? AND platform_id = ? AND account_code = ?`,
      [...vals, config.nodeId, platformId, accountId]
    );
    return res.affectedRows ? this.get(platformId, accountId) : undefined;
  }

  async add(platformId: string, account: Account): Promise<void> {
    await dbPool().query(
      `INSERT INTO geo_ui_platform_account
         (node_id, platform_id, account_code, remark, nickname, status, note,
          today_queries, query_date, consecutive_fails, ip_mode, last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), NOW())`,
      [
        config.nodeId,
        platformId,
        account.id,
        account.remark ?? null,
        account.nickname ?? null,
        account.status,
        clipNote(account.note) ?? null,
        account.todayQueries ?? 0,
        account.queryDate ?? null,
        account.consecutiveFails ?? 0,
        account.ipMode ?? 'local',
        account.lastUsedAt ?? null,
      ]
    );
  }

  async remove(platformId: string, accountId: string): Promise<void> {
    await dbPool().query(
      `DELETE FROM geo_ui_platform_account WHERE node_id = ? AND platform_id = ? AND account_code = ?`,
      [config.nodeId, platformId, accountId]
    );
  }
}

// ─────────────────────────── 工厂 ───────────────────────────

let instance: AccountRepo | null = null;

/** 惰性构造：首次调用时才根据配置选择实现（避免模块加载期就连库） */
export function accountRepo(): AccountRepo {
  if (!instance) instance = new MysqlAccountRepo();
  return instance;
}
