import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The row-level-security matrix, checked before a database exists to check it on.
 *
 * `db-verify-rls.mjs` is the real gate and it reads `pg_class`: a table with a
 * tenant column and no policy fails it, one without FORCE fails it, and one
 * whose policy never mentions the tenant column fails it. That check needs a
 * live database and runs in CI, which means the failure arrives after the branch
 * is pushed and long after the migration was written.
 *
 * This is the same three properties read out of the migration text, so the
 * mistake is caught in the file where it would be made. It is deliberately not a
 * substitute — a policy this file approves and Postgres rejects still fails
 * there — it is the fast half of the same question. `hr-relational-normalization.spec.ts`
 * does the same for its own bundle.
 */
describe("the customer lifecycle tables are in the row-level-security matrix", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "migrations/0534_customer_lifecycle.sql"),
    "utf8",
  );

  const TABLES = [
    "customer_lifecycles",
    "customer_lifecycle_signals",
    "customer_health_scores",
    "customer_usage_observations",
  ] as const;

  /** Tables whose whole point is that a row, once written, is not rewritten. */
  const APPEND_ONLY = ["customer_lifecycle_signals", "customer_health_scores"] as const;

  it("creates exactly the four tables it documents", () => {
    expect(migration.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(TABLES.length);
    for (const table of TABLES)
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
  });

  it("leaves no table readable organisation-wide", () => {
    for (const table of TABLES) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`CREATE POLICY "tenant_isolation" ON "${table}"`);
    }
  });

  it("subjects the table owner to the policies as well as the application role", () => {
    // Without FORCE the owner — which is the migration role — bypasses every
    // policy, so a cross-tenant read stays possible from the connection most
    // likely to be used for ad-hoc work.
    for (const table of TABLES)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
  });

  it("gates reads and writes on the tenant, not only reads", () => {
    const policies = migration.match(
      /CREATE POLICY "tenant_isolation" ON "\w+"\s+FOR ALL USING \(organization_id = app\.current_org_id\(\)\)\s+WITH CHECK \(organization_id = app\.current_org_id\(\)\);/g,
    );

    // A policy with a USING clause and no WITH CHECK stops a tenant reading
    // another's rows and lets them write one.
    expect(policies).toHaveLength(TABLES.length);
  });

  it("takes the default grant away from PUBLIC before granting anything", () => {
    for (const table of TABLES) {
      expect(migration).toContain(`REVOKE ALL ON "${table}" FROM PUBLIC;`);
      expect(migration).toMatch(new RegExp(`GRANT SELECT[^;]*ON "${table}" TO streamline_app;`));
    }
  });

  it("gives nothing the right to rewrite a score or a signal", () => {
    for (const table of APPEND_ONLY) {
      const grant = migration.match(new RegExp(`GRANT ([^;]+) ON "${table}" TO streamline_app;`));
      expect(grant?.[1]).not.toContain("UPDATE");
    }
  });

  it("keeps every party edge composite, so one tenant cannot reference another's customer", () => {
    const partyKeys = migration.match(/FOREIGN KEY \("organization_id", "party_id"\)/g);
    expect(partyKeys).toHaveLength(3);
    expect(migration).not.toMatch(/FOREIGN KEY \("party_id"\)/);
  });

  it("stages and then validates every foreign key it adds", () => {
    const staged = migration.match(/ON DELETE (?:CASCADE|SET NULL) NOT VALID;/g) ?? [];
    const validated = migration.match(/VALIDATE CONSTRAINT /g) ?? [];
    expect(staged).toHaveLength(validated.length);
    expect(staged.length).toBeGreaterThan(0);
  });
});
