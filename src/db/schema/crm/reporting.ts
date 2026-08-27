import { randomUUID } from "node:crypto";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
/**
 * `import type`, and it has to stay that way.
 *
 * This is the only place the schema layer reaches up into a module, and it is
 * tolerable solely because a type-only import is erased before it exists at run
 * time — so no cycle is created between `db/schema` and `modules/reporting`,
 * which imports the schema back. Making this a value import would close that
 * loop, and Drizzle's schema barrel is imported early enough that the resulting
 * partially-initialised module would surface as a table being `undefined` at
 * query time rather than as an obvious import error.
 *
 * The alternative — typing the column `unknown` — was rejected because then a
 * writer could store JSON the compiler cannot read, and nothing would say so
 * until somebody ran the report.
 */
import type { QueryDescription } from "../../../modules/reporting/compiler/query-description";

/**
 * Saved report definitions, and a record of every statement compiled from one.
 *
 * ## Why the description is stored, and not the SQL
 *
 * `query_description` holds the structured description, which is data a tenant
 * assembled from an enumeration — not a query. That is the whole point: a saved
 * report is inert JSON until the compiler turns it into parameterised SQL at run
 * time, so a row in this table cannot be an attack even if somebody wrote
 * straight to it. Storing generated SQL instead would make this table an
 * execution surface, and a `UPDATE crm_report_definitions SET sql = ...` a
 * remote code path.
 *
 * The consequence to keep in mind is that a stored description is *older* than
 * the compiler that will run it. A description written against last quarter's
 * registry may name a field that has since been withdrawn, and it must fail
 * loudly then rather than compile to something adjacent. That is why
 * `compileQuery` re-validates every name on every run instead of trusting that
 * the description was valid when it was saved.
 *
 * ## Why the run log holds the compiled statement
 *
 * `compiled_sql` is the audit trail — what was actually executed, not what
 * somebody meant. It can be stored in the clear precisely because of the
 * compiler's central invariant: a compiled statement contains no literals, only
 * `$n` placeholders. So this column holds the *shape* of the question and none
 * of its content — no filter values, no customer names, no thresholds. An
 * auditor can read the whole table and learn what was asked without learning
 * anything about the data. Storing the parameters beside it would undo that in a
 * single column, which is why only the count is kept.
 */

/**
 * A question somebody named and kept.
 *
 * `source_key` duplicates what is inside `query_description`, deliberately.
 * "Which saved reports read parties?" is a question asked when a permission is
 * withdrawn or a table is retired, and answering it by parsing every jsonb blob
 * makes it a scan with a JSON parse per row instead of an index lookup. The
 * denormalisation is safe because the service writes both from the same
 * compiled result — there is no path that sets one without the other.
 */
export const crmReportDefinitions = pgTable(
  "crm_report_definitions",
  {
    reportDefinitionId: text("report_definition_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** The registry source this reads. Denormalised from the description above. */
    sourceKey: text("source_key").notNull(),
    /**
     * Typed as the compiler's own input rather than `unknown`, so a writer that
     * stores something the compiler cannot read is a type error. It is still
     * re-validated on the way out — see the file docblock.
     */
    queryDescription: jsonb("query_description").$type<QueryDescription>().notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * One report per name per tenant. Two reports called "Q3 pipeline" that
     * return different numbers is how a disagreement in a meeting becomes
     * unresolvable, and the upsert path targets exactly this pair.
     */
    uniqueIndex("uniq_crm_report_definitions_org_name").on(table.organizationId, table.name),
    /** The list screen: this tenant's reports, most recently touched first. */
    index("idx_crm_report_definitions_org").on(table.organizationId, table.updatedAt),
    /** "What still reads this source", when a source is withdrawn. */
    index("idx_crm_report_definitions_org_source").on(table.organizationId, table.sourceKey),
  ],
);

/**
 * Every compilation that was executed.
 *
 * Written on the run path, not the compile path — a dry run tells a caller what
 * their description would produce and touches no data, so logging it would fill
 * the audit trail with rehearsals and make the real runs harder to find.
 *
 * `report_definition_id` is nullable because an ad-hoc run has no definition
 * behind it, and those are the runs an auditor most wants to see: a saved report
 * was reviewed by whoever saved it, an ad-hoc query was not.
 */
export const crmReportRuns = pgTable(
  "crm_report_runs",
  {
    reportRunId: text("report_run_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** Null for an ad-hoc run. Not a foreign key — see the migration for why. */
    reportDefinitionId: text("report_definition_id"),
    sourceKey: text("source_key").notNull(),
    /** Contains no literals, only placeholders. Safe to read; see the file docblock. */
    compiledSql: text("compiled_sql").notNull(),
    /** How many values were bound. The values themselves are deliberately absent. */
    parameterCount: integer("parameter_count").notNull(),
    rowCount: integer("row_count"),
    durationMs: integer("duration_ms"),
    ranByUserId: text("ran_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    /** The audit read: this tenant's runs, newest first. */
    index("idx_crm_report_runs_org_created").on(table.organizationId, table.createdAt),
    /** "How often is this report run, and by whom." */
    index("idx_crm_report_runs_org_definition").on(
      table.organizationId,
      table.reportDefinitionId,
    ),
  ],
);

export type CrmReportDefinition = typeof crmReportDefinitions.$inferSelect;
export type CrmReportRun = typeof crmReportRuns.$inferSelect;
