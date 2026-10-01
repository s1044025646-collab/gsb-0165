import { predictSeries } from "./model.js";
import { decode } from "./fitter.js";
import type { ModelParams, Sample } from "./types.js";

/** Sum of squared errors for a log-space simplex vertex. */
export function sseFor(p: ModelParams, obs: Sample[], x: number[]): number {
  const theta = decode(x);
  const pred = predictSeries(p, obs, theta);
  let sum = 0;
  for (let i = 0; i < obs.length; i++) {
    const e = obs[i].voltage - pred[i].predicted;
    sum += e * e;
  }
  return sum;
}
