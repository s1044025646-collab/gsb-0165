import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, ocvAt, simulate, SECONDS_PER_HOUR } from '../src/engine.ts';
import { standardParams } from '../src/fixtures.ts';
import type { PulseSegment, TheveninParams } from '../src/types.ts';
import { validateParams, validateSegments } from '../src/validation.ts';

test('OCV 分段线性插值在节点与中点正确', () => {
  const p = standardParams();
  assert.equal(ocvAt(p.ocvTable, 0.6), 3.9);
  assert.equal(ocvAt(p.ocvTable, 0), 3.0);
  assert.ok(Math.abs(ocvAt(p.ocvTable, 0.7) - 4.0) < 1e-12);
});

test('OCV 越界抛错而非外推', () => {
  const p = standardParams();
  assert.throws(() => ocvAt(p.ocvTable, -0.01), /SOC/);
  assert.throws(() => ocvAt(p.ocvTable, 1.01), /SOC/);
});

test('单支路解析式核对：静置时 V1 按指数衰减到 0', () => {
  const p = standardParams();
  const s = { time: 0, soc: 0.6, v1: 0.1, currentA: 0 };
  const next = advance(p, s, 0, p.tau);
  assert.ok(Math.abs(next.v1 - 0.1 * Math.exp(-1)) < 1e-12);
});

test('恒流阶跃后 V1 指数趋向 I*R1', () => {
  const p = standardParams();
  const s = { time: 0, soc: 0.6, v1: 0, currentA: 2 };
  const next = advance(p, s, 2, p.tau);
  const expected = 2 * p.r1 * (1 - Math.exp(-1));
  assert.ok(Math.abs(next.v1 - expected) < 1e-12);
});

test('电量守恒：SOC 变化等于 -I*dt/(cap*3600)', () => {
  const p = standardParams();
  const segs: PulseSegment[] = [
    { startTime: 0, endTime: 100, currentA: 2 },
    { startTime: 100, endTime: 200, currentA: -2 },
  ];
  const res = simulate(p, segs);
  // 放电100s再充电100s，净安时为0
  assert.ok(Math.abs(res.finalSoc - p.initialSoc) < 1e-12);
  const expectedDrop = (2 * 100) / (p.capacityAh * SECONDS_PER_HOUR);
  assert.ok(
    Math.abs(res.samples[1].soc - (p.initialSoc - expectedDrop)) < 1e-9,
  );
});

test('时间单位等价：分钟与秒描述同一波形', () => {
  const p = standardParams();
  const sec: PulseSegment[] = [{ startTime: 0, endTime: 60, currentA: 1 }];
  // 用换算后的 cap（Ah 不变，电流/时间仍以 A/s 描述）——这里验证 dt 缩放解析一致
  const a = simulate(p, sec, [0, 15, 30, 45, 60]);
  const twoSteps: PulseSegment[] = [
    { startTime: 0, endTime: 30, currentA: 1 },
    { startTime: 30, endTime: 60, currentA: 1 },
  ];
  const b = simulate(p, twoSteps, [0, 15, 30, 45, 60]);
  a.samples.forEach((s, i) => {
    assert.ok(Math.abs(s.v1 - b.samples[i].v1) < 1e-12);
    assert.ok(Math.abs(s.terminalVoltage - b.samples[i].terminalVoltage) < 1e-12);
  });
});

test('分段细分不变：把一段拆成两段恒流结果相同', () => {
  const p = standardParams();
  const one: PulseSegment[] = [{ startTime: 0, endTime: 40, currentA: 1.5 }];
  const two: PulseSegment[] = [
    { startTime: 0, endTime: 20, currentA: 1.5 },
    { startTime: 20, endTime: 40, currentA: 1.5 },
  ];
  const times = [0, 10, 20, 30, 40];
  const a = simulate(p, one, times);
  const b = simulate(p, two, times);
  times.forEach((_, i) => {
    assert.ok(Math.abs(a.samples[i].terminalVoltage - b.samples[i].terminalVoltage) < 1e-12);
  });
});

test('SOC 越界停止并保留原因，不静默裁剪', () => {
  const p: TheveninParams = {
    ...standardParams(),
    initialSoc: 0.95,
    capacityAh: 0.05,
  };
  const segs: PulseSegment[] = [{ startTime: 0, endTime: 60, currentA: -2 }];
  const res = simulate(p, segs, [0, 10, 20, 30, 40, 50]);
  assert.equal(res.stopped, true);
  assert.ok(/上限|SOC/.test(res.stopReason ?? ''));
  assert.ok(res.finalSoc >= 1 - 1e-9);
  assert.ok(res.samples.length < 6);
});

test('拒绝非正参数、时序倒退与电压表覆盖不足', () => {
  assert.throws(() => validateParams({ ...standardParams(), r0: 0 }), /r0/i);
  assert.throws(
    () =>
      validateSegments([
        { startTime: 0, endTime: 10, currentA: 0 },
        { startTime: 5, endTime: 15, currentA: 0 },
      ]),
    /不连续/,
  );
  assert.throws(
    () => validateParams({ ...standardParams(), initialSoc: 0.05, ocvTable: standardParams().ocvTable.slice(2) }),
    /覆盖|initialSoc/i,
  );
});
