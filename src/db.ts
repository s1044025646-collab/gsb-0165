import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.ts';

/**
 * 可重复执行的迁移（IF NOT EXISTS / 幂等 DDL）。
 * 每个迁移版本只应用一次，记录在 schema_migrations。
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_model_id INTEGER,
  params_json TEXT NOT NULL,
  ocv_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS ocv_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  points_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(model_ref, version)
);
CREATE TABLE IF NOT EXISTS pulses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  segments_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(model_id, version)
);
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  observation_version INTEGER NOT NULL DEFAULT 1,
  observations_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fit_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE,
  model_id INTEGER NOT NULL,
  dataset_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  report_json TEXT,
  optimizer_state_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
CREATE INDEX IF NOT EXISTS idx_fit_jobs_model ON fit_jobs(model_id);
`,
  },
];

export function openDb(path: string, now: () => string = () => new Date().toISOString()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  for (const m of MIGRATIONS) {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE version=?')
      .get(m.version);
    if (!applied) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)').run(m.version, now());
    }
  }
  return db;
}

export function paginate<T>(
  rows: T[],
  page: number,
  pageSize: number,
): { items: T[]; page: number; pageSize: number; total: number; totalPages: number } {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return {
    items: rows.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages,
  };
}

/** 在事务中执行 fn；抛错则回滚并原样抛出。 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 幂等创建：相同 key 直接返回既有资源，不重复插入。 */
export function idempotentInsert(
  db: DatabaseSync,
  key: string | undefined,
  kind: string,
  findExisting: () => { id: number } | undefined,
  doInsert: () => number,
  now: () => string,
  afterInsert?: (id: number) => void,
): { id: number; reused: boolean } {
  if (!key) return { id: doInsert(), reused: false };
  const seen = db.prepare('SELECT resource_id FROM idempotency WHERE idempotency_key=?').get(key) as
    | { resource_id: number }
    | undefined;
  if (seen) return { id: seen.resource_id, reused: true };
  return withTransaction(db, () => {
    const existing = findExisting();
    if (existing) {
      db.prepare(
        'INSERT OR IGNORE INTO idempotency(idempotency_key, kind, resource_id, created_at) VALUES(?,?,?,?)',
      ).run(key, kind, existing.id, now());
      return { id: existing.id, reused: true };
    }
    const id = doInsert();
    afterInsert?.(id);
    db.prepare(
      'INSERT INTO idempotency(idempotency_key, kind, resource_id, created_at) VALUES(?,?,?,?)',
    ).run(key, kind, id, now());
    return { id, reused: false };
  });
}

export function requirePageParams(query: { page?: string; pageSize?: string }): {
  page: number;
  pageSize: number;
} {
  const page = Number(query.page ?? '1');
  const pageSize = Number(query.pageSize ?? '20');
  if (!Number.isInteger(page) || page < 1) {
    throw new AppError('VALIDATION', 'page 必须为 >=1 的整数');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new AppError('VALIDATION', 'pageSize 必须为 1..200 的整数');
  }
  return { page, pageSize };
}
