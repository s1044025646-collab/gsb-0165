/**
 * 可重复端到端演示（纯进程内，不启动 HTTP）：
 * 建模型 -> 存脉冲 -> 仿真 -> 建夹具数据集 -> 拟合 -> 暂停/续算 -> 残差 ->
 * 不可辨识用例 -> SOC 越界停止 -> 版本比较。
 * 使用独立临时库 data/demo.db，可重复运行（每次重建文件）。
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db.ts';
import { Store } from '../src/store.ts';
import { Services } from '../src/services.ts';
import { buildFixture, standardParams } from '../src/fixtures.ts';
import { simulate } from '../src/engine.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_PATH = resolve(ROOT, 'tmp', 'demo.db');
rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });

const db = openDb(DB_PATH);
const store = new Store(db);
const services = new Services(store);
const line = (s = '') => console.log(s);

line('================ 电池单RC Thevenin 后端 E2E 演示 ================');
line('符号约定: 放电电流为正, 充电为负; Vt=OCV-I*R0-V1; 1Ah=3600A·s');
line();

// 1. 建模型（真值参数）
const params = standardParams();
const model = store.createModel('demo-cell', params).row;
line(`[1] 创建模型 demo-cell@v${model.version} id=${model.id}`);
line(`    cap=${params.capacityAh}Ah soc0=${params.initialSoc} R0=${params.r0} R1=${params.r1} tau=${params.tau}s`);

// 2. 保存正负脉冲并仿真
const pulse = buildFixture('pulse');
const pulses = store.addPulses(model.id, pulse.segments);
line(`[2] 保存脉冲 pulseVersion=${pulses.version} 段数=${pulse.segments.length}`);
const sim = services.simulateModel(model.id, pulses.version, 2);
line(`    仿真样本=${sim.samples.length} 末SOC=${sim.finalSoc.toFixed(5)} 末V1=${sim.finalV1.toFixed(5)} 停止=${sim.stopped}`);

// 3. 用合成数据拟合（故意给偏离真值的初值，证明优化恢复能力）
const ds = store.createDataset('demo-pulse', pulse.observations, 'fixture:pulse');
const wrongStart = { r0: 0.2, r1: 0.1, tau: 8 };
const fit = services.startFit(model.id, ds.id, { start: wrongStart });
line(`[3] 拟合任务 jobId=${fit.jobId} 状态=${fit.status}`);
const r = fit.report!;
line(`    恢复 R0=${r.fitted!.r0.toFixed(5)}(真值0.05) R1=${r.fitted!.r1.toFixed(5)}(真值0.03) tau=${r.fitted!.tau.toFixed(3)}(真值20)`);
line(`    RMSE=${r.rmse!.toExponential(2)}V 迭代=${r.iterations} 收敛=${r.converged}`);

// 4. 暂停/续算一致性：小迭代上限先暂停
const paused = services.startFit(model.id, ds.id, {
  maxIterations: 5,
  idempotencyKey: 'demo-pause',
  start: wrongStart,
});
line(`[4] 限制5次迭代 -> 状态=${paused.status} jobId=${paused.jobId}`);
const resumed = services.resumeFit(paused.jobId, 400);
line(`    续算后 -> 状态=${resumed.status} tau=${resumed.report!.fitted!.tau.toFixed(3)} RMSE=${resumed.report!.rmse!.toExponential(2)}`);

// 5. 不可辨识用例
for (const name of ['rest', 'constant', 'short'] as const) {
  const fx = buildFixture(name);
  const d = store.createDataset(`demo-${name}`, fx.observations, `fixture:${name}`);
  const j = services.startFit(model.id, d.id);
  line(`[5] 夹具 ${name}: ${j.status}`);
  j.report?.reasons.forEach((reason) => line(`      - ${reason}`));
}

// 6. SOC 边界停止
const boundary = buildFixture('socBoundary');
const bsim = simulate(boundary.params, boundary.segments, 1);
line(`[6] SOC边界用例: stopped=${bsim.stopped}`);
line(`    ${bsim.stopReason}`);
line(`    最后样本 soc=${bsim.samples[bsim.samples.length - 1].soc.toFixed(3)}（未静默裁剪继续）`);

// 7. 版本比较：拟合结果另存为新版本（不覆盖原参数）
const fittedParams = { ...params, r0: r.fitted!.r0, r1: r.fitted!.r1, tau: r.fitted!.tau };
const v2 = store.cloneAsNewVersion('demo-cell', fittedParams, model.id);
const cmp = services.compareVersions('demo-cell', 1, v2.version);
line(`[7] 拟合结果另存为 v${v2.version}（原 v1 未被覆盖）`);
line(`    ΔR0=${cmp.r0.delta.toExponential(2)} ΔR1=${cmp.r1.delta.toExponential(2)} Δtau=${cmp.tau.delta.toExponential(2)}`);
line();
line('说明：本系统仅为恒温单RC简化电学模型，不做能量调度优化，不控制真实电池。');
db.close();
