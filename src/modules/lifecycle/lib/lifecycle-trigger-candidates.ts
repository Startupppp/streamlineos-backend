import { and, asc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { businessParties } from "../../../db/schema/party";
import { deals } from "../../../db/schema/crm/deals";
import { crmPipelines, crmPipelineStages } from "../../../db/schema/crm/metadata";
import {
  customerHealthAssessments,
  customerLifecycleTriggers,
  customerLifecycles,
  customerLifecycleSignals,
} from "../../../db/schema/crm/lifecycle";
import { addDays, calendarDateOf, formatIsoDate } from "../lifecycle-terms";
import { CHURN_TRIGGER_HEALTH_BAND, EXPANSION_WINDOW_DAYS, RENEWAL_LEAD_DAYS } from "../renewal-triggers";
import { AT_RISK_THRESHOLD as RISK_AT_RISK_THRESHOLD } from "../lifecycle-risk";
import type { LoadedCandidate } from "../lifecycle-triggers.types";

/*
  The two reads the renewal-trigger sweep makes before it decides anything,
  moved out of `LifecycleTriggersService` with the handle passed in. Every
  query still carries the organisation predicate explicitly.
*/

/**
 * The tenant's own first open stage on its default deal pipeline.
 *
 * Never the literal string "LEAD", which is what `deals.stage` defaults to. A
 * renewal filed under a stage key the tenant's pipeline does not contain is
 * invisible to every board that groups by stage, and `loadDeal`'s join would
 * find no `stage_type` for it.
 *
 * Null is an acceptable answer: an organisation that has configured no deal
 * pipeline still gets an opportunity, on the default stage, and `toDealState`
 * reads a stage with no row as `open` — which is what it is.
 */
export async function resolveOpeningStage(
  db: Db,
  organizationId: string,
): Promise<{ key: string; pipelineId: string } | null> {
  const [row] = await db
    .select({ key: crmPipelineStages.key, pipelineId: crmPipelineStages.pipelineId })
    .from(crmPipelineStages)
    .innerJoin(
      crmPipelines,
      and(
        eq(crmPipelines.orgId, crmPipelineStages.orgId),
        eq(crmPipelines.id, crmPipelineStages.pipelineId),
      ),
    )
    .where(
      and(
        eq(crmPipelineStages.orgId, organizationId),
        eq(crmPipelineStages.isActive, true),
        eq(crmPipelineStages.stageType, "open"),
        eq(crmPipelines.isDefault, true),
        eq(crmPipelines.isActive, true),
        eq(crmPipelines.type, "deal"),
        isNull(crmPipelines.deletedAt),
      ),
    )
    .orderBy(asc(crmPipelineStages.sortOrder))
    .limit(1);

  return row ?? null;
}

/**
 * The book, narrowed to what could possibly be due.
 *
 * The predicate below is a NARROWING, not a second copy of the judgement:
 * `decideTrigger` re-answers every candidate this returns, and the SQL is
 * written to be strictly wider than it. That is why the risk and health arms
 * are `>=`/`=` on the same constants the decider uses rather than an
 * approximation — a narrowing that excluded something the decider would have
 * acted on is a renewal that silently never opens, and no test of the decider
 * would catch it.
 *
 * A term that already has a trigger is always included, however far off its
 * renewal is, because the re-offer path is what eventually gets a declined
 * conversation written.
 */
export async function loadCandidates(
  db: Db,
  organizationId: string,
  opts: { asOf: Date; limit: number; customerLifecycleId: string | null },
): Promise<LoadedCandidate[]> {
  const horizon = formatIsoDate(addDays(calendarDateOf(opts.asOf), RENEWAL_LEAD_DAYS));
  /**
   * The oldest expansion signal still worth acting on; see
   * `EXPANSION_WINDOW_DAYS`.
   *
   * An ISO string with an explicit cast rather than a `Date`. A raw `sql`
   * fragment carries no column type for Drizzle to serialise against, so the
   * driver receives a bare `Date` and refuses it — the query fails at run time
   * with a type error that no unit test and no typecheck can see. The cast is
   * what makes the comparison a timestamp one rather than a text one.
   */
  const expansionHorizon = new Date(
    opts.asOf.getTime() - EXPANSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const conditions: SQL[] = [eq(customerLifecycles.organizationId, organizationId)];
  if (opts.customerLifecycleId) {
    conditions.push(eq(customerLifecycles.customerLifecycleId, opts.customerLifecycleId));
  } else {
    conditions.push(eq(customerLifecycles.status, "active"));
    /**
     * The expansion arm widens what is loaded, and it has to.
     *
     * The other three arms are all about revenue leaving, so a healthy
     * customer whose renewal is a year out was never a candidate — which is
     * exactly the customer CRM-P2-07 is about. Without this arm the expansion
     * branch in `decideTrigger` would be unreachable in production while
     * passing every unit test, because the row it decides on would never be
     * selected.
     */
    const expansionInterested = sql`EXISTS (
      SELECT 1 FROM ${customerLifecycleSignals}
      WHERE ${customerLifecycleSignals.organizationId} = ${customerLifecycles.organizationId}
        AND ${customerLifecycleSignals.customerLifecycleId} = ${customerLifecycles.customerLifecycleId}
        AND ${customerLifecycleSignals.kind} = 'expansion-interest'
        AND ${customerLifecycleSignals.observedAt} >= ${expansionHorizon}::timestamp
    )`;
    const due = or(
      lte(customerLifecycles.renewalOn, horizon),
      gte(customerLifecycles.riskScore, RISK_AT_RISK_THRESHOLD),
      eq(customerHealthAssessments.healthStatus, CHURN_TRIGGER_HEALTH_BAND),
      expansionInterested,
      sql`${customerLifecycleTriggers.customerLifecycleTriggerId} IS NOT NULL`,
    );
    if (due) conditions.push(due);
  }

  return db
    .select({
      customerLifecycleId: customerLifecycles.customerLifecycleId,
      partyId: customerLifecycles.partyId,
      status: customerLifecycles.status,
      startedOn: customerLifecycles.startedOn,
      renewalOn: customerLifecycles.renewalOn,
      riskScore: customerLifecycles.riskScore,
      lastSignalAt: customerLifecycles.lastSignalAt,
      /**
       * When this customer last said they wanted more.
       *
       * A correlated MAX rather than a join, because a join on the signals
       * table multiplies the candidate rows by every signal on the lifecycle
       * and this query already left-joins four tables. `expansion-interest` is
       * the only kind read here — the rest of the signal history is what the
       * risk score is for.
       */
      /*
        Typed as text, because that is what comes back. A raw `sql` fragment
        carries no column mapping, so Drizzle hands the driver's own value
        through untouched — `sql<Date | null>` would have been a cast asserting
        something false, and the first thing to call a Date method on it would
        throw at run time with every typecheck green. Converted at the use
        site, once, in `toTriggerCandidate`.
      */
      expansionSignalAt: sql<string | null>`(
        SELECT MAX(${customerLifecycleSignals.observedAt})
        FROM ${customerLifecycleSignals}
        WHERE ${customerLifecycleSignals.organizationId} = ${customerLifecycles.organizationId}
          AND ${customerLifecycleSignals.customerLifecycleId} = ${customerLifecycles.customerLifecycleId}
          AND ${customerLifecycleSignals.kind} = 'expansion-interest'
      )`,
      contractValueMinor: customerLifecycles.contractValueMinor,
      healthScore: customerHealthAssessments.score,
      healthStatus: customerHealthAssessments.healthStatus,
      partyName: businessParties.name,
      companyName: businessParties.companyName,
      ownerUserId: deals.assignedToId,
      triggerId: customerLifecycleTriggers.customerLifecycleTriggerId,
      triggerKind: customerLifecycleTriggers.kind,
      dueOn: customerLifecycleTriggers.dueOn,
      opportunityDealId: customerLifecycleTriggers.opportunityDealId,
      attempts: customerLifecycleTriggers.attempts,
      lastAttemptAt: customerLifecycleTriggers.lastAttemptAt,
      autonomyHoldId: customerLifecycleTriggers.autonomyHoldId,
    })
    .from(customerLifecycles)
    /**
     * Joined on the TERM, not on the lifecycle. A renewal advances
     * `started_on`, so this finds the trigger for the term the contract is in
     * now and finds nothing for the term it has just entered — which is what
     * makes the next renewal open its own conversation rather than being
     * suppressed by last year's row.
     */
    .leftJoin(
      customerLifecycleTriggers,
      and(
        eq(customerLifecycleTriggers.organizationId, customerLifecycles.organizationId),
        eq(customerLifecycleTriggers.customerLifecycleId, customerLifecycles.customerLifecycleId),
        eq(customerLifecycleTriggers.termStartedOn, customerLifecycles.startedOn),
      ),
    )
    .leftJoin(
      customerHealthAssessments,
      and(
        eq(customerHealthAssessments.organizationId, customerLifecycles.organizationId),
        eq(customerHealthAssessments.partyId, customerLifecycles.partyId),
      ),
    )
    .leftJoin(
      businessParties,
      and(
        eq(businessParties.organizationId, customerLifecycles.organizationId),
        eq(businessParties.partyId, customerLifecycles.partyId),
      ),
    )
    /**
     * The source deal, for its assignee and nothing else. Left, and soft-delete
     * aware: a deleted source deal leaves `ownerUserId` null, which the
     * opportunity path refuses on rather than treating as "assign it to
     * nobody".
     */
    .leftJoin(
      deals,
      and(
        eq(deals.orgId, customerLifecycles.organizationId),
        eq(deals.id, customerLifecycles.sourceDealId),
        isNull(deals.deletedAt),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(customerLifecycles.renewalOn))
    .limit(opts.limit);
}
