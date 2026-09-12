import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  integer,
  bigint,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { crmCommissionPlans, crmCommissionPlanVersions } from "./commission-plans";

/**
 * One earning, and enough of its derivation to defend it.
 *
 * `planVersionId` is stored rather than re-resolved on read: re-resolution would
 * be correct today and would silently start answering differently the moment
 * somebody backdated a version, which is precisely the class of change this
 * ticket exists to make visible. `computation` carries the slice-by-slice trace
 * the evaluator produced, so a dispute is answered by reading a row rather than
 * by rerunning a build.
 */
export const crmCommissionEarnings = pgTable(
  "crm_commission_earnings",
  {
    earningId: text("earning_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "restrict" })
      .notNull(),
    planVersionId: text("plan_version_id")
      .references(() => crmCommissionPlanVersions.planVersionId, {
        onDelete: "restrict",
      })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    /** The date that selected the version. For a deal, its actual close date. */
    earnedOn: date("earned_on").notNull(),
    /** The attainment window the bands were walked over, from `rules.period`. */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** `deal` today; the column exists so a second source needs no migration. */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** What the bands were applied to, minor units. Never a float. */
    basisMinor: bigint("basis_minor", { mode: "number" }).notNull(),
    /** Cumulative basis already earned in this period before this row. */
    priorBasisMinor: bigint("prior_basis_minor", { mode: "number" })
      .default(0)
      .notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /**
     * `amountMinor * 10000 / basisMinor`, rounded, for reporting only.
     *
     * Derived and stored rather than computed on read because a marginal band
     * table has no single rate; this is the blended one, and a reader who
     * recomputed it from a tier would get a different number and believe the row
     * was wrong.
     */
    effectiveRateBps: integer("effective_rate_bps").default(0).notNull(),
    attainmentBps: integer("attainment_bps"),
    computation: jsonb("computation").$type<Record<string, unknown>>(),
    status: text("status").default("CALCULATED").notNull(),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * Recalculating is a no-op, not a double payment. Without this the retry of
     * a request that timed out after its INSERT pays the rep twice, and nothing
     * in the ledger says which of the two rows is the real one.
     */
    uniqueIndex("uniq_crm_commission_earnings_source").on(
      t.orgId,
      t.sourceType,
      t.sourceId,
      t.userId,
    ),
    /** The attainment read: one earner's period to date. */
    index("idx_crm_commission_earnings_attainment").on(
      t.orgId,
      t.userId,
      t.planId,
      t.earnedOn,
    ),
    index("idx_crm_commission_earnings_status").on(
      t.orgId,
      t.status,
      t.earnedOn,
    ),
    index("idx_crm_commission_earnings_version").on(t.orgId, t.planVersionId),
  ],
);
