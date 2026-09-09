import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../common/tenant/with-tenant";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { deals } from "../../db/schema/crm/deals";
import { crmPipelineStages } from "../../db/schema/crm/metadata";
import {
  crmCommissionAssignments,
  crmCommissionEarnings,
  crmCommissionPlans,
  crmCommissionPlanVersions,
  type CommissionRuleSet,
} from "../../db/schema/crm/commission";
import { evaluateCommission, periodWindow } from "./commission-rules";
import { decomposeEvaluation } from "./commission-accrual";
import { earningsUserFilter } from "./commission-scope";
import { recordAccrualForEarning } from "./commission-accrual.service";
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
 * Money is integer minor units on every path in this file. `basis_minor` and
 * `amount_minor` are `bigint`, so their SQL `sum()` comes back as `numeric` —
 * a string over the wire — and is converted deliberately rather than by
 * coincidence; see `attainmentToDate`.
 */
/**
 * Saturate a reporting figure into `integer`'s range instead of failing the write.
 *
 * `attainment_bps` is int4, and attainment is `basis * 10000 / quota` — so a
 * plan whose quota is a handful of minor units produces a number past 2^31 and
 * Postgres refuses the INSERT with 22003. The commission would then not be
 * recorded at all because a *display* column overflowed. Saturating at
 * 2,147,483,647 bps — twenty-one million percent — cannot be misread as a real
 * attainment, and the money in `amount_minor` is untouched by it.
 */
const INT4_MAX = 2_147_483_647;
export function clampToInt4(value: number): number {
  if (value > INT4_MAX) return INT4_MAX;
  if (value < -INT4_MAX) return -INT4_MAX;
  return Math.trunc(value);
}

/**
 * Which earner's rows a caller may read: their own, one they asked for, or all.
 *
 * Pure and exported so the rule is asserted directly rather than inferred from
 * a mocked WHERE clause. The failure it prevents is specific: a rep holding
 * `crm:commission-earnings:view` at scope `own` passing `?userId=` for a
 * colleague and receiving that colleague's entire compensation, in a request
 * that is authorised at every layer above this one.
 *
 * Returns null only when the caller may see everybody and asked for everybody.
 */
