/**
 * The verdict rules for the PRD-C057 inventory.
 *
 * Every verdict is derived from a measurement, never asserted. KEEP means a
 * measured reach or a structural guarantee; REFACTOR means reached but carrying
 * a named defect class; REMOVE means a measured zero reach across the whole
 * corpus. Each rule names the concrete failure it prevents, because "unused" on
 * its own is a deletion instruction and this repo has already been bitten by one.
 */

const AREA_BY_PREFIX = [
  ["hr_", "hr"],
  ["payroll_", "payroll"],
  ["inv_", "inventory"],
  ["crm_", "crm"],
  ["gl_", "accounting"],
  ["acct_", "accounting"],
  ["fin_", "accounting"],
  ["ap_", "accounting"],
  ["ar_", "accounting"],
  ["kb_", "knowledge"],
  ["chat_", "chat"],
  ["mail_", "mail"],
  ["notifications", "notifications"],
  ["notification_", "notifications"],
  ["support_", "support"],
  ["sign_", "e-sign"],
  ["billing_", "billing"],
  ["subscription", "billing"],
  ["cell_", "platform-cells"],
  ["audit_", "platform-audit"],
  ["survey", "surveys"],
  ["calendar_", "calendar"],
  ["event_", "calendar"],
  ["blog_", "blog"],
  ["portal_", "portal"],
  ["organization", "org-identity"],
  ["user", "org-identity"],
  ["account", "org-identity"],
  ["session", "org-identity"],
  ["permission", "rbac"],
  ["role", "rbac"],
  ["module", "module-access"],
  ["feature_flag", "settings"],
  ["api_key", "settings"],
  ["workflow", "workflow"],
  ["project", "build"],
  ["ticket", "build"],
  ["sprint", "build"],
  ["bug", "build"],
];

export function areaOfTable(schema, table) {
  if (schema === "build" || schema === "build_events") return "build";
  for (const [prefix, area] of AREA_BY_PREFIX) if (table.startsWith(prefix)) return area;
  return "platform-core";
}

export function areaOfKey(key) {
  const head = key.split(/[:.]/)[0] ?? "";
  if (head === "") return "platform-core";
  return head;
}

const STRUCTURAL_NAMES = new Set([
  "id",
  "org_id",
  "organization_id",
  "created_at",
  "updated_at",
  "deleted_at",
  "archived_at",
  "created_by",
  "updated_by",
  "deleted_by",
  "tenant_id",
  "version",
]);

const MONEY_WORDS = ["amount", "cost", "price", "rate", "total", "balance", "fee", "salary", "wage", "credit", "debit"];
const FLOAT_TYPES = new Set(["double precision", "real"]);

export function classifyColumn(column, facts) {
  const { isKeyColumn, constraintNames, reachedAt } = facts;
  const area = areaOfTable(column.schema, column.tbl);
  const base = {
    registry: "database.column",
    item: `${column.schema}.${column.tbl}.${column.col}`,
    owner: area,
  };
  const structural = isKeyColumn || STRUCTURAL_NAMES.has(column.col);
  if (!structural && reachedAt === null)
    return {
      ...base,
      verdict: "REMOVE",
      failurePrevented:
        "Zero reads and zero writes across backend source, frontend source and openapi.json. A column nothing touches advertises a feature that does not exist — feature_flags.rollout_percentage rolls a 10% flag out to 100% because nothing reads it. REMOVE is a candidate, not an instruction: PRD-C058 requires the ts-morph row-type pass before any drop, because a token census cannot see a column reached only through select *.",
      evidence: "token census: 0 sightings outside src/db/schema and migrations",
    };
  if (column.data_type === "timestamp without time zone")
    return {
      ...base,
      verdict: "REFACTOR",
      failurePrevented: `A naive timestamp is written and read in whatever zone the reader assumes, so the same instant is a different wall clock in another region — it silently backdates period locks, token expiries and audit order.${structural ? " Structural, so this is a type migration to timestamptz, never a drop." : ""}`,
      evidence: reachedAt ?? `pg_catalog: ${column.schema}.${column.tbl}.${column.col}`,
    };
  if (FLOAT_TYPES.has(column.data_type) && MONEY_WORDS.some((word) => column.col.includes(word)))
    return {
      ...base,
      verdict: "REFACTOR",
      failurePrevented:
        "Binary floating point cannot represent a cent. Money in double precision drifts under summation and reconciles to a different total than the ledger.",
      evidence: reachedAt ?? `pg_catalog: ${column.schema}.${column.tbl}.${column.col}`,
    };
  if (isKeyColumn)
    return {
      ...base,
      verdict: "KEEP",
      failurePrevented: `Dropping it breaks ${constraintNames.join(", ")} — the constraint stops being enforceable and every 23505/23503 handler naming it becomes unreachable code that looks like it handles a duplicate.`,
      evidence: `pg_catalog: ${constraintNames.join(", ")}`,
    };
  if (STRUCTURAL_NAMES.has(column.col))
    return {
      ...base,
      verdict: "KEEP",
      failurePrevented:
        column.col === "org_id" || column.col === "organization_id"
          ? "Dropping the tenant column removes the only thing that scopes this table to one organisation."
          : "Dropping it removes the identity, lifecycle or audit anchor every read predicate and retention job depends on.",
      evidence: `pg_catalog: ${column.schema}.${column.tbl}.${column.col}`,
    };
  return {
    ...base,
    verdict: "KEEP",
    failurePrevented: "Reached by live code; removing it breaks the reader at the cited site.",
    evidence: reachedAt,
  };
}

