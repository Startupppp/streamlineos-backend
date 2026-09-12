import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  integer,
  bigint,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { crmCommissionPlans, crmCommissionPlanVersions } from "./commission-plans";
import { crmCommissionEarnings } from "./commission-earnings";

/**
 * The decomposition, materialised: one row per band of one earning.
 *
 * Ticket P5-05. `crm_commission_earnings.computation` already carries a
 * slice-by-slice trace, and it cannot do this job for two reasons. It is a jsonb
 * blob, so "which deals produced this month's accrual, and under which rule?" is
 * a full scan and a re-parse rather than a query; and its slice amounts are
 * display roundings that **do not sum** to the earning they belong to — measured
 * against the evaluator, roughly a quarter of evaluations disagree by at least a
 * minor unit, and every capped one disagrees by far more.
 *
 * These rows are the same derivation apportioned so it adds up. The invariant is
 * literal and load-bearing: for any earning, the `amount_minor` of its parts sums
 * to the earning's `amount_minor` with no residue, so an accrued figure at any
 * granularity — a period, a rep, a plan version, a single rule — is the sum of a
 * set of these rows and never a number that has to be reconciled against one.
 * `trg_crm_commission_accrual_parts_reconcile` is a DEFERRABLE constraint trigger
 * that checks exactly that at commit, for every writer and not only the service.
 *
 * Append-only in practice. Parts are written in the same transaction as the
 * earning that produced them and are deleted only when that earning's
 * decomposition is rebuilt, whole, in one transaction — never edited in place,
 * because an edited part is a restatement wearing the same primary key.
 */
export const crmCommissionAccrualParts = pgTable(
  "crm_commission_accrual_parts",
  {
    partId: text("part_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    earningId: text("earning_id")
      .references(() => crmCommissionEarnings.earningId, { onDelete: "cascade" })
      .notNull(),

    /**
     * Denormalised from the earning: the earner, the plan, the exact version,
     * the period and the source.
     *
     * Redundant on purpose. The read this table exists for is "everything that
     * built this month's number for this person, broken down by deal and by
     * rule", and making that a four-table join would put the accrual query on
     * the slow path of the one screen the ticket wants people watching daily.
     * Drift is not a risk the way it usually is: these are copied at insert from
     * an earning whose own values never change, and a rebuild replaces the parts
     * rather than patching them.
     */
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "restrict" })
      .notNull(),
    planVersionId: text("plan_version_id")
      .references(() => crmCommissionPlanVersions.planVersionId, {
        onDelete: "restrict",
      })
      .notNull(),
    earnedOn: date("earned_on").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The deal. This column is what "decomposes to the deals" means. */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),

    /** Dense from 0 within an earning, and the ledger's stable sort key. */
    partIndex: integer("part_index").notNull(),

    /**
     * Which rule paid this part.
     *
     * `tier_index` rather than the rate alone, because two bands of one plan may
     * share a rate — 10% to quota, 15% to 150%, 10% beyond is a real shape — and
     * attributing by rate would credit the third band's money to the first.
     * `rate_bps` and `multiplier_bps` are stored alongside so a part stays
     * readable without resolving the version's rule document, and so a
     * decomposition still names its rule after a later version has renumbered
     * its bands.
     */
    tierIndex: integer("tier_index").notNull(),
    /** The band's declared `from`: attainment bps with a quota, minor without. */
    tierFrom: bigint("tier_from", { mode: "number" }).notNull(),
    rateBps: integer("rate_bps").notNull(),
    /** 10000 when no accelerator applied to this band. */
    multiplierBps: integer("multiplier_bps").notNull(),

    /** Cumulative window of the earner's period basis this band consumed. */
    sliceFromMinor: bigint("slice_from_minor", { mode: "number" }).notNull(),
    sliceToMinor: bigint("slice_to_minor", { mode: "number" }).notNull(),
    /** How much basis fell in the band, minor units. */
    basisMinor: bigint("basis_minor", { mode: "number" }).notNull(),

    /**
     * This part's exact share of the earning, minor units.
     *
     * Apportioned from the earning's settled total by largest remainder, not
     * recomputed from the rate — so a cap is attributed proportionally to the
     * bands that earned it instead of vanishing, and the parts reconstruct the
     * total rather than approximating it.
     */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /** A part is identified by its earning and its position; a rebuild replaces. */
    uniqueIndex("uniq_crm_commission_accrual_parts_slot").on(
      t.orgId,
      t.earningId,
      t.partIndex,
    ),
    /** The accrual read: one earner's period to date, decomposed. */
    index("idx_crm_commission_accrual_parts_period").on(
      t.orgId,
      t.userId,
      t.periodStart,
      t.earnedOn,
    ),
    /** "What did this deal pay, and to whom?" — the dispute's opening question. */
    index("idx_crm_commission_accrual_parts_source").on(
      t.orgId,
      t.sourceType,
      t.sourceId,
    ),
    /** "What has this version of the plan cost?" — the plan author's question. */
    index("idx_crm_commission_accrual_parts_version").on(
      t.orgId,
      t.planVersionId,
      t.tierIndex,
    ),
    index("idx_crm_commission_accrual_parts_earning").on(t.orgId, t.earningId),
  ],
);

