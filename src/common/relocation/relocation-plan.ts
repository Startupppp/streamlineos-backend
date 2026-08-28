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

export function planCoverage(
  allTenantTables: readonly string[],
  plan: RelocationPlan = DEFAULT_RELOCATION_PLAN,
): PlanCoverageReport {
  const planned = new Set(
    plan.tables.map((e) => `${e.schema}.${e.table}`),
  );
  const covered = allTenantTables.filter((t) => planned.has(normalizeTableName(t)));
  const uncovered = allTenantTables.filter((t) => !planned.has(normalizeTableName(t)));
  const coverageRatio =
    allTenantTables.length === 0 ? 1 : covered.length / allTenantTables.length;
  return { covered, uncovered, coverageRatio };
}

function normalizeTableName(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

export const DEFAULT_RELOCATION_PLAN: RelocationPlan = {
  tables: [
    { schema: "public", table: "organizations", tenantColumn: "id", isPartitioned: false },
    { schema: "public", table: "organization_members", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "organization_people", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "workers", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "organization_placement", tenantColumn: "organization_id", isPartitioned: false },
    { schema: "public", table: "outbox_events", tenantColumn: "organization_id", isPartitioned: false },
    { schema: "public", table: "inbox_records", tenantColumn: "organization_id", isPartitioned: false },
    { schema: "public", table: "external_effect_ledger", tenantColumn: "organization_id", isPartitioned: false },
    { schema: "public", table: "notifications", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "user_permission_grants", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "role_assignments", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "role_permission_grants", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "module_ownerships", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "user_delegations", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "subscriptions", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "ai_usage_logs", tenantColumn: "org_id", isPartitioned: true },
    { schema: "public", table: "chat_messages", tenantColumn: "org_id", isPartitioned: true },
    { schema: "build", table: "projects", tenantColumn: "org_id", isPartitioned: false },
    { schema: "build", table: "tickets", tenantColumn: "org_id", isPartitioned: false },
    { schema: "build", table: "ticket_assignees", tenantColumn: "org_id", isPartitioned: false },
    { schema: "build", table: "sprints", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "kb_spaces", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "kb_pages", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "kb_page_chunks", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "hr_people", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "hr_employments", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "payroll_runs", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "leave_policies", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "leave_requests", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "attendance_records", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "timesheet_entries", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "expense_claims", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "inventory_items", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "crm_contacts", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "crm_deals", tenantColumn: "org_id", isPartitioned: false },
    { schema: "public", table: "support_tickets", tenantColumn: "org_id", isPartitioned: false },
  ],
  objectStoragePrefixes: [
    { prefix: "org/{orgId}/", description: "All org-scoped objects" },
    { prefix: "org/{orgId}/documents/", description: "Uploaded documents and attachments" },
    { prefix: "org/{orgId}/avatars/", description: "Profile and org avatars" },
    { prefix: "org/{orgId}/exports/", description: "Data exports" },
  ],
  searchIndexes: [
    { indexName: "tickets-{orgId}", description: "Full-text ticket search index" },
    { indexName: "kb-{orgId}", description: "KB page full-text index" },
    { indexName: "people-{orgId}", description: "People directory search index" },
    { indexName: "contacts-{orgId}", description: "CRM contact search index" },
  ],
  vectorIndexes: [
    {
      schema: "public",
      table: "kb_page_chunks",
      indexName: "idx_kb_page_chunks_embedding",
      description: "HNSW embedding index for KB semantic search",
    },
  ],
};
