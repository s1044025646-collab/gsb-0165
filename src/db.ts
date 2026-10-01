import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import type { FitReport, ModelParams, OcPoint, Page, PulseSegment, Sample } from "./types.js";

export interface ModelRow {
  id: number;
  version: number;
  name: string;
  params_json: string;
  created_at: string;
}

export interface DatasetRow {
  id: number;
  model_id: number;
  model_version: number;
  ocv_version: number;
  name: string;
  samples_json: string;
  obs_hash: string;
  created_at: string;
}

export interface FitJobRow {
  id: number;
  dataset_id: number;
  state_json: string | null;
  budget_used: number;
  status: "running" | "paused" | "done" | "unidentifiable";
  report_json: string | null;
  updated_at: string;
}

/** Open (creating schema if needed). Migrations are idempotent via IF NOT EXISTS. */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL DEFAULT 1,
      lineage_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      params_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      model_version INTEGER NOT NULL,
      ocv_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      samples_json TEXT NOT NULL,
      obs_hash TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS fit_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id INTEGER NOT NULL REFERENCES datasets(id),
      state_json TEXT,
      budget_used INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      report_json TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  db.prepare(
    `INSERT INTO schema_meta(key,value) VALUES('schema_version','1')
     ON CONFLICT(key) DO NOTHING`,
  ).run();
}

export function parseParams(row: ModelRow): ModelParams {
  return JSON.parse(row.params_json) as ModelParams;
}
export function parseSamples(row: DatasetRow): Sample[] {
  return JSON.parse(row.samples_json) as Sample[];
}

export interface CreateModelInput {
  name: string;
  params: ModelParams;
  lineageId?: number;
  idempotencyKey?: string;
}

/** Insert a model version; reusing an idempotency key returns the prior row. */
export function createModel(db: DatabaseSync, input: CreateModelInput): { row: ModelRow; replayed: boolean } {
  if (input.idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM models WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as unknown as ModelRow | undefined;
    if (existing) return { row: existing, replayed: true };
  }
  const lineage =
    input.lineageId ??
    (db.prepare("SELECT COALESCE(MAX(lineage_id),0)+1 AS n FROM models").get() as { n: number }).n;
  const version =
    lineage === input.lineageId
      ? (db.prepare("SELECT COALESCE(MAX(version),0)+1 AS v FROM models WHERE lineage_id = ?").get(lineage) as { v: number }).v
      : 1;
  const stmt = db.prepare(
    `INSERT INTO models(version, lineage_id, name, params_json, idempotency_key)
     VALUES(?,?,?,?,?)`,
  );
  const info = stmt.run(version, lineage, input.name, JSON.stringify(input.params), input.idempotencyKey ?? null);
  const row = db.prepare("SELECT * FROM models WHERE id = ?").get(info.lastInsertRowid) as unknown as ModelRow;
  return { row, replayed: false };
}

export function getModel(db: DatabaseSync, id: number): ModelRow {
  const row = db.prepare("SELECT * FROM models WHERE id = ?").get(id) as unknown as ModelRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", `model ${id} not found`);
  return row;
}

export function listModels(
  db: DatabaseSync,
  opts: { limit: number; offset: number; lineageId?: number },
): Page<ModelRow> {
  const where = opts.lineageId ? "WHERE lineage_id = ?" : "";
  const args = opts.lineageId ? [opts.lineageId] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM models ${where}`).get(...args) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM models ${where} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...args, opts.limit, opts.offset) as unknown as ModelRow[];
  return { items, total, limit: opts.limit, offset: opts.offset };
}

export function updateParams(db: DatabaseSync, id: number, params: ModelParams): ModelRow {
  db.exec("BEGIN");
  try {
    getModel(db, id);
    db.prepare("UPDATE models SET params_json = ? WHERE id = ?").run(JSON.stringify(params), id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getModel(db, id);
}

export interface CreateDatasetInput {
  modelId: number;
  name: string;
  samples: Sample[];
  ocvVersion: number;
  modelVersion: number;
  obsHash: string;
  idempotencyKey?: string;
}

export function createDataset(db: DatabaseSync, input: CreateDatasetInput): { row: DatasetRow; replayed: boolean } {
  if (input.idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM datasets WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as unknown as DatasetRow | undefined;
    if (existing) return { row: existing, replayed: true };
  }
  getModel(db, input.modelId);
  const info = db
    .prepare(
      `INSERT INTO datasets(model_id, model_version, ocv_version, name, samples_json, obs_hash, idempotency_key)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      input.modelId,
      input.modelVersion,
      input.ocvVersion,
      input.name,
      JSON.stringify(input.samples),
      input.obsHash,
      input.idempotencyKey ?? null,
    );
  return { row: db.prepare("SELECT * FROM datasets WHERE id = ?").get(info.lastInsertRowid) as unknown as DatasetRow, replayed: false };
}

export function getDataset(db: DatabaseSync, id: number): DatasetRow {
  const row = db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as unknown as DatasetRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", `dataset ${id} not found`);
  return row;
}

export function listDatasets(db: DatabaseSync, opts: { limit: number; offset: number; modelId?: number }): Page<DatasetRow> {
  const where = opts.modelId ? "WHERE model_id = ?" : "";
  const args = opts.modelId ? [opts.modelId] : [];
  const total = (db.prepare(`SELECT COUNT(*) c FROM datasets ${where}`).get(...args) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM datasets ${where} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...args, opts.limit, opts.offset) as unknown as DatasetRow[];
  return { items, total, limit: opts.limit, offset: opts.offset };
}

export function upsertFitJob(
  db: DatabaseSync,
  datasetId: number,
  fields: {
    stateJson: string | null;
    budgetUsed: number;
    status: FitJobRow["status"];
    reportJson: string | null;
  },
  idempotencyKey?: string,
): { row: FitJobRow; replayed: boolean } {
  if (idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM fit_jobs WHERE idempotency_key = ?")
      .get(idempotencyKey) as unknown as FitJobRow | undefined;
    if (existing) return { row: existing, replayed: true };
  }
  const found = db.prepare("SELECT * FROM fit_jobs WHERE dataset_id = ?").get(datasetId) as unknown as FitJobRow | undefined;
  if (found) {
    db.prepare(
      `UPDATE fit_jobs SET state_json=?, budget_used=?, status=?, report_json=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(fields.stateJson, fields.budgetUsed, fields.status, fields.reportJson, found.id);
    return { row: db.prepare("SELECT * FROM fit_jobs WHERE id = ?").get(found.id) as unknown as FitJobRow, replayed: false };
  }
  const info = db
    .prepare(
      `INSERT INTO fit_jobs(dataset_id, state_json, budget_used, status, report_json, idempotency_key)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(datasetId, fields.stateJson, fields.budgetUsed, fields.status, fields.reportJson, idempotencyKey ?? null);
  return { row: db.prepare("SELECT * FROM fit_jobs WHERE id = ?").get(info.lastInsertRowid) as unknown as FitJobRow, replayed: false };
}

export function getFitJobByDataset(db: DatabaseSync, datasetId: number): FitJobRow {
  const row = db.prepare("SELECT * FROM fit_jobs WHERE dataset_id = ?").get(datasetId) as unknown as FitJobRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", `no fit job for dataset ${datasetId}`);
  return row;
}

export type { OcPoint, PulseSegment, FitReport };


