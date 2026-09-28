import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "migrations");

function insertInto(table: string): RegExp {
  return new RegExp(`insert\\s+into\\s+"?(public"?\\.)?"?${table}"?`, "i");
}

const GRANT_INSERT = insertInto("kb_page_grants");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
}

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf-8").replace(/\r\n/g, "\n");
}

describe("kb_page_grants carries no backfill, because a grant invented for a foreign-authored page hands out access nobody ever granted", () => {
  it("scans a non-empty set of migration files, so a later assertion cannot pass by reading nothing", () => {
    expect(migrationFiles().length).toBeGreaterThan(100);
  });

  it("detects a grant insert when one is present, so the absence assertion below is not vacuous", () => {
    expect(GRANT_INSERT.test('INSERT INTO "public"."kb_page_grants" (page_id)')).toBe(true);
    expect(GRANT_INSERT.test("insert into kb_page_grants select 1")).toBe(true);
    expect(GRANT_INSERT.test("INSERT INTO kb_page_grant_audit (id)")).toBe(false);
  });

  it("finds a real backfill through the same scan when one exists, so the empty result below reflects the migrations rather than a scan that never matches anything", () => {
    const backfilled = migrationFiles().filter((f) =>
      insertInto("role_permission_grants").test(readMigration(f)),
    );

    expect(backfilled).toContain("0207_backfill_crm_party_permissions.sql");
  });

  it("no migration inserts a row into kb_page_grants, so every grant in the table was written by a request whose actor held manage on that page", () => {
    const offenders = migrationFiles().filter((f) => GRANT_INSERT.test(readMigration(f)));

    expect(offenders).toEqual([]);
  });

  it("keeps the table's only definition a creation, so the shared-with-me surface starting empty is a deliberate outcome rather than a lost backfill", () => {
    const touching = migrationFiles().filter((f) => /kb_page_grants/i.test(readMigration(f)));

    expect(touching).toEqual(["1168_kb_page_grants.sql"]);
  });
});
