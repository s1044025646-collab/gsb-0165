import { AppError } from './errors.ts';
import type { OcvPoint, PulseSegment, TheveninParams } from './types.ts';

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function requirePositive(name: string, x: unknown): number {
  if (!isFiniteNumber(x) || (x as number) <= 0) {
    throw new AppError('NON_POSITIVE_PARAM', `${name} 必须为正数，收到: ${String(x)}`, {
      field: name,
      value: x,
    });
  }
  return x as number;
}

export function validateOcvTable(table: unknown): OcvPoint[] {
  if (!Array.isArray(table) || table.length < 2) {
    throw new AppError(
      'OCV_TABLE_INSUFFICIENT',
      '开路电压表至少需要 2 个 SOC 节点',
      { got: Array.isArray(table) ? table.length : 0 },
    );
  }
  const pts: OcvPoint[] = table.map((p, i) => {
    if (!p || !isFiniteNumber(p.soc) || !isFiniteNumber(p.voltage)) {
      throw new AppError('VALIDATION', `OCV 节点[${i}] 的 soc/voltage 必须为有限数`, p);
    }
    if (p.soc < 0 || p.soc > 1) {
      throw new AppError('VALIDATION', `OCV 节点[${i}] soc=${p.soc} 超出 [0,1]`);
    }
    return { soc: p.soc, voltage: p.voltage };
  });
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].soc <= pts[i - 1].soc) {
      throw new AppError(
        'OCV_TABLE_INSUFFICIENT',
        `OCV 节点 soc 必须严格递增：位置 ${i} 的 ${pts[i].soc} <= ${pts[i - 1].soc}`,
      );
    }
    if (pts[i].voltage < pts[i - 1].voltage) {
      throw new AppError(
        'VALIDATION',
        `OCV 电压必须随 SOC 单调非降：位置 ${i} 出现下降`,
      );
    }
  }
  return pts;
}

export function validateSegments(segs: unknown): PulseSegment[] {
  if (!Array.isArray(segs) || segs.length === 0) {
    throw new AppError('VALIDATION', '脉冲序列不能为空');
  }
  const out: PulseSegment[] = segs.map((s, i) => {
    if (!s || !isFiniteNumber(s.startTime) || !isFiniteNumber(s.endTime) || !isFiniteNumber(s.currentA)) {
      throw new AppError('VALIDATION', `脉冲段[${i}] 字段必须为有限数`, s);
    }
    if (s.endTime <= s.startTime) {
      throw new AppError(
        'TIME_NOT_MONOTONIC',
        `脉冲段[${i}] endTime(${s.endTime}) 必须 > startTime(${s.startTime})`,
      );
    }
    return { startTime: s.startTime, endTime: s.endTime, currentA: s.currentA };
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i].startTime !== out[i - 1].endTime) {
      throw new AppError(
        'TIME_NOT_MONOTONIC',
        `脉冲段[${i}] startTime=${out[i].startTime} 与上段 endTime=${out[i - 1].endTime} 不连续`,
      );
    }
  }
  return out;
}

export function validateParams(p: unknown): TheveninParams {
  if (!p || typeof p !== 'object') throw new AppError('VALIDATION', '参数必须为对象');
  const o = p as Record<string, unknown>;
  const capacityAh = requirePositive('capacityAh', o.capacityAh);
  const r0 = requirePositive('r0', o.r0);
  const r1 = requirePositive('r1', o.r1);
  const tau = requirePositive('tau', o.tau);
  if (!isFiniteNumber(o.initialSoc) || (o.initialSoc as number) < 0 || (o.initialSoc as number) > 1) {
    throw new AppError('VALIDATION', `initialSoc 必须在 [0,1]，收到: ${String(o.initialSoc)}`);
  }
  if (o.initialV1 !== undefined && !isFiniteNumber(o.initialV1)) {
    throw new AppError('VALIDATION', 'initialV1 必须为有限数');
  }
  const ocvTable = validateOcvTable(o.ocvTable);
  const initialSoc = o.initialSoc as number;
  if (initialSoc < ocvTable[0].soc || initialSoc > ocvTable[ocvTable.length - 1].soc) {
    throw new AppError(
      'OCV_TABLE_INSUFFICIENT',
      `initialSoc=${initialSoc} 不在电压表覆盖范围 [${ocvTable[0].soc}, ${
        ocvTable[ocvTable.length - 1].soc
      }] 内`,
    );
  }
  return {
    capacityAh,
    initialSoc,
    ocvTable,
    r0,
    r1,
    tau,
    initialV1: (o.initialV1 as number | undefined) ?? 0,
  };
}

/** 保证 OCV 表覆盖给定 SOC，否则拒绝（不做静默裁剪/外推）。 */
export function assertSocCovered(table: OcvPoint[], soc: number): void {
  const min = table[0].soc;
  const max = table[table.length - 1].soc;
  if (soc < min || soc > max) {
    throw new AppError(
      'SOC_OUT_OF_RANGE',
      `SOC=${soc} 超出电压表覆盖 [${min}, ${max}]，已停止（不做外推）`,
      { soc, min, max },
    );
  }
}
