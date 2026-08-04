import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface JournalEntry {
  idx: number;
  tag: string;
}

interface MigrationJournal {
  entries: JournalEntry[];
}

function readMigration(name: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
}

describe("RBAC hardening migrations", () => {
  const journal = JSON.parse(
    readMigration("meta/_journal.json"),
  ) as MigrationJournal;

  it("journals the generated migrations", () => {
    expect(journal.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "0117_invitation-events-org-fk" }),
        expect.objectContaining({ tag: "0118_module_access_indexes" }),
      ]),
    );
  });

  it("keeps the invitation FK lock-safe", () => {
    const migration = readMigration("0117_invitation-events-org-fk.sql");
    expect(migration).toContain("SET lock_timeout = '5s'");
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });

  it("keeps index creation compatible with Drizzle's transaction wrapper", () => {
    const migration = readMigration("0118_module_access_indexes.sql");
    expect(migration).toContain("SET statement_timeout = 0");
    expect(migration).toContain("SET lock_timeout = '5s'");
    expect(migration).not.toContain("CREATE INDEX CONCURRENTLY");
  });

  it("stages RBAC tenant enforcement before validation", () => {
    const add = readMigration("0394_rbac_composite_tenant_fks.sql");
    const validate = readMigration("0395_validate_rbac_composite_tenant_fks.sql");

    expect(add.match(/ON DELETE CASCADE NOT VALID;/g)).toHaveLength(5);
    expect(add).toContain("SET lock_timeout = '5s'");
    expect(validate.match(/ALTER TABLE \w+ VALIDATE CONSTRAINT/g)).toHaveLength(5);
    expect(validate).toContain("SET lock_timeout = '5s'");
  });

  it("makes the dead-table migration fail closed", () => {
    const migration = readMigration(
      "0396_drop_verified_dead_learning_tables.sql",
    );

    expect(migration).toContain("row_count <> 0");
    expect(migration.match(/DROP TABLE IF EXISTS/g)).toHaveLength(7);
    expect(migration).toContain("RESTRICT");
    expect(migration).not.toMatch(/DROP TABLE[^;]+CASCADE;/);
    expect(migration).not.toMatch(/DROP TABLE IF EXISTS payroll_statutory_rule_sets/);
  });
});
