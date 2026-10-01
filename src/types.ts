// Core domain types for the single-RC-branch Thevenin model.

/** Sign convention: I > 0 discharge, I < 0 charge, I = 0 rest. Units: ampere. */
export interface OcPoint {
  soc: number; // 0..1
  ocv: number; // volts
}

export interface ModelParams {
  capacityAh: number; // battery capacity in ampere-hours (> 0)
  soc0: number; // initial state of charge in 0..1
  ocvTable: OcPoint[]; // monotonic non-decreasing SOC -> OCV lookup
  r0: number; // ohmic resistance, ohm (> 0)
  r1: number; // polarization resistance, ohm (> 0)
  tau: number; // polarization time constant, second (> 0)
  up0: number; // initial polarization voltage, volt
}

/** One piecewise-constant current segment: constant I from tStart to tEnd. */
export interface PulseSegment {
  tStart: number; // seconds, >= 0
  tEnd: number; // seconds, > tStart
  current: number; // ampere, discharge positive
}

/** A sampled terminal-voltage record used for fitting/identification. */
export interface Sample {
  t: number; // seconds
  current: number; // ampere
  voltage: number; // volt
}

export interface SimResult {
  samples: Sample[];
  stopped: boolean;
  stopReason: string | null;
  finalSoc: number;
  finalUp: number;
}

export interface FitStatus {
  identifiable: boolean;
  reasons: string[];
}

export interface FitParams {
  r0: number;
  r1: number;
  tau: number;
}

export interface FitReport {
  modelId: number;
  modelVersion: number;
  ocvVersion: number;
  observationsHash: string;
  n: number;
  status: FitStatus;
  params: FitParams | null;
  rmse: number | null;
  maxAbsResidual: number | null;
  residuals: { t: number; residual: number }[];
  iterations: number;
  note: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
