import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { Store } from './store.ts';
import { Services } from './services.ts';
import { buildFixture, standardParams, type FixtureName } from './fixtures.ts';
import { AppError } from './errors.ts';
import type { TheveninParams } from './types.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_PATH = process.env.BATTERY_DB ?? resolve(ROOT, 'data', 'battery.db');

interface CliDeps {
  store: Store;
  services: Services;
  log: (s: string) => void;
}

function modelSummary(p: TheveninParams) {
  return `cap=${p.capacityAh}Ah soc0=${p.initialSoc} R0=${p.r0}Ω R1=${p.r1}Ω tau=${p.tau}s V1(0)=${p.initialV1 ?? 0}`;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const { store, services, log } = deps;
  try {
    switch (cmd) {
      case 'init-model': {
        const name = rest[0] ?? 'demo-cell';
        const params = standardParams();
        log(`\n--- 建模型：${name} ---`);
        const { row, reused } = store.createModel(name, params);
        log(`建模型后：${name}@${row.version} (id=${row.id})${reused ? ' [幂等:已存在]' : ''}`);
        log(`参数 ${modelSummary(params)}`);
        log(`OCV ${params.ocvTable.length} 节点, ocvVersion=${row.ocv_version}`);
        return 0;
      }
      case 'list-models': {
        const page = Number(rest[0] ?? '1');
        const pageSize = Number(rest[1] ?? '20');
        const r = store.listModels(page, pageSize);
        log(`模型分页 page=${r.page} total=${r.total}`);
        r.items.forEach((m) =>
          log(`  [${m.id}] ${m.name}@v${m.version} cap=${m.capacityAh} R0=${m.r0} R1=${m.r1} tau=${m.tau}`),
        );
        return 0;
      }
      case 'fixture': {
        const name = (rest[0] ?? 'pulse') as FixtureName;
        const fx = buildFixture(name);
        const dsName = `fixture-${name}`;
        log(`夹具 ${fx.name}：${fx.note}`);
        log(`真值参数 ${modelSummary(fx.params)}`);
        const { id, reused } = store.createDataset(dsName, fx.observations, `fixture:${name}`);
        log(`数据集 ${dsName} (id=${id}) 观测=${fx.observations.length}${reused ? ' [已存在]' : ''}`);
        return 0;
      }
      case 'simulate': {
        const modelId = Number(rest[0]);
        const before = store.getModelById(modelId);
        const { segments } = store.getPulses(modelId);
        log(`仿真前：模型 id=${modelId} v${before.version}, 脉冲段=${segments.length}`);
        const result = services.simulateModel(modelId);
        log(`仿真后：样本=${result.samples.length} 末SOC=${result.finalSoc.toFixed(5)} 末V1=${result.finalV1.toFixed(5)}`);
        if (result.stopped) log(`已停止：${result.stopReason}`);
        result.samples
          .filter((_, i) => i % Math.max(1, Math.floor(result.samples.length / 8)) === 0)
          .forEach((s) =>
            log(
          `  t=${s.time.toFixed(1)}s I=${s.currentA}A soc=${s.soc.toFixed(4)} OCV=${s.ocv.toFixed(4)} V1=${s.v1.toFixed(4)} Vt=${s.terminalVoltage.toFixed(4)}`,
            ),
          );
        return 0;
      }
      case 'add-pulses': {
        // add-pulses <modelId> <jsonFile>
        const modelId = Number(rest[0]);
        const file = rest[1];
        const { readFileSync } = await import('node:fs');
        const segments = JSON.parse(readFileSync(file, 'utf8'));
        const r = store.addPulses(modelId, segments);
        log(`脉冲已保存 model=${modelId} pulseVersion=${r.version} 段=${segments.length}${r.reused ? ' [幂等]' : ''}`);
        return 0;
      }
      case 'fit': {
        const modelId = Number(rest[0]);
        const datasetId = Number(rest[1]);
        const maxIter = rest[2] ? Number(rest[2]) : undefined;
        const job = services.startFit(modelId, datasetId, { maxIterations: maxIter });
        log(`拟合任务 jobId=${job.jobId} 状态=${job.status}${job.reused ? ' [幂等:返回既有任务]' : ''}`);
        printReport(log, job.report);
        return 0;
      }
      case 'resume': {
        const jobId = Number(rest[0]);
        const before = store.getFitJob(jobId);
        log(`续算前：job=${jobId} 状态=${before.status}`);
        const r = services.resumeFit(jobId);
        log(`续算后：状态=${r.status}`);
        printReport(log, r.report);
        return 0;
      }
      case 'residuals': {
        const jobId = Number(rest[0]);
        const job = store.getFitJob(jobId);
        const rs = job.report?.residuals ?? [];
        log(`任务 ${jobId} 状态=${job.status} 残差点=${rs.length} RMSE=${job.report?.rmse?.toFixed(6) ?? '-'}`);
        rs.slice(0, 10).forEach((r) =>
          log(`  t=${r.time.toFixed(1)} obs=${r.observed.toFixed(4)} pred=${r.predicted.toFixed(4)} res=${r.residual.toFixed(5)}`),
        );
        if (job.report) log(`冻结: obsV=${job.report.frozen.observationVersion} ocvV=${job.report.frozen.ocvVersion} modelV=${job.report.frozen.modelVersion}`);
        return 0;
      }
      case 'compare': {
        const [name, a, b] = rest;
        const r = services.compareVersions(name, Number(a), Number(b));
        log(`比较 ${name} v${a} -> v${b}`);
        for (const k of ['capacityAh', 'initialSoc', 'r0', 'r1', 'tau'] as const) {
          const d = r[k];
          log(`  ${k}: ${d.a} -> ${d.b} (Δ=${d.delta.toFixed(6)}, rel=${d.rel === null ? '-' : (d.rel * 100).toFixed(2) + '%'})`);
        }
        log(`  OCV表相同=${r.ocvSame}`);
        return 0;
      }
      default:
        log(
          [
            '用法: npm run cli -- <command> [args]',
            '命令:',
            '  init-model [name]                 创建标准模型（返回版本号）',
            '  list-models [page] [pageSize]     分页列模型',
            '  fixture <rest|constant|pulse|pulseNoisy|zeroV1|short|socBoundary>',
            '  add-pulses <modelId> <jsonFile>   保存分段恒定电流脉冲',
            '  simulate <modelId>                解析仿真并打印状态',
            '  fit <modelId> <datasetId> [maxIter]  拟合 R0/R1/tau（小maxIter可暂停）',
            '  resume <jobId>                    暂停后续算',
            '  residuals <jobId>                 查看残差与冻结版本',
            '  compare <name> <vA> <vB>          比较两个模型版本',
          ].join('\n'),
        );
        return cmd ? 1 : 0;
    }
  } catch (e) {
    if (e instanceof AppError) {
      log(`错误[${e.code}] ${e.message}`);
      return 2;
    }
    log(`错误 ${(e as Error).message}`);
    return 2;
  }
}

