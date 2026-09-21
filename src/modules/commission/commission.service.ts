import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { crmCommissionEarnings, crmCommissionPlans } from "../../db/schema/crm/commission";
import { NotificationsService } from "../notifications/notifications.service";
import { earningsUserFilter } from "./commission-scope";
import { calculateEarningForDeal } from "./lib/earning-calculation";
import { clawbackEarningForDeal, type ClawbackInput } from "./lib/clawback";
import {
  assignToPlan,
  createCommissionPlan,
  endPlanAssignment,
  readCommissionPlan,
  updateCommissionPlan,
} from "./lib/plan-admin";
import { createPlanVersion, resolvePlanVersion, updatePlanVersion } from "./lib/plan-versions";
import type {
  AssignInput,
  CalculateForDealInput,
  CreatePlanInput,
  CreateVersionInput,
  EndAssignmentInput,
  ListEarningsQuery,
  UpdatePlanInput,
  UpdateVersionInput,
} from "./dto/commission.schemas";

export { clampToInt4 } from "./lib/earning-calculation";

/**
 * Commission plans, their versions, and the earnings computed from them.
 *
 * The single rule this service exists to hold: **an earning is computed from the
 * plan version in force on the date it was earned, and that version can never
 * change afterwards.** Everything else here is bookkeeping around it.
 *
 * Two consequences worth stating, because they look like omissions:
 *
 *  - There is no "recalculate a plan's earnings" operation. Recalculation of a
 *    single source is idempotent by unique index and returns the existing row.
 *    A bulk restatement is exactly the thing the ticket forbids; changing what a
 *    period pays is done by writing a new version and, if history really must
 *    move, by voiding rows and recomputing them one at a time so each leaves a
 *    trace.
 *  - Attainment is read back out of the ledger rather than recomputed from
 *    deals. That makes a payout reproducible from stored rows alone, and it
 *    makes the order in which a period's deals were calculated part of the
 *    record instead of an invisible input.
 *
 * Money is integer minor units on every path in this file and its `lib/`.
 * `basis_minor` and `amount_minor` are `bigint`, so their SQL `sum()` comes back
 * as `numeric` — a string over the wire — and is converted deliberately rather
 * than by coincidence; see `attainmentToDate` in `lib/earning-inputs.ts`.
 *
 * The class is the entry point. Plans and assignments are `lib/plan-admin.ts`,
 * versions `lib/plan-versions.ts`, and the calculation
 * `lib/earning-calculation.ts`, with the reads it is priced from in
 * `lib/earning-inputs.ts`; the ledger's list and approval stay here.
 */
