import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, withTransaction } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Services } from '../src/services.ts';
import { buildFixture, standardParams } from '../src/fixtures.ts';

function dbPathFor(label: string): string {
  return new URL(`../tmp/test-${label}.db`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function openFresh(label: string): { db: DatabaseSync; path: string } {
  const path = dbPathFor(label);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  return { db: openDb(path), path };
}

test('迁移可重复执行：再次打开不报错且数据保留', () => {
  const { db, path } = openFresh('mig');
  const store = new Store(db);
  const created = store.createModel('mig-cell', standardParams()).row;
  db.close();
  const db2 = openDb(path);
  const store2 = new Store(db2);
  assert.equal(store2.getModel('mig-cell', created.version).id, created.id);
  db2.close();
  const db3 = openDb(path);
  new Store(db3).listModels(1, 10);
  db3.close();
});

test('事务回滚：中途抛错不留下部分写入', () => {
  const { db } = openFresh('rollback');
  const store = new Store(db);
  const before = (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c;
  assert.throws(() =>
    withTransaction(db, () => {
      store.createModel('tx-cell', standardParams());
      throw new Error('boom');
    }),
  );
  const after = (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c;
  assert.equal(after, before);
  db.close();
});

test('幂等：相同 idempotencyKey 重复提交返回同一资源', () => {
  const { db } = openFresh('idem');
  const store = new Store(db);
  const a = store.createModel('idem', standardParams(), { idempotencyKey: 'k-1' });
  const b = store.createModel('idem', standardParams(), { idempotencyKey: 'k-1' });
  assert.equal(a.row.id, b.row.id);
  assert.equal(b.reused, true);
  assert.equal(store.listModels(1, 50, 'idem').total, 1);
  db.close();
});

test('分页查询正确切片', () => {
  const { db } = openFresh('page');
  const store = new Store(db);
  for (let i = 0; i < 5; i++) store.createModel(`page-${i}`, standardParams());
  const p1 = store.listModels(1, 2);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.total, 5);
  assert.equal(p1.totalPages, 3);
  assert.equal(store.listModels(3, 2).items.length, 1);
  db.close();
});

test('重启后持久化：拟合任务跨连接暂停再续算', () => {
  const { db, path } = openFresh('restart');
  const store = new Store(db);
  const services = new Services(store);
  const model = store.createModel('persist-cell', standardParams()).row;
  store.addPulses(model.id, buildFixture('pulse').segments);
  const ds = store.createDataset('persist-pulse', buildFixture('pulse').observations, 'fx');
  const paused = services.startFit(model.id, ds.id, {
    maxIterations: 3,
    start: { r0: 0.2, r1: 0.1, tau: 8 },
  });
  assert.equal(paused.status, 'paused');
  db.close();

  const db2 = openDb(path);
  const store2 = new Store(db2);
  const job = store2.getFitJob(paused.jobId);
  assert.equal(job.status, 'paused');
  assert.ok(job.optimizerState);
  const resumed = new Services(store2).resumeFit(paused.jobId, 400);
  assert.equal(resumed.status, 'completed');
  assert.ok(Math.abs(resumed.report!.fitted!.r0 - 0.05) < 1e-3);
  db2.close();
});

test('createModel 版本递增且不覆盖旧版本', () => {
  const { db } = openFresh('version');
  const store = new Store(db);
  const v1 = store.createModel('ver', standardParams()).row;
  const v2 = store.cloneAsNewVersion('ver', { ...standardParams(), r0: 0.09 }, v1.id);
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(store.getModel('ver', 1).id, v1.id);
  db.close();
});

test('所有数据库文件均落在项目 tmp 目录', () => {
  assert.ok(dbPathFor('x').replace(/\\/g, '/').includes('/tmp/'));
});