/**
 * The accrued figure as it stood at the end of each day — the curve people watch.
 *
 * Derived from the parts and kept anyway, because the point of continuous
 * accrual is not only that today's number is available but that yesterday's is
 * still what it was yesterday. Recomputing the curve from the ledger on demand
 * would answer "what is the number now, dated back" rather than "what did we
 * tell you on the 14th", and a rep who watched a figure fall would have no way
 * to show that it ever stood higher — a late-arriving deal, a void, or a
 * corrected close date all move history under a recomputed curve.
 *
 * One row per earner, plan, period and day, upserted: the last write on a given
 * day wins, so the curve is end-of-day rather than every intraday flicker.
 * `accrued_minor` always equals the sum of the parts in that period whose
 * `earned_on` falls on or before `as_of_date`, at the moment it was written.
 */
export const crmCommissionAccrualSnapshots = pgTable(
  "crm_commission_accrual_snapshots",
  {
    snapshotId: text("snapshot_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "restrict" })
      .notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The day this figure was true of. The curve's x axis. */
    asOfDate: date("as_of_date").notNull(),

    /** Commission accrued in the period up to and including `as_of_date`. */
    accruedMinor: bigint("accrued_minor", { mode: "number" }).notNull(),
    /** Basis behind it, so the blended rate is derivable without the parts. */
    basisMinor: bigint("basis_minor", { mode: "number" }).notNull(),
    earningCount: integer("earning_count").default(0).notNull(),
    partCount: integer("part_count").default(0).notNull(),
    /**
     * Attainment at the close of the latest earning counted here.
     *
     * Taken from that earning rather than recomputed, because the quota that
     * produced it lives on an assignment that can since have been re-dated or
     * ended, and a curve point that silently re-bases itself against today's
     * quota is exactly the restatement this table exists to prevent. Null when
     * the plan version carried no quota.
     */
    attainmentBps: integer("attainment_bps"),
    currency: text("currency").notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [
    /** One point per day; the day's later writes update it in place. */
    uniqueIndex("uniq_crm_commission_accrual_snapshots_day").on(
      t.orgId,
      t.userId,
      t.planId,
      t.periodStart,
      t.asOfDate,
    ),
    /** The curve read: one earner's period, in date order. */
    index("idx_crm_commission_accrual_snapshots_curve").on(
      t.orgId,
      t.userId,
      t.asOfDate,
    ),
    index("idx_crm_commission_accrual_snapshots_plan").on(
      t.orgId,
      t.planId,
      t.periodStart,
    ),
  ],
);
