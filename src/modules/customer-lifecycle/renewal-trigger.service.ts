import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  autonomousDecisions,
  businessParties,
  crmPipelineStages,
  crmPipelines,
  dealStageTransitions,
  deals,
} from "../../db/schema";
import {
  customerHealthScores,
  customerLifecycleSignals,
  customerLifecycles,
} from "../../db/schema/crm/customer-lifecycle";
import { buildDecision } from "../autonomy/decision-record";
import { toTransitionRow } from "../deals/deal-stage-ledger";
import {
  evaluateRenewalTriggers,
  renewalLeadTime,
  type CompletedRenewalCycle,
  type LifecycleForTrigger,
  type RenewalLeadTime,
  type RenewalTrigger,
} from "./renewal-triggers";

/**
 * Turning a trigger into an opportunity the existing loops already know how to work.
 *
 * Ticket 09, and the shape of it is a refusal to build anything. There is no
 * retention queue here, no outreach, no schedule and no hold. A trigger produces
 * a deal in the tenant's own pipeline, a stage-transition row in the ledger every
 * other deal writes to, a signal on the customer's history, and a decision record
 * of the same kind and through the same builder as every other autonomous
 * conclusion. Everything after that is machinery that already exists:
 * `outbound-eligibility.ts` sees an open deal on a relationship, `outbound-draft`
 * writes to it, `send-guardrails.ts` decides at send time whether it may leave,
 * and `autonomy-hold.workflow.ts` holds it. A second autonomy model would mean
 * two answers to "may this go out", and the one nobody remembered to update
 * would be the one that let something through.
 */

/**
 * What the ledger says made this happen.
 *
 * Also the key the lead-time history is read back by: a completed renewal is a
 * deal this trigger opened that has since closed, and the decision row is the
 * only thing that records which deals those were.
 */
export const RENEWAL_TRIGGER_SOURCE = "customer-lifecycle.renewal-sweep";

/** What the stage ledger shows as the actor. Never a person's name. */
const TRIGGER_ACTOR = "Renewal triggers";

/**
 * The decision kind a trigger is recorded under.
 *
 * `stage.advanced` and not a new kind, and the reasoning is worth stating
 * because the alternative was tempting. What the system concludes here is that a
 * customer's lifecycle has moved out of `active` — into `renewal_open` or
 * `at_risk` — and the opportunity is the consequence of that move rather than a
 * separate act. That is a stage advance the system made on its own: undone by a
 * single reversing write, costly when wrong because it puts a value into a
 * forecast people plan against, and reviewed on exactly the same feed. Both the
 * reversibility class and the act threshold `decision-record.ts` gives
 * `stage.advanced` are the right ones for it.
 *
 * `shouldAct` is deliberately never consulted. A trigger is a rule over dates
 * and a stored score, not a model output, so there is no confidence to compare
 * against a threshold — the row records `confidence: null` for the same reason
 * `field.repaired` does.
 */
const TRIGGER_DECISION_KIND = "stage.advanced" as const;

/** Terminal stage keys for tenants who never configured a pipeline. */
const FALLBACK_CLOSED_STAGE_KEYS = [
  "WON",
  "LOST",
  "CLOSED_WON",
  "CLOSED_LOST",
  "CONVERTED",
] as const;

/** How many contracts one sweep considers. Bounded for the reason the other sweep is. */
const SWEEP_LIMIT = 500;

/** How many past renewals the lead time is derived from. */
const HISTORY_LIMIT = 100;

export interface TriggerSweepResult {
  readonly leadTimeDays: number;
  readonly leadTimeSource: RenewalLeadTime["source"];
  readonly leadTimeSampleCount: number;
  readonly considered: number;
  readonly opened: number;
}

