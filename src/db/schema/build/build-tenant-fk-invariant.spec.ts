import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as buildSchema from "./index";
import { crmOrgPartyMap } from "../party/legacy-party-map";

const BUILD_SCHEMAS = new Set(["build", "build_events"]);
const TENANT_COLUMN = "org_id";

interface TenantParentReference {
  readonly child: string;
  readonly parent: string;
  readonly name: string;
  readonly onDelete: string | undefined;
  readonly childTenantColumn: string;
  readonly parentTenantColumn: string;
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

function parentTenantColumn(table: PgTable): string | undefined {
  const config = getTableConfig(table);
  if (config.columns.some((column) => column.name === TENANT_COLUMN)) {
    return TENANT_COLUMN;
  }
  if (table === crmOrgPartyMap) {
    return crmOrgPartyMap.organizationId.name;
  }
  return undefined;
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
      const parentTenant = parentTenantColumn(parent);
      if (!parentTenant) continue;
      found.push({
        child: qualifiedName(table),
        parent: qualifiedName(parent),
        name: foreignKey.getName(),
        onDelete: foreignKey.onDelete,
        childTenantColumn: TENANT_COLUMN,
        parentTenantColumn: parentTenant,
        localColumns: reference.columns.map((column) => column.name),
        parentColumns: reference.foreignColumns.map((column) => column.name),
      });
    }
  }
  return found;
}

function pairsTenantColumn(reference: TenantParentReference): boolean {
  const position = reference.parentColumns.indexOf(
    reference.parentTenantColumn,
  );
  return (
    position !== -1 &&
    reference.localColumns[position] === reference.childTenantColumn
  );
}

function describeReference(reference: TenantParentReference): string {
  return `${reference.child}(${reference.localColumns.join(", ")}) -> ${reference.parent}(${reference.parentColumns.join(", ")})`;
}

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
    expect(references).toContainEqual({
      child: "build.tickets",
      parent: "crm_org_party_map",
      name: "fk_tickets_customer_id_org",
      onDelete: "set null",
      childTenantColumn: "org_id",
      parentTenantColumn: "organization_id",
      localColumns: ["org_id", "customer_id"],
      parentColumns: ["organization_id", "crm_organization_id"],
    });
  });

  it("pairs org_id with the parent tenant key on every build child reference to a tenant-scoped parent", () => {
    const unpaired = tenantParentReferences()
      .filter((reference) => !pairsTenantColumn(reference))
      .map(describeReference)
      .sort();

    expect(unpaired).toEqual([]);
  });
});
