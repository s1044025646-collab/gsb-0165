import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getModel, openDb, parseParams } from "../src/db.js";
import { generateFixture, knownGoodParams } from "../src/fixtures.js";
import { freezeObservations } from "../src/fitter.js";
import { ingestDataset, makeModel, runFit, getReport } from "../src/services.js";
import { AppError } from "../src/errors.js";

function tempDb() {
  return openDb(join(tmpdir(), `batt-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`));
}

function ingest(db: ReturnType<typeof tempDb>, kind: ReturnType<typeof generateFixture>["kind"], key: string, modelId: number, params = knownGoodParams()) {
  const fx = generateFixture(kind, { noise: 1e-5, seed: 7 });
  const hash = freezeObservations(fx.samples, params.ocvTable);
  return ingestDataset(db, modelId, kind, fx.samples, hash, key);
}

test("recovers known R0/R1/tau from synthetic pulse data", () => {
  const db = tempDb();
  const params = knownGoodParams();
  const { model } = makeModel(db, "cell", params);
  const { row } = ingest(db, "pulse_pair", "k1", model.id, params);
  const { report } = runFit(db, row.id, 4000);
  assert.ok(report);
  assert.equal(report!.status.identifiable, true, report!.status.reasons.join(","));
  const rel = (a: number, b: number) => Math.abs(a - b) / b;
  assert.ok(rel(report!.params!.r0, params.r0) < 0.1, `r0 ${report!.params!.r0}`);
  assert.ok(rel(report!.params!.r1, params.r1) < 0.1, `r1 ${report!.params!.r1}`);
  assert.ok(rel(report!.params!.tau, params.tau) < 0.2, `tau ${report!.params!.tau}`);
  assert.ok(report!.rmse! < 1e-3);
});

test("fitting does NOT overwrite user model parameters", () => {
  const db = tempDb();
  const before = knownGoodParams();
  const { model } = makeModel(db, "cell", before);
  const { row } = ingest(db, "pulse_pos", "k2", model.id, before);
  runFit(db, row.id, 4000);
  const after = parseParams(getModel(db, model.id));
  assert.equal(after.r0, before.r0);
  assert.equal(after.tau, before.tau);
});

test("rest fixture (no current variation) flagged unidentifiable", () => {
  const db = tempDb();
  const params = knownGoodParams();
  const { model } = makeModel(db, "cell", params);
  const { row } = ingest(db, "rest", "k3", model.id, params);
  const { report } = runFit(db, row.id, 100);
  assert.equal(report!.status.identifiable, false);
  assert.ok(report!.status.reasons.includes("NO_CURRENT_VARIATION"));
  assert.equal(report!.params, null);
});

test("short record relative to tau is flagged unidentifiable", () => {
  const db = tempDb();
  const params = knownGoodParams({ tau: 60000 });
  const { model } = makeModel(db, "long-tau", params);
  const { row } = ingest(db, "short_record", "k4", model.id, params);
  const { report } = runFit(db, row.id, 4000);
  assert.equal(report!.status.identifiable, false);
  assert.ok(report!.status.reasons.includes("RECORD_SHORTER_THAN_TAU"));
});

test("pause and resume converge to the same fit", () => {
  const db = tempDb();
  const params = knownGoodParams();
  const { model } = makeModel(db, "cell", params);
  const { row } = ingest(db, "pulse_pair", "k5", model.id, params);
  const first = runFit(db, row.id, 30);
  assert.equal(first.report, null);
  assert.equal(first.job.status, "paused");
  let next = runFit(db, row.id, 30);
  while (!next.report) next = runFit(db, row.id, 100);
  const report = getReport(db, row.id);
  assert.equal(report.status.identifiable, true);
  assert.ok(report.params!.tau > 0);
});

test("report freezes observation and OCV versions", () => {
  const db = tempDb();
  const params = knownGoodParams();
  const { model } = makeModel(db, "cell", params);
  const { row } = ingest(db, "pulse_neg", "k6", model.id, params);
  const { report } = runFit(db, row.id, 4000);
  assert.equal(report!.modelVersion, 1);
  assert.equal(report!.ocvVersion, 1);
  assert.match(report!.observationsHash, /^[0-9a-f]{64}$/);
  assert.match(report!.note, /Simplified/);
});

test("missing model/dataset yields NOT_FOUND", () => {
  const db = tempDb();
  assert.throws(() => runFit(db, 999, 10), (e: AppError) => e.code === "NOT_FOUND");
});
