import { simulate } from "./model.js";
import type { ModelParams, PulseSegment, Sample } from "./types.js";

/** Deterministic PRNG so generated fixtures are reproducible in tests/demos. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultOcvTable() {
  return [
    { soc: 0.0, ocv: 3.0 },
    { soc: 0.1, ocv: 3.2 },
    { soc: 0.2, ocv: 3.35 },
    { soc: 0.3, ocv: 3.45 },
    { soc: 0.4, ocv: 3.55 },
    { soc: 0.5, ocv: 3.65 },
    { soc: 0.6, ocv: 3.72 },
    { soc: 0.7, ocv: 3.8 },
    { soc: 0.8, ocv: 3.9 },
    { soc: 0.9, ocv: 4.05 },
    { soc: 1.0, ocv: 4.2 },
  ];
}

export function knownGoodParams(overrides: Partial<ModelParams> = {}): ModelParams {
  return {
    capacityAh: 10,
    soc0: 0.5,
    ocvTable: defaultOcvTable(),
    r0: 0.02,
    r1: 0.015,
    tau: 60,
    up0: 0,
    ...overrides,
  };
}

export interface FixtureSpec {
  kind:
    | "rest"
    | "constant"
    | "pulse_pos"
    | "pulse_neg"
    | "pulse_pair"
    | "zero_up0"
    | "short_record"
    | "soc_boundary_low"
    | "soc_boundary_high";
  params: ModelParams;
  segments: PulseSegment[];
  samples: Sample[];
  stopped: boolean;
  stopReason: string | null;
}

/** Build pulses and synthesize voltage observations via the analytic simulator. */
export function generateFixture(
  kind: FixtureSpec["kind"],
  opts: { noise?: number; seed?: number; sampleInterval?: number } = {},
): FixtureSpec {
  const noise = opts.noise ?? 0;
  const rand = mulberry32(opts.seed ?? 12345);
  const params = knownGoodParams();
  let segs: PulseSegment[] = [];
  let p: ModelParams = params;

  switch (kind) {
    case "rest":
      segs = [{ tStart: 0, tEnd: 600, current: 0 }];
      break;
    case "constant":
      segs = [{ tStart: 0, tEnd: 1200, current: 5 }];
      break;
    case "pulse_pos":
      segs = [
        { tStart: 0, tEnd: 120, current: 0 },
        { tStart: 120, tEnd: 240, current: 8 },
        { tStart: 240, tEnd: 600, current: 0 },
      ];
      break;
    case "pulse_neg":
      segs = [
        { tStart: 0, tEnd: 120, current: 0 },
        { tStart: 120, tEnd: 240, current: -8 },
        { tStart: 240, tEnd: 600, current: 0 },
      ];
      break;
    case "pulse_pair":
      segs = [
        { tStart: 0, tEnd: 60, current: 0 },
        { tStart: 60, tEnd: 180, current: 10 },
        { tStart: 180, tEnd: 360, current: 0 },
        { tStart: 360, tEnd: 480, current: -10 },
        { tStart: 480, tEnd: 900, current: 0 },
      ];
      break;
    case "zero_up0":
      p = knownGoodParams({ up0: 0, soc0: 0.6 });
      segs = [
        { tStart: 0, tEnd: 30, current: 6 },
        { tStart: 30, tEnd: 300, current: 0 },
      ];
      break;
    case "short_record":
      segs = [
        { tStart: 0, tEnd: 2, current: 0 },
        { tStart: 2, tEnd: 4, current: 8 },
        { tStart: 4, tEnd: 10, current: 0 },
      ];
      break;
    case "soc_boundary_low":
      p = knownGoodParams({ soc0: 0.02, capacityAh: 10 });
      segs = [{ tStart: 0, tEnd: 3600, current: 5 }]; // empties the cell
      break;
    case "soc_boundary_high":
      p = knownGoodParams({ soc0: 0.98, capacityAh: 10 });
      segs = [{ tStart: 0, tEnd: 3600, current: -5 }]; // overcharges
      break;
  }

  const interval =
    opts.sampleInterval ??
    (kind === "short_record" || kind === "soc_boundary_low" || kind === "soc_boundary_high" || kind === "rest"
      ? undefined
      : 5);
  const sim = simulate(p, segs, interval ? { sampleInterval: interval } : {});
  const samples: Sample[] = sim.samples.map((s) => ({
    t: s.t,
    current: s.current,
    voltage: noise ? s.voltage + (rand() - 0.5) * 2 * noise : s.voltage,
  }));
  return { kind, params: p, segments: segs, samples, stopped: sim.stopped, stopReason: sim.stopReason };
}

export const FIXTURE_KINDS: FixtureSpec["kind"][] = [
  "rest",
  "constant",
  "pulse_pos",
  "pulse_neg",
  "pulse_pair",
  "zero_up0",
  "short_record",
  "soc_boundary_low",
  "soc_boundary_high",
];
