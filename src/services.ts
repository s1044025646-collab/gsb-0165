import type { DatabaseSync } from "node:sqlite";
import {
  createDataset,
  createModel,
  getDataset,
  getFitJobByDataset,
  getModel,
  parseParams,
  parseSamples,
  updateParams,
  upsertFitJob,
  type DatasetRow,
  type FitJobRow,
} from "./db.js";
import { AppError } from "./errors.js";
import { buildReport, decode, initialGuess, initialSimplex, nelderMeadStep, type SimplexState } from "./fitter.js";
import { sseFor } from "./fit-helpers.js";
import { validateParams } from "./model.js";
import type { FitReport, ModelParams, Sample } from "./types.js";

export interface ModelSummary {
  id: number;
  version: number;
  lineageId: number;
  name: string;
  createdAt: string;
  params: ModelParams;
}

export function summarize(row: ReturnType<typeof getModel> & { lineage_id?: number }): ModelSummary {
  const r = row as unknown as {
    id: number;
    version: number;
    lineage_id: number;
    name: string;
    created_at: string;
  };
  return {
    id: r.id,
    version: r.version,
    lineageId: r.lineage_id,
    name: r.name,
    createdAt: r.created_at,
    params: parseParams(row),
  };
}

export function makeModel(
  db: DatabaseSync,
  name: string,
  params: ModelParams,
  opts: { lineageId?: number; idempotencyKey?: string } = {},
) {
  validateParams(params);
  const { row, replayed } = createModel(db, {
    name,
    params,
    lineageId: opts.lineageId,
    idempotencyKey: opts.idempotencyKey,
  });
  return { model: summarize(row as never), replayed };
}

export function cloneModelVersion(db: DatabaseSync, sourceId: number, name: string) {
  const src = getModel(db, sourceId);
  const lineage = (src as unknown as { lineage_id: number }).lineage_id;
  return makeModel(db, name, parseParams(src), { lineageId: lineage });
}

export function replaceParams(db: DatabaseSync, id: number, params: ModelParams) {
  validateParams(params);
  return summarize(updateParams(db, id, params) as never);
}

export function ingestDataset(
  db: DatabaseSync,
  modelId: number,
  name: string,
  samples: Sample[],
  obsHash: string,
  idempotencyKey?: string,
) {
  const model = getModel(db, modelId);
  if (samples.length < 2) throw new AppError("VALIDATION_ERROR", "dataset requires at least 2 samples");
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].t > samples[i - 1].t))
      throw new AppError("VALIDATION_ERROR", "sample times must be strictly increasing");
  }
  const { row, replayed } = createDataset(db, {
    modelId,
    name,
    samples,
    modelVersion: model.version,
    ocvVersion: model.version,
    obsHash,
    idempotencyKey,
  });
  return { row, replayed };
}

/**
 * Run up to `budget` simplex iterations. When the budget is exhausted the job
 * is persisted as paused and can be resumed later; otherwise a report is built.
 * Fitted parameters are NEVER written back to the user's model parameters.
 */
export function runFit(db: DatabaseSync, datasetId: number, budget: number): { job: FitJobRow; report: FitReport | null } {
  const dataset = getDataset(db, datasetId);
  const modelRow = getModel(db, dataset.model_id);
  const params = parseParams(modelRow);
  const obs = parseSamples(dataset);

  let job: FitJobRow;
  try {
    job = getFitJobByDataset(db, datasetId);
  } catch {
    job = undefined as never;
  }

  let state: SimplexState | null = job?.state_json ? (JSON.parse(job.state_json) as SimplexState) : null;
  const used0 = job?.budget_used ?? 0;

  // Unidentifiable data short-circuits optimization entirely.
  const currents = new Set(obs.map((s) => s.current));
  if (currents.size < 2 || obs.length < 3) {
    const report = buildReport({ model: params, obs, modelId: modelRow.id, modelVersion: dataset.model_version, ocvVersion: dataset.ocv_version });
    const saved = upsertFitJob(db, datasetId, {
      stateJson: null,
      budgetUsed: used0,
      status: "unidentifiable",
      reportJson: JSON.stringify(report),
    });
    return { job: saved.row, report };
  }

  if (!state) {
    const guess = initialGuess(obs);
    state = initialSimplex(guess);
  state.fx = state.X.map((x) => sseFor(params, obs, x));
  }

  const out = nelderMeadStep(params, obs, state, used0 + budget);
  const used = out.state.iterations;
  const didWork = used > used0;

  if (didWork && !out.converged) {
    const saved = upsertFitJob(db, datasetId, {
      stateJson: JSON.stringify(out.state),
      budgetUsed: used,
      status: "paused",
      reportJson: null,
    });
    return { job: saved.row, report: null };
  }

  const theta = decode(out.state.X[0]);
  const report = buildReport({
    model: params,
    obs,
    modelId: modelRow.id,
    modelVersion: dataset.model_version,
    ocvVersion: dataset.ocv_version,
    result: {
      theta,
      sseValue: out.state.fx[0],
      iterations: used,
      state: out.state,
    },
  });
  const saved = upsertFitJob(db, datasetId, {
    stateJson: JSON.stringify(out.state),
    budgetUsed: used,
    status: report.status.identifiable ? "done" : "unidentifiable",
    reportJson: JSON.stringify(report),
  });
  return { job: saved.row, report };
}

export function getReport(db: DatabaseSync, datasetId: number): FitReport {
  const job = getFitJobByDataset(db, datasetId);
  if (!job.report_json)
    throw new AppError("BAD_STATE", `fit job for dataset ${datasetId} is ${job.status}; resume before reading a report`);
  return JSON.parse(job.report_json) as FitReport;
}

export interface VersionComparison {
  a: { id: number; version: number; name: string };
  b: { id: number; version: number; name: string };
  params: Record<keyof Pick<ModelParams, "capacityAh" | "soc0" | "r0" | "r1" | "tau" | "up0">, { a: number; b: number; delta: number }>;
  sameLineage: boolean;
  ocvSame: boolean;
}

export function compareVersions(db: DatabaseSync, idA: number, idB: number): VersionComparison {
  const a = getModel(db, idA);
  const b = getModel(db, idB);
  const pa = parseParams(a);
  const pb = parseParams(b);
  const keys = ["capacityAh", "soc0", "r0", "r1", "tau", "up0"] as const;
  const params = {} as VersionComparison["params"];
  for (const k of keys) params[k] = { a: pa[k], b: pb[k], delta: pb[k] - pa[k] };
  return {
    a: { id: a.id, version: a.version, name: a.name },
    b: { id: b.id, version: b.version, name: b.name },
    params,
    sameLineage: (a as unknown as { lineage_id: number }).lineage_id === (b as unknown as { lineage_id: number }).lineage_id,
    ocvSame: JSON.stringify(pa.ocvTable) === JSON.stringify(pb.ocvTable),
  };
}

export type { DatasetRow };
