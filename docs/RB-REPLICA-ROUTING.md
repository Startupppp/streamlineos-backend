# RB — Physical read replica routing

Companion to [the completion plan](../../architecture-refactor/prd/completion-plan.md), which contains the current cell-operations requirements and alert runbooks.

**Do not provision a replica before closing the two code blockers below.** A replica that exists but whose GUC is never set will fail every RLS-protected query with `42501`, silently or visibly depending on error handling at the call site.

---

## Current state (2026-08-31)

- `backend/src/db/replica-router.ts` — pool-selection logic exists and is correct. Routes `analytics-refresh` and `search-freshness` to the replica; all other work classes to the primary.
- `backend/src/db/pool.config.ts` — reads `DB_REPLICA_URL` and exposes `replicaConnectionString` in `ResolvedPoolConfig`.
- `backend/src/db/drizzle.constants.ts` — exports `DRIZZLE`, `DB_POOL_CONFIG`, `DRIZZLE_REPLICA`, `REPLICA_ROUTER`.
- `backend/src/db/drizzle.module.ts` — **FIXED (Blocker A)**. Creates two postgres clients: primary under `DRIZZLE` (proxy-wrapped via `createTenantAwareDb`), replica under `DRIZZLE_REPLICA` (raw, not proxy-wrapped). `REPLICA_ROUTER` is also provided. When `DB_REPLICA_URL` is unset, `DRIZZLE_REPLICA` falls back to the primary connection string with `max=2` and logs the fallback explicitly. Both pools are ended on `onApplicationShutdown`.
- `backend/src/common/tenant/run-in-tenant-transaction.ts` — **FIXED (Blocker B)**. `runInReplicaTenantRead(replicaDb, fn)` opens a `READ ONLY` transaction on the replica db, issues `SELECT set_config('app.organization_id', …, true)` from the ambient `TenantContext` (not from the caller — impersonation impossible), and runs `fn` inside. Throws immediately if no ambient context exists (no GUC possible → 42501 prevented). Exported from `common/tenant/index.ts`.
- `backend/src/degradation/read-replica.spec.ts` — ratchets the env-var seam; lag-simulation tests are `xit` (skipped pending replica provisioning). 18 passing.
- `backend/src/common/tenant/__tests__/run-in-tenant-transaction.spec.ts` — 9 passing including 4 new specs for `runInReplicaTenantRead`, each bite-proved.

---

## Routing policy

**Default: primary.** All code continues to use `this.db` (the `DRIZZLE` token) which routes to the ambient tenant transaction (primary) via the `createTenantAwareDb` proxy. No change required at existing call sites.

**Replica: explicit opt-in per call site.** A service that needs replica routing for a stale-tolerant projection:
1. Injects `@Inject(DRIZZLE_REPLICA) private readonly replicaDb: Db` (raw, not the proxy-wrapped primary).
2. Calls `runInReplicaTenantRead(this.replicaDb, async (tx) => { … })` for `analytics-refresh` or `search-freshness` work classes.
3. Does NOT call `runInReplicaTenantRead` for any other work class — the caller decides based on its own work class.

The helper is structurally unable to run without the ambient tenant context. A call site that forgets to check its work class will still set the GUC correctly and route to the replica pool — the worst outcome is a stale read, not a cross-tenant hole or a 42501.

---

## Code blocker A — CLOSED

`DrizzleModule` now provides two pools:

- `DRIZZLE` — primary, proxy-wrapped (`createTenantAwareDb`), routes all property access to the ambient tenant transaction. Pool max from `DB_POOL_MAX` env / defaults.
- `DRIZZLE_REPLICA` — raw Drizzle instance (no proxy), backed by `DB_REPLICA_URL` when set; falls back to primary connection string with `max=2` when unset. Logged explicitly at startup.
- `REPLICA_ROUTER` — `ReplicaRouter(primary, replica | null)` for health-check and observability tooling.

---

## Code blocker B — CLOSED

`runInReplicaTenantRead` in `backend/src/common/tenant/run-in-tenant-transaction.ts`:

1. Reads `orgId` and `audience` from `getTenantContext()` (AsyncLocalStorage) — the caller cannot override it.
2. Throws immediately if no context exists — no GUC, no query, no 42501.
3. Opens a `READ ONLY` transaction on the raw replica db.
4. Issues `SELECT set_config('app.organization_id', orgId, true), set_config('app.audience', audience, true)` — `is_local = true` means it reverts at COMMIT, exactly matching Neon's pooler requirements.
5. Runs `fn(tx)` and returns the result.

---

## Infrastructure prerequisite (do after both code blockers are closed)

1. In the Neon console, open the cell-2 project and create a read replica endpoint.
2. Copy the replica connection string.
3. Set `DB_REPLICA_URL` in the cell-2 deployment environment.
4. Run `pnpm -C backend cell:isolation --region=cell-2` — the read replica line should move from UNPROVISIONED to ISOLATED (separate endpoint from the primary).
5. Deploy the application. Confirm structured logs show the replica pool warming up.

**Lag simulation test (before routing live traffic):**

```bash
# inject an artificial lag on the replica and confirm analytics-refresh work
# is shed (ReplicaShedError) rather than silently routed to primary
node backend/src/scripts/failure-drill.mjs --execute --drill=read-replica-lag
```

This drill does not exist yet — create it alongside the code changes above. The self-test must prove `ReplicaShedError` is thrown and the caller receives a 503, not a fallback to primary.

---

## Verification after provisioning

```bash
# 1. Confirm the pool config reads the replica URL
pnpm -C backend ts-node -e "import { resolvePoolConfig } from './src/db/pool.config'; console.log(resolvePoolConfig(process.env).replicaConnectionString)"

# 2. Drive an analytics-refresh workload and confirm replica pool received the query
#    (check PoolHandle.id in logs — should be "replica", not "primary")
pnpm -C backend load:drive --work-class=analytics-refresh --duration=10s

# 3. Confirm an RLS-protected replica read succeeds
pnpm -C backend cell:isolation:replica --region=cell-2
```

Step 2 above does not work as written: `load:drive` (`src/scripts/run-load-driver.mjs`) has no `--work-class` flag and drives no analytics-refresh workload — `DRIVEN` (`src/scripts/load-driver/workloads.mjs`) is a fixed set of named probes (cross-org exposure, permission revocation, durable event loss, authenticated availability, node-failure loss), none of them replica-routed. `--duration` also takes milliseconds, not `10s` (default `30000`). Nothing in the codebase drives replica-routed traffic and asserts `PoolHandle.id` in logs; write that before relying on this step.

**CORRECTED:** Step 3's `cell:isolation:replica` script exists — the prior claim that it "does not exist yet" was wrong. `package.json` wires it to `node --env-file-if-exists=.env src/scripts/verify-replica-routing.mjs --isolation` (self-test: `cell:isolation:replica:self-test`). It fails closed with a named missing prerequisite (`DB_REPLICA_URL`, then `APP_DATABASE_URL`) rather than a vacuous pass. The `--region=cell-2` shown above is a no-op on this script: unlike `verify-cell-isolation.mjs` (infra step 4), `verify-replica-routing.mjs` parses only `--self-test` and `--isolation` — it reads `DB_REPLICA_URL`/`APP_DATABASE_URL` straight from the environment already scoped to the target cell.

**Confirm resolution:** No `42501` errors in the structured log for `analytics-refresh` or `search-freshness` routes after deployment. `alert-tenant-ctx-errors.mjs` exits 0 over a fresh log window.
