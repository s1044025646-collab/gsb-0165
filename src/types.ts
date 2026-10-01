/**
 * 领域类型定义。
 *
 * 符号约定（务必一致）：
 *  - 电流 I：放电为正，充电为负，静置为 0（单位 A）。
 *  - 安时/秒换算：1 Ah = 3600 A·s；电量 deltaQ[Ah] = I[A] * dt[s] / 3600。
 *  - SOC：放电使 SOC 下降：soc(t+dt) = soc(t) - I*dt/(capacityAh*3600)。
 *  - 极化电压 V1：单 RC 支路，I 为正时沿 V1 正方向充电，
 *    稳态 V1_ss = I*R1；放电时 V1>0，拉低端电压。
 *  - 端电压：Vt = OCV(soc) - I*R0 - V1。
 */

export interface OcvPoint {
  /** SOC，范围 [0,1]，节点必须严格递增。 */
  soc: number;
  /** 该 SOC 下开路电压 [V]。 */
  voltage: number;
}

export interface TheveninParams {
  /** 容量 [Ah]，必须 > 0。 */
  capacityAh: number;
  /** 初始 SOC [0,1]。 */
  initialSoc: number;
  /** 开路电压表（SOC 节点单调，需覆盖运行区间）。 */
  ocvTable: OcvPoint[];
  /** 欧姆电阻 R0 [Ω]，必须 > 0。 */
  r0: number;
  /** 极化电阻 R1 [Ω]，必须 > 0。 */
  r1: number;
  /** 时间常数 tau = R1*C1 [s]，必须 > 0。 */
  tau: number;
  /** 初始极化电压 V1(0) [V]，默认 0（完全静置后启动）。 */
  initialV1?: number;
}

/**
 * 分段恒定电流输入。
 * 每段在 [startTime, endTime) 内保持恒定电流 currentA。
 * 段端点语义：相邻段 endTime 必须等于下一段 startTime（连续），
 * 首段 startTime 作为 t=0 基准；段内不允许零时长。
 */
export interface PulseSegment {
  startTime: number; // [s]
  endTime: number; // [s]，须 > startTime
  currentA: number; // [A]，放电正/充电负
}

export interface SimulationSample {
  /** 该样本对应的时间 [s]，首样本为脉冲序列起点。 */
  time: number;
  soc: number;
  ocv: number;
  v1: number;
  currentA: number;
  terminalVoltage: number;
}

export interface SimulationResult {
  samples: SimulationSample[];
  finalSoc: number;
  finalV1: number;
  stopped: boolean;
  stopReason?: string;
}

/** 观测记录（合成夹具或拟合输入）。 */
export interface Observation {
  time: number; // [s]，须严格递增、不重复不倒退
  currentA: number;
  voltage: number;
}

export interface FittedParams {
  r0: number;
  r1: number;
  tau: number;
}

export interface ResidualPoint {
  time: number;
  observed: number;
  predicted: number;
  residual: number;
}

export interface FitReport {
  identifiable: boolean;
  reasons: string[];
  fitted?: FittedParams;
  rmse?: number;
  maxAbsResidual?: number;
  residuals?: ResidualPoint[];
  iterations?: number;
  converged?: boolean;
  /** 参数约束（下界/上界），用于报告拟合是否贴边。 */
  bounds: { r0: [number, number]; r1: [number, number]; tau: [number, number] };
  atBounds?: string[];
  /** 冻结的观测与电压表版本，保证报告可复现。 */
  frozen: {
    observationVersion: number;
    ocvVersion: number;
    modelVersion: number;
  };
}
