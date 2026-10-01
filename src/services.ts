import { simulate } from './engine.ts';
import {
  fitParameters,
  runNelderMead,
  reportFromParams,
  DEFAULT_BOUNDS,
} from './fit.ts';
import type { FitReport, FittedParams, TheveninParams } from './types.ts';
import { parseModelParams, Store } from './store.ts';
import { AppError } from './errors.ts';
import { validateParams, validateSegments, isFiniteNumber } from './validation.ts';
import type { FitBounds } from './fit.ts';

export class Services {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  simulateModel(
    modelId: number,
    pulseVersion?: number,
    sampleDt?: number,
  ): ReturnType<typeof simulate> {
    const row = this.store.getModelById(modelId);
    const params = validateParams(parseModelParams(row));
    const { segments } = this.store.getPulses(modelId, pulseVersion);
    validateSegments(segments);
    const sampleTimes =
      sampleDt && sampleDt > 0
        ? buildUniformTimes(segments[0].startTime, segments[segments.length - 1].endTime, sampleDt)
        : undefined;
    return simulate(params, segments, sampleTimes);
  }

  /** 启动/重复提交一次拟合；maxIterations 较小时任务可暂停，稍后 resume 续算。 */
  startFit(
    modelId: number,
    datasetId: number,
    opts: {
      idempotencyKey?: string;
      maxIterations?: number;
      start?: FittedParams;
      bounds?: FitBounds;
    } = {},
  ): { jobId: number; reused: boolean; status: string; report: FitReport | null } {
    const modelRow = this.store.getModelById(modelId);
    const dataset = this.store.getDataset(datasetId);
    const base = validateParams(parseModelParams(modelRow));
    validateObservations(dataset.observations);

    const frozen = {
      observationVersion: dataset.observation_version,
      ocvVersion: modelRow.ocv_version,
      modelVersion: modelRow.version,
    };

    // 不可辨识短路：不跑优化，直接给原因。
    const probe = fitParameters(
      base,
      dataset.observations,
      { bounds: opts.bounds, start: opts.start, frozen, maxIterations: 0 },
    );
    if (!probe.identifiable) {
      const { id, reused } = this.store.upsertFitJob({
        idempotencyKey: opts.idempotencyKey,
        modelId,
        datasetId,
        status: 'unidentifiable',
        report: probe,
      });
      return { jobId: id, reused, status: 'unidentifiable', report: probe };
    }

    const maxIter = opts.maxIterations ?? 400;
    const result = runNelderMead(base, dataset.observations, opts.bounds ?? DEFAULT_BOUNDS, {
      start: opts.start,
      maxIterations: maxIter,
    });
    const paused = !result.converged && result.iterations >= maxIter;
    const report = paused
      ? null
      : reportFromParams(
          base,
          dataset.observations,
          result.best,
          opts.bounds ?? DEFAULT_BOUNDS,
          frozen,
          result.iterations,
          result.converged,
        );
    const { id, reused } = this.store.upsertFitJob({
      idempotencyKey: opts.idempotencyKey,
      modelId,
      datasetId,
      status: paused ? 'paused' : 'completed',
      report: report ?? undefined,
      optimizerState: result.state,
    });
    return { jobId: id, reused, status: paused ? 'paused' : 'completed', report };
  }

  /** 从暂停的优化状态继续迭代。 */
  resumeFit(
    jobId: number,
    maxIterations = 400,
  ): { status: string; report: FitReport | null } {
    const job = this.store.getFitJob(jobId);
    if (job.status !== 'paused') {
      return { status: job.status, report: job.report };
    }
    const modelRow = this.store.getModelById(job.model_id);
    const dataset = this.store.getDataset(job.dataset_id);
    const base = validateParams(parseModelParams(modelRow));
    const result = runNelderMead(base, dataset.observations, DEFAULT_BOUNDS, {
      state: job.optimizerState as never,
      maxIterations,
    });
    const paused = !result.converged && result.iterations >= maxIterations;
    const frozen = {
      observationVersion: dataset.observation_version,
      ocvVersion: modelRow.ocv_version,
      modelVersion: modelRow.version,
    };
    const report = paused
      ? null
      : reportFromParams(
          base,
          dataset.observations,
          result.best,
          DEFAULT_BOUNDS,
          frozen,
          result.iterations,
          result.converged,
        );
    this.store.upsertFitJob({
      id: jobId,
      modelId: job.model_id,
      datasetId: job.dataset_id,
      status: paused ? 'paused' : 'completed',
      report: report ?? undefined,
      optimizerState: result.state,
    });
    return { status: paused ? 'paused' : 'completed', report };
  }

  compareVersions(name: string, vA: number, vB: number) {
    const a = parseModelParams(this.store.getModel(name, vA));
    const b = parseModelParams(this.store.getModel(name, vB));
    const diff = (key: keyof Pick<TheveninParams, 'capacityAh' | 'r0' | 'r1' | 'tau' | 'initialSoc'>) => ({
      a: a[key],
      b: b[key],
      delta: (b[key] as number) - (a[key] as number),
      rel: a[key] === 0 ? null : ((b[key] as number) - (a[key] as number)) / (a[key] as number),
    });
    return {
      name,
      versions: { a: vA, b: vB },
      capacityAh: diff('capacityAh'),
      initialSoc: diff('initialSoc'),
      r0: diff('r0'),
      r1: diff('r1'),
      tau: diff('tau'),
      ocvSame: JSON.stringify(a.ocvTable) === JSON.stringify(b.ocvTable),
      note: '仅比较简化单RC Thevenin电学参数，不代表真实电池全特性',
    };
  }
}

function buildUniformTimes(t0: number, end: number, dt: number): number[] {
  const times: number[] = [];
  for (let t = t0; t <= end + 1e-9; t += dt) times.push(Number(t.toFixed(6)));
  if (times[times.length - 1] !== end) times.push(end);
  return times;
}

function validateObservations(obs: unknown) {
  if (!Array.isArray(obs) || obs.length < 2) {
    throw new AppError('VALIDATION', '观测至少 2 条');
  }
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i] as { time: number; currentA: number; voltage: number };
    if (
      !o ||
      !isFiniteNumber(o.time) ||
      !isFiniteNumber(o.voltage) ||
      !isFiniteNumber(o.currentA)
    ) {
      throw new AppError('VALIDATION', `观测[${i}] 的 time/currentA/voltage 必须为有限数`);
    }
    if (i > 0 && o.time <= obs[i - 1].time) {
      throw new AppError(
        'TIME_NOT_MONOTONIC',
        `观测时间重复或倒退于索引 ${i}：${o.time} <= ${obs[i - 1].time}`,
      );
    }
  }
}
