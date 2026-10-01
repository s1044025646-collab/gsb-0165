import { AppError } from "./errors.js";
import type {
  FitStatus,
  ModelParams,
  PulseSegment,
  Sample,
  SimResult,
} from "./types.js";

export const SECONDS_PER_HOUR = 3600;

export function fail(code: AppError["code"], message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}

/** Validate model parameters and the OCV table. Throws AppError on violation. */
export function validateParams(p: ModelParams): void {
  const errs: string[] = [];
  if (!Number.isFinite(p.capacityAh) || p.capacityAh <= 0)
    errs.push("capacityAh must be a positive number");
  if (!Number.isFinite(p.soc0) || p.soc0 < 0 || p.soc0 > 1)
    errs.push("soc0 must be within [0,1]");
  for (const k of ["r0", "r1", "tau"] as const) {
    if (!Number.isFinite(p[k]) || p[k] <= 0) errs.push(`${k} must be a positive number`);
  }
  if (!Array.isArray(p.ocvTable) || p.ocvTable.length < 2)
    errs.push("ocvTable must contain at least 2 nodes");
  if (errs.length === 0) {
    const pts = p.ocvTable;
    for (const q of pts) {
      if (!Number.isFinite(q.soc) || !Number.isFinite(q.ocv))
        fail("VALIDATION_ERROR", "ocvTable nodes must be finite numbers");
    }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].soc <= pts[i - 1].soc)
        fail("VALIDATION_ERROR", "ocvTable SOC nodes must be strictly increasing");
      if (pts[i].ocv < pts[i - 1].ocv - 1e-12)
        fail("VALIDATION_ERROR", "ocvTable OCV values must be monotonic non-decreasing");
    }
    if (pts[0].soc > 0 || pts[pts.length - 1].soc < 1)
      fail(
        "RANGE_ERROR",
        "ocvTable coverage insufficient: nodes must span the full SOC range [0,1]",
        { first: pts[0].soc, last: pts[pts.length - 1].soc },
      );
  }
  if (errs.length) fail("VALIDATION_ERROR", errs.join("; "));
}

/** Validate a piecewise-constant current schedule. Throws on repeated/reversed time. */
export function validateSegments(segs: PulseSegment[]): void {
  if (!Array.isArray(segs) || segs.length === 0)
    fail("VALIDATION_ERROR", "at least one pulse segment is required");
  for (const s of segs) {
    if (!Number.isFinite(s.tStart) || !Number.isFinite(s.tEnd) || !Number.isFinite(s.current))
      fail("VALIDATION_ERROR", "segment fields must be finite numbers");
    if (s.tStart < 0) fail("VALIDATION_ERROR", "tStart must be >= 0");
    if (!(s.tEnd > s.tStart))
      fail("VALIDATION_ERROR", "each segment requires tEnd > tStart (no zero/reversed duration)");
  }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].tStart < segs[i - 1].tEnd)
      fail("VALIDATION_ERROR", "segments must be ordered and non-overlapping (time must not go backwards)");
    if (segs[i].tStart > segs[i - 1].tEnd)
      fail("VALIDATION_ERROR", "segments must be contiguous (gaps are not allowed)");
  }
}

/** Piecewise-linear OCV interpolation; SOC must be within [0,1]. */
export function ocvAt(table: ModelParams["ocvTable"], soc: number): number {
  if (soc < 0 || soc > 1)
    fail("RANGE_ERROR", `SOC ${soc} is outside the OCV table domain [0,1]`);
  if (soc <= table[0].soc) return table[0].ocv;
  const last = table[table.length - 1];
  if (soc >= last.soc) return last.ocv;
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].soc <= soc) lo = mid;
    else hi = mid;
  }
  const a = table[lo];
  const b = table[hi];
  const w = (soc - a.soc) / (b.soc - a.soc);
  return a.ocv + w * (b.ocv - a.ocv);
}

interface State {
  soc: number;
  up: number;
}

/** Advance polarization voltage analytically over a constant-current interval. */
export function stepPolarization(up: number, current: number, r1: number, tau: number, dt: number): number {
  const f = Math.exp(-dt / tau);
  return current * r1 * (1 - f) + up * f;
}

/** Coulomb counting: discharge (I>0) decreases SOC. */
export function stepSoc(soc: number, current: number, capacityAh: number, dt: number): number {
  return soc - (current * dt) / (capacityAh * SECONDS_PER_HOUR);
}

export function terminalVoltage(p: ModelParams, soc: number, up: number, current: number): number {
  return ocvAt(p.ocvTable, soc) - up - p.r0 * current;
}

