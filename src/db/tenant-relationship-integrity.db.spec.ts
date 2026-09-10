/**
 * Real PostgreSQL contract probe for build.tickets(org_id, epic_id).
 *
 * Requires TENANT_FK_PROBE_DATABASE_URL for an approved disposable "scratch"
 * database, ALLOW_DESTRUCTIVE_DB_TESTS=1, and DB_SPEC_ALLOWED_HOSTS when not local.
 * No DATABASE_URL/.env fallback. Explicit seeded fixtures (TENANT_FK_PROBE_ prefix):
 * ORG_A, ORG_B, PROJECT_A_ID, PROJECT_B_ID, PARENT_A_ID, PARENT_B_ID, CHILD_B_ID.
 * Each parent must be an EPIC in its named org/project; child B must have no epic.
 *
 * pnpm test:db-specs --runTestsByPath src/db/tenant-relationship-integrity.db.spec.ts
 *
 * Updates only the named child in a bounded transaction that ALWAYS rolls back;
 * does not insert fixtures, advance sequences, or alter constraints. The default
 * unit suite excludes .db.spec.ts. Missing configuration fails rather than skips.
 */
import postgres from "postgres";
import {
  isTicketEpicForeignKeyViolation,
  loadTenantFkProbeConfig,
} from "../../test/helpers/tenant-fk-probe";

const config = loadTenantFkProbeConfig(process.env);
const client = postgres(config.url, {
  max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5,
  onnotice: () => undefined,
});

describe("build.tickets epic FK — real cross-tenant rejection", () => {
  afterAll(async () => { await client.end({ timeout: 5 }); });

  it("allows a same-org epic, rejects another org with fk_tickets_org_epic/23503, and rolls back", async () => {
    const rolledBack = new Error("tenant FK probe rollback");
    try {
      await client.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '5s'`;
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SELECT set_config('app.organization_id', ${config.orgA}, true)`;
        const parentA = await tx`
          SELECT id FROM build.tickets
          WHERE id = ${config.parentA} AND org_id = ${config.orgA}
            AND project_id = ${config.projectA} AND type = 'EPIC' AND deleted_at IS NULL
          FOR KEY SHARE`;
        expect(parentA).toHaveLength(1);

        await tx`SELECT set_config('app.organization_id', ${config.orgB}, true)`;
        const parentB = await tx`
          SELECT id FROM build.tickets
          WHERE id = ${config.parentB} AND org_id = ${config.orgB}
            AND project_id = ${config.projectB} AND type = 'EPIC' AND deleted_at IS NULL
          FOR KEY SHARE`;
        expect(parentB).toHaveLength(1);
        const child = await tx`
          SELECT id FROM build.tickets
          WHERE id = ${config.childB} AND org_id = ${config.orgB}
            AND project_id = ${config.projectB} AND epic_id IS NULL AND deleted_at IS NULL
          FOR UPDATE`;
        expect(child).toHaveLength(1);

        // An unrelated missing fixture, RLS denial, status FK or unique constraint
        // must not satisfy the negative case: prove this exact child is writable.
        const control = await tx`
          UPDATE build.tickets SET epic_id = ${config.parentB}
          WHERE id = ${config.childB} AND org_id = ${config.orgB} AND project_id = ${config.projectB}
          RETURNING id, org_id, epic_id`;
        expect(control).toHaveLength(1);
        expect(control[0]).toMatchObject({ id: config.childB, org_id: config.orgB, epic_id: config.parentB });

        let rejected: unknown;
        try {
          await tx.savepoint(async (sp) => {
            await sp`
              UPDATE build.tickets SET epic_id = ${config.parentA}
              WHERE id = ${config.childB} AND org_id = ${config.orgB} AND project_id = ${config.projectB}`;
            await sp`SET CONSTRAINTS ALL IMMEDIATE`;
          });
        } catch (error: unknown) {
          rejected = error;
        }
        expect(isTicketEpicForeignKeyViolation(rejected)).toBe(true);
        const preserved = await tx`
          SELECT epic_id FROM build.tickets WHERE id = ${config.childB} AND org_id = ${config.orgB}`;
        expect(preserved).toHaveLength(1);
        expect(preserved[0]?.epic_id).toBe(config.parentB);
        throw rolledBack;
      });
    } catch (error: unknown) {
      if (error !== rolledBack) throw error;
    }

    // Independently observe that the positive-control write was not committed.
    await client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SELECT set_config('app.organization_id', ${config.orgB}, true)`;
      const restored = await tx`
        SELECT epic_id FROM build.tickets
        WHERE id = ${config.childB} AND org_id = ${config.orgB} AND project_id = ${config.projectB}`;
      expect(restored).toHaveLength(1);
      expect(restored[0]?.epic_id).toBeNull();
    });
  }, 30_000);
});
