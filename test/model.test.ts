import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SECONDS_PER_HOUR,
  ocvAt,
  simulate,
  stepPolarization,
  stepSoc,
  validateParams,
  validateSegments,
} from "../src/model.js";
import { generateFixture, knownGoodParams } from "../src/fixtures.js";
import { AppError } from "../src/errors.js";

test("OCV piecewise linear interpolation", () => {
  const p = knownGoodParams();
  assert.equal(ocvAt(p.ocvTable, 0), 3.0);
  assert.equal(ocvAt(p.ocvTable, 1), 4.2);
  const mid = ocvAt(p.ocvTable, 0.05);
  assert.ok(Math.abs(mid - 3.1) < 1e-12);
  assert.throws(() => ocvAt(p.ocvTable, -0.01), AppError);
});

test("rejects non-positive parameters", () => {
  assert.throws(() => validateParams(knownGoodParams({ r0: 0 })), /positive/);
  assert.throws(() => validateParams(knownGoodParams({ tau: -1 })), /positive/);
  assert.throws(() => validateParams(knownGoodParams({ capacityAh: 0 })), /positive/);
});

test("rejects reversed/overlapping timing and bad OCV coverage", () => {
  assert.throws(
    () => validateSegments([{ tStart: 5, tEnd: 1, current: 1 }]),
    /tEnd > tStart/,
  );
  assert.throws(
    () =>
      validateSegments([
        { tStart: 0, tEnd: 2, current: 1 },
        { tStart: 1, tEnd: 3, current: 1 },
      ]),
    /non-overlapping/,
  );
  assert.throws(
    () => validateParams(knownGoodParams({ ocvTable: [{ soc: 0.1, ocv: 3 }, { soc: 1, ocv: 4 }] })),
    /coverage/,
  );
});

test("charge/discharge sign: discharge lowers SOC, charge raises it", () => {
  const p = knownGoodParams();
  const dis = stepSoc(p.soc0, 5, p.capacityAh, SECONDS_PER_HOUR);
  assert.ok(Math.abs(dis - (0.5 - 5 / 10)) < 1e-12);
  const chg = stepSoc(p.soc0, -5, p.capacityAh, SECONDS_PER_HOUR);
  assert.ok(chg > p.soc0);
});

test("analytic RC steady state matches I*R1 and zero-current relaxes to 0", () => {
  const up = stepPolarization(0, 2, 0.015, 60, 60 * 30);
  assert.ok(Math.abs(up - 2 * 0.015) < 1e-9);
  const relaxed = stepPolarization(0.03, 0, 0.015, 60, 60 * 30);
  assert.ok(Math.abs(relaxed) < 1e-9);
});

test("charge conservation over constant current", () => {
  const p = knownGoodParams();
  const res = simulate(p, [{ tStart: 0, tEnd: 1800, current: 4 }]); // 0.5 h at 4 A
  assert.equal(res.stopped, false);
  assert.ok(Math.abs(res.finalSoc - (0.5 - (4 * 0.5) / 10)) < 1e-9);
});

test("time-unit equivalence: seconds vs equivalent split give identical SOC", () => {
  const p = knownGoodParams();
  const a = simulate(p, [{ tStart: 0, tEnd: 120, current: 6 }]);
  const b = simulate(p, [
    { tStart: 0, tEnd: 60, current: 6 },
    { tStart: 60, tEnd: 120, current: 6 },
  ]);
  assert.ok(Math.abs(a.finalSoc - b.finalSoc) < 1e-12);
  assert.ok(Math.abs(a.finalUp - b.finalUp) < 1e-12);
});

test("segment subdivision invariance for polarization voltage", () => {
  const p = knownGoodParams();
  const coarse = simulate(p, [
    { tStart: 0, tEnd: 100, current: 0 },
    { tStart: 100, tEnd: 220, current: 7 },
  ]);
  const fine = simulate(p, [
    { tStart: 0, tEnd: 100, current: 0 },
    { tStart: 100, tEnd: 160, current: 7 },
    { tStart: 160, tEnd: 220, current: 7 },
  ]);
  assert.ok(Math.abs(coarse.finalUp - fine.finalUp) < 1e-12);
  assert.ok(Math.abs(coarse.samples.at(-1)!.voltage - fine.samples.at(-1)!.voltage) < 1e-12);
});

test("SOC boundary stops with explicit reason instead of clipping", () => {
  const low = generateFixture("soc_boundary_low");
  assert.equal(low.stopped, true);
  assert.equal(low.stopReason, "SOC_BELOW_0");
  assert.ok(low.samples.at(-1)!.t < 3600);
  const high = generateFixture("soc_boundary_high");
  assert.equal(high.stopReason, "SOC_ABOVE_1");
});

test("rest and zero initial polarization fixtures behave correctly", () => {
  const rest = generateFixture("rest");
  assert.equal(rest.stopped, false);
  const v0 = rest.samples[0].voltage;
  const vEnd = rest.samples.at(-1)!.voltage;
  assert.ok(Math.abs(v0 - vEnd) < 1e-9);
  const z = generateFixture("zero_up0");
  assert.equal(z.params.up0, 0);
});
