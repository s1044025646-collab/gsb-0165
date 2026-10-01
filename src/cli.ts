import { readFileSync, writeFileSync, existsSync, readFileSync as rf } from "node:fs";
import { resolve } from "node:path";
import { DB_PATH, DATA_DIR, PID_FILE, PORT_FILE, dbFromEnv } from "./config.js";
import { generateFixture, FIXTURE_KINDS, knownGoodParams } from "./fixtures.js";
import { simulate } from "./model.js";
import {
  cloneModelVersion,
  compareVersions,
  getReport,
  ingestDataset,
  makeModel,
  replaceParams,
  runFit,
} from "./services.js";
import { getModel, parseParams, parseSamples } from "./db.js";
import { freezeObservations } from "./fitter.js";
import { startServer } from "./api.js";
import { mkdirSync, writeFileSync as wf } from "node:fs";

function readJsonArg(v: string) {
  if (existsSync(v)) return JSON.parse(readFileSync(v, "utf8"));
  return JSON.parse(v);
}

function show(title: string, obj: unknown) {
  console.log(`\n== ${title} ==`);
  console.log(JSON.stringify(obj, null, 2));
}

function briefModel(id: number) {
  const row = getModel(dbFromEnv(), id);
  const p = parseParams(row);
  return { id: row.id, version: row.version, name: row.name, r0: p.r0, r1: p.r1, tau: p.tau, soc0: p.soc0 };
}

const db = dbFromEnv();
const [, , cmd, ...rest] = process.argv;

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) out[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  return out;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  switch (cmd) {
    case "init": {
      console.log(`database ready at ${DB_PATH}`);
      break;
    }
    case "create-model": {
      const f = flags(rest);
      const name = f.name ?? "default";
      const params = f.params ? readJsonArg(f.params) : knownGoodParams();
      console.log("before:", "no model");
      const res = makeModel(db, name, params, { idempotencyKey: f.idem });
      show("model created" + (res.replayed ? " (idempotent replay)" : ""), {
        ...briefModel(res.model.id),
        replayed: res.replayed,
      });
      break;
    }
    case "list-models": {
      const f = flags(rest);
      const limit = Number(f.limit ?? 20);
      const offset = Number(f.offset ?? 0);
      const { listModels } = await import("./db.js");
      const page = listModels(db, { limit, offset, lineageId: f.lineage ? Number(f.lineage) : undefined });
      show(`models ${offset + 1}-${offset + page.items.length} of ${page.total}`, page);
      break;
    }
    case "get-model": {
      const id = Number(rest[0]);
      show("model", briefModel(id));
      break;
    }
    case "set-params": {
      const id = Number(rest[0]);
      console.log("before:", briefModel(id));
      const updated = replaceParams(db, id, readJsonArg(flags(rest).params));
      console.log("after:", { id: updated.id, r0: updated.params.r0, r1: updated.params.r1, tau: updated.params.tau });
      break;
    }
    case "new-version": {
      const id = Number(rest[0]);
      const f = flags(rest);
      console.log("source:", briefModel(id));
      const res = cloneModelVersion(db, id, f.name ?? `v-clone-${Date.now()}`);
      console.log("after: new version", briefModel(res.model.id));
      break;
    }
    case "compare": {
      const f = flags(rest);
      show("version comparison", compareVersions(db, Number(f.a), Number(f.b)));
      break;
    }
    case "fixture": {
      const kind = rest[0];
      if (!FIXTURE_KINDS.includes(kind as never)) throw new Error(`unknown fixture kind: ${kind}`);
      const f = flags(rest);
      const fx = generateFixture(kind as never, { noise: f.noise ? Number(f.noise) : 0, seed: f.seed ? Number(f.seed) : 12345 });
      const out = f.out ? resolve(f.out) : undefined;
      if (out) {
        wf(out, JSON.stringify(fx, null, 2));
        console.log(`fixture written to ${out} (n=${fx.samples.length}, stopped=${fx.stopped} ${fx.stopReason ?? ""})`);
      } else {
        show(`fixture:${kind}`, fx);
      }
      break;
    }
    case "simulate": {
      const id = Number(rest[0]);
      const segments = readJsonArg(flags(rest).segments);
      const p = parseParams(getModel(db, id));
      console.log("before:", { soc0: p.soc0, up0: p.up0 });
      const res = simulate(p, segments);
      show("simulation", {
        n: res.samples.length,
        stopped: res.stopped,
        stopReason: res.stopReason,
        finalSoc: res.finalSoc,
        first: res.samples[0],
        last: res.samples[res.samples.length - 1],
      });
      break;
    }
    case "ingest": {
      const id = Number(rest[0]);
      const f = flags(rest);
      const fx = JSON.parse(rf(resolve(f.file), "utf8")) as { samples: never[] };
      const hash = freezeObservations(fx.samples, parseParams(getModel(db, id)).ocvTable);
      const res = ingestDataset(db, id, f.name ?? "dataset", fx.samples, hash, f.idem);
      show("dataset ingested" + (res.replayed ? " (replay)" : ""), { id: res.row.id, n: fx.samples.length, replayed: res.replayed });
      break;
    }
    case "fit": {
      const datasetId = Number(rest[0]);
      const f = flags(rest);
      const budget = Number(f.budget ?? 2000);
      const { job, report } = runFit(db, datasetId, budget);
      console.log(`job status: ${job.status} (budget used ${job.budget_used})`);
      if (report) {
        show("fit report", {
          identifiable: report.status.identifiable,
          reasons: report.status.reasons,
          params: report.params,
          rmse: report.rmse,
          maxAbsResidual: report.maxAbsResidual,
          iterations: report.iterations,
          frozen: { modelVersion: report.modelVersion, ocvVersion: report.ocvVersion, observationsHash: report.observationsHash.slice(0, 12) },
        });
      } else {
        console.log("optimization paused; run `resume` to continue. User parameters were NOT modified.");
      }
      break;
    }
    case "resume": {
      const datasetId = Number(rest[0]);
      const f = flags(rest);
      const { job, report } = runFit(db, datasetId, Number(f.budget ?? 2000));
      console.log(`resumed -> status: ${job.status} (budget ${job.budget_used})`);
      if (report) show("fit report", { params: report.params, rmse: report.rmse, identifiable: report.status.identifiable, reasons: report.status.reasons });
      break;
    }
    case "residuals": {
      const datasetId = Number(rest[0]);
      const f = flags(rest);
      const report = getReport(db, datasetId);
      const limit = Number(f.limit ?? 50);
      const offset = Number(f.offset ?? 0);
      show("residuals", {
        total: report.residuals.length,
        rmse: report.rmse,
        items: report.residuals.slice(offset, offset + limit),
      });
      break;
    }
    case "serve": {
      const { server, port } = await startServer({ db, portFile: PORT_FILE, port: process.env.BATT_PORT ? Number(process.env.BATT_PORT) : 0 });
      wf(PID_FILE, String(process.pid));
      console.log(`API listening on http://127.0.0.1:${port} (loopback only). pid=${process.pid}`);
      console.log("press Ctrl+C to stop.");
      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
      break;
    }
    case "demo": {
      await runDemo();
      break;
    }
    default:
      console.log(`unknown command: ${cmd ?? ""}
commands: init create-model list-models get-model set-params new-version compare
          fixture simulate ingest fit resume residuals serve demo`);
      process.exit(1);
  }
}