@Injectable()
export class RenewalTriggerService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * One pass over a tenant's contracts.
   *
   * The lead time is computed once per sweep rather than per contract, because
   * it is a property of the tenant rather than of the customer — how long THIS
   * business takes to get a renewal to a conclusion. The term used for the
   * fallback is the median term across the contracts considered, so a tenant
   * selling monthly and annual plans falls back to something that describes them
   * rather than to whichever contract happened to sort first.
   */
  async sweep(orgId: string, now: Date = new Date()): Promise<TriggerSweepResult> {
    const lifecycles = await this.loadLifecycles(orgId);
    if (lifecycles.length === 0)
      return {
        leadTimeDays: 0,
        leadTimeSource: "term-fallback",
        leadTimeSampleCount: 0,
        considered: 0,
        opened: 0,
      };

    const history = await this.completedRenewalCycles(orgId);
    const leadTime = renewalLeadTime(history, medianTermMonths(lifecycles));

    const triggers = evaluateRenewalTriggers({ now, leadTime, lifecycles });

    let opened = 0;
    for (const trigger of triggers) if (await this.openOpportunity(orgId, trigger, now)) opened += 1;

    return {
      leadTimeDays: leadTime.days,
      leadTimeSource: leadTime.source,
      leadTimeSampleCount: leadTime.sampleCount,
      considered: lifecycles.length,
      opened,
    };
  }

  /**
   * Everything the judgement needs, gathered in four bounded reads.
   *
   * The open-opportunity flag is the one that matters most: without it a nightly
   * sweep opens one renewal deal per night against the same contract, and the
   * feature meant to protect a tenant's revenue destroys their forecast instead.
   */
  private async loadLifecycles(orgId: string): Promise<LifecycleForTrigger[]> {
    const rows = await this.db
      .select({
        customerLifecycleId: customerLifecycles.customerLifecycleId,
        partyId: customerLifecycles.partyId,
        stage: customerLifecycles.stage,
        termMonths: customerLifecycles.termMonths,
        contractValueMinor: customerLifecycles.contractValueMinor,
        currencyCode: customerLifecycles.currencyCode,
        renewalDate: customerLifecycles.renewalDate,
      })
      .from(customerLifecycles)
      .where(
        and(
          eq(customerLifecycles.organizationId, orgId),
          notInArray(customerLifecycles.stage, ["renewed", "churned"]),
        ),
      )
      .orderBy(customerLifecycles.renewalDate)
      .limit(SWEEP_LIMIT);

    if (rows.length === 0) return [];

    const partyIds = [...new Set(rows.map((row) => row.partyId))];
    const closedKeys = await this.closedStageKeys(orgId);

    const [names, openDeals, scores] = await Promise.all([
      this.db
        .select({ partyId: businessParties.partyId, name: businessParties.name })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, orgId),
            inArray(businessParties.partyId, partyIds),
          ),
        ),
      this.db
        .select({ partyId: deals.partyId })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            inArray(deals.partyId, partyIds),
            notInArray(deals.stage, closedKeys),
            isNull(deals.deletedAt),
          ),
        ),
      this.db
        .select({
          partyId: customerHealthScores.partyId,
          score: customerHealthScores.score,
          band: customerHealthScores.band,
          computedAt: customerHealthScores.computedAt,
        })
        .from(customerHealthScores)
        .where(
          and(
            eq(customerHealthScores.organizationId, orgId),
            inArray(customerHealthScores.partyId, partyIds),
          ),
        )
        .orderBy(desc(customerHealthScores.computedAt))
        .limit(partyIds.length),
    ]);

    const nameOf = new Map(names.map((row) => [row.partyId, row.name]));
    const busy = new Set(openDeals.map((row) => row.partyId).filter(Boolean));
    const latestHealth = new Map<string, LifecycleForTrigger["latestHealth"]>();
    for (const score of scores)
      if (!latestHealth.has(score.partyId))
        latestHealth.set(score.partyId, {
          score: score.score,
          band: score.band,
          computedAt: score.computedAt,
        });

    return rows.map((row) => ({
      customerLifecycleId: row.customerLifecycleId,
      partyId: row.partyId,
      customerName: nameOf.get(row.partyId) ?? "This customer",
      stage: row.stage,
      termMonths: row.termMonths,
      contractValueMinor: row.contractValueMinor,
      currencyCode: row.currencyCode,
      renewalDate: row.renewalDate,
      hasOpenOpportunity: busy.has(row.partyId),
      latestHealth: latestHealth.get(row.partyId) ?? null,
    }));
  }

  /**
   * The tenant's own renewal cycle, read out of the decision ledger.
   *
   * A completed renewal is an opportunity this sweep opened that has since
   * reached a terminal stage. The decision row is what records which deals those
   * were — there is no "is this a renewal" column on `deals`, and adding one
   * would be a second place the same fact lives. A tenant who has never been
   * through one this way has no history and gets the stated fallback, which is
   * the honest answer rather than a borrowed benchmark from another tenant.
   */
  private async completedRenewalCycles(orgId: string): Promise<CompletedRenewalCycle[]> {
    const decisions = await this.db
      .select({
        dealId: autonomousDecisions.dealId,
        decidedAt: autonomousDecisions.decidedAt,
      })
      .from(autonomousDecisions)
      .where(
        and(
          eq(autonomousDecisions.organizationId, orgId),
          eq(autonomousDecisions.triggerType, RENEWAL_TRIGGER_SOURCE),
        ),
      )
      .orderBy(desc(autonomousDecisions.decidedAt))
      .limit(HISTORY_LIMIT);

    const openedAt = new Map<number, Date>();
    for (const decision of decisions) {
      const id = Number(decision.dealId);
      if (!Number.isInteger(id)) continue;
      // Newest first, so the first row for a deal is the decision that opened it.
      if (!openedAt.has(id)) openedAt.set(id, decision.decidedAt);
    }
    if (openedAt.size === 0) return [];

    const closedKeys = await this.closedStageKeys(orgId);
    const closed = await this.db
      .select({ id: deals.id, stage: deals.stage, updatedAt: deals.updatedAt })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          inArray(deals.id, [...openedAt.keys()]),
          inArray(deals.stage, closedKeys),
        ),
      );

    return closed
      .map((deal) => ({ openedAt: openedAt.get(deal.id)!, closedAt: deal.updatedAt }))
      .filter((cycle) => cycle.closedAt.getTime() >= cycle.openedAt.getTime());
  }

  private async closedStageKeys(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, orgId),
          inArray(crmPipelineStages.stageType, ["won", "lost"]),
        ),
      );

    const keys = [...new Set([...rows.map((row) => row.key), ...FALLBACK_CLOSED_STAGE_KEYS])];
    return keys;
  }

  /**
   * Where a new deal enters the tenant's own pipeline.
   *
   * The first non-terminal stage of their default deal pipeline, by the order
   * they arranged it in. A bespoke "Renewal" stage would keep renewals out of
   * every forecast, conversion report and stage-duration figure the tenant
   * already has — which is precisely the parallel machine this ticket refuses.
   * Falls back to the column's own default when a tenant has no pipeline
   * configured, because that is what every other new deal gets.
   */
  private async entryStage(
    orgId: string,
  ): Promise<{ pipelineId: string | null; stage: string; probability: number }> {
    const [pipeline] = await this.db
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(
        and(
          eq(crmPipelines.orgId, orgId),
          eq(crmPipelines.type, "deal"),
          eq(crmPipelines.isActive, true),
          isNull(crmPipelines.deletedAt),
        ),
      )
      .orderBy(desc(crmPipelines.isDefault), crmPipelines.sortOrder)
      .limit(1);

    if (!pipeline) return { pipelineId: null, stage: "LEAD", probability: 0 };

    const [stage] = await this.db
      .select({ key: crmPipelineStages.key, probability: crmPipelineStages.probability })
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, orgId),
          eq(crmPipelineStages.pipelineId, pipeline.id),
          eq(crmPipelineStages.isActive, true),
          eq(crmPipelineStages.isTerminal, false),
        ),
      )
      .orderBy(crmPipelineStages.sortOrder)
      .limit(1);

    return {
      pipelineId: pipeline.id,
      stage: stage?.key ?? "LEAD",
      probability: stage?.probability ?? 0,
    };
  }

  /**
   * The whole of what a trigger does, in one transaction.
   *
   * Four writes that have to happen together or not at all: the opportunity, the
   * stage ledger entry that says the system opened it, the lifecycle's own move,
   * and the decision record. A partial application here is the worst outcome
   * available — a deal in somebody's pipeline that no decision row explains, or
   * a lifecycle marked `renewal_open` with nothing open.
   */
  private async openOpportunity(
    orgId: string,
    trigger: RenewalTrigger,
    now: Date,
  ): Promise<boolean> {
    const entry = await this.entryStage(orgId);

    await this.db.transaction(async (tx) => {
      /**
       * Inserted here rather than through `DealsCrudService`, and the trade is
       * worth stating. Going through that service would pull `DealsModule` and
       * with it notifications, automation, webhooks, billing and activities into
       * this module's graph for one write — and would attribute the deal to
       * whichever user happened to trigger the sweep. What it would also bring
       * is the plan-limit check and the tenant's own field-validation rules,
       * and those are genuinely skipped here: a tenant at their deal cap gets a
       * renewal opportunity anyway, and a required custom field is not enforced
       * on it. Both are the right way round for a record the system opens on a
       * customer's behalf — refusing to warn somebody their revenue is at risk
       * because of a seat count would be the wrong failure — but neither is an
       * oversight, and a caller who needs them should move this write rather
       * than add a second one beside it.
       */
      const [created] = await tx
        .insert(deals)
        .values({
          orgId,
          name: trigger.opportunity.name,
          valueMinor: trigger.opportunity.valueMinor,
          stage: entry.stage,
          partyId: trigger.partyId,
          pipelineId: entry.pipelineId,
          probability: entry.probability,
          expectedCloseDate: trigger.opportunity.expectedCloseDate,
          notes: trigger.opportunity.reason,
        })
        .returning({ id: deals.id });

      if (!created) throw new Error("renewal trigger: the opportunity insert returned no row");

      // The ledger every other deal writes to, with the system named as the
      // actor. `toTransitionRow` is what keeps the actor columns mutually
      // exclusive, which is the invariant the CHECK holds at the other end.
      await tx.insert(dealStageTransitions).values(
        toTransitionRow({
          organizationId: orgId,
          dealId: created.id,
          pipelineId: entry.pipelineId,
          fromStage: null,
          toStage: entry.stage,
          actor: { kind: "system", label: TRIGGER_ACTOR },
          reason: trigger.opportunity.reason,
        }),
      );

      await tx
        .update(customerLifecycles)
        .set({ stage: trigger.nextStage, updatedAt: now })
        .where(
          and(
            eq(customerLifecycles.organizationId, orgId),
            eq(customerLifecycles.customerLifecycleId, trigger.customerLifecycleId),
          ),
        );

      await tx.insert(customerLifecycleSignals).values({
        organizationId: orgId,
        customerLifecycleId: trigger.customerLifecycleId,
        partyId: trigger.partyId,
        kind: trigger.signal.kind,
        evidence: { ...trigger.signal.evidence, openedDealId: created.id },
        reversibility: trigger.signal.reversibility,
        summary: trigger.signal.summary,
        observedAt: trigger.signal.observedAt,
      });

      await tx.insert(autonomousDecisions).values(
        buildDecision({
          organizationId: orgId,
          kind: TRIGGER_DECISION_KIND,
          outcome: "applied",
          triggerType: RENEWAL_TRIGGER_SOURCE,
          triggerId: trigger.customerLifecycleId,
          partyId: trigger.partyId,
          dealId: String(created.id),
          // A rule, not a model. See the note on TRIGGER_DECISION_KIND.
          confidence: null,
          inputs: { ...trigger.signal.evidence, triggerKind: trigger.kind },
          decision: {
            openedDealId: created.id,
            pipelineId: entry.pipelineId,
            stage: entry.stage,
            valueMinor: trigger.opportunity.valueMinor,
            currencyCode: trigger.opportunity.currencyCode,
            expectedCloseDate: trigger.opportunity.expectedCloseDate,
            lifecycleStage: trigger.nextStage,
          },
          summary: trigger.signal.summary,
        }),
      );
    });

    return true;
  }
}

/**
 * The term the fallback lead time is built from, when there is no history.
 *
 * A median rather than a mean: a tenant with fifty annual contracts and one
 * ten-year one should fall back to something that describes the fifty.
 */
function medianTermMonths(lifecycles: readonly LifecycleForTrigger[]): number {
  const terms = lifecycles.map((lifecycle) => lifecycle.termMonths).sort((a, b) => a - b);
  const middle = Math.floor(terms.length / 2);
  return terms[middle] ?? 12;
}
