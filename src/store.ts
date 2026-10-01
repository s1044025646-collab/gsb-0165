import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.ts';
import type {
  FitReport,
  Observation,
  PulseSegment,
  TheveninParams,
} from './types.ts';
import { idempotentInsert, paginate, withTransaction } from './db.ts';

export interface ModelRow {
  id: number;
  name: string;
  version: number;
  parent_model_id: number | null;
  params_json: string;
  ocv_version: number;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;
  private now: () => string;
  constructor(db: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
  }

  createModel(
    name: string,
    params: TheveninParams,
    opts: { idempotencyKey?: string; parentId?: number } = {},
  ): { row: ModelRow; reused: boolean } {
    const latest = this.db
      .prepare('SELECT MAX(version) AS v FROM models WHERE name=?')
      .get(name) as { v: number | null };
    const existing = latest.v
      ? (this.db
          .prepare('SELECT id FROM models WHERE name=? AND version=?')
          .get(name, latest.v) as { id: number })
      : undefined;
    const { id, reused } = idempotentInsert(
      this.db,
      opts.idempotencyKey,
      'model',
      () => existing,
      () => {
        const version = (latest.v ?? 0) + 1;
        const info = this.db
          .prepare(
            `INSERT INTO models(name, version, parent_model_id, params_json, ocv_version, created_at)
             VALUES(?,?,?,?,?,?)`,
          )
          .run(name, version, opts.parentId ?? null, JSON.stringify(params), 1, this.now());
        return Number(info.lastInsertRowid);
      },
      this.now,
      (newId) => {
        const version = (latest.v ?? 0) + 1;
        this.db
          .prepare(
            'INSERT INTO ocv_tables(model_ref, version, points_json, created_at) VALUES(?,?,?,?)',
          )
          .run(`${name}@${version}`, 1, JSON.stringify(params.ocvTable), this.now());
        void newId;
      },
    );
    return { row: this.getModelById(id), reused };
  }

