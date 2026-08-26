import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * Where each mailbox's sync got to.
 *
 * Push tells you a message arrived; it does not tell you about the one that
 * arrived while the endpoint was down, or during a deploy, or the ones a
 * provider silently dropped. Push is the fast path and this is the truth: a
 * sweep reads from `syncedThrough` forward and closes whatever gap exists, and
 * the seam's idempotency makes the overlap free.
 *
 * A timestamp rather than a provider cursor, deliberately. A cursor is opaque,
 * provider-specific, and invalid after re-authorisation — which is exactly when
 * a gap is most likely. A timestamp survives reconnecting the same mailbox.
 */
export const crmMailboxSync = pgTable(
  "crm_mailbox_sync",
  {
    crmMailboxSyncId: text("crm_mailbox_sync_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    connectionId: integer("connection_id").notNull(),
    mailboxAddress: text("mailbox_address").notNull(),
    provider: text("provider").$type<"gmail" | "outlook">().notNull(),

    /** Everything at or before this has been offered to the seam. */
    syncedThrough: timestamp("synced_through"),
    lastRunAt: timestamp("last_run_at"),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    /**
     * What the provider signs its push notifications with.
     *
     * Per mailbox, not per deployment: one global secret makes any integrator's
     * leak a key to every tenant's ingress. Null until a push subscription is
     * registered, and a null can never match a constant-time comparison, so an
     * unregistered mailbox fails closed with no special case.
     */
    pushSecret: text("push_secret"),

    /**
     * A person can stop a mailbox feeding the CRM without disconnecting it from
     * the rest of the product, which is a different decision.
     */
    enabled: boolean("enabled").default(true).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Two watermarks would race, each treating the other's progress as a gap
    // and re-offering the same messages forever.
    uniqueIndex("uniq_crm_mailbox_sync_connection").on(t.organizationId, t.connectionId),
    index("idx_crm_mailbox_sync_due")
      .on(t.organizationId, t.lastRunAt)
      .where(sql`${t.enabled} = true`),
  ],
);
