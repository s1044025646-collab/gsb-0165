import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOUNDS, fitParameters, identifiabilityChecks, runNelderMead } from '../src/fit.ts';
import { buildFixture } from '../src/fixtures.ts';

test('已知参数恢复：无噪声脉冲数据恢复 R0/R1/tau', () => {
  const fx = buildFixture('pulse');
  const report = fitParameters(fx.params, fx.observations, {
    start: { r0: 0.2, r1: 0.1, tau: 8 },
    maxIterations: 800,
  });
  assert.equal(report.identifiable, true, report.reasons.join(';'));
  const f = report.fitted!;
  assert.ok(Math.abs(f.r0 - fx.params.r0) < 1e-4, `r0=${f.r0}`);
  assert.ok(Math.abs(f.r1 - fx.params.r1) < 1e-3, `r1=${f.r1}`);
  assert.ok(Math.abs(f.tau - fx.params.tau) / fx.params.tau < 0.02, `tau=${f.tau}`);
  assert.ok((report.rmse ?? 1) < 1e-6);
});

test('有噪声也能近似恢复且报告残差', () => {
  const fx = buildFixture('pulseNoisy');
  const report = fitParameters(fx.params, fx.observations, { maxIterations: 600 });
  assert.equal(report.identifiable, true);
  assert.ok(report.residuals!.length === fx.observations.length);
  assert.ok(Math.abs(report.fitted!.r0 - fx.params.r0) < 0.02);
  assert.ok(report.rmse! > 0);
});

test('静置/恒流/短记录标注不可辨识，而不是给低误差数字', () => {
  for (const name of ['rest', 'constant', 'short'] as const) {
    const fx = buildFixture(name);
    const report = fitParameters(fx.params, fx.observations);
    assert.equal(report.identifiable, false, name);
    assert.ok(report.reasons.length > 0, name);
    assert.equal(report.fitted, undefined);
  }
});

test('identifiabilityChecks 直接判定时间过短', () => {
  const obs = [
    { time: 0, currentA: 0, voltage: 4 },
    { time: 1, currentA: 2, voltage: 3.9 },
    { time: 2, currentA: 2, voltage: 3.89 },
    { time: 3, currentA: 2, voltage: 3.88 },
  ];
  const reasons = identifiabilityChecks(obs, 200);
  assert.ok(reasons.some((r) => r.includes('时间常数')));
});

test('暂停与续算：分批迭代结果等于一次跑够', () => {
  const fx = buildFixture('pulse');
  const once = runNelderMead(fx.params, fx.observations, DEFAULT_BOUNDS, {
    start: { r0: 0.2, r1: 0.1, tau: 8 },
    maxIterations: 300,
  });
  const part1 = runNelderMead(fx.params, fx.observations, DEFAULT_BOUNDS, {
    start: { r0: 0.2, r1: 0.1, tau: 8 },
    maxIterations: 100,
  });
  const part2 = runNelderMead(fx.params, fx.observations, DEFAULT_BOUNDS, {
    state: part1.state,
    maxIterations: 200,
  });
  assert.equal(part2.iterations, once.iterations);
  assert.ok(Math.abs(part2.best.r0 - once.best.r0) < 1e-9);
  assert.ok(Math.abs(part2.best.tau - once.best.tau) < 1e-9);
});