export function classifyForeignKey(foreignKey, covered) {
  const area = areaOfTable(foreignKey.schema, foreignKey.tbl);
  const base = { registry: "database.foreign-key", item: `${foreignKey.schema}.${foreignKey.tbl}.${foreignKey.name}`, owner: area };
  if (covered)
    return {
      ...base,
      verdict: "KEEP",
      failurePrevented: "Referential integrity, with the child columns covered by a leading-column index so a parent delete does not seq-scan the child.",
      evidence: `pg_catalog: ${foreignKey.definition}`,
    };
  return {
    ...base,
    verdict: "REFACTOR",
    failurePrevented:
      "The child columns lead no index, so every delete or key update on the parent takes a full scan of this table while holding a row lock. Measured at head on inv_stock_transactions (166,800 rows): Seq Scan, Buffers shared read=3404, 71.760 ms for one FOR KEY SHARE probe.",
    evidence: `pg_catalog: ${foreignKey.definition}`,
  };
}

export function classifyUnique(unique, tenantColumns) {
  const area = areaOfTable(unique.schema, unique.tbl);
  const columns = unique.cols === "" ? [] : unique.cols.split(",");
  const base = { registry: "database.unique", item: `${unique.schema}.${unique.tbl}.${unique.name}`, owner: area };
  if (unique.table_is_tenant_owned && !columns.some((column) => tenantColumns.has(column)))
    return {
      ...base,
      verdict: "REFACTOR",
      failurePrevented:
        "A deployment-global unique on a tenant-owned table lets one organisation's value block another organisation from ever using it, and leaks the existence of the first tenant's row through a 409.",
      evidence: `pg_catalog: ${unique.definition}`,
    };
  return {
    ...base,
    verdict: "KEEP",
    failurePrevented: "Uniqueness the application relies on; several 23505 handlers name it and become unreachable without it.",
    evidence: `pg_catalog: ${unique.definition}`,
  };
}

export function classifyIndex(index, { declared, overlapReason }) {
  const area = areaOfTable(index.schema, index.tbl);
  const base = { registry: "database.index", item: `${index.schema}.${index.tbl}.${index.name}`, owner: area };
  if (!declared && !index.backs_constraint && !index.is_primary)
    return {
      ...base,
      verdict: "REFACTOR",
      failurePrevented:
        "The index exists in the catalog and nothing in src/db/schema declares it. Nothing regenerates it after a rebuild, and check:declaration-constraint-drift can only report it as live-but-undeclared.",
      evidence: `pg_catalog: ${index.definition}`,
    };
  return {
    ...base,
    verdict: "KEEP",
    failurePrevented:
      overlapReason === null
        ? "A declared access path with no overlapping sibling; removing it turns its predicate into a scan."
        : `Overlaps a wider sibling and is kept anyway: ${overlapReason.replace(/-/g, " ")}. Statistics never justify the deletion — migration 0999 dropped 337 narrow indexes on the coverage argument and seven were measured regressions under tenant skew.`,
    evidence: `pg_catalog: ${index.definition}`,
  };
}