@Injectable()
export class CommissionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Plans ────────────────────────────────────────────────────────────────

  async listPlans(orgId: string) {
    return this.db
      .select({
        planId: crmCommissionPlans.planId,
        name: crmCommissionPlans.name,
        description: crmCommissionPlans.description,
        currency: crmCommissionPlans.currency,
        retiredOn: crmCommissionPlans.retiredOn,
        createdAt: crmCommissionPlans.createdAt,
      })
      .from(crmCommissionPlans)
      .where(eq(crmCommissionPlans.orgId, orgId))
      .orderBy(asc(crmCommissionPlans.name))
      .limit(200);
  }

  /**
   * A plan and its first version, in one transaction.
   *
   * Never a plan on its own: a plan with no version resolves to nothing on every
   * date, so an assignment against it would silently earn zero and look like a
   * rate problem rather than a missing rule set.
   */
  async createPlan(orgId: string, userId: string, input: CreatePlanInput) {
    return createCommissionPlan(this.db, orgId, userId, input);
  }

  async getPlan(orgId: string, planId: string) {
    return readCommissionPlan(this.db, orgId, planId);
  }

  /** Renames and retirement only. Anything that changes money is a version. */
  async updatePlan(orgId: string, planId: string, input: UpdatePlanInput) {
    return updateCommissionPlan(this.db, orgId, planId, input);
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  /**
   * Add a dated rule set to a plan.
   *
   * The new version must start strictly after the newest existing one. Allowing
   * a backdated insert would move the version in force for dates that already
   * have earnings filed against a different version, so the ledger and a fresh
   * resolution of the same date would disagree — and the ledger would be the one
   * that looked wrong.
   */
  async createVersion(
    orgId: string,
    planId: string,
    userId: string,
    input: CreateVersionInput,
  ) {
    return createPlanVersion(this.db, orgId, planId, userId, input);
  }

  /**
   * Edit a version that has not been earned against yet.
   *
   * The `sealed_at IS NULL` predicate is in the UPDATE itself rather than in a
   * read-then-write: between a check and a write, a concurrent calculation can
   * seal the version, and the edit would then rewrite the rules that request had
   * already paid somebody under. The database trigger refuses the same write; a
   * lost UPDATE here turns that raise into a 409 the caller can read.
   */
  async updateVersion(
    orgId: string,
    planId: string,
    planVersionId: string,
    input: UpdateVersionInput,
  ) {
    return updatePlanVersion(this.db, orgId, planId, planVersionId, input);
  }

  /**
   * The version governing `on`: the greatest `effective_from` at or before it.
   *
   * This is the whole dating model in one query. There is no end date to check
   * because there is none to store — the next version's start is this one's end,
   * so a gap cannot exist and an overlap cannot be expressed.
   */
  async resolveVersion(orgId: string, planId: string, on: string) {
    return resolvePlanVersion(this.db, orgId, planId, on);
  }

  // ── Assignments ──────────────────────────────────────────────────────────

  async assign(orgId: string, planId: string, input: AssignInput) {
    return assignToPlan(this.db, orgId, planId, input);
  }

  async endAssignment(orgId: string, assignmentId: string, input: EndAssignmentInput) {
    return endPlanAssignment(this.db, orgId, assignmentId, input);
  }

  // ── Earnings ─────────────────────────────────────────────────────────────

  /**
   * Compute what a won deal earned its owner, under the rules of the day.
   *
   * Every input is dated by `deals.actualCloseDate`: the assignment, the plan
   * version and the attainment window. Nothing reads "the current plan", which
   * is what makes editing a plan unable to restate this row.
   */
  async calculateForDeal(orgId: string, input: CalculateForDealInput) {
    return calculateEarningForDeal(this.db, orgId, input);
  }

  /**
   * Phase 5 ticket 06. A reversed or reclassified deal claws its commission
   * back through the same ledger that paid it — see `lib/clawback.ts` for
   * the mechanism. This method adds the fourth thing the ledger itself
   * cannot: telling the person it happened to, with the reason and the deal.
   *
   * The notification fires after the transaction commits, not inside it —
   * the same reason every other post-commit side effect in this product
   * does: a notification that failed to send must not roll back a clawback
   * that genuinely happened, and a `void ... .catch(...)` here would let a
   * failure vanish with nothing to say the rep was never told.
   */
  async clawbackForDeal(orgId: string, input: ClawbackInput) {
    const result = await clawbackEarningForDeal(this.db, orgId, input);

    if (result.created) {
      try {
        await this.notifications.create({
          orgId,
          userId: result.userId,
          type: result.drivesNegative ? "WARNING" : "INFO",
          priority: result.drivesNegative ? "HIGH" : "NORMAL",
          category: "SYSTEM",
          sourceModule: "commission",
          eventKey: "commission.clawback",
          entityType: "deal",
          entityId: String(input.dealId),
          actorUserId: input.actorUserId,
          reason: input.reason,
          title: "A commission was clawed back",
          message: result.drivesNegative
            ? `Deal #${input.dealId} reversed — ${input.reason}. This takes your accrual for the period negative; payroll will follow up on how it is recovered.`
            : `Deal #${input.dealId} reversed — ${input.reason}. The commission it earned has been clawed back.`,
          link: `/crm/deals/${input.dealId}`,
        });
      } catch (error) {
        throw new Error(
          `Clawback for deal ${input.dealId} was recorded but the rep was not notified: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
    }

    return result;
  }

  /**
   * The earnings ledger, narrowed to what the caller is allowed to see.
   *
   * `viewer.viewAll` comes from the request's resolved RBAC scope, not from a
   * role name, and the narrowing is applied here rather than in the controller
   * so no future caller can reach the ledger without it. A commission row is
   * somebody's pay: a rep holding `crm:commission-earnings:view` at scope `own`
   * who passed `?userId=` for a colleague would otherwise read that colleague's
   * entire compensation, and the request would look perfectly authorised.
   */
  async listEarnings(
    orgId: string,
    query: ListEarningsQuery,
    viewer: { userId: string; viewAll: boolean },
  ) {
    const predicates = [eq(crmCommissionEarnings.orgId, orgId)];
    const only = earningsUserFilter(query, viewer);
    if (only !== null) predicates.push(eq(crmCommissionEarnings.userId, only));
    if (query.planId) predicates.push(eq(crmCommissionEarnings.planId, query.planId));
    if (query.status) predicates.push(eq(crmCommissionEarnings.status, query.status));
    if (query.from) predicates.push(gte(crmCommissionEarnings.earnedOn, query.from));
    if (query.to) predicates.push(lte(crmCommissionEarnings.earnedOn, query.to));

    return this.db
      .select()
      .from(crmCommissionEarnings)
      .where(and(...predicates))
      .orderBy(desc(crmCommissionEarnings.earnedOn), desc(crmCommissionEarnings.createdAt))
      .limit(query.limit)
      .offset(query.offset);
  }

  /**
   * Approve a calculated earning.
   *
   * Only from `CALCULATED`. Re-approving something already paid would move it
   * backwards through the payroll handoff, and approving a voided row would
   * resurrect a payment somebody deliberately cancelled.
   */
  async approveEarning(orgId: string, earningId: string, userId: string) {
    const [updated] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(crmCommissionEarnings)
          .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(crmCommissionEarnings.orgId, orgId),
              eq(crmCommissionEarnings.earningId, earningId),
              eq(crmCommissionEarnings.status, "CALCULATED"),
            ),
          )
          .returning(),
      { orgId },
    );
    if (!updated)
      throw new ConflictException(
        "Earning not found, or it is no longer awaiting approval",
      );
    return updated;
  }
}
