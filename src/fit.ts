import { ocvAt, predictAtObservations } from './engine.ts';
import type {
  FitReport,
  FittedParams,
  Observation,
  ResidualPoint,
  TheveninParams,
} from './types.ts';

export interface FitBounds {
  r0: [number, number];
  r1: [number, number];
  tau: [number, number];
}

export const DEFAULT_BOUNDS: FitBounds = {
  r0: [1e-5, 10],
  r1: [1e-5, 10],
  tau: [1e-3, 1e6],
};

/** 可辨识性检查：缺电流变化或记录远短于时间常数则不可辨识。 */
export function identifiabilityChecks(
  obs: Observation[],
  tauGuess: number,
): string[] {
  const reasons: string[] = [];
  if (obs.length < 4) reasons.push(`观测样本过少（${obs.length} < 4），无法稳定辨识三参数`);
  const currents = new Set(obs.map((o) => o.currentA));
  if (currents.size < 2) {
    reasons.push('电流全程无变化（缺少阶跃/脉冲），R0 与极化响应不可分离');
  }
  const span = obs[obs.length - 1].time - obs[0].time;
  if (span < tauGuess / 3) {
    reasons.push(
      `记录时长 ${span.toFixed(2)}s 远短于时间常数量级 ${tauGuess.toFixed(
        2,
      )}s（< tau/3），tau 与 R1 不可辨识`,
    );
  }
  let hasStep = false;
  for (let i = 1; i < obs.length; i++) {
    if (obs[i].currentA !== obs[i - 1].currentA) hasStep = true;
  }
  if (!hasStep) reasons.push('未检测到电流阶跃，无法激励 RC 瞬态');
  return reasons;
}

function rmseWith(
  base: TheveninParams,
  obs: Observation[],
  r0: number,
  r1: number,
  tau: number,
): { rmse: number; predicted: number[] } {
  const candidate: TheveninParams = { ...base, r0, r1, tau };
  const { predicted } = predictAtObservations(candidate, obs);
  let sumSq = 0;
  for (let i = 0; i < obs.length; i++) {
    const d = obs[i].voltage - predicted[i];
    sumSq += d * d;
  }
  return { rmse: Math.sqrt(sumSq / obs.length), predicted };
}

type Vec = [number, number, number];

const KEYS: (keyof FitBounds)[] = ['r0', 'r1', 'tau'];

function toLog(bounds: FitBounds, v: FittedParams): Vec {
  return KEYS.map((k) => {
    const [lo, hi] = bounds[k];
    const c = Math.min(hi, Math.max(lo, v[k]));
    return Math.log(c);
  }) as Vec;
}

function fromLog(bounds: FitBounds, x: Vec): FittedParams {
  const out = {} as FittedParams;
  KEYS.forEach((k, i) => {
    const [lo, hi] = bounds[k];
    out[k] = Math.min(hi, Math.max(lo, Math.exp(x[i])));
  });
  return out;
}

export interface OptimizerState {
  simplex: Vec[];
  values: number[];
  iterations: number;
}

export interface StepResult {
  state: OptimizerState;
  converged: boolean;
}

const ALPHA = 1;
const GAMMA = 2;
const RHO = 0.5;
const SIGMA = 0.5;

export function initSimplex(x0: Vec): Vec[] {
  const simplex = [x0.slice() as Vec];
  for (let i = 0; i < 3; i++) {
    const v = x0.slice() as Vec;
    v[i] += v[i] === 0 ? 0.0025 : 0.25;
    simplex.push(v);
  }
  return simplex;
}

