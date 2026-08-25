import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * Where a direct connector's read of somebody else's CRM has got to.
 *
 * Two columns carry the whole resumption story and they answer different
 * questions, which is why neither can do the other's job.
 *
 * `cursor` is **where this walk is**. It is the provider's own next-page request
 * — a Salesforce `nextRecordsUrl`, a HubSpot `after`, a Zoho `page_token`, a
 * Pipedrive `next_start` — written in the same transaction that stages the page
 * it came after. A run that dies mid-walk resumes from it instead of starting
 * the collection again, which is what makes a large migration finishable at all.
 *
 * `syncedThrough` is **what has definitely been read**, and it moves only when a
 * walk reaches the end of the collection. That is the watermark lesson from the
 * mailbox sweep, applied to a case where the lesson is harder: mail arrives in a
 * known order, so "everything up to this instant" is a meaningful claim about a
 * partial read. A CRM collection has no order this repository can rely on — two
 * of the four providers give no ordering guarantee on their list endpoints at
 * all — so a partial walk supports **no** claim about a time range. Advancing
 * the watermark to the newest record seen halfway through a walk would silently
 * exclude every older record the walk had not reached yet, and those records
 * would never be read again. Six days of mail vanished the last time a watermark
 * moved past what had actually been read; this is the same mistake with a
 * customer list.
 *
 * So the rule is stated once and enforced in one place: **a walk that did not
 * drain advances nothing.** It costs a re-read, and a re-read is free — records
 * arrive at `planImport`, match the parties they already created, and become
 * updates.
 */
export const crmConnectorSyncs = pgTable(
  "crm_connector_syncs",
  {
    crmConnectorSyncId: text("crm_connector_sync_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The mirror row in `user_integration_connections`, by id.
     *
     * No foreign key, and that is deliberate rather than an omission: that table
     * is a mirror of Composio's state, it is hard-deleted on disconnect, and it
     * carries no tenant-composite key to point a composite FK at. A sync whose
     * connection has gone is a sync that reports "disconnected" and stops, which
     * is a better answer than a cascade that deletes the record of what was
     * imported.
     */
    connectionId: integer("connection_id").notNull(),

    /** `salesforce` | `hubspot` | `zoho` | `pipedrive`. */
    provider: text("provider").notNull(),
    /** `accounts` | `contacts` | `deals` | `activities`. */
    stream: text("stream").notNull(),

    /**
     * Everything in this collection modified at or before this has been read.
     *
     * Null until the first walk drains. See the docblock: it moves on a drain
     * and on nothing else.
     */
    syncedThrough: timestamp("synced_through"),

    /**
     * The provider's own next-page request, or null when no walk is in flight.
     *
     * Stored as the request rather than as a token because the four providers
     * page four different ways and the walk should not have to know which — it
     * asks the parser for "the next request" and gets a path back.
     */
    cursor: jsonb("cursor").$type<{ method: "GET"; path: string }>(),

    /** The import the current walk is filling, so a caller can watch it. */
    crmImportId: text("crm_import_id"),
    workflowRunId: text("workflow_run_id"),

    lastRunAt: timestamp("last_run_at"),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),

    /**
     * A person can stop a connector without disconnecting the account, which is
     * a different decision — the same distinction `crm_mailbox_sync` draws.
     */
    enabled: boolean("enabled").default(true).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * One watermark per stream of a connection.
     *
     * Two would race exactly as two mailbox watermarks would: each would treat
     * the other's progress as a gap, and the pair would re-read the same
     * collection forever without either ever draining.
     */
    uniqueIndex("uniq_crm_connector_syncs_stream").on(
      t.organizationId,
      t.connectionId,
      t.stream,
    ),
    index("idx_crm_connector_syncs_due")
      .on(t.organizationId, t.lastRunAt)
      .where(sql`${t.enabled} = true`),
    unique("uniq_crm_connector_syncs_org_id").on(t.organizationId, t.crmConnectorSyncId),
  ],
);

/**
 * One record as the provider handed it over, before anything is decided.
 *
 * A staging table rather than an accumulator in memory or in a step's memo, and
 * the reason is the shape of a resumed run. A walk is tens of pages across
 * several attempts; holding the pages in the workflow's step outputs would put
 * megabytes of somebody else's CRM in `workflow_steps` and make every later
 * attempt load all of it back to get to the frontier. Here a page is written
 * once, the step's memo carries only what the loop needs — how many landed, and
 * the next request — and the plan reads the collection back in one pass at the
 * end.
 *
 * `values` is keyed by the header the provider's own CSV export writes, which is
 * what lets `crm-connector.service` hand these to exactly the same `preview` a
 * pasted file goes through.
 */
export const crmConnectorRecords = pgTable(
  "crm_connector_records",
  {
    crmConnectorRecordId: text("crm_connector_record_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    crmConnectorSyncId: text("crm_connector_sync_id").notNull(),

    /**
     * The provider's identifier, and the claim.
     *
     * The unique index below is what makes a re-read of a page a no-op: a step
     * that failed after writing half a page rolls back, re-runs, and inserts the
     * same records `ON CONFLICT DO NOTHING`. Without it a retried page would
     * duplicate every record it had already staged, and the import would carry
     * two of each — which `planImport` would then fold, hiding the bug behind a
     * correct-looking result.
     */
    sourceId: text("source_id").notNull(),

    /** What the provider says it last changed, and the only watermark input. */
    sourceModifiedAt: timestamp("source_modified_at"),

    /** Keyed by export header. See the docblock. */
    values: jsonb("values").$type<Record<string, string>>().notNull(),

    /** Which walk staged it, so a completed walk's rows can be cleared. */
    stagedAt: timestamp("staged_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_crm_connector_records_source").on(
      t.organizationId,
      t.crmConnectorSyncId,
      t.sourceId,
    ),
    index("idx_crm_connector_records_sync").on(
      t.organizationId,
      t.crmConnectorSyncId,
      t.stagedAt,
    ),
  ],
);
