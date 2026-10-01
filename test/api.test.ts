import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Services } from '../src/services.ts';
import { handleRequest } from '../src/api.ts';
import { standardParams } from '../src/fixtures.ts';

const DB_PATH = new URL('../tmp/test-api.db', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let server: Server;
let base: string;

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
  const db = openDb(DB_PATH);
  const store = new Store(db);
  const services = new Services(store);
  server = createServer((req, res) => void handleRequest(req, res, { services, store }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${(addr as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  return { status: res.status, json };
}

test('健康检查', async () => {
  const r = await api('/health');
  assert.equal(r.status, 200);
  assert.equal((r.json.data as { status: string }).status, 'ok');
});

test('建模型 -> 存脉冲 -> 仿真 全链路', async () => {
  const created = await api('/models', {
    method: 'POST',
    body: { name: 'api-cell', params: standardParams() },
  });
  assert.equal(created.status, 200);
  const modelId = (created.json.data as { id: number }).id;

  const pulses = await api(`/models/${modelId}/pulses`, {
    method: 'POST',
    body: {
      segments: [
        { startTime: 0, endTime: 30, currentA: 0 },
        { startTime: 30, endTime: 60, currentA: 2 },
        { startTime: 60, endTime: 120, currentA: 0 },
      ],
    },
  });
  assert.equal(pulses.status, 200);

  const sim = await api(`/models/${modelId}/simulate`, { method: 'POST', body: { sampleDt: 10 } });
  assert.equal(sim.status, 200);
  const data = sim.json.data as { samples: unknown[]; finalSoc: number };
  assert.ok(data.samples.length > 5);
  assert.ok(data.finalSoc < standardParams().initialSoc);
});

test('参数校验返回明确错误码', async () => {
  const r = await api('/models', {
    method: 'POST',
    body: { name: 'bad', params: { ...standardParams(), r0: -1 } },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error!.code, 'NON_POSITIVE_PARAM');
});

test('未知资源 404 与错误分页 400', async () => {
  assert.equal((await api('/models/99999')).status, 404);
  const p = await api('/models?page=0');
  assert.equal(p.status, 400);
  assert.equal(p.json.error!.code, 'VALIDATION');
});

test('夹具 -> 拟合 -> 残差 与 不可辨识', async () => {
  await api('/models', { method: 'POST', body: { name: 'fit-cell', params: standardParams() } });
  const list = await api('/models?name=fit-cell');
  const modelId = (list.json.data as { items: Array<{ id: number }> }).items[0].id;

  const fx = await api('/datasets/fixture/pulse', {
    method: 'POST',
    body: { datasetName: 'api-pulse' },
  });
  const datasetId = (fx.json.data as { id: number }).id;

  const fit = await api(`/models/${modelId}/fit/${datasetId}`, { method: 'POST', body: {} });
  assert.equal(fit.status, 200);
  const report = (fit.json.data as { report: { fitted: { r0: number }; frozen: unknown } }).report;
  assert.ok(Math.abs(report.fitted.r0 - 0.05) < 1e-3);
  assert.ok(report.frozen);

  const jobId = (fit.json.data as { jobId: number }).jobId;
  const residuals = await api(`/fits/${jobId}/residuals?page=1&pageSize=5`);
  const rd = residuals.json.data as { items: unknown[]; total: number };
  assert.equal(rd.items.length, 5);
  assert.ok(rd.total > 5);

  const restFx = await api('/datasets/fixture/rest', {
    method: 'POST',
    body: { datasetName: 'api-rest' },
  });
  const restId = (restFx.json.data as { id: number }).id;
  const unfit = await api(`/models/${modelId}/fit/${restId}`, { method: 'POST', body: {} });
  const u = unfit.json.data as { status: string; report: { identifiable: boolean } };
  assert.equal(u.status, 'unidentifiable');
  assert.equal(u.report.identifiable, false);
});

test('重复提交幂等：同一 key 不新建拟合任务', async () => {
  await api('/datasets/fixture/pulse', {
    method: 'POST',
    body: { datasetName: 'idem-pulse' },
  });
  const modelId = (
    (await api('/models?name=fit-cell')).json.data as { items: Array<{ id: number }> }
  ).items[0].id;
  const dsId = ((await api('/datasets?pageSize=200')).json.data as { items: Array<{ id: number; name: string }> }).items.find(
    (d) => d.name === 'idem-pulse',
  )!.id;
  const a = await api(`/models/${modelId}/fit/${dsId}`, {
    method: 'POST',
    body: { idempotencyKey: 'fit-key-1' },
  });
  const b = await api(`/models/${modelId}/fit/${dsId}`, {
    method: 'POST',
    body: { idempotencyKey: 'fit-key-1' },
  });
  assert.equal(
    (a.json.data as { jobId: number }).jobId,
    (b.json.data as { jobId: number; reused: boolean }).jobId,
  );
  assert.equal((b.json.data as { reused: boolean }).reused, true);
});

test('暂停续算经 API 工作', async () => {
  const modelId = (
    (await api('/models?name=fit-cell')).json.data as { items: Array<{ id: number }> }
  ).items[0].id;
  const dsId = ((await api('/datasets?pageSize=200')).json.data as { items: Array<{ id: number; name: string }> }).items.find(
    (d) => d.name === 'api-pulse',
  )!.id;
  const paused = await api(`/models/${modelId}/fit/${dsId}`, {
    method: 'POST',
    body: { maxIterations: 2, idempotencyKey: 'pause-api' },
  });
  const jobId = (paused.json.data as { jobId: number; status: string }).jobId;
  assert.equal(paused.json.data.status, 'paused');
  const resumed = await api(`/fits/${jobId}/resume`, { method: 'POST', body: { maxIterations: 400 } });
  assert.equal((resumed.json.data as { status: string }).status, 'completed');
});