async function runDemo() {
  console.log("# End-to-end demo (deterministic; uses project-local data/demo.db)");
  const { openDb } = await import("./db.js");
  const demoDb = openDb(resolve(DATA_DIR, "demo.db"));
  const created = makeModel(demoDb, "demo-cell", knownGoodParams(), { idempotencyKey: "demo-model" });
  const modelId = created.model.id;
  console.log("model:", { id: modelId, replayed: created.replayed });

  const fx = generateFixture("pulse_pair", { noise: 1e-4, seed: 42 });
  const hash = freezeObservations(fx.samples, created.model.params.ocvTable);
  const ds = ingestDataset(demoDb, modelId, "demo-pulses", fx.samples, hash, "demo-dataset");
  console.log("dataset:", { id: ds.row.id, n: fx.samples.length, replayed: ds.replayed });

  const { job, report } = runFit(demoDb, ds.row.id, 4000);
  console.log("fit:", { status: job.status, identifiable: report?.status.identifiable, fitted: report?.params, rmse: report?.rmse });
  console.log("original user params untouched ->", { r0: created.model.params.r0, r1: created.model.params.r1, tau: created.model.params.tau });

  const rest = generateFixture("rest");
  const restHash = freezeObservations(rest.samples, created.model.params.ocvTable);
  const dsRest = ingestDataset(demoDb, modelId, "rest", rest.samples, restHash, "demo-rest");
  const unid = runFit(demoDb, dsRest.row.id, 100);
  console.log("unidentifiable rest fixture:", unid.report?.status);

  const boundary = generateFixture("soc_boundary_low");
  console.log("boundary fixture:", { stopped: boundary.stopped, reason: boundary.stopReason, samples: boundary.samples.length });
}

main().catch((err) => {
  console.error(`error [${err.code ?? "ERROR"}]: ${err.message}`);
  if (err.details) console.error(JSON.stringify(err.details));
  process.exit(1);
});
