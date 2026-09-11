import type { Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { deals } from "../../../db/schema/crm/deals";
import { customerLifecycleTriggers, type LifecycleTriggerKind } from "../../../db/schema/crm/lifecycle";
import type { DealsService } from "../../deals/deals.service";
import type { OutboundService } from "../../autonomy/outbound.service";
import { renewalNextStep, renewalOpportunityName } from "../renewal-triggers";
import type { LoadedCandidate, SweepEntry } from "../lifecycle-triggers.types";
import { resolveOpeningStage } from "./lifecycle-trigger-candidates";
import { base, messageOf } from "./lifecycle-trigger-shapes";

/**
 * What the opportunity and hand-off steps act through: the service's own
 * collaborators, passed in rather than reached for, so these steps have no
 * route to anything `LifecycleTriggersService` was not already given.
 */
export interface TriggerActionDeps {
  readonly db: Db;
  readonly deals: DealsService;
  readonly outbound: OutboundService;
  readonly logger: Logger;
}

/**
 * The renewal opportunity, created through the same door a person uses.
 *
 * `DealsService.createDeal` rather than an insert, so the plan limit, the
 * tenant's own field validation, the audit row, the cache invalidation and the
 * `deal.created` automation event all happen exactly as they do for a deal
 * somebody typed. A renewal that skipped the tenant's automations would be a
 * deal their own rules never saw.
 *
 * The owner is the source deal's assignee, and there is no fallback. The
 * outbound draft is written AS a named person — `judgeDraft` refuses with
 * `no-sender-name` when there is nobody — so a contract whose deal has no
 * assignee has no message to send, and inventing an owner would put a
 * colleague's name on a mail they never saw. Refusing here rather than letting
 * the loop refuse also saves a provider call the tenant would be billed for.
 */
export async function openOpportunity(
  deps: TriggerActionDeps,
  organizationId: string,
  candidate: LoadedCandidate,
  kind: LifecycleTriggerKind,
  dueOn: string,
  triggerId: string,
): Promise<number | { reason: string }> {
  if (!candidate.ownerUserId) {
    const reason = "Nobody owns the deal this contract came from, so there is nobody to write as.";
    await recordRefusal(deps.db, organizationId, triggerId, "opportunity", reason);
    return { reason };
  }

  const stage = await resolveOpeningStage(deps.db, organizationId);
  const customerName = candidate.companyName ?? candidate.partyName ?? "";

  let dealId: number;
  try {
    const created = await deps.deals.createDeal(organizationId, candidate.ownerUserId, {
      name: renewalOpportunityName(customerName, candidate.renewalOn, kind),
      /**
       * Major units here because that is what the route's schema takes, and
       * overwritten with the exact integer below before anything reads it.
       * The contract value is money and must not survive a float round trip;
       * this is the one statement where it briefly is one.
       */
      value: candidate.contractValueMinor / 100,
      stage: stage?.key,
      assignedToId: candidate.ownerUserId,
      expectedCloseDate: candidate.renewalOn,
      partyId: candidate.partyId,
    });

    if (!created) throw new Error("createDeal returned nothing");
    dealId = created.id;
  } catch (error) {
    const reason = `The renewal opportunity could not be opened: ${messageOf(error)}`;
    deps.logger.warn(`lifecycle trigger ${triggerId}: ${reason}`);
    await recordRefusal(deps.db, organizationId, triggerId, "opportunity", reason);
    return { reason };
  }

  /**
   * The four fields the create route cannot carry, and the reason the trigger
   * is worth anything at all.
   *
   * `next_step` and `follow_up_date` are what `loadComposeContext` reads as
   * `agreedNextStep` and `nextStepDueAt`; without them the loop sees an open
   * deal with nothing agreed and answers "nothing to say" until the
   * relationship has been silent for ten days. `pipeline_id` is what lets
   * `loadDeal` resolve a real `stage_type`, so the opportunity reads as closed
   * once somebody closes it. `value_minor` restores the exact integer.
   */
  await deps.db
    .update(deals)
    .set({
      valueMinor: candidate.contractValueMinor,
      nextStep: renewalNextStep(kind, candidate.renewalOn),
      followUpDate: new Date(`${dueOn}T00:00:00.000Z`),
      pipelineId: stage?.pipelineId ?? null,
    })
    .where(and(eq(deals.orgId, organizationId), eq(deals.id, dealId)));

  await deps.db
    .update(customerLifecycleTriggers)
    .set({ opportunityDealId: dealId })
    .where(
      and(
        eq(customerLifecycleTriggers.organizationId, organizationId),
        eq(customerLifecycleTriggers.customerLifecycleTriggerId, triggerId),
      ),
    );

  return dealId;
}

/**
 * Hand the opportunity to the outbound loop, and write down what it said.
 *
 * `composeAndHold` is the only call in this file that can result in a message,
 * and everything it does to earn that — the eligibility judgement, the kill
 * switch, the draft, the confidence floor, the hold window, and later the
 * guardrail snapshot and the cold gate — is unchanged and unbypassed. A
 * refusal is recorded with the loop's own sentence rather than a paraphrase,
 * because the trigger log's job is to say why a renewal went unwritten and a
 * paraphrase is where that answer stops being checkable.
 */
export async function offerToLoop(
  deps: TriggerActionDeps,
  organizationId: string,
  candidate: LoadedCandidate,
  triggerId: string,
  dealId: number,
  action: "opened" | "reoffered",
): Promise<SweepEntry> {
  let update: Partial<typeof customerLifecycleTriggers.$inferInsert>;
  let entry: Partial<SweepEntry>;

  try {
    const outcome = await deps.outbound.composeAndHold({
      organizationId,
      partyId: candidate.partyId,
      dealId: String(dealId),
    });

    if (outcome.held) {
      update = {
        outcome: "held",
        refusalStage: null,
        refusalReason: null,
        autonomyHoldId: outcome.autonomyHoldId,
        autonomousDecisionId: outcome.decisionId,
        outboundMessageId: outcome.outboundMessageId,
      };
      entry = { outcome: "held", reason: null, autonomyHoldId: outcome.autonomyHoldId };
    } else {
      update = {
        outcome: "skipped",
        refusalStage: outcome.stage,
        refusalReason: outcome.reason,
        autonomyHoldId: null,
        autonomousDecisionId: null,
        outboundMessageId: null,
      };
      entry = { outcome: "skipped", reason: outcome.reason };
    }
  } catch (error) {
    /**
     * An outage, a duplicate hold, a provider failure. Recorded as a refusal
     * with a stage of its own rather than thrown: one contract that could not
     * be considered must not end a sweep over two hundred of them, and a
     * failure nobody wrote down is indistinguishable from a trigger that never
     * fired — which is the same argument `recordRefusal` makes in
     * `outbound.service.ts`.
     */
    const reason = messageOf(error);
    deps.logger.warn(`lifecycle trigger ${triggerId}: the loop could not be reached — ${reason}`);
    update = {
      outcome: "skipped",
      refusalStage: "loop-error",
      refusalReason: reason,
      autonomyHoldId: null,
      autonomousDecisionId: null,
      outboundMessageId: null,
    };
    entry = { outcome: "skipped", reason };
  }

  await deps.db
    .update(customerLifecycleTriggers)
    .set({
      ...update,
      attempts: sql`${customerLifecycleTriggers.attempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(customerLifecycleTriggers.organizationId, organizationId),
        eq(customerLifecycleTriggers.customerLifecycleTriggerId, triggerId),
      ),
    );

  return { ...base(candidate, { action, triggerId }), ...entry, opportunityDealId: dealId };
}

async function recordRefusal(
  db: Db,
  organizationId: string,
  triggerId: string,
  stage: string,
  reason: string,
): Promise<void> {
  await db
    .update(customerLifecycleTriggers)
    .set({
      outcome: "skipped",
      refusalStage: stage,
      refusalReason: reason,
      autonomyHoldId: null,
      autonomousDecisionId: null,
      outboundMessageId: null,
      attempts: sql`${customerLifecycleTriggers.attempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(customerLifecycleTriggers.organizationId, organizationId),
        eq(customerLifecycleTriggers.customerLifecycleTriggerId, triggerId),
      ),
    );
}
