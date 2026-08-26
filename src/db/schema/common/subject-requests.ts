import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * What was done for a data subject, per region, and when.
 *
 * A right that cannot be evidenced was not exercised. This is the record a
 * regulator reads: which regions were visited, what each one did, when, and
 * whether the whole request may be reported as complete.
 *
 * **Not tenant-scoped.** A data subject may exist in several organisations and
 * has one right across all of them; filing the record under one tenant would
 * make the others invisible to the person exercising it.
 *
 * Deliberately outside the soft-delete default: erasure is one of the enumerated
 * exceptions, and a soft-deleted erasure record would be a contradiction.
 */
export const subjectRequests = pgTable(
  "subject_requests",
  {
    subjectRequestId: text("subject_request_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** `erasure` or `export`. Same enumeration; different terminal action. */
    kind: text("kind").notNull(),

    /** Canonicalised once, at the boundary, so one person is not two requests. */
    subjectEmail: text("subject_email").notNull(),

    /**
     * One row per region, exactly as reported.
     *
     * Stored verbatim rather than summarised: the summary is derivable from the
     * outcomes and the outcomes are not derivable from the summary, and it is
     * the per-region detail a regulator asks for.
     */
    regionOutcomes: jsonb("region_outcomes").$type<
      { region: string; status: string; recordsAffected: number; at: string; error?: string }[]
    >(),

    /** True only when every *configured* region was visited and succeeded. */
    isComplete: text("is_complete").notNull(),

    totalRecordsAffected: integer("total_records_affected").default(0).notNull(),

    /**
     * When the last backup copy expires.
     *
     * Backups are covered by policy and schedule rather than deletion. Stating
     * the date lets the subject be told something true instead of given a
     * promise nobody can keep.
     */
    backupsExpireBy: text("backups_expire_by"),

    /** The statutory window this request is being tracked against. */
    dueBy: timestamp("due_by"),

    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_subject_requests_email").on(table.subjectEmail, table.requestedAt),
    // The overdue query: anything not yet complete, oldest first.
    index("idx_subject_requests_due").on(table.dueBy),
  ],
);
