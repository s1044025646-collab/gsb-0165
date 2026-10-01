import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { freezeObservations } from "./fitter.js";
import { generateFixture } from "./fixtures.js";
import {
  listDatasets,
  listModels,
  getDataset,
  getModel,
} from "./db.js";
import {
  cloneModelVersion,
  compareVersions,
  getReport,
  ingestDataset,
  makeModel,
  replaceParams,
  runFit,
  summarize,
} from "./services.js";
import { parseParams, parseSamples } from "./db.js";
import { simulate } from "./model.js";
import type { Page, Sample } from "./types.js";

interface RouteCtx {
  db: DatabaseSync;
  body: any;
  query: URLSearchParams;
  params: Record<string, string>;
}

type Handler = (ctx: RouteCtx) => unknown | Promise<unknown>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([^/]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler });
}

function paginate(q: URLSearchParams): { limit: number; offset: number } {
  const limit = Number(q.get("limit") ?? "50");
  const offset = Number(q.get("offset") ?? "0");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new AppError("VALIDATION_ERROR", "limit must be an integer in [1,500]");
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("VALIDATION_ERROR", "offset must be a non-negative integer");
  return { limit, offset };
}

function idParam(ctx: RouteCtx, key: string): number {
  const v = Number(ctx.params[key]);
  if (!Number.isInteger(v) || v <= 0) throw new AppError("VALIDATION_ERROR", `${key} must be a positive integer`);
  return v;
}

route("GET", "/health", () => ({ ok: true }));

route("POST", "/models", (ctx) => {
  const { name, params, idempotencyKey } = ctx.body ?? {};
  if (typeof name !== "string" || !name.trim()) throw new AppError("VALIDATION_ERROR", "name is required");
  if (!params || typeof params !== "object") throw new AppError("VALIDATION_ERROR", "params is required");
  return makeModel(ctx.db, name, params, { idempotencyKey });
});

route("GET", "/models", (ctx) => {
  const { limit, offset } = paginate(ctx.query);
  const lineageId = ctx.query.get("lineageId");
  const page: Page<unknown> = listModels(ctx.db, {
    limit,
    offset,
    lineageId: lineageId ? Number(lineageId) : undefined,
  });
  return { ...page, items: page.items.map((r) => summarize(r as never)) };
});

route("GET", "/models/:id", (ctx) => summarize(getModel(ctx.db, idParam(ctx, "id")) as never));

route("PUT", "/models/:id/params", (ctx) => {
  const params = ctx.body?.params;
  if (!params) throw new AppError("VALIDATION_ERROR", "params is required");
  return replaceParams(ctx.db, idParam(ctx, "id"), params);
});

route("POST", "/models/:id/versions", (ctx) => {
  const name = ctx.body?.name;
  if (typeof name !== "string" || !name.trim()) throw new AppError("VALIDATION_ERROR", "name is required");
  return cloneModelVersion(ctx.db, idParam(ctx, "id"), name);
});

route("GET", "/models/:id/compare/:otherId", (ctx) =>
  compareVersions(ctx.db, idParam(ctx, "id"), idParam(ctx, "otherId")),
);

route("POST", "/models/:id/simulate", (ctx) => {
  const model = getModel(ctx.db, idParam(ctx, "id"));
  const segments = ctx.body?.segments;
  if (!Array.isArray(segments)) throw new AppError("VALIDATION_ERROR", "segments array is required");
  return simulate(parseParams(model), segments);
});

route("POST", "/fixtures", (ctx) => {
  const kind = ctx.body?.kind;
  const noise = ctx.body?.noise ?? 0;
  const seed = ctx.body?.seed;
  return generateFixture(kind, { noise, seed });
});

route("POST", "/models/:id/datasets", (ctx) => {
  const modelId = idParam(ctx, "id");
  const name = ctx.body?.name;
  const samples = ctx.body?.samples as Sample[] | undefined;
  if (typeof name !== "string" || !name.trim()) throw new AppError("VALIDATION_ERROR", "name is required");
  if (!Array.isArray(samples)) throw new AppError("VALIDATION_ERROR", "samples array is required");
  const model = getModel(ctx.db, modelId);
  const obsHash = freezeObservations(samples, parseParams(model).ocvTable);
  return ingestDataset(ctx.db, modelId, name, samples, obsHash, ctx.body?.idempotencyKey);
});

route("GET", "/datasets", (ctx) => {
  const { limit, offset } = paginate(ctx.query);
  const modelId = ctx.query.get("modelId");
  return listDatasets(ctx.db, { limit, offset, modelId: modelId ? Number(modelId) : undefined });
});

route("GET", "/datasets/:id", (ctx) => getDataset(ctx.db, idParam(ctx, "id")));

route("POST", "/datasets/:id/fit", (ctx) => {
  const budget = ctx.body?.budget ?? 2000;
  if (!Number.isInteger(budget) || budget < 1) throw new AppError("VALIDATION_ERROR", "budget must be a positive integer");
  return runFit(ctx.db, idParam(ctx, "id"), budget);
});

route("GET", "/datasets/:id/report", (ctx) => getReport(ctx.db, idParam(ctx, "id")));

route("GET", "/datasets/:id/residuals", (ctx) => {
  const report = getReport(ctx.db, idParam(ctx, "id"));
  const { limit, offset } = paginate(ctx.query);
  return {
    total: report.residuals.length,
    limit,
    offset,
    items: report.residuals.slice(offset, offset + limit),
    rmse: report.rmse,
    maxAbsResidual: report.maxAbsResidual,
  };
});

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) reject(new AppError("VALIDATION_ERROR", "request body too large"));
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("VALIDATION_ERROR", "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function createApiServer(db: DatabaseSync): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const result = await r.handler({ db, body, query: url.searchParams, params });
        return send(res, 200, { ok: true, data: result });
      }
      send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "no such route" } });
    } catch (err) {
      if (err instanceof AppError) {
        const status =
          err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" || err.code === "IDEMPOTENCY_REPLAY" ? 409 : 400;
        return send(res, status, { ok: false, error: { code: err.code, message: err.message, details: err.details } });
      }
      send(res, 500, { ok: false, error: { code: "INTERNAL", message: (err as Error).message } });
    }
  });
  return server;
}

export interface ServeOptions {
  db: DatabaseSync;
  portFile?: string;
  port?: number;
  host?: string;
}

/** Bind only to loopback; port 0 lets the OS assign a free port. */
export function startServer(opts: ServeOptions): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    const server = createApiServer(opts.db);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (opts.portFile) writeFileSync(opts.portFile, String(port), "utf8");
      resolve({ server, port });
    });
  });
}
