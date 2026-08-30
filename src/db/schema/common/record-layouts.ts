import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "./auth";

/** One of the tenant's own sections, replacing the declared ones. */
export interface RecordLayoutGroup {
  readonly title: string;
  readonly fields: readonly string[];
}

/**
 * A tenant's arrangement of a record type, held apart from the description.
 *
 * An overlay, never a copy of the layout. A tenant who hid one column this year
 * must still receive the field we add next year, and a forked description would
 * freeze them at the day they touched it. So this table stores only the delta —
 * an order, a hidden set, and the tenant's own groupings — and the description
 * itself stays where it is declared.
 *
 * **Three columns rather than one `adjustment` jsonb.** `field_order` and
 * `hidden_fields` are flat lists of field names, which is exactly what `text[]`
 * is: a column-level `NOT NULL DEFAULT '{}'` then makes "no order" and "an empty
 * order" one state instead of the three a nullable jsonb blob would have
 * (key absent, key null, key `[]`), and `= ANY(hidden_fields)` answers "does
 * this tenant hide that field" without parsing anything. `groups` is genuinely
 * nested and ordered — a list of `{title, fields[]}` — so it is jsonb, because
 * the alternative is a second table and a second transaction for data nothing
 * queries into. A single jsonb column would have moved all three shapes into
 * application code and left the database unable to refuse a half-written row.
 *
 * **`updated_by` carries no foreign key to `users`, deliberately.**
 * `scripts/purge-user.mjs` deletes every row whose column references `users`,
 * ignoring the delete rule — so an FK here would erase a whole organisation's
 * screen arrangement on the day the administrator who last saved it is
 * offboarded. 0223 removed exactly this edge from two other tables for the same
 * reason. The column records who, and losing the who is not worth losing the
 * what.
 *
 * **It cannot widen access.** Everything stored here is a field name the
 * description already publishes. Hiding is display-only: the value keeps
 * arriving, keeps being stored, and returns the moment the field is unhidden —
 * and revealing a field does not make a denied read succeed. There is no
 * permission key in this table and there must never be one.
 */
export const recordLayoutAdjustments = pgTable(
  "record_layout_adjustments",
  {
    adjustmentId: bigint("adjustment_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * `RecordLayout.key` — `crm:lead`, `party`, and the rest.
     *
     * Validated against a published set before it is ever written; an
     * arrangement for a record type nobody renders is a row that outlives its
     * own meaning.
     */
    layoutKey: text("layout_key").notNull(),

    /** Field names in the tenant's order. Unnamed fields keep their declared place. */
    fieldOrder: text("field_order")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** Fields the tenant does not want rendered. Display only. */
    hiddenFields: text("hidden_fields")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** The tenant's own sections, replacing the declared ones. Empty means "as declared". */
    groups: jsonb("groups")
      .$type<RecordLayoutGroup[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Who last saved it. A user id, never a foreign key — see above. */
    updatedBy: text("updated_by"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One arrangement per record type per tenant. Two would mean the renderer
    // had to pick, and there is no rule that could.
    unique("uniq_record_layout_adjustments_org_layout").on(
      table.orgId,
      table.layoutKey,
    ),
  ],
);

export type RecordLayoutAdjustmentRow = typeof recordLayoutAdjustments.$inferSelect;
