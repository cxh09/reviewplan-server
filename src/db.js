import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * 单用户同步场景下，整份数据（待办 / 计划 / 高考日期 / 日程广场合集）
 * 作为一个 JSON 快照整体读写，用自增的 rev 做乐观锁，防止多端互相覆盖。
 */

export const SCHEMA_VERSION = 1

/** 表里永远只有这一行 */
const ROW_ID = 1

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new DatabaseSync(dbPath)
  // WAL 模式读写并发更友好，多端同时拉取时不易互相阻塞
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_snapshot (
      id             INTEGER PRIMARY KEY CHECK (id = ${ROW_ID}),
      data           TEXT    NOT NULL,
      rev            INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
      updated_at     TEXT    NOT NULL
    );
  `)

  return db
}

export function createRepository(db) {
  const selectStmt = db.prepare('SELECT data, rev, updated_at FROM sync_snapshot WHERE id = ?')
  const selectRevStmt = db.prepare('SELECT rev, updated_at FROM sync_snapshot WHERE id = ?')
  const upsertStmt = db.prepare(`
    INSERT INTO sync_snapshot (id, data, rev, schema_version, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data           = excluded.data,
      rev            = excluded.rev,
      schema_version = excluded.schema_version,
      updated_at     = excluded.updated_at
  `)

  /** @returns {{ rev: number, updatedAt: string|null, data: object|null }} */
  function readSnapshot() {
    const row = selectStmt.get(ROW_ID)
    if (!row) return { rev: 0, updatedAt: null, data: null }

    let data
    try {
      data = JSON.parse(row.data)
    } catch {
      // 库里的数据被写坏时按「没有数据」处理，不阻塞拉取
      data = null
    }
    return { rev: Number(row.rev) || 0, updatedAt: row.updated_at, data }
  }

  /** 只读版本号，供客户端轮询「云端是否变了」，不解析整份 data */
  function readRev() {
    const row = selectRevStmt.get(ROW_ID)
    if (!row) return { rev: 0, updatedAt: null }
    return { rev: Number(row.rev) || 0, updatedAt: row.updated_at }
  }

  /**
   * @param {object} data 要保存的快照
   * @param {number|null} expectedRev 客户端持有的版本号，null 表示不校验
   * @returns {{ conflict: true, current: object } | { conflict: false, rev: number, updatedAt: string }}
   */
  function writeSnapshot(data, expectedRev) {
    // 「读 rev → 写 rev」必须原子：否则多进程 / 多实例共享同一个库文件时，
    // 两个请求可能同时通过校验，后写的那个会把先写的覆盖掉。
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = readSnapshot()
      if (expectedRev !== null && expectedRev !== current.rev) {
        db.exec('ROLLBACK')
        return { conflict: true, current }
      }

      const rev = current.rev + 1
      const updatedAt = new Date().toISOString()
      upsertStmt.run(ROW_ID, JSON.stringify(data), rev, SCHEMA_VERSION, updatedAt)
      db.exec('COMMIT')
      return { conflict: false, rev, updatedAt }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已经结束，忽略回滚失败
      }
      throw error
    }
  }

  return { readSnapshot, readRev, writeSnapshot }
}
