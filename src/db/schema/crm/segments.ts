import { randomUUID } from "node:crypto";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
/**
 * `import type`, and it has to stay that way — the same constraint
 * `crm/reporting.ts` records for the same reason.
 *
 * A type-only import is erased before it exists at run time, so no cycle is
 * created between `db/schema` and `modules/reporting`, which imports the schema
 * back. Making this a value import would close that loop, and Drizzle's schema
 * barrel is imported early enough that the resulting partially-initialised
 * module surfaces as a table being `undefined` at query time rather than as an
 * obvious import error.
 */
import type { FilterNode } from "../../../modules/reporting/compiler/query-description";

/**
 * A named set of CRM parties, defined by criteria rather than by membership.
 *
 * ## Why there is no membership table
 *
 * The obvious shape for a segment is a header row and a child row per member,
 * refreshed by a sweep. That shape is wrong here and the reason is worth
 * stating, because it is the decision the whole module rests on: a materialised
 * membership is a *copy* of an answer, and a copy is stale from the instant the
 * next party is created, edited, reassigned or soft-deleted. A user who moves a
 * customer from `PROSPECT` to `CUSTOMER` and then opens "Prospects in Textiles"
 * and still sees them there has been told something false by a screen whose
 * whole job is to be true. Worse, the falsehood is silent and unbounded — it
 * lasts until whatever sweep nobody has looked at runs again.
 *
 * So a segment stores its *criteria* and is evaluated on every read. The cost is
 * a query per read; the thing bought is that the answer cannot be stale, and
 * that there is no sweep, no refresh cadence, no `last_evaluated_at` for
 * somebody to misread as "current", and no second copy of the tenant's customer
 * list to keep tenant-isolated.
 *
 * ## Why the criteria are a filter tree and not a query
 *
 * `criteria` is a `FilterNode` — the reporting compiler's own filter vocabulary
 * — and deliberately *not* a `QueryDescription`. A `QueryDescription` also
 * carries projections, grouping, ordering and a limit, and a segment that could
 * express those would be a saved report wearing a different noun: two features
 * with two screens, two permission ladders and one query engine, drifting.
 *
 * Storing only the filter makes the difference structural rather than a
 * convention. A segment answers exactly one question — *which rows* — and the
 * shape of the answer (which columns, in what order, how many) belongs to
 * whoever is reading, not to the saved object. `segment-query.ts` is where the
 * stored filter is wrapped in the projection the read needs, and it is the only
 * place that decides one.
 *
 * ## Why the criteria are safe to store as jsonb
 *
 * The same argument `crm_report_definitions` makes. A filter tree is data a
 * tenant assembled from an enumeration — named fields, enumerated operators,
 * bound values — and it is inert until `compileQuery` turns it into
 * parameterised SQL at read time. A row here cannot be an attack even if
 * somebody wrote straight to it, because nothing in it ever reaches a statement
 * as text: field names are looked up in the registry and the registry's own
 * string is emitted, and values only ever cross the wire as bind parameters.
 *
 * The consequence to hold onto is that a stored filter is *older* than the
 * compiler that will run it, so a criterion naming a field that has since been
 * withdrawn from the registry must fail loudly rather than compile to something
 * adjacent. `compileQuery` re-validates every name on every evaluation, which is
 * what makes that true.
 */
export const crmSegments = pgTable(
  "crm_segments",
  {
    segmentId: text("segment_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The reporting registry source this segments over.
     *
     * Stored rather than assumed, even though only one source is segmentable
     * today: a column that is always `'parties'` is a column, but a module that
     * *cannot say* which source a segment reads has to be rewritten the day the
     * second one arrives, and the row it has to rewrite is the tenant's data.
     * It is also what answers "which segments read parties" when the party
     * permission is withdrawn, without parsing every criteria blob.
     */
    sourceKey: text("source_key").notNull(),
    /**
     * Typed as the compiler's own filter node rather than `unknown`, so a writer
     * that stores something the compiler cannot read is a type error here. It is
     * still re-validated on the way out — see the file docblock.
     */
    criteria: jsonb("criteria").$type<FilterNode>().notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * One segment per name per tenant.
     *
     * A segment's name is how it is referred to in a campaign brief, a standup
     * and a mail merge, so two segments called "Lapsed enterprise" that return
     * different sets is how a disagreement in a meeting becomes unresolvable.
     * Composite on `organization_id` and not a bare unique, or one tenant's
     * "Customers" would block the name for every other organisation.
     */
    uniqueIndex("uniq_crm_segments_org_name").on(table.organizationId, table.name),
    /** The list screen: this tenant's segments, most recently touched first. */
    index("idx_crm_segments_org_updated").on(table.organizationId, table.updatedAt),
    /** "What still reads this source", asked when a source is withdrawn. */
    index("idx_crm_segments_org_source").on(table.organizationId, table.sourceKey),
  ],
);

export type CrmSegment = typeof crmSegments.$inferSelect;
