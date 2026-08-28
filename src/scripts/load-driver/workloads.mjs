import { summarise } from "./percentiles.mjs";

export const NOT_DRIVEN_REASONS = {
  "authenticated-interactive-availability":
    "an availability percentage is a month of production traffic, not a run",
  "p95-browser-cached-read":
    "no browser is involved and the run is not in the PRD's reference geography",
  "p75-first-useful-view":
    "a first useful view is a browser measurement on a reference device and network",
  "p99-in-process-authorization":
    "the warm path is AccessService.applyUniversalGrants and stripDeniedModules, both private methods reached through resolveUserPermissions. A benchmark that reimplements them measures the benchmark, not the product, so this stays unmeasured until a harness constructs the real service with primed caches",
  "node-failure-committed-loss":
    "needs a node killed mid-commit and the committed transactions counted afterwards; Neon gives no handle to kill one",
  "regional-rpo": "a Neon control-plane property, not something this driver can exercise",
  "cell-rto": "needs a real recovery drill, timed end to end",
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

const SCOPE_RANK = { none: 0, own: 1, team: 2, all: 3 };
function moduleOf(key) {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
}

export async function measurePermissionRevocation(sql, orgId) {
  const memberRows = await sql`
    SELECT id FROM organization_members
    WHERE org_id = ${orgId} AND role = 'MEMBER' AND status = 'ACTIVE'
    LIMIT 1`;
  if (!memberRows.length) return { error: "no active MEMBER found in the seeded org" };
  const membershipId = memberRows[0].id;

  const permRows = await sql`
    SELECT name FROM permissions WHERE is_delegable = true LIMIT 1`;
  if (!permRows.length) return { error: "permissions table is empty; run app seed or migration to populate it" };
  const permKey = permRows[0].name;
  const modKey = moduleOf(permKey);

  await sql`
    DELETE FROM user_permission_grants
    WHERE org_id = ${orgId} AND organization_membership_id = ${membershipId}
      AND permission_key = ${permKey}`;

  await sql`
    INSERT INTO user_permission_grants
      (org_id, organization_membership_id, permission_key, scope, module_key)
    VALUES (${orgId}, ${membershipId}, ${permKey}, 'all', ${modKey})
    ON CONFLICT (org_id, organization_membership_id, permission_key) DO UPDATE SET scope = 'all'`;

  await sql`
    INSERT INTO access_versions (org_id, permissions_version) VALUES (${orgId}, 2)
    ON CONFLICT (org_id) DO UPDATE
      SET permissions_version = access_versions.permissions_version + 1,
          updated_at = now()`;

  const check = await sql`
    SELECT count(*)::int AS n FROM user_permission_grants
    WHERE org_id = ${orgId} AND organization_membership_id = ${membershipId}
      AND permission_key = ${permKey}`;
  if (Number(check[0].n) === 0) return { error: "grant not visible after insert; FK or RLS may be blocking" };

  const t0 = process.hrtime.bigint();
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM user_permission_grants
      WHERE org_id = ${orgId} AND organization_membership_id = ${membershipId}
        AND permission_key = ${permKey}`;
    await tx`
      INSERT INTO access_versions (org_id, permissions_version) VALUES (${orgId}, 2)
      ON CONFLICT (org_id) DO UPDATE
        SET permissions_version = access_versions.permissions_version + 1,
            updated_at = now()`;
  });
  const revoked = await sql`
    SELECT count(*)::int AS n FROM user_permission_grants
    WHERE org_id = ${orgId} AND organization_membership_id = ${membershipId}
      AND permission_key = ${permKey}`;
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  if (Number(revoked[0].n) !== 0) return { error: "grant still present after revocation commit" };
  return { elapsedMs, permKey };
}

export async function measureDurableEventLoss(sql, orgId) {
  const ts = Date.now();
  const EVENT_COUNT = 20;
  const eventIds = Array.from({ length: EVENT_COUNT }, (_, i) => `probe-loss-${ts}-${i}`);

  try {
    for (let i = 0; i < EVENT_COUNT; i++) {
      await sql`
        INSERT INTO outbox_events
          (event_id, organization_id, aggregate_type, aggregate_id, aggregate_version,
           schema_version, event_type, payload, occurred_at)
        VALUES
          (${eventIds[i]}, ${orgId}, 'probe', ${`probe-${ts}-${i}`}, 1,
           1, 'probe.loss-test', '{}', now())
        ON CONFLICT DO NOTHING`;
    }

    const before = await sql`
      SELECT count(*)::int AS n FROM outbox_events
      WHERE organization_id = ${orgId} AND event_id = ANY(${eventIds})
        AND delivery_state = 'PENDING'`;
    const inserted = Number(before[0].n);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE outbox_events SET delivery_state = 'IN_FLIGHT'
        WHERE organization_id = ${orgId} AND event_id = ANY(${eventIds})`;
      await tx`
        UPDATE outbox_events SET delivery_state = 'DELIVERED', published_at = now()
        WHERE organization_id = ${orgId} AND event_id = ANY(${eventIds})`;
      throw new Error("induced abort");
    }).catch(() => {});

    const after = await sql`
      SELECT count(*)::int AS n FROM outbox_events
      WHERE organization_id = ${orgId} AND event_id = ANY(${eventIds})
        AND delivery_state = 'PENDING'`;
    const remaining = Number(after[0].n);
    const lost = inserted - remaining;
    return { acknowledged: inserted, remaining, lost };
  } finally {
    await sql`
      DELETE FROM outbox_events
      WHERE organization_id = ${orgId} AND event_id = ANY(${eventIds})`;
  }
}

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
