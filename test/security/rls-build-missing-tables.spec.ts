import { readFileSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

const CASES = [
  {
    migration: "1390_rls_project_updates.sql",
    rollback: "rollback/1390_rls_project_updates.down.sql",
    schema: "build",
    table: "project_updates",
    number: "1390",
  },
  {
    migration: "1391_rls_project_attachments.sql",
    rollback: "rollback/1391_rls_project_attachments.down.sql",
    schema: "build",
    table: "project_attachments",
    number: "1391",
  },
  {
    migration: "1392_rls_managed_product_memberships.sql",
    rollback: "rollback/1392_rls_managed_product_memberships.down.sql",
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
