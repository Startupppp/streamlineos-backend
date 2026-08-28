import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  accountOrganizationIndex,
  organizationLegalHolds,
  organizationLifecycleSagas,
  organizationPlacement,
  organizationPurgeConfirmations,
  organizationReservations,
  organizationSagaSteps,
} from "../../db/schema";

const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "..",
  "migrations",
  "0608_organization_placement_and_lifecycle.sql",
);

const migrationSql = readFileSync(MIGRATION, "utf8");

const withTenantSource = readFileSync(
  join(__dirname, "..", "tenant", "with-tenant.ts"),
  "utf8",
);

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

const SQL_WORDS = new Set([
  "select",
  "count",
  "from",
  "where",
  "and",
  "status",
  "active",
  "now",
  "as",
  "organization_placement",
]);

/**
 * The identifiers the fence probe actually names, read out of the source rather
 * than restated here — a restated list passes a substring check even when the
 * SQL says `write_fence_tokens`.
 */
function fenceProbeIdentifiers(source: string): string[] {
  const probe = /FROM organization_placement([\s\S]*?)\) AS/.exec(source)?.[1];
  if (probe === undefined) throw new Error("fence probe not found in with-tenant.ts");

  // `${placement.placementVersion}` is a JS expression, not a column reference.
  const words = probe.replace(/\$\{[^}]*\}/g, " ").match(/\b[a-z][a-z0-9_]*\b/g) ?? [];
  return [...new Set(words)].filter((word) => !SQL_WORDS.has(word));
}

describe("the raw fence probe matches the placement table", () => {
  const columns = columnNames(organizationPlacement);
  const referenced = fenceProbeIdentifiers(withTenantSource);

  it("names a table the schema actually declares", () => {
    expect(getTableConfig(organizationPlacement).name).toBe("organization_placement");
    expect(withTenantSource).toContain("FROM organization_placement");
  });

  it("names identifiers at all, so an empty parse cannot pass vacuously", () => {
    expect(referenced.length).toBeGreaterThanOrEqual(4);
  });

  it("references only columns that exist on the table", () => {
    expect(referenced.filter((name) => !columns.includes(name))).toEqual([]);
  });

  it.each(["organization_id", "placement_version", "write_fence_token", "lease_expires_at"])(
    "fences on %s",
    (column) => {
      expect(columns).toContain(column);
      expect(referenced).toContain(column);
    },
  );

  it("sets the placement version and cell id as local GUCs", () => {
    expect(withTenantSource).toContain("app.placement_version");
    expect(withTenantSource).toContain("app.cell_id");
    expect(withTenantSource).not.toContain("options=-c");
  });
});

describe("the migration creates what the schema declares", () => {
  const tables = [
    organizationPlacement,
    organizationLifecycleSagas,
    organizationSagaSteps,
    organizationReservations,
    accountOrganizationIndex,
    organizationPurgeConfirmations,
    organizationLegalHolds,
  ];

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    "creates %s with every column the schema declares",
    (name, table) => {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "${name}"`);
      for (const column of columnNames(table))
        expect(migrationSql).toContain(`"${column}"`);
    },
  );

  it("leaves organization_placement without a foreign key to organizations", () => {
    expect(getTableConfig(organizationPlacement).foreignKeys).toHaveLength(0);
  });

  it("backfills a placement row for every existing organisation at cell legacy-1", () => {
    expect(migrationSql).toContain('INSERT INTO "organization_placement"');
    expect(migrationSql).toContain("'legacy-1'");
    expect(migrationSql).toContain('FROM "organizations" o');
  });

  it("takes a lock timeout so it fails fast instead of blocking the table", () => {
    expect(migrationSql).toContain("SET lock_timeout");
  });

  it("adds every foreign key NOT VALID and then validates it", () => {
    const added = migrationSql.match(/ADD CONSTRAINT "(\w+)" FOREIGN KEY/g) ?? [];
    const validated = migrationSql.match(/VALIDATE CONSTRAINT "(\w+)"/g) ?? [];
    expect(added.length).toBeGreaterThan(0);
    expect(validated).toHaveLength(added.length);
    expect(migrationSql.match(/NOT VALID/g) ?? []).toHaveLength(added.length);
  });

  it("is registered in the drizzle journal, or it would never run", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "..", "migrations", "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: { tag: string }[] };

    expect(journal.entries.map((entry) => entry.tag)).toContain(
      "0608_organization_placement_and_lifecycle",
    );
  });
});

describe("the control-plane tables are declared RLS-exempt with a reason", () => {
  const verifier = readFileSync(
    join(__dirname, "..", "..", "scripts", "db-verify-rls.mjs"),
    "utf8",
  );

  it.each([
    "public.organization_placement",
    "public.organization_lifecycle_sagas",
    "public.organization_saga_steps",
    "public.organization_reservations",
  ])("lists %s", (table) => {
    expect(verifier).toContain(table);
  });

  it("gives the tenant-owned lifecycle tables a policy instead of an exemption", () => {
    for (const table of [
      "account_organization_index",
      "organization_purge_confirmations",
      "organization_legal_holds",
    ]) {
      expect(migrationSql).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      expect(migrationSql).toContain(`CREATE POLICY "tenant_isolation" ON "${table}"`);
      expect(verifier).not.toContain(`public.${table}`);
    }
  });
});
