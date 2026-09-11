import type { FieldType } from "./query-description";

/**
 * What may be queried, and under what authority.
 *
 * A bind parameter solves values. It cannot solve identifiers: `SELECT $1 FROM
 * $2` is not a thing Postgres will do, so a table or column name has to reach
 * the statement as text. That makes this file the one place in the module where
 * the injection question is live, and the answer is that **caller input is never
 * an identifier — it is a key looked up in this registry, and the registry's own
 * string is what gets emitted.** A field name a tenant sends is a lookup miss or
 * a hit; it is never a fragment.
 *
 * Two consequences worth being explicit about.
 *
 * The registry is an allow-list of the *product's* reportable surface, not a
 * reflection of the schema. Nothing here is derived from `information_schema` or
 * from the Drizzle table objects, because a registry that auto-populates grows
 * new reportable columns whenever somebody adds one — including
 * `password_hash`-shaped ones — with no review. Every line here is a decision
 * somebody made.
 *
 * And each source carries the permission key that *already* governs its data.
 * Without that, this module would be a permission bypass with a query language
 * attached: a user who may not read deals would read every deal by asking for a
 * report of them. Reporting adds a way to ask; it must not add a right to know.
 *
 * The `crm:reporting:run` key gates the ability to run reports at all. The key
 * on the source gates *that* data. Both are required — see
 * `reporting-source-access.ts`.
 */

export interface FieldSpec {
  /** Physical column name. Registry-owned; emitted after `quoteIdent`. */
  readonly column: string;
  readonly type: FieldType;
  /** What this means to a person, for the sources endpoint. */
  readonly label: string;
}

/**
 * A relation reachable from a source, on a join the registry fixes.
 *
 * The `ON` condition is not expressible by a caller — only the *choice* of a
 * declared join is, and only implicitly, by naming a field behind it. A caller
 * that could supply a join condition could supply `ON true`, which is a
 * cross join and a way to make the database spend the afternoon.
 */
