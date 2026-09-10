import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { sql } from "drizzle-orm";

/**
 * Who else processes our customers' data, and what for.
 *
 * A register, not a document. A PDF on a website goes stale the week after it is
 * written, and the customer whose own compliance depends on it has no way to know
 * -- so this is a table with a page over it, and a change to a row is an event
 * somebody can be told about.
 *
 * Deliberately **not** tenant-scoped. Our subprocessors are the same for every
 * customer; a per-tenant register would imply each organisation has its own set,
 * which is not true and would be a strange thing to assert in writing to a
 * regulator. It is platform data, readable by anyone, edited by platform staff.
 */
export const subprocessors = pgTable(
  "subprocessors",
  {
    subprocessorId: text("subprocessor_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** The legal entity, as a customer's counsel would need to identify it. */
    name: text("name").notNull(),

    /** What we use them for, in a sentence a non-engineer can act on. */
    purpose: text("purpose").notNull(),

    /** Where the processing happens. The question every EU customer asks first. */
    location: text("location").notNull(),

    /** Their own privacy or DPA page, so a reviewer can go straight to it. */
    url: text("url"),

    /**
     * When they started processing, which is not when the row was written.
     *
     * A register backfilled today would otherwise claim every subprocessor began
     * today, and the notification history would be a lie about what changed when.
     */
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),

    /**
     * When they stopped, if they have.
     *
     * Retired rows stay: a customer reviewing a period needs to know who
     * processed their data *then*, and deleting the row erases exactly that.
     */
    retiredAt: timestamp("retired_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    // One row per named processor. Two would put the register in the position of
    // saying two different things about the same company.
    uniqueIndex("uniq_subprocessors_name").on(table.name),
    index("idx_subprocessors_effective").on(table.effectiveFrom),
  ],
);

/**
 * Who asked to be told when the register changes.
 *
 * An email rather than a user: the person who reviews subprocessors is often a
 * counsel or a compliance officer who has no login here, and requiring one would
 * make the notification useless to exactly the people it exists for.
 */
export const subprocessorSubscribers = pgTable(
  "subprocessor_subscribers",
  {
    subprocessorSubscriberId: text("subprocessor_subscriber_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    email: text("email").notNull(),

    /** Optional: which customer they are asking on behalf of, where they said. */
    organizationId: text("organization_id"),

    /** Cleared when they unsubscribe; the row stays so a re-subscribe is one act. */
    unsubscribedAt: timestamp("unsubscribed_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_subprocessor_subscribers_email").on(table.email),
    index("idx_subprocessor_subscribers_active").on(table.unsubscribedAt),
    /*
     * Leads with the tenant column because this table carries RLS
     * (`tenant_isolation: organization_id = current_org_id()`), so every read
     * of it carries that predicate. Neither index above can serve it — they
     * lead with `email` and `unsubscribed_at` — which left the policy to a
     * sequential scan and made this the one tenant table of 744 that
     * `check:tenant-indexes` reported. Section 7: the policy qual is not
     * leakproof, so an index the planner will even consider has to supply
     * `organization_id` itself.
     *
     * Partial on the live rows: every read here asks who should be notified,
     * and an unsubscribed row is never part of that answer. Installed by 0674.
     */
    index("idx_subprocessor_subscribers_org_active")
      .on(table.organizationId, table.email)
      .where(sql`${table.unsubscribedAt} IS NULL`),
  ],
);
