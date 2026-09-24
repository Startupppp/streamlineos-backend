import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as buildSchema from "./index";

const BUILD_SCHEMAS = new Set(["build", "build_events"]);
const TENANT_COLUMN = "org_id";

interface TenantParentReference {
  readonly child: string;
  readonly parent: string;
  readonly localColumns: readonly string[];
  readonly parentColumns: readonly string[];
}

function qualifiedName(table: PgTable): string {
  const config = getTableConfig(table);
  return config.schema ? `${config.schema}.${config.name}` : config.name;
}

function isTenantScoped(table: PgTable): boolean {
  return getTableConfig(table).columns.some(
    (column) => column.name === TENANT_COLUMN,
  );
}

function buildTables(): PgTable[] {
  const tables: PgTable[] = [];
  for (const exported of Object.values(buildSchema)) {
    if (!(exported instanceof PgTable)) continue;
    if (!BUILD_SCHEMAS.has(getTableConfig(exported).schema ?? "")) continue;
    tables.push(exported);
  }
  return tables;
}

function tenantParentReferences(): TenantParentReference[] {
  const found: TenantParentReference[] = [];
  for (const table of buildTables()) {
    if (!isTenantScoped(table)) continue;
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      const reference = foreignKey.reference();
      const parent = reference.foreignTable;
      if (!(parent instanceof PgTable)) continue;
      if (!isTenantScoped(parent)) continue;
      found.push({
        child: qualifiedName(table),
        parent: qualifiedName(parent),
        localColumns: reference.columns.map((column) => column.name),
        parentColumns: reference.foreignColumns.map((column) => column.name),
      });
    }
  }
  return found;
}

function pairsTenantColumn(reference: TenantParentReference): boolean {
  const position = reference.parentColumns.indexOf(TENANT_COLUMN);
  return (
    position !== -1 && reference.localColumns[position] === TENANT_COLUMN
  );
}

function describeReference(reference: TenantParentReference): string {
  return `${reference.child}(${reference.localColumns.join(", ")}) -> ${reference.parent}(${reference.parentColumns.join(", ")})`;
}

const UNPAIRED_TENANT_REFERENCES = [
  "build.tickets(customer_id) -> clients(id)",
];

describe("build schema tenant foreign keys", () => {
  it("walks every build and build_events table so the later assertions cannot pass vacuously", () => {
    const tables = buildTables();
    expect(tables.length).toBeGreaterThan(80);
    expect(
      tables.every((table) => isTenantScoped(table)),
    ).toBe(true);
  });

  it("discovers the tenant-scoped parent references the invariant is meant to police", () => {
    const references = tenantParentReferences();
    expect(references.length).toBeGreaterThan(100);
    expect(references.filter(pairsTenantColumn).length).toBeGreaterThan(100);
  });

  it("pairs org_id with the parent key on every build child reference to a tenant-scoped parent, except the references recorded below", () => {
    const unpaired = tenantParentReferences()
      .filter((reference) => !pairsTenantColumn(reference))
      .map(describeReference)
      .sort();

    expect(unpaired).toEqual(UNPAIRED_TENANT_REFERENCES);
  });

  it("holds tickets.customer_id as the only unpaired reference, which lets a ticket point at another organisation's client row until a migration rebuilds the constraint as composite", () => {
    expect(UNPAIRED_TENANT_REFERENCES).toHaveLength(1);

    const unpaired = tenantParentReferences().filter(
      (reference) => !pairsTenantColumn(reference),
    );

    expect(unpaired).toHaveLength(1);
    expect(unpaired[0]?.child).toBe("build.tickets");
    expect(unpaired[0]?.parent).toBe("clients");
    expect(unpaired[0]?.localColumns).toEqual(["customer_id"]);
  });
});