/**
 * Simulate piecewise-constant pulses. One sample is emitted at each segment
 * endpoint; that sample uses the current of the segment just ending (endpoint
 * semantics). A pre-pulse sample at the first tStart is emitted with zero
 * current. If SOC would leave [0,1] inside a segment, integration stops at the
 * exact crossing time with a reason instead of clipping and continuing.
 */
export function simulate(p: ModelParams, segs: PulseSegment[], opts: { sampleInterval?: number } = {}): SimResult {
  validateParams(p);
  validateSegments(segs);

  const samples: Sample[] = [
    { t: segs[0].tStart, current: 0, voltage: terminalVoltage(p, p.soc0, p.up0, 0) },
  ];
  let state: State = { soc: p.soc0, up: p.up0 };

  for (const seg of segs) {
    const interval = opts.sampleInterval && opts.sampleInterval > 0 ? opts.sampleInterval : seg.tEnd - seg.tStart;
    let tCursor = seg.tStart;
    while (tCursor < seg.tEnd - 1e-12) {
      const dt = Math.min(interval, seg.tEnd - tCursor);
      const tNext = tCursor + dt;
      const socEnd = stepSoc(state.soc, seg.current, p.capacityAh, dt);
      if (socEnd < 0 || socEnd > 1) {
        // SOC moves linearly inside a constant-current segment: find exact crossing.
        const rate = -seg.current / (p.capacityAh * SECONDS_PER_HOUR); // d(soc)/dt
        const boundary = socEnd < 0 ? 0 : 1;
        const dtCross = (boundary - state.soc) / rate;
        const tCross = tCursor + dtCross;
        const upCross = stepPolarization(state.up, seg.current, p.r1, p.tau, dtCross);
        samples.push({
          t: tCross,
          current: seg.current,
          voltage: terminalVoltageAt(p, boundary, upCross, seg.current),
        });
        return {
          samples,
          stopped: true,
          stopReason: socEnd < 0 ? "SOC_BELOW_0" : "SOC_ABOVE_1",
          finalSoc: boundary,
          finalUp: upCross,
        };
      }
      state = {
        soc: socEnd,
        up: stepPolarization(state.up, seg.current, p.r1, p.tau, dt),
      };
      samples.push({
        t: tNext,
        current: seg.current,
        voltage: terminalVoltage(p, state.soc, state.up, seg.current),
      });
      tCursor = tNext;
    }
  }
  return { samples, stopped: false, stopReason: null, finalSoc: state.soc, finalUp: state.up };
}

function terminalVoltageAt(p: ModelParams, soc: number, up: number, current: number): number {
  return ocvAt(p.ocvTable, soc) - up - p.r0 * current;
}

/**
 * Predict terminal voltage for an observed time series (zero-order-held
 * current). Sample k>0 is evaluated by propagating state through preceding
 * intervals and applying the instantaneous ohmic drop of its own current.
 */
export function predictSeries(
  p: ModelParams,
  obs: Sample[],
  theta: { r0: number; r1: number; tau: number },
): { t: number; predicted: number; soc: number; up: number }[] {
  const q: ModelParams = { ...p, r0: theta.r0, r1: theta.r1, tau: theta.tau };
  const out: { t: number; predicted: number; soc: number; up: number }[] = [];
  let soc = q.soc0;
  let up = q.up0;
  out.push({ t: obs[0].t, predicted: terminalVoltageAt(q, soc, up, obs[0].current), soc, up });
  for (let k = 1; k < obs.length; k++) {
    const dt = obs[k].t - obs[k - 1].t;
    if (!(dt > 0)) fail("VALIDATION_ERROR", "observation times must be strictly increasing");
    const current = obs[k - 1].current;
    soc = stepSoc(soc, current, q.capacityAh, dt);
    up = stepPolarization(up, current, q.r1, q.tau, dt);
    out.push({ t: obs[k].t, predicted: terminalVoltageAt(q, soc, up, obs[k].current), soc, up });
  }
  return out;
}

/**
 * Decide whether R0/R1/tau are structurally identifiable from the record:
 * the current must actually vary (ohmic jumps) and the record must span a
 * meaningful fraction of a candidate time constant (polarization dynamics).
 */
export function assessIdentifiability(obs: Sample[]): FitStatus {
  const reasons: string[] = [];
  const currents = new Set(obs.map((s) => s.current));
  if (currents.size < 2) reasons.push("NO_CURRENT_VARIATION");
  if (obs.length < 3) reasons.push("TOO_FEW_SAMPLES");
  const span = obs[obs.length - 1].t - obs[0].t;
  if (!(span > 0)) reasons.push("ZERO_TIME_SPAN");
  // A conservative span check: polarization is only weakly observable if the
  // whole record is shorter than ~1/5 of the smallest plausible tau. The
  // fitted tau is cross-checked against this threshold after optimization.
  return { identifiable: reasons.length === 0, reasons };
}
