import { createHash } from "node:crypto";
import { assessIdentifiability, predictSeries } from "./model.js";
import type { FitParams, FitReport, ModelParams, Sample } from "./types.js";

const MIN_TAU = 1e-3;
const MAX_TAU = 1e7;

/** Freeze the observation set + OCV table into a stable hash. */
export function freezeObservations(obs: Sample[], ocvTable: ModelParams["ocvTable"]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ obs, ocvTable }));
  return h.digest("hex");
}

function residualsFor(p: ModelParams, obs: Sample[], theta: FitParams) {
  const pred = predictSeries(p, obs, theta);
  return obs.map((s, i) => s.voltage - pred[i].predicted);
}

function sse(p: ModelParams, obs: Sample[], theta: FitParams): number {
  const r = residualsFor(p, obs, theta);
  let sum = 0;
  for (const e of r) sum += e * e;
  return sum;
}

/** Optimize in log space (x = log theta) so positivity constraints are implicit. */
function decode(x: number[]): FitParams {
  return { r0: Math.exp(x[0]), r1: Math.exp(x[1]), tau: Math.exp(x[2]) };
}

export interface SimplexState {
  X: number[][];
  fx: number[];
  iterations: number;
}

export interface OptimizerResult {
  theta: FitParams;
  sseValue: number;
  iterations: number;
  state: SimplexState;
}

/**
 * Self-contained Nelder-Mead simplex optimizer over log(R0), log(R1), log(tau).
 * `budget` limits iterations per call so long fits can be paused/resumed;
 * pass the returned state back in to continue.
 */
export function nelderMeadStep(
  p: ModelParams,
  obs: Sample[],
  state: SimplexState,
  budget: number,
): { state: SimplexState; converged: boolean } {
  const { X, fx } = state;
  let { iterations } = state;
  const n = 3;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;
  const f = (x: number[]) => sse(p, obs, decode(x));
  let converged = false;

  const sortAll = () => {
    const idx = fx.map((_, i) => i).sort((a, b) => fx[a] - fx[b]);
    const nX = idx.map((i) => X[i]);
    const nf = idx.map((i) => fx[i]);
    X.length = 0;
    fx.length = 0;
    X.push(...nX);
    fx.push(...nf);
  };

  for (; iterations < budget; iterations++) {
    sortAll();
    const spread = Math.max(...X[0].map((_, j) => Math.abs(X[n][j] - X[0][j])));
    const fspread = fx[n] - fx[0];
    if (iterations > 50 && (spread < 1e-10 || fspread < 1e-18)) {
      converged = true;
      break;
    }
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += X[i][j] / n;

    const xr = centroid.map((c, j) => c + alpha * (c - X[n][j]));
    const fr = f(xr);
    if (fr < fx[n]) {
      let xnew = xr;
      let fnew = fr;
      if (fr < fx[0]) {
        const xe = centroid.map((c, j) => c + gamma * (xr[j] - c));
        const fe = f(xe);
        if (fe < fr) {
          xnew = xe;
          fnew = fe;
        }
      }
      X[n] = xnew;
      fx[n] = fnew;
    } else {
      const xc = centroid.map((c, j) => c + rho * (X[n][j] - c));
      const fc = f(xc);
      if (fc < fx[n]) {
        X[n] = xc;
        fx[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          X[i] = X[i].map((v, j) => X[0][j] + sigma * (v - X[0][j]));
          fx[i] = f(X[i]);
        }
      }
    }
  }
  sortAll();
  return { state: { X, fx, iterations }, converged };
}

export function initialSimplex(guess: FitParams): SimplexState {
  const x0 = [Math.log(guess.r0), Math.log(guess.r1), Math.log(guess.tau)];
  const X = [x0];
  for (let j = 0; j < 3; j++) {
    const v = [...x0];
    v[j] += 0.5;
    X.push(v);
  }
  return { X, fx: X.map(() => 0), iterations: 0 };
}

/** Robust initial guess from ohmic jumps and a mid-range relaxation time. */
export function initialGuess(obs: Sample[]): FitParams {
  let maxJump = 0;
  for (let i = 1; i < obs.length; i++) {
    const di = Math.abs(obs[i].current - obs[i - 1].current);
    const dv = Math.abs(obs[i].voltage - obs[i - 1].voltage);
    if (di > 1e-9) maxJump = Math.max(maxJump, dv / di);
  }
  const span = obs[obs.length - 1].t - obs[0].t;
  return {
    r0: maxJump > 1e-9 ? maxJump : 0.01,
    r1: 0.01,
    tau: Math.min(Math.max(span / 4, MIN_TAU * 10), MAX_TAU / 10),
  };
}

export interface FitInput {
  model: ModelParams;
  obs: Sample[];
  modelId: number;
  modelVersion: number;
  ocvVersion: number;
  state?: SimplexState | null;
  budget?: number;
  totalBudget?: number;
  result?: OptimizerResult;
}

export function buildReport(input: FitInput, result?: OptimizerResult): FitReport {
  const { model, obs, modelId, modelVersion, ocvVersion } = input;
  const status = assessIdentifiability(obs);
  const span = obs.length > 1 ? obs[obs.length - 1].t - obs[0].t : 0;
  const observationsHash = freezeObservations(obs, model.ocvTable);
  const base = {
    modelId,
    modelVersion,
    ocvVersion,
    observationsHash,
    n: obs.length,
    residuals: [],
    iterations: 0,
    note: "Simplified isothermal single-RC-branch Thevenin electrical model only; not a physical battery characterization.",
  };

  if (!status.identifiable) return { ...base, status, params: null, rmse: null, maxAbsResidual: null };

  const opt =
    result ??
    (() => {
      const guess = initialGuess(obs);
      let st = initialSimplex(guess);
      st.fx = st.X.map((x) => sse(model, obs, decode(x)));
      const out = nelderMeadStep(model, obs, st, input.totalBudget ?? 4000);
      return {
        theta: decode(out.state.X[0]),
        sseValue: out.state.fx[0],
        iterations: out.state.iterations,
        state: out.state,
      } satisfies OptimizerResult;
    })();

  const theta = opt.theta;
  const res = residualsFor(model, obs, theta);
  const rmse = Math.sqrt(opt.sseValue / obs.length);
  const maxAbsResidual = Math.max(...res.map((e) => Math.abs(e)));

  // Record much shorter than the fitted dynamics => tau is not separable.
  if (span < theta.tau / 2) status.identifiable = false, status.reasons.push("RECORD_SHORTER_THAN_TAU");
  if (!(theta.tau > MIN_TAU && theta.tau < MAX_TAU))
    status.identifiable = false, status.reasons.push("TAU_AT_BOUNDARY");

  return {
    ...base,
    status,
    params: status.identifiable ? theta : null,
    rmse: status.identifiable ? rmse : null,
    maxAbsResidual: status.identifiable ? maxAbsResidual : null,
    residuals: obs.map((s, i) => ({ t: s.t, residual: res[i] })),
    iterations: opt.iterations,
  };
}

export { decode, MIN_TAU, MAX_TAU };
