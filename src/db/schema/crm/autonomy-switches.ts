import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * The off switch, per action type.
 *
 * A product that acts without asking needs a way to be stopped that does not
 * involve a deploy. When a prompt change starts advancing stages wrongly at
 * 3am, the fix has to be a row, not a release — and it has to work at two
 * levels: an operator stopping one action type across the platform, and one
 * organisation stopping it for themselves without affecting anyone else.
 *
 * A NULL `organization_id` is the platform-level switch. It is deliberately the
 * same table rather than two: one resolution path means there is no way to check
 * the org switch and forget the platform one.
 */
export const autonomySwitches = pgTable(
  "autonomy_switches",
  {
    autonomySwitchId: text("autonomy_switch_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** NULL is the platform-wide switch. */
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    /** A decision kind, or `*` for every action at once. */
    kind: text("kind").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    /** Why it was turned off, which is the first thing anyone asks. */
    reason: text("reason"),
    /**
     * Who last flipped it. Deliberately *not* a foreign key to `users`.
     *
     * `scripts/purge-user.mjs` deletes every row whose column references
     * `users`, without consulting the delete rule. With an edge here, purging
     * whoever last touched a switch would delete the switch -- and
     * `resolveSwitch` reports `allowed: true` when no row is found, so an
     * offboarding would silently re-enable an action an operator had killed.
     * See migration 0223.
     */
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One switch per (scope, kind). Two rows for the same pair would make the
    // effective state depend on which the query happened to read first.
    //
    // The real index (migration 0220) is additionally NULLS NOT DISTINCT, which
    // is what makes it cover the platform rows: Postgres treats every NULL as
    // distinct by default, so without it any number of conflicting
    // platform-wide switches could exist for the same action. Drizzle 0.45
    // exposes `nullsNotDistinct()` only on `unique()` constraints, not on an
    // index builder, so it cannot be declared here. The migration is the source
    // of truth; this declaration is deliberately the weaker of the two.
    uniqueIndex("uniq_autonomy_switches_org_kind").on(t.organizationId, t.kind),
  ],
);