  getModelById(id: number): ModelRow {
    const row = this.db.prepare('SELECT * FROM models WHERE id=?').get(id) as ModelRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `模型 id=${id} 不存在`);
    return row;
  }

  getModel(name: string, version?: number): ModelRow {
    const row = version
      ? (this.db.prepare('SELECT * FROM models WHERE name=? AND version=?').get(name, version) as
          | ModelRow
          | undefined)
      : (this.db
          .prepare('SELECT * FROM models WHERE name=? ORDER BY version DESC LIMIT 1')
          .get(name) as ModelRow | undefined);
    if (!row) throw new AppError('NOT_FOUND', `模型 ${name}${version ? `@${version}` : ''} 不存在`);
    return row;
  }

  listModels(page: number, pageSize: number, name?: string) {
    const rows = (
      this.db
        .prepare(
          name
            ? 'SELECT * FROM models WHERE name=? ORDER BY name, version'
            : 'SELECT * FROM models ORDER BY name, version',
        )
        .all(...(name ? [name] : [])) as ModelRow[]
    ).map(toModelSummary);
    return paginate(rows, page, pageSize);
  }

  /** 以某版本为父创建新版本（不覆盖原参数）。 */
  cloneAsNewVersion(
    name: string,
    params: TheveninParams,
    parentId: number,
  ): ModelRow {
    return this.createModel(name, params, { parentId }).row;
  }

  addPulses(
    modelId: number,
    segments: PulseSegment[],
    idempotencyKey?: string,
  ): { id: number; version: number; reused: boolean } {
    this.getModelById(modelId);
    const latest = this.db
      .prepare('SELECT MAX(version) AS v FROM pulses WHERE model_id=?')
      .get(modelId) as { v: number | null };
    const existing = latest.v
      ? (this.db
          .prepare('SELECT id, version FROM pulses WHERE model_id=? AND version=?')
          .get(modelId, latest.v) as { id: number; version: number })
      : undefined;
    const { id, reused } = idempotentInsert(
      this.db,
      idempotencyKey,
      'pulses',
      () => existing,
      () => {
        const version = (latest.v ?? 0) + 1;
        const info = this.db
          .prepare('INSERT INTO pulses(model_id, version, segments_json, created_at) VALUES(?,?,?,?)')
          .run(modelId, version, JSON.stringify(segments), this.now());
        return Number(info.lastInsertRowid);
      },
      this.now,
    );
    const row = this.db.prepare('SELECT version FROM pulses WHERE id=?').get(id) as {
      version: number;
    };
    return { id, version: row.version, reused };
  }

  getPulses(modelId: number, version?: number) {
    this.getModelById(modelId);
    const row = version
      ? (this.db
          .prepare('SELECT * FROM pulses WHERE model_id=? AND version=?')
          .get(modelId, version) as
          | { id: number; version: number; segments_json: string }
          | undefined)
      : (this.db
          .prepare('SELECT * FROM pulses WHERE model_id=? ORDER BY version DESC LIMIT 1')
          .get(modelId) as
          | { id: number; version: number; segments_json: string }
          | undefined);
    if (!row) throw new AppError('NOT_FOUND', `模型 id=${modelId} 无脉冲数据`);
    return { id: row.id, version: row.version, segments: JSON.parse(row.segments_json) as PulseSegment[] };
  }

  createDataset(
    name: string,
    observations: Observation[],
    source: string,
    idempotencyKey?: string,
  ): { id: number; reused: boolean } {
    const existing = this.db.prepare('SELECT id FROM datasets WHERE name=?').get(name) as
      | { id: number }
      | undefined;
    if (existing && !idempotencyKey) {
      throw new AppError('CONFLICT', `数据集 ${name} 已存在`);
    }
    const { id, reused } = idempotentInsert(
      this.db,
      idempotencyKey,
      'dataset',
      () => existing,
      () => {
        const info = this.db
          .prepare(
            'INSERT INTO datasets(name, observation_version, observations_json, source, created_at) VALUES(?,?,?,?,?)',
          )
          .run(name, 1, JSON.stringify(observations), source, this.now());
        return Number(info.lastInsertRowid);
      },
      this.now,
    );
    return { id, reused };
  }

  getDataset(id: number): {
    id: number;
    name: string;
    observation_version: number;
    observations: Observation[];
    source: string;
  } {
    const row = this.db.prepare('SELECT * FROM datasets WHERE id=?').get(id) as
      | {
          id: number;
          name: string;
          observation_version: number;
          observations_json: string;
          source: string;
        }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `数据集 id=${id} 不存在`);
    return {
      id: row.id,
      name: row.name,
      observation_version: row.observation_version,
      observations: JSON.parse(row.observations_json),
      source: row.source,
    };
  }

  listDatasets(page: number, pageSize: number) {
    const rows = (
      this.db
        .prepare(
          'SELECT id, name, observation_version, source, created_at FROM datasets ORDER BY id',
        )
        .all() as Array<{
        id: number;
        name: string;
        observation_version: number;
        source: string;
        created_at: string;
      }>
    );
    return paginate(rows, page, pageSize);
  }

  upsertFitJob(row: {
    id?: number;
    idempotencyKey?: string;
    modelId: number;
    datasetId: number;
    status: string;
    report?: FitReport;
    optimizerState?: unknown;
  }): { id: number; reused: boolean } {
    return withTransaction(this.db, () => {
      if (row.idempotencyKey) {
        const seen = this.db
          .prepare('SELECT resource_id FROM idempotency WHERE idempotency_key=? AND kind=?')
          .get(row.idempotencyKey, 'fit') as { resource_id: number } | undefined;
        if (seen) return { id: seen.resource_id, reused: true };
      }
      if (row.id) {
        this.db
          .prepare(
            'UPDATE fit_jobs SET status=?, report_json=?, optimizer_state_json=?, updated_at=? WHERE id=?',
          )
          .run(
            row.status,
            row.report ? JSON.stringify(row.report) : null,
            row.optimizerState ? JSON.stringify(row.optimizerState) : null,
            this.now(),
            row.id,
          );
        if (row.idempotencyKey) {
          this.db
            .prepare(
              'INSERT OR IGNORE INTO idempotency(idempotency_key, kind, resource_id, created_at) VALUES(?,?,?,?)',
            )
            .run(row.idempotencyKey, 'fit', row.id, this.now());
        }
        return { id: row.id, reused: false };
      }
      const info = this.db
        .prepare(
          `INSERT INTO fit_jobs(idempotency_key, model_id, dataset_id, status, report_json, optimizer_state_json, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.idempotencyKey ?? null,
          row.modelId,
          row.datasetId,
          row.status,
          row.report ? JSON.stringify(row.report) : null,
          row.optimizerState ? JSON.stringify(row.optimizerState) : null,
          this.now(),
          this.now(),
        );
      const id = Number(info.lastInsertRowid);
      if (row.idempotencyKey) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO idempotency(idempotency_key, kind, resource_id, created_at) VALUES(?,?,?,?)',
          )
          .run(row.idempotencyKey, 'fit', id, this.now());
      }
      return { id, reused: false };
    });
  }

  getFitJob(id: number): {
    id: number;
    model_id: number;
    dataset_id: number;
    status: string;
    report: FitReport | null;
    optimizerState: unknown;
  } {
    const row = this.db.prepare('SELECT * FROM fit_jobs WHERE id=?').get(id) as
      | {
          id: number;
          model_id: number;
          dataset_id: number;
          status: string;
          report_json: string | null;
          optimizer_state_json: string | null;
        }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `拟合任务 id=${id} 不存在`);
    return {
      id: row.id,
      model_id: row.model_id,
      dataset_id: row.dataset_id,
      status: row.status,
      report: row.report_json ? JSON.parse(row.report_json) : null,
      optimizerState: row.optimizer_state_json ? JSON.parse(row.optimizer_state_json) : null,
    };
  }

  listFitJobs(page: number, pageSize: number, modelId?: number) {
    const rows = this.db
      .prepare(
        modelId
          ? 'SELECT id, model_id, dataset_id, status, created_at, updated_at FROM fit_jobs WHERE model_id=? ORDER BY id'
          : 'SELECT id, model_id, dataset_id, status, created_at, updated_at FROM fit_jobs ORDER BY id',
      )
      .all(...(modelId ? [modelId] : []));
    return paginate(rows, page, pageSize);
  }
}

function toModelSummary(row: ModelRow) {
  const params = JSON.parse(row.params_json) as TheveninParams;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    parentModelId: row.parent_model_id,
    ocvVersion: row.ocv_version,
    createdAt: row.created_at,
    capacityAh: params.capacityAh,
    initialSoc: params.initialSoc,
    r0: params.r0,
    r1: params.r1,
    tau: params.tau,
  };
}

export function parseModelParams(row: ModelRow): TheveninParams {
  return JSON.parse(row.params_json) as TheveninParams;
}