@Injectable()
export class CommissionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
    try {
      return await runInTenantTransaction(
        this.db,
        async (tx) => {
          const [plan] = await tx
            .insert(crmCommissionPlans)
            .values({
              orgId,
              name: input.name,
              description: input.description ?? null,
              currency: input.currency,
              createdBy: userId,
            })
            .returning();
          if (!plan) throw new ConflictException("Could not create the plan");

          const [version] = await tx
            .insert(crmCommissionPlanVersions)
            .values({
              orgId,
              planId: plan.planId,
              versionNumber: 1,
              effectiveFrom: input.effectiveFrom,
              rules: input.rules as CommissionRuleSet,
              note: input.note ?? null,
              createdBy: userId,
            })
            .returning();

          return { plan, version };
        },
        { orgId },
      );
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "23505")
        throw new ConflictException("A commission plan with this name already exists");
      throw e;
    }
  }

  async getPlan(orgId: string, planId: string) {
    const [plan] = await this.db
      .select()
      .from(crmCommissionPlans)
      .where(
        and(eq(crmCommissionPlans.orgId, orgId), eq(crmCommissionPlans.planId, planId)),
      )
      .limit(1);
    if (!plan) throw new NotFoundException("Commission plan not found");

    const [versions, assignments] = await Promise.all([
      this.db
        .select()
        .from(crmCommissionPlanVersions)
        .where(
          and(
            eq(crmCommissionPlanVersions.orgId, orgId),
            eq(crmCommissionPlanVersions.planId, planId),
          ),
        )
        .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
        .limit(200),
      this.db
        .select()
        .from(crmCommissionAssignments)
        .where(
          and(
            eq(crmCommissionAssignments.orgId, orgId),
            eq(crmCommissionAssignments.planId, planId),
          ),
        )
        .orderBy(desc(crmCommissionAssignments.effectiveFrom))
        .limit(500),
    ]);

    return { plan, versions, assignments };
  }

  /** Renames and retirement only. Anything that changes money is a version. */
  async updatePlan(orgId: string, planId: string, input: UpdatePlanInput) {
    const [updated] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(crmCommissionPlans)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(crmCommissionPlans.orgId, orgId),
              eq(crmCommissionPlans.planId, planId),
            ),
          )
          .returning(),
      { orgId },
    );
    if (!updated) throw new NotFoundException("Commission plan not found");
    return updated;
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
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [plan] = await tx
          .select({
            planId: crmCommissionPlans.planId,
            retiredOn: crmCommissionPlans.retiredOn,
          })
          .from(crmCommissionPlans)
          .where(
            and(
              eq(crmCommissionPlans.orgId, orgId),
              eq(crmCommissionPlans.planId, planId),
            ),
          )
          .limit(1);
        if (!plan) throw new NotFoundException("Commission plan not found");
        if (plan.retiredOn)
          throw new ConflictException("This plan is retired; create a new plan instead");

        const [newest] = await tx
          .select({
            versionNumber: crmCommissionPlanVersions.versionNumber,
            effectiveFrom: crmCommissionPlanVersions.effectiveFrom,
          })
          .from(crmCommissionPlanVersions)
          .where(
            and(
              eq(crmCommissionPlanVersions.orgId, orgId),
              eq(crmCommissionPlanVersions.planId, planId),
            ),
          )
          .orderBy(desc(crmCommissionPlanVersions.versionNumber))
          .limit(1);

        if (newest && input.effectiveFrom <= newest.effectiveFrom)
          throw new ConflictException(
            `A new version must take effect after ${newest.effectiveFrom}; backdating would restate earnings already filed against the current version`,
          );

        const [version] = await tx
          .insert(crmCommissionPlanVersions)
          .values({
            orgId,
            planId,
            versionNumber: (newest?.versionNumber ?? 0) + 1,
            effectiveFrom: input.effectiveFrom,
            rules: input.rules as CommissionRuleSet,
            note: input.note ?? null,
            createdBy: userId,
          })
          .returning();
        return version;
      },
      { orgId },
    );
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
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.effectiveFrom !== undefined) patch.effectiveFrom = input.effectiveFrom;
    if (input.rules !== undefined) patch.rules = input.rules as CommissionRuleSet;
    if (input.note !== undefined) patch.note = input.note;

    const [updated] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(crmCommissionPlanVersions)
          .set(patch)
          .where(
            and(
              eq(crmCommissionPlanVersions.orgId, orgId),
              eq(crmCommissionPlanVersions.planId, planId),
              eq(crmCommissionPlanVersions.planVersionId, planVersionId),
              isNull(crmCommissionPlanVersions.sealedAt),
            ),
          )
          .returning(),
      { orgId },
    );

    if (!updated) {
      const [existing] = await this.db
        .select({ sealedAt: crmCommissionPlanVersions.sealedAt })
        .from(crmCommissionPlanVersions)
        .where(
          and(
            eq(crmCommissionPlanVersions.orgId, orgId),
            eq(crmCommissionPlanVersions.planVersionId, planVersionId),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundException("Plan version not found");
      throw new ConflictException(
        "This version has already been earned against and cannot be changed. Create a new version instead.",
      );
    }
    return updated;
  }

  /**
   * The version governing `on`: the greatest `effective_from` at or before it.
   *
   * This is the whole dating model in one query. There is no end date to check
   * because there is none to store — the next version's start is this one's end,
   * so a gap cannot exist and an overlap cannot be expressed.
   */
  async resolveVersion(orgId: string, planId: string, on: string) {
    const [version] = await this.db
      .select()
      .from(crmCommissionPlanVersions)
      .where(
        and(
          eq(crmCommissionPlanVersions.orgId, orgId),
          eq(crmCommissionPlanVersions.planId, planId),
          lte(crmCommissionPlanVersions.effectiveFrom, on),
        ),
      )
      .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
      .limit(1);
    if (!version)
      throw new NotFoundException(
        `No commission plan version was in force on ${on}`,
      );
    return version;
  }

  // ── Assignments ──────────────────────────────────────────────────────────

  async assign(orgId: string, planId: string, input: AssignInput) {
    try {
      return await runInTenantTransaction(
        this.db,
        async (tx) => {
          const [plan] = await tx
            .select({ retiredOn: crmCommissionPlans.retiredOn })
            .from(crmCommissionPlans)
            .where(
              and(
                eq(crmCommissionPlans.orgId, orgId),
                eq(crmCommissionPlans.planId, planId),
              ),
            )
            .limit(1);
          if (!plan) throw new NotFoundException("Commission plan not found");
          if (plan.retiredOn)
            throw new ConflictException("This plan is retired and takes no new members");

          const [assignment] = await tx
            .insert(crmCommissionAssignments)
            .values({
              orgId,
              planId,
              userId: input.userId,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo,
              quotaOverrideMinor: input.quotaOverrideMinor,
            })
            .returning();
          return assignment;
        },
        { orgId },
      );
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "23505")
        throw new ConflictException(
          "This person already has an open commission assignment; end it before starting another",
        );
      throw e;
    }
  }

  async endAssignment(orgId: string, assignmentId: string, input: EndAssignmentInput) {
    const [updated] = await runInTenantTransaction(
      this.db,
      (tx) =>
        tx
          .update(crmCommissionAssignments)
          .set({ effectiveTo: input.effectiveTo, updatedAt: new Date() })
          .where(
            and(
              eq(crmCommissionAssignments.orgId, orgId),
              eq(crmCommissionAssignments.assignmentId, assignmentId),
              gte(sql`${input.effectiveTo}::date`, crmCommissionAssignments.effectiveFrom),
            ),
          )
          .returning(),
      { orgId },
    );
    if (!updated)
      throw new NotFoundException(
        "Assignment not found, or the end date precedes its start",
      );
    return updated;
  }

  /** The assignment covering a date; null when the person was on no plan then. */
  private async assignmentOn(tx: TenantTx, orgId: string, userId: string, on: string) {
    const [assignment] = await tx
      .select()
      .from(crmCommissionAssignments)
      .where(
        and(
          eq(crmCommissionAssignments.orgId, orgId),
          eq(crmCommissionAssignments.userId, userId),
          lte(crmCommissionAssignments.effectiveFrom, on),
          or(
            isNull(crmCommissionAssignments.effectiveTo),
            gte(crmCommissionAssignments.effectiveTo, on),
          ),
        ),
      )
      .orderBy(desc(crmCommissionAssignments.effectiveFrom))
      .limit(1);
    return assignment ?? null;
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
    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const [deal] = await tx
          .select({
            id: deals.id,
            stage: deals.stage,
            valueMinor: deals.valueMinor,
            actualCloseDate: deals.actualCloseDate,
            assignedToId: deals.assignedToId,
          })
          .from(deals)
          .where(
            and(eq(deals.orgId, orgId), eq(deals.id, input.dealId), isNull(deals.deletedAt)),
          )
          .limit(1);
        if (!deal) throw new NotFoundException("Deal not found");

        const wonStages = await this.wonStageKeys(tx, orgId);
        if (!wonStages.includes(deal.stage))
          throw new BadRequestException(
            "Commission is earned on a won deal; this one is in stage " + deal.stage,
          );
        // The close date is the whole dating model's input. Refusing rather than
        // falling back to today is the point: "today" would make the same deal
        // compute differently depending on when somebody pressed the button.
        if (!deal.actualCloseDate)
          throw new BadRequestException(
            "This deal has no actual close date, so there is no date to price it on",
          );
        if (!deal.assignedToId)
          throw new BadRequestException("This deal has no owner to credit");

        const earnedOn = deal.actualCloseDate;
        const userId = deal.assignedToId;

        const assignment = await this.assignmentOn(tx, orgId, userId, earnedOn);
        if (!assignment)
          throw new BadRequestException(
            `The deal owner was on no commission plan on ${earnedOn}`,
          );

        const [version] = await tx
          .select()
          .from(crmCommissionPlanVersions)
          .where(
            and(
              eq(crmCommissionPlanVersions.orgId, orgId),
              eq(crmCommissionPlanVersions.planId, assignment.planId),
              lte(crmCommissionPlanVersions.effectiveFrom, earnedOn),
            ),
          )
          .orderBy(desc(crmCommissionPlanVersions.effectiveFrom))
          .limit(1);
        if (!version)
          throw new BadRequestException(
            `No version of this commission plan was in force on ${earnedOn}`,
          );

        const [plan] = await tx
          .select({ currency: crmCommissionPlans.currency })
          .from(crmCommissionPlans)
          .where(
            and(
              eq(crmCommissionPlans.orgId, orgId),
              eq(crmCommissionPlans.planId, assignment.planId),
            ),
          )
          .limit(1);

        const window = periodWindow(version.rules.period, earnedOn);
        const priorBasisMinor = await this.attainmentToDate(
          tx,
          orgId,
          userId,
          assignment.planId,
          window,
          String(deal.id),
        );

        const evaluation = evaluateCommission(version.rules, {
          basisMinor: deal.valueMinor,
          priorBasisMinor,
          quotaOverrideMinor: assignment.quotaOverrideMinor,
        });

        /**
         * `onConflictDoNothing`, then read back. The unique index on
         * (org, source_type, source_id, user) is what makes a retried request a
         * no-op instead of a second payment; without the read-back the caller
         * could not tell "already calculated" from "failed".
         */
        const [inserted] = await tx
          .insert(crmCommissionEarnings)
          .values({
            orgId,
            planId: assignment.planId,
            planVersionId: version.planVersionId,
            userId,
            earnedOn,
            periodStart: window.start,
            periodEnd: window.end,
            sourceType: "deal",
            sourceId: String(deal.id),
            basisMinor: deal.valueMinor,
            priorBasisMinor,
            amountMinor: evaluation.amountMinor,
            currency: plan?.currency ?? "INR",
            effectiveRateBps: clampToInt4(evaluation.effectiveRateBps),
            attainmentBps:
              evaluation.attainmentBps === null
                ? null
                : clampToInt4(evaluation.attainmentBps),
            computation: {
              quotaMinor: evaluation.quotaMinor,
              capped: evaluation.capped,
              slices: evaluation.slices,
              rules: version.rules,
              planVersionNumber: version.versionNumber,
              versionEffectiveFrom: version.effectiveFrom,
            },
          })
          .onConflictDoNothing()
          .returning();

        if (inserted) {
          /**
           * Accrue in the same transaction as the earning. This is what makes
           * accrual continuous rather than a month-end job: the figure people
           * watch and its decomposition move at the moment the deal is
           * calculated, not when somebody remembers to run something.
           *
           * Same transaction and not a follow-up call, because a request that
           * died between the two would leave an earning that no accrual counted
           * — and a figure that understates what somebody is owed, with nothing
           * on either row to say so. `recordAccrualForEarning` asserts that the
           * parts reconstruct `amountMinor` before it writes, so a decomposition
           * that does not add up takes the earning down with it rather than
           * being committed beside it.
           */
          await recordAccrualForEarning(tx, {
            orgId,
            earningId: inserted.earningId,
            userId,
            planId: assignment.planId,
            planVersionId: version.planVersionId,
            earnedOn,
            periodStart: window.start,
            periodEnd: window.end,
            sourceType: "deal",
            sourceId: String(deal.id),
            currency: plan?.currency ?? "INR",
            /**
             * The evaluation's own total, not the row read back.
             *
             * Parts and total then come from one evaluation, so the assertion
             * inside `recordAccrualForEarning` is checking that the
             * apportionment is self-consistent — which is the thing it can
             * actually prove. Whether the parts also match what was *persisted*
             * is a different claim, and the deferred constraint trigger
             * `trg_crm_commission_accrual_parts_reconcile` is what proves that,
             * against the stored row, at commit. Checking the same thing twice
             * against the same source would have looked like belt and braces
             * and been one strap.
             */
            amountMinor: evaluation.amountMinor,
            attainmentBps:
              evaluation.attainmentBps === null
                ? null
                : clampToInt4(evaluation.attainmentBps),
            parts: decomposeEvaluation(evaluation),
          });

          // Seal in the same transaction as the earning that sealed it. The
          // database trigger does this too; doing it here as well is what lets
          // the returned version be correct without a second round trip, and
          // keeps the property under unit test rather than only under a trigger
          // nothing hermetic can exercise.
          await tx
            .update(crmCommissionPlanVersions)
            .set({ sealedAt: new Date() })
            .where(
              and(
                eq(crmCommissionPlanVersions.orgId, orgId),
                eq(crmCommissionPlanVersions.planVersionId, version.planVersionId),
                isNull(crmCommissionPlanVersions.sealedAt),
              ),
            );
          return { earning: inserted, created: true };
        }

        const [existing] = await tx
          .select()
          .from(crmCommissionEarnings)
          .where(
            and(
              eq(crmCommissionEarnings.orgId, orgId),
              eq(crmCommissionEarnings.sourceType, "deal"),
              eq(crmCommissionEarnings.sourceId, String(deal.id)),
              eq(crmCommissionEarnings.userId, userId),
            ),
          )
          .limit(1);
        return { earning: existing ?? null, created: false };
      },
      { orgId },
    );
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

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Cumulative basis this earner has already booked in the window.
   *
   * `sum()` over a `bigint` column is `numeric`, which postgres-js hands back as
   * a string; `Number` on it is exact up to 2^53 minor units, which is ninety
   * trillion of any currency and past the point where a commission plan is the
   * problem. Coalesced because `sum()` over no rows is NULL, and NULL would
   * propagate into the evaluator as `NaN` and pay zero without failing.
   *
   * VOID rows are excluded and the deal itself is excluded, so a recalculation
   * of an existing earning walks the same bands it walked the first time.
   */
  private async attainmentToDate(
    tx: TenantTx,
    orgId: string,
    userId: string,
    planId: string,
    window: { start: string; end: string },
    excludeSourceId: string,
  ): Promise<number> {
    const [row] = await tx
      .select({
        total: sql<string>`coalesce(sum(${crmCommissionEarnings.basisMinor}), 0)`,
      })
      .from(crmCommissionEarnings)
      .where(
        and(
          eq(crmCommissionEarnings.orgId, orgId),
          eq(crmCommissionEarnings.userId, userId),
          eq(crmCommissionEarnings.planId, planId),
          gte(crmCommissionEarnings.earnedOn, window.start),
          lte(crmCommissionEarnings.earnedOn, window.end),
          ne(crmCommissionEarnings.status, "VOID"),
          ne(crmCommissionEarnings.sourceId, excludeSourceId),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /**
   * The stage keys the tenant treats as won.
   *
   * Resolved from the tenant's own pipeline metadata, with the same fallback
   * `crm-campaigns.service.ts` uses, so an organisation that never configured
   * pipelines still behaves. Hard-coding `"WON"` would silently pay nothing for
   * every tenant whose won stage is called something else.
   */
  private async wonStageKeys(tx: TenantTx, orgId: string): Promise<string[]> {
    const rows = await tx
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, orgId),
          inArray(crmPipelineStages.stageType, ["won"]),
        ),
      );
    return rows.length ? rows.map((r) => r.key) : ["WON", "Closed Won"];
  }
}
