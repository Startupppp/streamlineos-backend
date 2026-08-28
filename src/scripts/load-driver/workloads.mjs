export const NOT_DRIVEN_REASONS = {
  "authenticated-interactive-availability":
    "an availability percentage is a month of production traffic, not a run",
  "p95-browser-cached-read":
    "no browser is involved and the run is not in the PRD's reference geography",
  "p75-first-useful-view":
    "a first useful view is a browser measurement on a reference device and network",
  "permission-revocation-explicit":
    "needs a grant revoked while a session is live and the effect observed; that is a two-process test",
  "durable-event-loss-after-ack":
    "needs an acknowledged event and then an induced failure; nothing here injects one",
  "node-failure-committed-loss":
    "needs a node killed mid-commit and the committed transactions counted afterwards; Neon gives no handle to kill one",
  "regional-rpo": "a Neon control-plane property, not something this driver can exercise",
  "cell-rto": "needs a real recovery drill, timed end to end",
  "p99-in-process-authorization":
    "100 microseconds of CPU with no I/O needs an in-process profiler on the permission evaluator, not a database driver",
};

export const DRIVEN = {
  "p95-simple-db-roundtrip": {
    percentileKey: "p95",
    description:
      "one round trip inside a transaction with the tenant GUC set, as the application role",
    async run(ctx) {
      const started = process.hrtime.bigint();
      await ctx.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${ctx.orgId}, true)`;
        await tx`SELECT 1 AS ok`;
      });
      return Number(process.hrtime.bigint() - started) / 1e6;
    },
  },

  "p95-complex-db-read": {
    percentileKey: "p95",
    description: "a tenant-scoped list read over the largest organization, RLS enforced",
    async run(ctx) {
      const started = process.hrtime.bigint();
      await ctx.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${ctx.orgId}, true)`;
        await tx`
          SELECT m.id, m.user_id, m.status, m.joined_at
          FROM organization_members m
          WHERE m.org_id = ${ctx.orgId}
          ORDER BY m.joined_at DESC
          LIMIT ${ctx.pageSize}`;
      });
      return Number(process.hrtime.bigint() - started) / 1e6;
    },
  },

  "p95-transactional-write": {
    percentileKey: "p95",
    description:
      "a committed insert through row-level security with the tenant GUC set, against the cell's probe table",
    async run(ctx) {
      const started = process.hrtime.bigint();
      await ctx.target.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${ctx.orgId}, true)`;
        await tx`INSERT INTO load_driver_probe (org_id, note) VALUES (${ctx.orgId}, 'probe')`;
      });
      return Number(process.hrtime.bigint() - started) / 1e6;
    },
  },

  "p95-redis-operation": {
    percentileKey: "p95",
    description: "a round trip to the configured cache, including network",
    async run(ctx) {
      if (ctx.redis === null) return Number.NaN;
      const started = process.hrtime.bigint();
      await ctx.redis.ping();
      return Number(process.hrtime.bigint() - started) / 1e6;
    },
  },
};

export const PROBE_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS load_driver_probe (
     id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     org_id text NOT NULL,
     note text,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE load_driver_probe ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation ON load_driver_probe`,
  `CREATE POLICY tenant_isolation ON load_driver_probe FOR ALL
     USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())`,
  `REVOKE ALL ON load_driver_probe FROM PUBLIC`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON load_driver_probe TO streamline_app`,
];

export const PROBE_TABLE_DROP = "DROP TABLE IF EXISTS load_driver_probe";

export async function crossOrgExposureProbe(sql, orgId, otherOrgId) {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${otherOrgId}, true)`;
    return tx`SELECT count(*)::int AS n FROM organization_members WHERE org_id = ${orgId}`;
  });
  return Number(rows[0]?.n ?? -1);
}
