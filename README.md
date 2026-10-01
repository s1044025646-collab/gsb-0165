# 电池单 RC Thevenin 模型：脉冲响应仿真与参数辨识后端

恒温、**单 RC 支路 Thevenin** 等效电路模型的本地后端。只提供：

- REST API（仅监听本机、自动端口）
- 命令行 CLI
- 虚构（合成）电流/电压数据夹具
- 自动化测试

**不包含**网页界面、能量调度优化，也不控制任何真实电池。
本项目只是简化电学模型，结果不代表真实电池的全部特性。

## 模型与符号约定

等效关系：

```
Vt = OCV(SOC) - I*R0 - V1
dV1/dt = (I*R1 - V1)/tau,   tau = R1*C1
SOC(t+dt) = SOC(t) - I*dt / (capacityAh * 3600)
```

- **电流正负号**：放电为正 `(I>0)`，充电为负 `(I<0)`，静置为 `0`。
- **安时/秒换算**：`1 Ah = 3600 A·s`，电量 `ΔQ[Ah] = I[A]·dt[s]/3600`。
- **初始极化**：`initialV1` 默认 `0`（完全静置后启动），可显式指定。
- **分段端点语义**：脉冲为分段恒定电流，段 `[startTime,endTime)` 内电流恒定；
  相邻段必须首尾连续（上段 `endTime` = 下段 `startTime`），不允许零时长；
  端点 `t` 的样本采用该时刻电流阶跃**之后**的值（段 `[a,b)` 的端点 `b` 归属下一段）。
- **OCV**：按单调 SOC 节点分段线性插值。SOC 一旦超出电压表覆盖范围，
  仿真在越界时刻**停止并记录原因**，不做静默裁剪/外推后继续生成“看似正常”的电压。
- **参数校验**：`capacityAh/R0/R1/tau` 非正、时间重复或倒退、电压表覆盖不足一律拒绝。

### 极化电压解析递推

恒流段内使用解析式（非数值积分），段长 `dt`：

```
V1(t+dt) = I*R1 + (V1(t) - I*R1) * exp(-dt/tau)
```

跨电流阶跃时按段拆分推进，因此“把一段恒流细分成多段”结果不变（测试覆盖）。

## 参数辨识

在容量、OCV 表、初态已知时，从合成脉冲数据拟合 `R0 / R1 / tau`：

- 优化器为**自行实现**的 Nelder–Mead，在**对数参数空间**迭代，天然满足正参数约束；
  返回 RMSE、逐点残差、迭代次数、收敛标志与参数上下界，标记是否贴边。
- **可辨识性前置检查**：电流全程无变化、无电流阶跃、或记录时长远小于时间常数
  （`< tau/3`）时直接判定**不可辨识并给出原因**，不会只给一个低误差数字。
- 支持**暂停/续算**：用较小迭代上限运行会保存优化器状态，之后继续迭代。
- 拟合报告**冻结观测版本、OCV 表版本与模型版本**，且**不会自动覆盖**用户原参数；
  需要采用时显式另存为新模型版本。

## 环境依赖

- Node.js `>= 22.5`（开发验证于 Node v25），依赖内置 `node:sqlite` 与原生 TS 类型擦除。
- **零第三方 npm 依赖**，无需 `npm install`、无需联网、无需原生编译。
- Windows / macOS / Linux 均可；以下命令以 PowerShell 为例。

所有数据库与临时文件都写在本项目 `data/` 与 `tmp/` 内。

## 运行自动化测试

```powershell
npm test
```

覆盖：单支路解析式核对、电量守恒、时间单位等价、分段细分不变、已知参数恢复、
有噪声拟合、不可辨识用例、失败路径、事务回滚、幂等、分页、跨进程重启持久化，
以及 HTTP 端到端。

## 可重复端到端演示

```powershell
npm run demo
```

