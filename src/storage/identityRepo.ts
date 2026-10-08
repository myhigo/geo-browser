// 匿名身份/轮换计数的键值仓储（对应 geo_ui_identity_state 表，MySQL 实现）。

import { config } from '../config/index.js';
import { dbPool } from '../db/pool.js';
import type { RowDataPacket } from 'mysql2';

export interface IdentityRepo {
  get(key: string): Promise<Record<string, unknown> | null>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
}

// ─────────────────────────── MySQL 实现 ───────────────────────────

interface PayloadRow extends RowDataPacket {
  payload: Record<string, unknown> | string;
}

export class MysqlIdentityRepo implements IdentityRepo {
  async get(key: string): Promise<Record<string, unknown> | null> {
    const [rows] = await dbPool().query<PayloadRow[]>(
      `SELECT payload FROM geo_ui_identity_state WHERE node_id = ? AND state_key = ?`,
      [config.nodeId, key]
    );
    if (!rows.length) return null;
    const p = rows[0].payload;
    return typeof p === 'string' ? (JSON.parse(p) as Record<string, unknown>) : p;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    await dbPool().query(
      `INSERT INTO geo_ui_identity_state (node_id, state_key, payload) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
      [config.nodeId, key, JSON.stringify(value)]
    );
  }
}

// ─────────────────────────── 工厂 ───────────────────────────

let instance: IdentityRepo | null = null;

export function identityRepo(): IdentityRepo {
  if (!instance) instance = new MysqlIdentityRepo();
  return instance;
}
