# Battery Thevenin Pulse-Response & Parameter Identification Backend

Local Windows-runnable backend for a **constant-temperature, single-RC-branch Thevenin
equivalent-circuit battery model**. It provides a JSON HTTP API (loopback only), a CLI,
deterministic synthetic current/voltage fixtures and automated tests.

> This is a **simplified electrical model** for simulation/identification exercises only.
> It is not a physical battery characterization tool, does no energy-dispatch optimization
> and never controls real hardware.

## Model and conventions

Terminal voltage:

```
V(t) = OCV(SOC) - Up(t) - R0 * I(t)
dUp/dt = (R1*I - Up) / tau
SOC(t) = SOC0 - integral(I dt) / (capacityAh * 3600)
```

- Current sign: **I > 0 discharge, I < 0 charge, I = 0 rest** (ampere).
- Time is in **seconds**; capacity in **ampere-hours**. Ah <-> s conversion uses `3600 s/h`
  (`SECONDS_PER_HOUR`).
- Inputs are **piecewise-constant current segments** `{tStart,tEnd,current}`; segments must be
  contiguous, strictly increasing and non-overlapping.
- Polarization voltage is propagated with the **analytic exponential recurrence**
  `Up(k) = I*R1*(1-exp(-dt/tau)) + Up(k-1)*exp(-dt/tau)`.
- SOC is updated by **coulomb counting**. OCV is **piecewise-linear interpolation** over
  monotonically increasing SOC nodes that must cover `[0,1]`.
- One sample is emitted per segment endpoint; the endpoint sample uses the current of the segment
  just ending (a pre-pulse sample at `tStart` uses zero current).
- Initial polarization `up0` is explicit. If SOC would leave `[0,1]`, simulation **stops at the
  exact crossing time** with `stopped=true` and reason `SOC_BELOW_0` / `SOC_ABOVE_1` — it never
  silently clips SOC and keeps producing plausible-looking voltage.
- Non-positive parameters, duplicate/reversed timing and insufficient OCV coverage are rejected
  with explicit validation errors.

## Parameter identification

Given known capacity, OCV table and initial state, R0/R1/tau are fitted from synthetic pulse
observations with a self-contained **Nelder-Mead simplex** optimizer over log-parameter space
(positivity is implicit). The report includes residuals, RMSE, parameter constraints and frozen
versions:

- Observations and OCV table are hashed (`observationsHash`); model/OCV versions are frozen.
- Fitted parameters are **never written back** to the user's model parameters automatically.
- A record with no current variation is flagged `NO_CURRENT_VARIATION`; a record much shorter
  than the fitted dynamics is flagged `RECORD_SHORTER_THAN_TAU` (also `TOO_FEW_SAMPLES`).
  Unidentifiable cases return `params: null` plus reasons rather than a misleading low-error
  number.
- Long fits can be run in small iteration budgets (`paused`) and `resume`d from the persisted
  simplex state.

## Prerequisites

- Node.js >= 22.5 (built-in `node:sqlite`; developed on Node 25). No native modules.

## Install

```powershell
npm install
```

## Tests

```powershell
npm test
```

Covers analytic single-branch cross-checks, charge conservation, time-unit equivalence, segment
subdivision invariance, known-parameter recovery, failure paths, transaction rollback,
idempotency, restart persistence and the HTTP API.

## Repeatable end-to-end demo

```powershell
npm run demo
```

Deterministic (seeded fixtures + idempotency keys): rerunning replays the same rows.

## CLI

```powershell
npm run cli -- init
npm run cli -- create-model --name cell [--params '<json|file>'] [--idem key]
npm run cli -- list-models [--limit 20 --offset 0] [--lineage 1]
npm run cli -- get-model 1
npm run cli -- set-params 1 --params '<json>'
npm run cli -- new-version 1 --name v2
npm run cli -- compare --a 1 --b 2
npm run cli -- fixture pulse_pair --out tmp/pulse.json [--noise 0.0001 --seed 42]
npm run cli -- simulate 1 --segments '<json|file>'
npm run cli -- ingest 1 --file tmp/pulse.json --name pulses [--idem key]
npm run cli -- fit 1 [--budget 2000]
npm run cli -- resume 1 [--budget 2000]
npm run cli -- residuals 1 [--limit 50 --offset 0]
```

Fixture kinds: `rest`, `constant`, `pulse_pos`, `pulse_neg`, `pulse_pair`, `zero_up0`,
`short_record`, `soc_boundary_low`, `soc_boundary_high`.

## HTTP API (loopback only)

Start (binds `127.0.0.1`, OS-assigned free port written to `data/server.port`):

```powershell
npm run serve
```

Routes:

- `GET  /health`
- `POST /models` `{name, params, idempotencyKey?}`
- `GET  /models?limit=&offset=&lineageId=`
- `GET  /models/:id`
- `PUT  /models/:id/params` `{params}`
- `POST /models/:id/versions` `{name}` (new version in the same lineage)
- `GET  /models/:id/compare/:otherId`
- `POST /models/:id/simulate` `{segments}`
- `POST /fixtures` `{kind, noise?, seed?}`
- `POST /models/:id/datasets` `{name, samples, idempotencyKey?}`
- `GET  /datasets?limit=&offset=&modelId=`
- `GET  /datasets/:id`
- `POST /datasets/:id/fit` `{budget}`
- `GET  /datasets/:id/report`
- `GET  /datasets/:id/residuals?limit=&offset=`

Errors use stable codes: `VALIDATION_ERROR`, `NOT_FOUND`, `RANGE_ERROR`, `UNIDENTIFIABLE`,
`BAD_STATE`. List endpoints paginate with `limit`/`offset`.

## Stop / clean

Stop the server with Ctrl+C in its terminal. To remove project-local data/temp files and stop a
server started by this project (pid in `data/server.pid`):

```powershell
npm run clean
```

All databases and temporary files live under this project's `data/` and `tmp/` directories.
Environment overrides: `BATT_DB`, `BATT_DATA_DIR`, `BATT_PORT`.
