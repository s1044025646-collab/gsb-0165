import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { migrate, openDb } from "../src/db.js";
import { makeModel } from "../src/services.js";
import { knownGoodParams, generateFixture } from "../src/fixtures.js";
import { freezeObservations } from "../src/fitter.js";
import { ingestDataset, runFit, getReport } from "../src/services.js";
import { startServer, createApiServer } from "../src/api.js";

const dbPath = join(tmpdir(), `batt-persist-${process.pid}.db`);

test("transaction rollback on invalid dataset leaves no rows", () => {
  const db = openDb(dbPath);
  const { model } = makeModel(db, "rollback-cell", knownGoodParams(), { idempotencyKey: "rb-1" });
  const before = (db.prepare("SELECT COUNT(*) c FROM datasets").get() as { c: number }).c;
  assert.throws(() => ingestDataset(db, model.id, "bad", [{ t: 0, current: 0, voltage: 3 }], "x"));
  const after = (db.prepare("SELECT COUNT(*) c FROM datasets").get() as { c: number }).c;
  assert.equal(after, before);
  db.close();
});

test("idempotent model creation replays the same row", () => {
  const db = openDb(dbPath);
  const a = makeModel(db, "idem", knownGoodParams(), { idempotencyKey: "idem-key" });
  const b = makeModel(db, "idem", knownGoodParams(), { idempotencyKey: "idem-key" });
  assert.equal(a.model.id, b.model.id);
  assert.equal(b.replayed, true);
  db.close();
});

test("state persists across reopen", () => {
  let db = openDb(dbPath);
  const { model } = makeModel(db, "persist", knownGoodParams(), { idempotencyKey: "persist-1" });
  const fx = generateFixture("pulse_pair", { seed: 3 });
  const hash = freezeObservations(fx.samples, model.params.ocvTable);
  const ds = ingestDataset(db, model.id, "persist-ds", fx.samples, hash, "persist-ds-1");
  runFit(db, ds.row.id, 4000);
  db.close();

  db = openDb(dbPath);
  const report = getReport(db, ds.row.id);
  assert.equal(report.status.identifiable, true);
  assert.ok(report.params!.r0 > 0);
  db.close();
});

test("migrations are repeatable", () => {
  const db = openDb(dbPath);
  assert.doesNotThrow(() => migrate(db as never));
  db.close();
});

test("HTTP API validation, errors, pagination and full fit flow", async () => {
  const db = openDb(":memory:");
  const { server, port } = await startServer({ db, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  assert.equal((await call("GET", "/health")).json.ok, true);

  const created = await call("POST", "/models", { name: "api-cell", params: knownGoodParams() });
  const modelId = created.json.data.model.id;
  assert.equal(created.status, 200);

  const bad = await call("POST", "/models", { name: "x", params: { ...knownGoodParams(), r0: -1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "VALIDATION_ERROR");

  const notFound = await call("GET", "/models/9999");
  assert.equal(notFound.json.error.code, "NOT_FOUND");

  const fx = generateFixture("pulse_pos", { seed: 9 });
  const ds = await call("POST", `/models/${modelId}/datasets`, { name: "d", samples: fx.samples });
  const datasetId = ds.json.data.row.id;
  const fit = await call("POST", `/datasets/${datasetId}/fit`, { budget: 4000 });
  assert.equal(fit.json.data.report.status.identifiable, true);
  const res = await call("GET", `/datasets/${datasetId}/residuals?limit=2&offset=0`);
  assert.equal(res.json.data.items.length, 2);
  assert.equal(res.json.data.total, fx.samples.length);

  const paged = await call("GET", "/models?limit=1&offset=0");
  assert.equal(paged.json.data.limit, 1);
  assert.ok(paged.json.data.total >= 1);

  const badPage = await call("GET", "/models?limit=0");
  assert.equal(badPage.status, 400);

  const replayed = await call("POST", "/models", {
    name: "api-cell",
    params: knownGoodParams(),
    idempotencyKey: "api-idem",
  });
  const again = await call("POST", "/models", {
    name: "api-cell",
    params: knownGoodParams(),
    idempotencyKey: "api-idem",
  });
  assert.equal(replayed.json.data.model.id, again.json.data.model.id);
  assert.equal(again.json.data.replayed, true);

  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
});