function printReport(log: (s: string) => void, report: import('./types.ts').FitReport | null) {
  if (!report) {
    log('优化暂停中，尚无最终报告，请 resume 续算。');
    return;
  }
  if (!report.identifiable) {
    log('不可辨识：');
    report.reasons.forEach((r) => log(`  - ${r}`));
    log('（不会仅给一个低误差数字）');
    return;
  }
  const f = report.fitted!;
  log(
    `辨识结果 R0=${f.r0.toFixed(5)}Ω R1=${f.r1.toFixed(5)}Ω tau=${f.tau.toFixed(3)}s ` +
      `RMSE=${report.rmse!.toExponential(3)}V max|res|=${report.maxAbsResidual!.toExponential(3)}V ` +
      `迭代=${report.iterations} 收敛=${report.converged}`,
  );
  if (report.atBounds && report.atBounds.length) {
    log('参数贴边警告：');
    report.atBounds.forEach((b) => log(`  - ${b}`));
  }
  log(`冻结版本: 观测v${report.frozen.observationVersion} OCVv${report.frozen.ocvVersion} 模型v${report.frozen.modelVersion}（不自动覆盖用户原参数）`);
  log('注意：这只是恒温单RC简化电学模型，非真实电池全特性。');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`, 'file:').href;
if (isMain) {
  const db = openDb(DB_PATH);
  const store = new Store(db);
  const services = new Services(store);
  const code = await runCli(process.argv.slice(2), {
    store,
    services,
    log: (s) => console.log(s),
  });
  db.close();
  process.exit(code);
}
