import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import type { DecisionKind } from "./autonomous-decisions";

/**
 * What a human changed after the system decided.
 *
 * Two things need this and neither can be recovered later. The correction rate
 * needs a correction attributed to the *specific* decision it corrected —
 * counting edits that happen near an action in time gives a number that looks
 * real and is not. And accuracy only compounds if the correction is captured in
 * a shape a dataset can take, at the moment it is made, while the system's own
 * answer is still known.
 */

export const CORRECTION_TYPES = ["reversal", "edit"] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export const autonomyCorrections = pgTable(
  "autonomy_corrections",
  {
    autonomyCorrectionId: text("autonomy_correction_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /**
     * The decision this corrects. Nullable because a person may correct a
     * system-set value directly, long after, without going through the feed.
     */
    autonomousDecisionId: text("autonomous_decision_id"),

    kind: text("kind").$type<DecisionKind>().notNull(),
    correctionType: text("correction_type").$type<CorrectionType>().notNull(),

    /** What was corrected, and both answers, as the eval harness compares them. */
    field: text("field").notNull(),
    systemValue: text("system_value"),
    humanValue: text("human_value"),
    reason: text("reason"),

    /**
     * No foreign key to `users`, deliberately — see migration 0223. A purge
     * would otherwise delete the row and silently shrink the denominator of the
     * correction rate whenever somebody left the company.
     */
    correctedByUserId: text("corrected_by_user_id"),

    /**
     * Gates entry to an evaluation dataset at all. Only consented or synthetic
     * data may be promoted, and these rows are within scope of an erasure
     * request.
     */
    consented: boolean("consented").default(false).notNull(),
    /** Null until somebody deliberately promotes it. Never automatic. */
    promotedAt: timestamp("promoted_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_autonomy_corrections_kind").on(t.organizationId, t.kind, t.createdAt),
    index("idx_autonomy_corrections_decision").on(t.organizationId, t.autonomousDecisionId),
    // Partial, matching migration 0224: what is eligible for promotion and not
    // yet promoted is a small slice of a table that only grows.
    index("idx_autonomy_corrections_promotable")
      .on(t.organizationId, t.createdAt)
      .where(sql`${t.promotedAt} IS NULL AND ${t.consented} = true`),
  ],
);
