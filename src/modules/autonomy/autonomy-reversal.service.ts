import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  autonomousDecisions,
  autonomyCorrections,
  businessParties,
  deals,
} from "../../db/schema";
import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import { DealsService } from "../deals/deals.service";
import { planReversal, type TargetState } from "./reversal-plan";
import { softDeletePartyWithMirror } from "../party/party-legacy-writer";
import type { ReverseDecisionInput } from "./dto/autonomy-review.schemas";

@Injectable()
export class AutonomyReversalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dealsService: DealsService,
  ) {}

  async reverseDecision(
    organizationId: string,
    userId: string,
    decisionId: string,
    input: ReverseDecisionInput,
  ) {
    const [decision] = await this.db
      .select({
        autonomousDecisionId: autonomousDecisions.autonomousDecisionId,
        kind: autonomousDecisions.kind,
        outcome: autonomousDecisions.outcome,
        reversibility: autonomousDecisions.reversibility,
        reversedAt: autonomousDecisions.reversedAt,
        dealId: autonomousDecisions.dealId,
        activityId: autonomousDecisions.activityId,
        partyId: autonomousDecisions.partyId,
        decision: autonomousDecisions.decision,
      })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      )
      .limit(1);

    if (!decision) throw new NotFoundException("Decision not found");

    const target = await this.loadTarget(organizationId, decision.kind, decision);
    const plan = planReversal(
      {
        kind: decision.kind,
        outcome: decision.outcome,
        reversibility: decision.reversibility,
        reversedAt: decision.reversedAt,
        dealId: decision.dealId,
        activityId: decision.activityId,
        partyId: decision.partyId,
        decision: decision.decision,
      },
      target,
    );

    if (!plan.ok) throw new ConflictException(plan.explanation);

    const claimed = await this.db
      .update(autonomousDecisions)
      .set({
        reversedAt: new Date(),
        reversedByUserId: userId,
        reversedReason: input.reason ?? null,
        outcome: "reversed",
      })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
          isNull(autonomousDecisions.reversedAt),
        ),
      )
      .returning({ id: autonomousDecisions.autonomousDecisionId });

    if (claimed.length === 0)
      throw new ConflictException("This was reversed by someone else a moment ago.");

    const { field, systemValue, humanValue } = await this.applyReversal(
      organizationId,
      userId,
      plan,
    );

    await this.db.insert(autonomyCorrections).values({
      organizationId,
      autonomousDecisionId: decisionId,
      kind: decision.kind,
      correctionType: "reversal",
      field,
      systemValue,
      humanValue,
      reason: input.reason ?? null,
      correctedByUserId: userId,
      consented: input.consented,
    });

    return { reversed: true, action: plan.action };
  }

  private async applyReversal(
    organizationId: string,
    userId: string,
    plan: Extract<ReturnType<typeof planReversal>, { ok: true }>,
  ): Promise<{ field: string; systemValue: string | null; humanValue: string | null }> {
    switch (plan.action) {
      case "restore-stage": {
        const moved = await this.dealsService.updateDeal(
          organizationId,
          userId,
          Number(plan.dealId),
          { stage: plan.toStage, stageChangeReason: "Reversed an autonomous stage change" },
          { kind: "human", userId },
        );

        if (!moved.ok)
          throw new ConflictException("The deal could not be moved back — it may have changed.");

        return { field: "stage", systemValue: plan.fromStage, humanValue: plan.toStage };
      }

      case "delete-activity": {
        await this.db
          .update(activities)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(activities.organizationId, organizationId),
              eq(activities.activityId, plan.activityId),
              isNull(activities.deletedAt),
            ),
          );

        return { field: "task", systemValue: "created", humanValue: "removed" };
      }

      case "delete-party": {
        const [live] = await this.db
          .select({ partyId: businessParties.partyId })
          .from(businessParties)
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              eq(businessParties.partyId, plan.partyId),
              isNull(businessParties.deletedAt),
            ),
          )
          .limit(1);
        if (live) await softDeletePartyWithMirror(this.db, organizationId, live.partyId);

        return { field: "party", systemValue: "created", humanValue: "removed" };
      }
    }
  }

  private async loadTarget(
    organizationId: string,
    kind: DecisionKind,
    decision: { dealId: string | null; activityId: string | null; partyId: string | null },
  ): Promise<TargetState> {
    if (kind === "stage.advanced") {
      const numeric = Number(decision.dealId);
      if (!decision.dealId || !Number.isInteger(numeric)) return null;

      const [row] = await this.db
        .select({ stage: deals.stage })
        .from(deals)
        .where(and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)))
        .limit(1);

      return row ? { kind: "deal", stage: row.stage } : null;
    }

    if (kind === "task.extracted" || kind === "activity.logged") {
      if (!decision.activityId) return null;

      const [row] = await this.db
        .select({ deletedAt: activities.deletedAt, completedAt: activities.completedAt })
        .from(activities)
        .where(
          and(
            eq(activities.organizationId, organizationId),
            eq(activities.activityId, decision.activityId),
          ),
        )
        .limit(1);

      return row ? { kind: "activity", deletedAt: row.deletedAt, completedAt: row.completedAt } : null;
    }

    if (kind === "party.created") {
      if (!decision.partyId) return null;

      const [row] = await this.db
        .select({ deletedAt: businessParties.deletedAt })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, organizationId),
            eq(businessParties.partyId, decision.partyId),
          ),
        )
        .limit(1);

      return row ? { kind: "party", deletedAt: row.deletedAt } : null;
    }

    return null;
  }
}