/** 自实现 Nelder-Mead（对数参数空间，天然满足正参数约束）。返回暂停/续算所需状态。 */
export function runNelderMead(
  base: TheveninParams,
  obs: Observation[],
  bounds: FitBounds,
  opts: {
    start?: FittedParams;
    maxIterations?: number;
    tolerance?: number;
    state?: OptimizerState;
  } = {},
): { best: FittedParams; rmse: number; iterations: number; converged: boolean; state: OptimizerState } {
  const maxIter = opts.maxIterations ?? 400;
  const tol = opts.tolerance ?? 1e-9;

  const cost = (x: Vec): number => {
    const v = fromLog(bounds, x);
    return rmseWith(base, obs, v.r0, v.r1, v.tau).rmse;
  };

  let state: OptimizerState;
  if (opts.state) {
    state = opts.state;
  } else {
    const x0 = toLog(bounds, opts.start ?? { r0: base.r0, r1: base.r1, tau: base.tau });
    const simplex = initSimplex(x0);
    state = { simplex, values: simplex.map(cost), iterations: 0 };
  }

  let converged = false;
  while (state.iterations < maxIter) {
    const order = state.values
      .map((v, i) => [v, i] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const idx = order.map((o) => o[1]);
    const bestVal = state.values[idx[0]];
    const worstVal = state.values[idx[3]];
    if (worstVal - bestVal < tol) {
      converged = true;
      break;
    }
    const sorted = idx.map((i) => state.simplex[i]);
    const vals = idx.map((i) => state.values[i]);
    const centroid: Vec = [0, 0, 0];
    for (let i = 0; i < 3; i++) for (let d = 0; d < 3; d++) centroid[d] += sorted[i][d] / 3;

    const reflect: Vec = centroid.map((c, d) => c + ALPHA * (c - sorted[3][d])) as Vec;
    const fr = cost(reflect);
    if (vals[0] <= fr && fr < vals[2]) {
      sorted[3] = reflect;
      vals[3] = fr;
    } else if (fr < vals[0]) {
      const expand: Vec = centroid.map((c, d) => c + GAMMA * (reflect[d] - c)) as Vec;
      const fe = cost(expand);
      if (fe < fr) {
        sorted[3] = expand;
        vals[3] = fe;
      } else {
        sorted[3] = reflect;
        vals[3] = fr;
      }
    } else {
      const contract: Vec = centroid.map((c, d) => c + RHO * (sorted[3][d] - c)) as Vec;
      const fc = cost(contract);
      if (fc < worstVal) {
        sorted[3] = contract;
        vals[3] = fc;
      } else {
        for (let i = 1; i < 4; i++) {
          sorted[i] = sorted[i].map((xd, d) => sorted[0][d] + SIGMA * (xd - sorted[0][d])) as Vec;
          vals[i] = cost(sorted[i]);
        }
      }
    }
    state.simplex = sorted;
    state.values = vals;
    state.iterations++;
  }

  let bi = 0;
  for (let i = 1; i < state.values.length; i++) if (state.values[i] < state.values[bi]) bi = i;
  const best = fromLog(bounds, state.simplex[bi]);
  return { best, rmse: state.values[bi], iterations: state.iterations, converged, state };
}

export interface FitOptions {
  bounds?: FitBounds;
  start?: FittedParams;
  maxIterations?: number;
  tolerance?: number;
  frozen?: FitReport['frozen'];
}

/** 由给定最优参数构建完整报告（残差、RMSE、贴边），不再迭代。 */
export function reportFromParams(
  base: TheveninParams,
  obs: Observation[],
  best: FittedParams,
  bounds: FitBounds,
  frozen: FitReport['frozen'],
  iterations: number,
  converged: boolean,
): FitReport {
  const { rmse, predicted } = rmseWith(base, obs, best.r0, best.r1, best.tau);
  const residuals: ResidualPoint[] = obs.map((o, i) => ({
    time: o.time,
    observed: o.voltage,
    predicted: predicted[i],
    residual: o.voltage - predicted[i],
  }));
  const maxAbsResidual = residuals.reduce((m, r) => Math.max(m, Math.abs(r.residual)), 0);
  const atBounds: string[] = [];
  for (const k of KEYS) {
    const [lo, hi] = bounds[k];
    const val = best[k];
    if (val <= lo * (1 + 1e-6)) atBounds.push(`${k}=${val} 贴下界 ${lo}`);
    if (val >= hi * (1 - 1e-6)) atBounds.push(`${k}=${val} 贴上界 ${hi}`);
  }
  return {
    identifiable: true,
    reasons: [],
    fitted: best,
    rmse,
    maxAbsResidual,
    residuals,
    iterations,
    converged,
    bounds,
    atBounds,
    frozen,
  };
}

/** 完整辨识：先可辨识性检查，再优化，输出残差与贴边约束。不自动覆盖原参数。 */
export function fitParameters(
  base: TheveninParams,
  obs: Observation[],
  opts: FitOptions = {},
): FitReport {
  const bounds = opts.bounds ?? DEFAULT_BOUNDS;
  const frozen = opts.frozen ?? { observationVersion: 0, ocvVersion: 0, modelVersion: 0 };
  const reasons = identifiabilityChecks(obs, opts.start?.tau ?? base.tau);

  const baseReport: FitReport = { identifiable: reasons.length === 0, reasons, bounds, frozen };
  if (reasons.length > 0) return baseReport;

  const { best, rmse, iterations, converged } = runNelderMead(base, obs, bounds, opts);
  void rmse;
  return reportFromParams(base, obs, best, bounds, frozen, iterations, converged);
}

export { ocvAt };
