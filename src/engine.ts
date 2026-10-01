import { AppError } from './errors.ts';
import type {
  Observation,
  PulseSegment,
  SimulationResult,
  SimulationSample,
  TheveninParams,
} from './types.ts';
import { assertSocCovered } from './validation.ts';

export const SECONDS_PER_HOUR = 3600;

/** 单调 SOC 节点分段线性插值；越界抛错（不做静默外推/裁剪）。 */
export function ocvAt(table: TheveninParams['ocvTable'], soc: number): number {
  assertSocCovered(table, soc);
  if (soc === table[table.length - 1].soc) return table[table.length - 1].voltage;
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid].soc <= soc) lo = mid;
    else hi = mid;
  }
  const a = table[lo];
  const b = table[hi];
  const f = (soc - a.soc) / (b.soc - a.soc);
  return a.voltage + f * (b.voltage - a.voltage);
}

interface State {
  time: number;
  soc: number;
  v1: number;
  currentA: number;
}

/** 单步解析推进：恒流 I 持续 dt 秒后的精确状态（指数递推 + 库仑计量）。 */
export function advance(
  p: TheveninParams,
  s: State,
  currentA: number,
  dt: number,
): State {
  const v1ss = currentA * p.r1;
  const decay = Math.exp(-dt / p.tau);
  const v1 = v1ss + (s.v1 - v1ss) * decay;
  const soc = s.soc - (currentA * dt) / (p.capacityAh * SECONDS_PER_HOUR);
  return { time: s.time + dt, soc, v1, currentA };
}

function makeSample(p: TheveninParams, s: State): SimulationSample {
  const ocv = ocvAt(p.ocvTable, s.soc);
  return {
    time: s.time,
    soc: s.soc,
    ocv,
    v1: s.v1,
    currentA: s.currentA,
    terminalVoltage: ocv - s.currentA * p.r0 - s.v1,
  };
}

/**
 * 仿真分段恒定电流。
 * @param sampleTimes 需要记录的时间点；缺省记录每段端点。首端点恒为序列起点。
 * 端点语义：在 t 时刻的样本采用该时刻的电流阶跃“之后”的值，
 * 即段 [a,b) 端点 b 归属于下一段（若有）。
 */
export function simulate(
  params: TheveninParams,
  segments: PulseSegment[],
  sampleTimes?: number[] | number,
): SimulationResult {
  const t0 = segments[0].startTime;
  const tEnd = segments[segments.length - 1].endTime;
  const normalized: number[] | undefined =
    typeof sampleTimes === 'number'
      ? uniformTimes(t0, tEnd, sampleTimes)
      : sampleTimes;
  sampleTimes = normalized;
  let state: State = {
    time: t0,
    soc: params.initialSoc,
    v1: params.initialV1 ?? 0,
    currentA: segments[0].currentA,
  };

  const requested = sampleTimes
    ? [t0, ...sampleTimes.filter((t) => t > t0)]
    : (() => {
        return [t0, ...segments.map((s) => s.endTime)];
      })();

  const samples: SimulationSample[] = [];
  try {
    samples.push(makeSample(params, state));
  } catch (e) {
    throw e instanceof AppError ? e : e;
  }

  let segIdx = 0;
  let stopped = false;
  let stopReason: string | undefined;

  const table = params.ocvTable;
  const socMin = table[0].soc;
  const socMax = table[table.length - 1].soc;

  const segmentAt = (t: number): PulseSegment => {
    while (segIdx < segments.length && t >= segments[segIdx].endTime) segIdx++;
    return segments[Math.min(segIdx, segments.length - 1)];
  };

  for (const target of requested.slice(1)) {
    // 分段推进到 target，保持解析指数递推在每段内成立。
    while (state.time < target && !stopped) {
      const seg = segmentAt(state.time);
      const currentA = seg.currentA;
      state.currentA = currentA;
      const stepEnd = Math.min(target, seg.endTime);
      const dt = stepEnd - state.time;
      const next = advance(params, state, currentA, dt);

      if (next.soc < socMin || next.soc > socMax) {
        // 段内 SOC 线性，求首次越界时刻并在该处停止。
        const rate = -currentA / (params.capacityAh * SECONDS_PER_HOUR); // dSoc/dt
        const boundary = next.soc < socMin ? socMin : socMax;
        const dtCross = rate === 0 ? dt : (boundary - state.soc) / rate;
        const crossed = advance(params, state, currentA, Math.max(0, dtCross));
        crossed.soc = boundary;
        samples.push(makeSample(params, crossed));
        state = crossed;
        stopped = true;
        stopReason =
          next.soc < socMin
            ? `SOC 于 t=${crossed.time.toFixed(3)}s 触及下限 ${socMin}，放电越界，已停止`
            : `SOC 于 t=${crossed.time.toFixed(3)}s 触及上限 ${socMax}，充电越界，已停止`;
        break;
      }
      state = next;
    }
    if (stopped) break;
    state.currentA = segmentAt(target).currentA;
    samples.push(makeSample(params, state));
  }

  return {
    samples,
    finalSoc: state.soc,
    finalV1: state.v1,
    stopped,
    stopReason,
  };
}

export function uniformTimes(t0: number, end: number, dt: number): number[] {
  if (!(dt > 0)) throw new Error('采样步长必须 > 0');
  const times: number[] = [];
  for (let t = t0; t <= end + 1e-9; t += dt) times.push(Number(t.toFixed(6)));
  if (times[times.length - 1] !== end) times.push(end);
  return times;
}

/** 在给定观测时间点上预测端电压（时间戳必须严格递增）。 */
export function predictAtObservations(
  params: TheveninParams,
  obs: Observation[],
): { predicted: number[]; state: State } {
  const t0 = obs[0].time;
  let state: State = {
    time: t0,
    soc: params.initialSoc,
    v1: params.initialV1 ?? 0,
    currentA: obs[0].currentA,
  };
  const out: number[] = [];
  out.push(ocvAt(params.ocvTable, state.soc) - state.currentA * params.r0 - state.v1);
  for (let i = 1; i < obs.length; i++) {
    const dt = obs[i].time - obs[i - 1].time;
    if (dt <= 0) {
      throw new AppError(
        'TIME_NOT_MONOTONIC',
        `观测时间必须严格递增：索引 ${i} 处 dt=${dt}`,
      );
    }
    // 区间 [t_{i-1}, t_i) 内电流取前一记录值（与夹具生成约定一致）。
    state = advance(params, state, obs[i - 1].currentA, dt);
    state.currentA = obs[i].currentA;
    out.push(ocvAt(params.ocvTable, state.soc) - state.currentA * params.r0 - state.v1);
  }
  return { predicted: out, state };
}