export interface JoinSpec {
  /** Table alias in the emitted statement. Registry-owned, unique within a source. */
  readonly alias: string;
  readonly table: string;
  /** The joined table's tenant column. The join carries its own org predicate. */
  readonly organizationColumn: string;
  /** Column on the base source. */
  readonly localColumn: string;
  /** Column on the joined table. */
  readonly foreignColumn: string;
  readonly softDeleteColumn?: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

/**
 * How a source says who owns a row.
 *
 * A union with a mandatory `reason` on the negative arm, rather than an optional
 * column. A missing optional reads as "not filled in yet" and still compiles;
 * this makes a new source's author state which it is, beside the table name,
 * where a reviewer sees the answer. The failure it prevents is a source that
 * ships with no ownership column and therefore reports org-wide to a caller
 * narrowed to `own` — silently, because a report that returns too much looks
 * exactly like a report.
 *
 * Ownership is declared on the *source*, not on its joins. The scope narrows
 * which rows the report is about; a relation is reached only through a row
 * already in scope, so a deal I own may name a party I do not. Narrowing the
 * join as well would blank the party column on my own deals, which is a
 * different — and wrong — answer to a question nobody asked.
 */
export type OwnershipSpec =
  /** The column carrying the owning user id. Registry-owned; emitted via `quoteIdent`. */
  | { readonly kind: "column"; readonly column: string }
  /**
   * This source has no ownership relation at all. A narrowed requester sees
   * nothing from it — see `compileScopePredicate` in `scope.ts`, which fails
   * closed rather than widening to org-wide because the narrowing could not be
   * expressed.
   */
  | { readonly kind: "unowned"; readonly reason: string };

export interface SourceSpec {
  readonly table: string;
  readonly organizationColumn: string;
  /**
   * Who owns a row here, for the requester's `DataScope`.
   *
   * Required, so adding a source is a decision about scope rather than an
   * omission of one. The column named must be a physical column on `table` and
   * must hold a user id — it is compared against the requester's own id.
   */
  readonly ownership: OwnershipSpec;
  /**
   * Set where the table is soft-deleted. Omitting it on a table that *is* soft
   * deleted would silently report deleted rows, which on a customer list is a
   * privacy incident rather than a bug.
   */
  readonly softDeleteColumn?: string;
  /** The permission that already governs reading this data elsewhere in the product. */
  readonly requiredPermission: string;
  readonly label: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly joins?: Readonly<Record<string, JoinSpec>>;
}

/**
 * The base alias every source is given.
 *
 * Fixed rather than derived from the table name, so the emitted statement's
 * alias never varies with caller input in any way at all — not even indirectly
 * through which source was chosen.
 */
export const BASE_ALIAS = "s";

/**
 * Deals.
 *
 * `value_minor` is the money column and it is integer minor units; `value` is a
 * GENERATED decimal kept for fifteen legacy readers and is deliberately absent
 * here, so a report can never sum the derived float-shaped column when the exact
 * one is right there. `SUM` over `bigint` returns `numeric`, so a total stays
 * exact however many rows it crosses.
 */
const DEALS: SourceSpec = {
  table: "deals",
  organizationColumn: "org_id",
  softDeleteColumn: "deleted_at",
  /**
   * The same column the rest of the product scopes deals by:
   * `crm/entity/crm-entity.adapter.ts` passes `deals.assignedToId` to
   * `applyScope`. Agreeing with it is the requirement — a rep whose deals list
   * shows twelve rows must not be able to report over four hundred, and the only
   * way that holds is if both surfaces read ownership from the same column.
   *
   * `crm:deals:read` is `scopable: true` in the catalogue, so this is the one
   * source of the three where a narrowed grant actually arrives here.
   */
  ownership: { kind: "column", column: "assigned_to_id" },
  requiredPermission: "crm:deals:read",
  label: "Deals",
  fields: {
    name: { column: "name", type: "text", label: "Deal name" },
    stage: { column: "stage", type: "text", label: "Stage" },
    forecast_category: {
      column: "forecast_category",
      type: "text",
      label: "Forecast category",
    },
    value_minor: { column: "value_minor", type: "number", label: "Value (minor units)" },
    probability: { column: "probability", type: "number", label: "Probability" },
    health_score: { column: "health_score", type: "number", label: "Health score" },
    assigned_to_id: { column: "assigned_to_id", type: "text", label: "Owner" },
    pipeline_id: { column: "pipeline_id", type: "text", label: "Pipeline" },
    lost_reason: { column: "lost_reason", type: "text", label: "Lost reason" },
    expected_close_date: {
      column: "expected_close_date",
      type: "date",
      label: "Expected close date",
    },
    actual_close_date: {
      column: "actual_close_date",
      type: "date",
      label: "Actual close date",
    },
    created_at: { column: "created_at", type: "timestamp", label: "Created" },
    updated_at: { column: "updated_at", type: "timestamp", label: "Updated" },
  },
  joins: {
    /**
     * The party a deal is with.
     *
     * Reachable from deals because "revenue by industry" is the question this
     * module exists for and industry lives on the party, not the deal. It is a
     * `LEFT` join: `deals.party_id` is nullable while the CRM's party migration
     * runs, and an inner join would silently drop every unmigrated deal from
     * the totals — a report that is wrong rather than one that is empty.
     */
    party: {
      alias: "j0",
      table: "business_parties",
      organizationColumn: "organization_id",
      localColumn: "party_id",
      foreignColumn: "party_id",
      softDeleteColumn: "deleted_at",
      fields: {
        name: { column: "name", type: "text", label: "Party name" },
        industry: { column: "industry", type: "text", label: "Industry" },
        city: { column: "city", type: "text", label: "City" },
        state: { column: "state", type: "text", label: "State" },
        status: { column: "status", type: "text", label: "Party status" },
        lifecycle_stage: {
          column: "lifecycle_stage",
          type: "text",
          label: "Lifecycle stage",
        },
        owner_user_id: { column: "owner_user_id", type: "text", label: "Party owner" },
      },
    },
  },
};

/**
 * The unified activity timeline.
 *
 * Its tenant column is `organization_id` where `deals` uses `org_id`. That
 * inconsistency is exactly why the org predicate is emitted per source from a
 * declared column rather than from a constant everyone assumes. Hardcoding
 * `org_id` here would produce a statement Postgres rejects — noisy, survivable.
 * Getting a *fallback* wrong would produce one it accepts, against the wrong
 * column, and that is a cross-tenant read. There is no fallback.
 */
const ACTIVITIES: SourceSpec = {
  table: "activities",
  organizationColumn: "organization_id",
  softDeleteColumn: "deleted_at",
  /**
   * Assignment, not authorship — the same relation `crm/inbox/crm-inbox.service.ts`
   * scopes a task by (`ownerColumn: tasks.assigneeId`).
   *
   * An activity has two candidate owners: whoever it is assigned to, and
   * whoever logged it (`actor_user_id`). One column has to win, because
   * `applyScope` compares one column and a second definition of "mine" that
   * disagreed with the inbox would be worse than a narrow one. The cost is
   * stated rather than hidden: at `own` scope a call I logged against nobody
   * would not be mine, and most emails and calls carry no assignee at all.
   *
   * That cost is currently theoretical. `crm:activities:view` is not `scopable`
   * in the catalogue, so `resolveReportingScope` resolves this source at `all`
   * and this column is not consulted — see `REPORTING_SCOPE_GAP`. It is declared
   * anyway so that making the key scopable is a one-line catalogue change rather
   * than a scramble to decide what an activity's owner is.
   */
  ownership: { kind: "column", column: "assignee_user_id" },
  requiredPermission: "crm:activities:view",
  label: "Activities",
  fields: {
    kind: { column: "kind", type: "text", label: "Kind" },
    subject: { column: "subject", type: "text", label: "Subject" },
    source: { column: "source", type: "text", label: "Source" },
    actor_kind: { column: "actor_kind", type: "text", label: "Actor kind" },
    actor_user_id: { column: "actor_user_id", type: "text", label: "Actor" },
    assignee_user_id: { column: "assignee_user_id", type: "text", label: "Assignee" },
    party_id: { column: "party_id", type: "text", label: "Party" },
    deal_id: { column: "deal_id", type: "text", label: "Deal" },
    occurred_at: { column: "occurred_at", type: "timestamp", label: "Occurred" },
    due_at: { column: "due_at", type: "timestamp", label: "Due" },
    completed_at: { column: "completed_at", type: "timestamp", label: "Completed" },
    created_at: { column: "created_at", type: "timestamp", label: "Created" },
  },
};

/**
 * Parties, as a source in their own right.
 *
 * Under `party:parties:view` rather than a CRM key, because that is the key that
 * governs the same rows on every other surface. `notes`, `tax_number` and the
 * contact channels are absent: a reporting surface that can group by them is a
 * bulk export of contact data, and this module is for counting and totalling,
 * not for extracting. Somebody who needs the export should be denied or granted
 * an export, visibly, rather than reaching it sideways through a report.
 */
const PARTIES: SourceSpec = {
  table: "business_parties",
  organizationColumn: "organization_id",
  softDeleteColumn: "deleted_at",
  /**
   * `businessParties.ownerUserId`, which is what `clients/client-party-reader.ts`
   * and `leads/lead-party-reader.ts` both hand to `applyScope`.
   *
   * Like activities, this is declared and currently unreached:
   * `party:parties:view` is not `scopable`, so the scope resolves to `all` here.
   * The two party readers narrow under their own keys (`crm:clients:read`,
   * which is scopable) rather than under this one, and reporting must not invent
   * a narrowing the key it checks does not carry.
   */
  ownership: { kind: "column", column: "owner_user_id" },
  requiredPermission: "party:parties:view",
  label: "Parties",
  fields: {
    name: { column: "name", type: "text", label: "Name" },
    /** A real Postgres enum (`party_type`), not a text column. See `FIELD_TYPES`. */
    party_type: { column: "party_type", type: "enum", label: "Type" },
    status: { column: "status", type: "text", label: "Status" },
    industry: { column: "industry", type: "text", label: "Industry" },
    city: { column: "city", type: "text", label: "City" },
    state: { column: "state", type: "text", label: "State" },
    lifecycle_stage: { column: "lifecycle_stage", type: "text", label: "Lifecycle stage" },
    owner_user_id: { column: "owner_user_id", type: "text", label: "Owner" },
    created_at: { column: "created_at", type: "timestamp", label: "Created" },
    updated_at: { column: "updated_at", type: "timestamp", label: "Updated" },
  },
};

/**
 * The registry, as a `Map`.
 *
 * A `Map` rather than the plain object, and this is not a preference. Looking a
 * caller's string up in an object reaches the prototype: `source: "__proto__"`
 * returns `Object.prototype`, `field: "constructor"` returns a function, and
 * both are truthy — so a naive `if (registry[name])` treats them as found and
 * carries on into the emit path with an object that has no `table`. `Map` has no
 * prototype chain to walk, so those names miss like any other unknown name.
 * `registry.spec.ts` holds that behaviour down.
 */
export type QueryRegistry = ReadonlyMap<string, SourceSpec>;

export const REPORTING_REGISTRY: QueryRegistry = new Map<string, SourceSpec>([
  ["deals", DEALS],
  ["activities", ACTIVITIES],
  ["parties", PARTIES],
]);

/**
 * Field and join maps are looked up the same way, and for the same reason.
 *
 * `Object.entries` reads own enumerable properties only, so the maps these build
 * already exclude the prototype names above; the `Map` is what keeps the
 * *lookup* free of them too. Memoised per spec object because a filter tree
 * resolves a field per node and rebuilding the map each time would make
 * resolution quadratic in the size of a tenant-supplied tree — which is a
 * request-shaped way to spend CPU.
 */
const fieldMaps = new WeakMap<object, ReadonlyMap<string, FieldSpec>>();
const joinMaps = new WeakMap<object, ReadonlyMap<string, JoinSpec>>();

export function fieldsOf(spec: SourceSpec | JoinSpec): ReadonlyMap<string, FieldSpec> {
  const cached = fieldMaps.get(spec);
  if (cached) return cached;
  const built: ReadonlyMap<string, FieldSpec> = new Map(Object.entries(spec.fields));
  fieldMaps.set(spec, built);
  return built;
}

export function joinsOf(spec: SourceSpec): ReadonlyMap<string, JoinSpec> {
  const cached = joinMaps.get(spec);
  if (cached) return cached;
  const built: ReadonlyMap<string, JoinSpec> = new Map(Object.entries(spec.joins ?? {}));
  joinMaps.set(spec, built);
  return built;
}