该脚本使用独立库 `tmp/demo.db`（每次重建，结果可重复；随机噪声使用固定种子）。

## 启动 / 停止 HTTP 服务

```powershell
# 启动（后台/前台均可）。端口由系统自动分配，仅绑定 127.0.0.1，不对外暴露。
npm start

# 真实端口与 pid 写入：
#   tmp/server.port   tmp/server.pid
```

PowerShell 后台启动示例：

```powershell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'src/server.ts' `
  -RedirectStandardOutput tmp\srv.out -RedirectStandardError tmp\srv.err
Get-Content tmp\server.port   # 查看自动端口
```

停止（**只**按本项目记录的 pid 停止本项目进程，不触碰其他进程）：

```powershell
npm run stop
```

自定义数据库位置（可选）：

```powershell
$env:BATTERY_DB = "E:\GSB\0165\A\tmp\mine.db"
npm start
```

## CLI

```powershell
npm run cli -- init-model [name]
npm run cli -- list-models [page] [pageSize]
npm run cli -- fixture <rest|constant|pulse|pulseNoisy|zeroV1|short|socBoundary>
npm run cli -- add-pulses <modelId> <jsonFile>
npm run cli -- simulate <modelId>
npm run cli -- fit <modelId> <datasetId> [maxIterations]
npm run cli -- resume <jobId>
npm run cli -- residuals <jobId>
npm run cli -- compare <name> <vA> <vB>
```

CLI 在关键操作前后打印模型/任务状态。示例脉冲文件见 `tmp/sample-pulses.json`。

## REST API 摘要

所有响应为 `{ ok, data }` 或 `{ ok:false, error:{ code,message,details } }`。
列表接口支持 `?page=&pageSize=`（1..200）分页。写操作可用 `idempotencyKey` 保证幂等。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/models` | 创建模型（body: `name`,`params`,`idempotencyKey?`） |
| GET | `/models` | 分页列模型（可 `?name=`） |
| GET | `/models/:id` | 模型详情（含参数） |
| POST | `/models/:id/pulses` | 保存分段恒定电流脉冲 |
| GET | `/models/:id/pulses?version=` | 读取脉冲 |
| POST | `/models/:id/simulate` | 仿真（`pulseVersion?`,`sampleDt?`） |
| POST | `/datasets/fixture/:name` | 由内置夹具生成数据集 |
| POST | `/datasets` | 上传观测数组 |
| GET | `/datasets` / `/datasets/:id` | 分页/详情 |
| POST | `/models/:id/fit/:datasetId` | 拟合（`maxIterations?` 小值可暂停） |
| POST | `/fits/:id/resume` | 暂停后续算 |
| GET | `/fits/:id` | 拟合任务状态与报告 |
| GET | `/fits/:id/residuals` | 分页残差、RMSE、冻结版本 |
| GET | `/fits?modelId=` | 分页任务 |
| GET | `/compare?name=&a=&b=` | 比较两个模型版本 |

### 错误码

`VALIDATION`、`NON_POSITIVE_PARAM`、`TIME_NOT_MONOTONIC`、`OCV_TABLE_INSUFFICIENT`、
`SOC_OUT_OF_RANGE`、`NOT_FOUND`、`CONFLICT`、`NOT_IDENTIFIABLE`、`BAD_REQUEST`、`INTERNAL`。

## 数据库迁移

迁移定义在 `src/db.ts`，使用 `IF NOT EXISTS` 的幂等 DDL，并通过 `schema_migrations`
记录版本；每次打开数据库都会安全地、可重复地执行，不会重复建表或破坏既有数据。

## 目录

```
src/      领域类型、校验、仿真引擎、辨识、夹具、DB、仓储、服务、API、CLI、server
scripts/  可重复 demo 与停止脚本
test/     node:test 自动化测试
data/     默认 SQLite 库（运行时生成）
tmp/      演示/测试库、端口与 pid 文件、示例脉冲 JSON
```
