import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, httpStatus } from './errors.ts';
import { requirePageParams } from './db.ts';
import { Services } from './services.ts';
import { Store } from './store.ts';
import { buildFixture, type FixtureName } from './fixtures.ts';
import { validateParams, validateSegments } from './validation.ts';

interface RouteCtx {
  services: Services;
  store: Store;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RouteCtx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

const routes: Route[] = [
  route('GET', '/health', () => ({ status: 'ok' })),

  route('POST', '/models', (ctx) => {
    const b = ctx.body as {
      name?: string;
      params?: unknown;
      idempotencyKey?: string;
    };
    if (!b || typeof b.name !== 'string' || !b.name.trim()) {
      throw new AppError('VALIDATION', 'name 必填');
    }
    const params = validateParams(b.params);
    const { row, reused } = ctx.store.createModel(b.name, params, {
      idempotencyKey: b.idempotencyKey,
    });
    return { id: row.id, name: row.name, version: row.version, reused };
  }),

  route('GET', '/models', (ctx) => {
    const { page, pageSize } = requirePageParams(Object.fromEntries(ctx.query));
    const name = ctx.query.get('name') ?? undefined;
    return ctx.store.listModels(page, pageSize, name);
  }),

  route('GET', '/models/:id', (ctx) => {
    const row = ctx.store.getModelById(Number(ctx.params.id));
    return { ...row, params: JSON.parse(row.params_json) };
  }),

  route('POST', '/models/:id/pulses', (ctx) => {
    const modelId = Number(ctx.params.id);
    const b = ctx.body as { segments?: unknown; idempotencyKey?: string };
    const segments = validateSegments(b?.segments);
    return ctx.store.addPulses(modelId, segments, b?.idempotencyKey);
  }),

  route('GET', '/models/:id/pulses', (ctx) => {
    const version = ctx.query.get('version') ? Number(ctx.query.get('version')) : undefined;
    return ctx.store.getPulses(Number(ctx.params.id), version);
  }),

  route('POST', '/models/:id/simulate', (ctx) => {
    const b = (ctx.body ?? {}) as { pulseVersion?: number; sampleDt?: number };
    return ctx.services.simulateModel(
      Number(ctx.params.id),
      b.pulseVersion,
      b.sampleDt,
    );
  }),

  route('POST', '/datasets/fixture/:name', (ctx) => {
    const name = ctx.params.name as FixtureName;
    const fx = buildFixture(name);
    const dsName =
      (ctx.body as { datasetName?: string } | null)?.datasetName ?? `fixture-${name}`;
    const { id, reused } = ctx.store.createDataset(
      dsName,
      fx.observations,
      `fixture:${name}`,
      (ctx.body as { idempotencyKey?: string } | null)?.idempotencyKey,
    );
    return {
      id,
      reused,
      name: dsName,
      fixture: fx.name,
      note: fx.note,
      observations: fx.observations.length,
    };
  }),

  route('POST', '/datasets', (ctx) => {
    const b = ctx.body as {
      name?: string;
      observations?: unknown;
      source?: string;
      idempotencyKey?: string;
    };
    if (!b || typeof b.name !== 'string' || !b.name.trim()) {
      throw new AppError('VALIDATION', 'name 必填');
    }
    if (!Array.isArray(b.observations)) throw new AppError('VALIDATION', 'observations 必须为数组');
    return ctx.store.createDataset(
      b.name,
      b.observations as never,
      b.source ?? 'api',
      b.idempotencyKey,
    );
  }),

  route('GET', '/datasets', (ctx) => {
    const { page, pageSize } = requirePageParams(Object.fromEntries(ctx.query));
    return ctx.store.listDatasets(page, pageSize);
  }),

  route('GET', '/datasets/:id', (ctx) => ctx.store.getDataset(Number(ctx.params.id))),

  route('POST', '/models/:id/fit/:datasetId', (ctx) => {
    const b = (ctx.body ?? {}) as {
      idempotencyKey?: string;
      maxIterations?: number;
      start?: unknown;
    };
    return ctx.services.startFit(
      Number(ctx.params.id),
      Number(ctx.params.datasetId),
      {
        idempotencyKey: b.idempotencyKey,
        maxIterations: b.maxIterations,
        start: b.start as never,
      },
    );
  }),

  route('POST', '/fits/:id/resume', (ctx) => {
    const maxIter =
      (ctx.body as { maxIterations?: number } | null)?.maxIterations ?? 400;
    return ctx.services.resumeFit(Number(ctx.params.id), maxIter);
  }),

  route('GET', '/fits/:id', (ctx) => ctx.store.getFitJob(Number(ctx.params.id))),

  route('GET', '/fits/:id/residuals', (ctx) => {
    const { page, pageSize } = requirePageParams(Object.fromEntries(ctx.query));
    const job = ctx.store.getFitJob(Number(ctx.params.id));
    const all = job.report?.residuals ?? [];
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize),
      page,
      pageSize,
      total: all.length,
      totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
      rmse: job.report?.rmse ?? null,
      maxAbsResidual: job.report?.maxAbsResidual ?? null,
      frozen: job.report?.frozen ?? null,
    };
  }),

  route('GET', '/fits', (ctx) => {
    const { page, pageSize } = requirePageParams(Object.fromEntries(ctx.query));
    const modelId = ctx.query.get('modelId') ? Number(ctx.query.get('modelId')) : undefined;
    return ctx.store.listFitJobs(page, pageSize, modelId);
  }),

  route('GET', '/compare', (ctx) => {
    const name = ctx.query.get('name');
    const a = Number(ctx.query.get('a'));
    const b = Number(ctx.query.get('b'));
    if (!name || !a || !b) {
      throw new AppError('VALIDATION', 'compare 需要 name, a, b 查询参数');
    }
    return ctx.services.compareVersions(name, a, b);
  }),
];

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { services: Services; store: Store },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const send = (status: number, payload: unknown) => {
    const text = JSON.stringify(payload, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  };
  try {
    let body: unknown = undefined;
    if (req.method && !['GET', 'HEAD'].includes(req.method)) {
      const raw = await readBody(req);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new AppError('BAD_REQUEST', '请求体不是合法 JSON');
        }
      }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const result = await r.handler({
        services: deps.services,
        store: deps.store,
        params,
        query: url.searchParams,
        body,
      });
      send(200, { ok: true, data: result });
      return;
    }
    send(404, { ok: false, error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${url.pathname}` } });
  } catch (e) {
    if (e instanceof AppError) {
      send(httpStatus(e.code), {
        ok: false,
        error: { code: e.code, message: e.message, details: e.details ?? null },
      });
    } else {
      send(500, {
        ok: false,
        error: { code: 'INTERNAL', message: (e as Error).message },
      });
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new AppError('BAD_REQUEST', '请求体超过 5MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
