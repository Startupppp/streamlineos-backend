export interface TablePlanEntry {
  readonly schema: string;
  readonly table: string;
  readonly tenantColumn: string;
  readonly isPartitioned: boolean;
}

export interface ObjectStoragePlanEntry {
  readonly prefix: string;
  readonly description: string;
}

export interface SearchIndexPlanEntry {
  readonly indexName: string;
  readonly description: string;
}

export interface VectorIndexPlanEntry {
  readonly schema: string;
  readonly table: string;
  readonly indexName: string;
  readonly description: string;
}

export interface RelocationPlan {
  readonly tables: readonly TablePlanEntry[];
  readonly objectStoragePrefixes: readonly ObjectStoragePlanEntry[];
  readonly searchIndexes: readonly SearchIndexPlanEntry[];
  readonly vectorIndexes: readonly VectorIndexPlanEntry[];
}

export interface PlanCoverageReport {
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
  readonly coverageRatio: number;
}

export interface CatalogTenantTable {
  readonly schema: string;
  readonly table: string;
  readonly tenantColumn: string;
  readonly isPartitioned: boolean;
}

export const NON_RELOCATABLE_TABLES: ReadonlySet<string> = new Set([
  "public.organization_placement",
  "public.organization_relocations",
  "public.organization_relocation_checksums",
  "public.placement_decisions",
  "public.organization_lifecycle_sagas",
  "public.organization_saga_steps",
  "public.organization_reservations",
  "public.noisy_neighbour_reviews",
  "public.cell_capacity_measurements",
]);

export function qualifiedName(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export function buildTablePlan(
  catalogTables: readonly CatalogTenantTable[],
): readonly TablePlanEntry[] {
  return catalogTables
    .filter(
      (t) => !NON_RELOCATABLE_TABLES.has(qualifiedName(t.schema, t.table)),
    )
    .map((t) => ({
      schema: t.schema,
      table: t.table,
      tenantColumn: t.tenantColumn,
      isPartitioned: t.isPartitioned,
    }))
    .sort((a, b) =>
      qualifiedName(a.schema, a.table).localeCompare(
        qualifiedName(b.schema, b.table),
      ),
    );
}

export function buildRelocationPlan(
  catalogTables: readonly CatalogTenantTable[],
): RelocationPlan {
  return {
    tables: buildTablePlan(catalogTables),
    objectStoragePrefixes: OBJECT_STORAGE_SCOPES,
    searchIndexes: SEARCH_INDEX_SCOPES,
    vectorIndexes: VECTOR_INDEX_SCOPES,
  };
}

export function planCoverage(
  allTenantTables: readonly string[],
  plan: RelocationPlan,
): PlanCoverageReport {
  const planned = new Set(
    plan.tables.map((e) => qualifiedName(e.schema, e.table)),
  );
  const relevant = allTenantTables.filter(
    (t) => !NON_RELOCATABLE_TABLES.has(normalize(t)),
  );
  const covered = relevant.filter((t) => planned.has(normalize(t)));
  const uncovered = relevant.filter((t) => !planned.has(normalize(t)));
  const coverageRatio =
    relevant.length === 0 ? 1 : covered.length / relevant.length;
  return { covered, uncovered, coverageRatio };
}

function normalize(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

export const OBJECT_STORAGE_SCOPES: readonly ObjectStoragePlanEntry[] = [
  { prefix: "org/{orgId}/", description: "All org-scoped objects" },
  {
    prefix: "org/{orgId}/documents/",
    description: "Uploaded documents and attachments",
  },
  { prefix: "org/{orgId}/avatars/", description: "Profile and org avatars" },
  { prefix: "org/{orgId}/exports/", description: "Data exports" },
];

export const SEARCH_INDEX_SCOPES: readonly SearchIndexPlanEntry[] = [
  {
    indexName: "tickets-{orgId}",
    description: "Full-text ticket search index",
  },
  { indexName: "kb-{orgId}", description: "KB page full-text index" },
  { indexName: "people-{orgId}", description: "People directory search index" },
  { indexName: "contacts-{orgId}", description: "CRM contact search index" },
];

export const VECTOR_INDEX_SCOPES: readonly VectorIndexPlanEntry[] = [
  {
    schema: "public",
    table: "kb_page_chunks",
    indexName: "idx_kb_page_chunks_embedding",
    description: "HNSW embedding index for KB semantic search",
  },
];
