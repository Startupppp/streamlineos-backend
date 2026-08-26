import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./auth";

/**
 * A tenant's arrangement of a record type.
 *
 * The layout description is data, which is what makes the renderer worth having:
 * an organisation reorders, hides and groups the fields of a record type without
 * a deploy, and every list, detail view and form of that type follows.
 *
 * Stored server-side rather than in the browser, deliberately. An arrangement
 * made by an administrator has to reach every colleague on every device;
 * `localStorage` is not per tenant, it is per browser, and calling that "a
 * tenant can adjust their layout" would be dressing one thing as another.
 *
 * Only *presentation* lives here. `order` and `hidden` name fields the
 * description already publishes, and `groups` re-sections them. Nothing here
 * grants or withholds access to a value: a hidden field is not a protected one,
 * and any surface treating it as such would be building authorisation out of a
 * display preference.
 */
export interface LayoutGroup {
  readonly title: string;
  readonly fields: readonly string[];
}

export const recordLayoutAdjustments = pgTable(
  "record_layout_adjustments",
  {
    recordLayoutAdjustmentId: text("record_layout_adjustment_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** Matches `RecordLayout.key` on the client — `party`, `subject:property`. */
    layoutKey: text("layout_key").notNull(),

    /**
     * Field names in the tenant's order.
     *
     * A field not named keeps its declared position, behind every field that is,
     * so an arrangement written today does not have to be rewritten when the
     * description grows a field tomorrow.
     */
    order: jsonb("order").$type<string[]>(),

    /** Fields the tenant does not want rendered. Display only — see above. */
    hidden: jsonb("hidden").$type<string[]>(),

    /** The tenant's own sections, replacing the declared ones. */
    groups: jsonb("groups").$type<LayoutGroup[]>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One arrangement per type per tenant. A second row would make the rendered
    // layout depend on which the query happened to read first.
    uniqueIndex("uniq_record_layout_adjustments_org_key").on(
      table.organizationId,
      table.layoutKey,
    ),
    // Every record surface in the product reads this, so the read is the one
    // that matters: organisation first, then the key, covering `updated_at`.
    index("idx_record_layout_adjustments_org").on(table.organizationId, table.updatedAt),
  ],
);

export const RECORD_LAYOUT_ADJUSTMENTS_TENANT_POLICY = sql`organization_id = app.current_org_id()`;
