import { readFileSync } from "fs";
import { join } from "path";

/**
 * Validates that migrations 1390, 1391, and 1392 each enable RLS and install a
 * tenant_isolation policy on the three build tables that were identified in CCG-7
 * as running without any policy.
 *
 * These are static content checks on the migration files themselves, not live
 * database probes. Live verification (as the app role, with and without the tenant
 * GUC) must be performed by the orchestrator using db:verify-rls.
 *
 * Each migration must: (a) ENABLE ROW LEVEL SECURITY on the qualified table,
 * (b) define a tenant_isolation policy using org_id = app.current_org_id(), and
 * (c) carry a GRANT to streamline_app.
 *
 * Each rollback must: (a) DROP POLICY IF EXISTS tenant_isolation and
 * (b) DISABLE ROW LEVEL SECURITY.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

const CASES = [
  {
    migration: "1390_rls_project_updates.sql",
    rollback: "1390_rls_project_updates_rollback.sql",
    schema: "build",
    table: "project_updates",
    number: "1390",
  },
  {
    migration: "1391_rls_project_attachments.sql",
    rollback: "1391_rls_project_attachments_rollback.sql",
    schema: "build",
    table: "project_attachments",
    number: "1391",
  },
  {
    migration: "1392_rls_managed_product_memberships.sql",
    rollback: "1392_rls_managed_product_memberships_rollback.sql",
    schema: "build",
    table: "managed_product_memberships",
    number: "1392",
  },
] as const;

describe("RLS migrations for the three build tables identified in CCG-7", () => {
  for (const c of CASES) {
    describe(`${c.number}: ${c.schema}.${c.table}`, () => {
      let migSql: string;
      let rollbackSql: string;

      beforeAll(() => {
        migSql = readMigration(c.migration);
        rollbackSql = readMigration(c.rollback);
      });

      it("migration file exists and is non-empty", () => {
        expect(migSql.length).toBeGreaterThan(0);
      });

      it("sets a lock_timeout", () => {
        expect(migSql).toMatch(/SET\s+lock_timeout/i);
      });

      it("enables RLS on the fully-qualified table", () => {
        const re = new RegExp(
          `ALTER\\s+TABLE\\s+"${c.schema}"\\."${c.table}"\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
          "i",
        );
        expect(migSql).toMatch(re);
      });

      it("creates a tenant_isolation policy", () => {
        expect(migSql).toMatch(/CREATE\s+POLICY\s+tenant_isolation/i);
      });

      it("policy USING clause gates on org_id = app.current_org_id()", () => {
        expect(migSql).toMatch(/USING\s*\(\s*"org_id"\s*=\s*app\.current_org_id\(\)/i);
      });

      it("policy WITH CHECK clause gates on org_id = app.current_org_id()", () => {
        expect(migSql).toMatch(/WITH\s+CHECK\s*\(\s*"org_id"\s*=\s*app\.current_org_id\(\)/i);
      });

      it("grants DML to streamline_app", () => {
        expect(migSql).toMatch(/GRANT\s+SELECT.*streamline_app/is);
      });

      it("rollback file exists and is non-empty", () => {
        expect(rollbackSql.length).toBeGreaterThan(0);
      });

      it("rollback drops the policy", () => {
        expect(rollbackSql).toMatch(/DROP\s+POLICY\s+IF\s+EXISTS\s+tenant_isolation/i);
      });

      it("rollback disables RLS", () => {
        const re = new RegExp(
          `ALTER\\s+TABLE.*${c.table}.*DISABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
          "i",
        );
        expect(rollbackSql).toMatch(re);
      });
    });
  }
});
