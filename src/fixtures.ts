import { simulate } from './engine.ts';
import type { Observation, PulseSegment, TheveninParams } from './types.ts';

/** 可注入的确定性伪随机（mulberry32），默认种子固定，保证演示/测试可重复。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function samplesToObservations(
  samples: { time: number; currentA: number; terminalVoltage: number }[],
  noiseStd = 0,
  rand: () => number = Math.random,
): Observation[] {
  // Box–Muller 高斯噪声
  return samples.map((s) => {
    let noise = 0;
    if (noiseStd > 0) {
      const u = Math.max(1e-12, rand());
      const v = rand();
      noise = noiseStd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    return { time: s.time, currentA: s.currentA, voltage: s.terminalVoltage + noise };
  });
}

function seg(startTime: number, duration: number, currentA: number): PulseSegment {
  return { startTime, endTime: startTime + duration, currentA };
}

export interface FixtureResult {
  name: string;
  params: TheveninParams;
  segments: PulseSegment[];
  observations: Observation[];
  note: string;
}

/** 标准单 RC 参数（合成真值，供恢复测试）。 */
export function standardParams(initialV1 = 0): TheveninParams {
  return {
    capacityAh: 5.0,
    initialSoc: 0.6,
    ocvTable: [
      { soc: 0, voltage: 3.0 },
      { soc: 0.2, voltage: 3.4 },
      { soc: 0.4, voltage: 3.7 },
      { soc: 0.6, voltage: 3.9 },
      { soc: 0.8, voltage: 4.1 },
      { soc: 1, voltage: 4.2 },
    ],
    r0: 0.05,
    r1: 0.03,
    tau: 20,
    initialV1,
  };
}

function sampleTimesFor(segments: PulseSegment[], dt: number, t0: number, end: number): number[] {
  const times: number[] = [];
  for (let t = t0; t <= end + 1e-9; t += dt) times.push(Number(t.toFixed(6)));
  const last = segments[segments.length - 1].endTime;
  if (times[times.length - 1] !== last) times.push(last);
  return times;
}

function build(
  name: string,
  params: TheveninParams,
  segments: PulseSegment[],
  dt: number,
  note: string,
  noiseStd = 0,
  seed = 42,
): FixtureResult {
  const t0 = segments[0].startTime;
  const end = segments[segments.length - 1].endTime;
  const times = sampleTimesFor(segments, dt, t0, end);
  const res = simulate(params, segments, times);
  const observations = samplesToObservations(res.samples, noiseStd, mulberry32(seed));
  return { name, params, segments, observations, note };
}

/** 静置：电流恒 0（不可辨识用例）。 */
export function restFixture(): FixtureResult {
  const params = standardParams();
  const segments = [seg(0, 120, 0)];
  return build('rest', params, segments, 5, '全程静置，电流无变化，应标注不可辨识');
}

/** 恒流：单一非零电流（无阶跃，不可辨识）。 */
export function constantCurrentFixture(): FixtureResult {
  const params = standardParams();
  const segments = [seg(0, 120, 1)];
  return build('constant', params, segments, 5, '恒流放电，无电流阶跃，应标注不可辨识');
}

/** 正负脉冲：放电脉冲 + 静置 + 充电脉冲，适合辨识。 */
export function pulseFixture(noiseStd = 0): FixtureResult {
  const params = standardParams();
  const segments = [
    seg(0, 60, 0),
    seg(60, 60, 2),
    seg(120, 120, 0),
    seg(240, 60, -2),
    seg(300, 120, 0),
  ];
  return build(
    'pulse',
    params,
    segments,
    2,
    '静置-放电-静置-充电-静置，覆盖正负脉冲',
    noiseStd,
  );
}

/** 零初始极化：显式 V1(0)=0 且以静置开头。 */
export function zeroInitialV1Fixture(): FixtureResult {
  const params = standardParams(0);
  const segments = [seg(0, 40, 0), seg(40, 80, 2), seg(120, 80, 0)];
  return build('zero-v1', params, segments, 2, '零初始极化 V1(0)=0');
}

/** 短记录：出现阶跃但总时长远小于 tau（不可辨识）。 */
export function shortRecordFixture(): FixtureResult {
  const params = standardParams();
  const segments = [seg(0, 2, 0), seg(2, 2, 2)];
  return build('short', params, segments, 0.5, '记录仅 4s，远短于 tau=20s，应标注不可辨识');
}

/** SOC 边界：从高 SOC 大电流充电，快速触及上限并停止。 */
export function socBoundaryFixture(): FixtureResult {
  const params: TheveninParams = { ...standardParams(), initialSoc: 0.95, capacityAh: 0.02 };
  const segments = [seg(0, 5, 0), seg(5, 30, -2), seg(35, 20, 0)];
  return build('soc-boundary', params, segments, 1, '高SOC小容量充电，触及SOC上限应停止并留原因');
}

export const ALL_FIXTURE_BUILDERS = {
  rest: restFixture,
  constant: constantCurrentFixture,
  pulse: () => pulseFixture(0),
  pulseNoisy: () => pulseFixture(0.002),
  zeroV1: zeroInitialV1Fixture,
  short: shortRecordFixture,
  socBoundary: socBoundaryFixture,
};

export type FixtureName = keyof typeof ALL_FIXTURE_BUILDERS;

export function buildFixture(name: FixtureName): FixtureResult {
  return ALL_FIXTURE_BUILDERS[name]();
}
