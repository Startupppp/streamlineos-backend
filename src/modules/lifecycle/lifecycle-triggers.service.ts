import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema/party";
import { deals } from "../../db/schema/crm/deals";
import { crmPipelines, crmPipelineStages } from "../../db/schema/crm/metadata";
import {
  customerHealthAssessments,
  customerLifecycleTriggers,
  customerLifecycles,
  customerLifecycleSignals,
  type LifecycleTriggerKind,
} from "../../db/schema/crm/lifecycle";
import { DealsService } from "../deals/deals.service";
import { OutboundService } from "../autonomy/outbound.service";
import { addDays, calendarDateOf, formatIsoDate } from "./lifecycle-terms";
import {
  CHURN_TRIGGER_HEALTH_BAND,
  EXPANSION_WINDOW_DAYS,
  RENEWAL_LEAD_DAYS,
  decideTrigger,
  renewalNextStep,
  renewalOpportunityName,
  type TriggerCandidate,
  type TriggerDecision,
} from "./renewal-triggers";
import { AT_RISK_THRESHOLD as RISK_AT_RISK_THRESHOLD } from "./lifecycle-risk";
import type { SweepTriggersQuery, ListTriggersQuery } from "./dto/triggers.schemas";

/**
 * Renewal and churn triggers, wired into the loops that already exist.
 *
 * There is no sender here, no hold, no guardrail and no second decision ledger.
 * A trigger does exactly three things: it decides a renewal conversation is due
 * (`renewal-triggers.ts`, pure), it opens the opportunity that conversation is
 * about (an ordinary deal, in the tenant's own pipeline, worked by the same
 * people who work everything else), and it hands that opportunity to
 * `OutboundService.composeAndHold` — the identical call the outbound route
 * makes for a message a person triggered.
 *
 * That is the whole design and the reason for it is worth stating. Every
 * protection on an autonomous message — the eligibility judgement, the hold
 * window a human can cancel inside, the late guardrail snapshot taken at the far
 * end of that window, the cold gate, the kill switch, the decision ledger —
 * lives behind that one call. A retention feature with its own send path would
 * have to reimplement each of them, and the reimplementation is always the one
 * missing the working-hours check.
 *
 * The opportunity is not decoration either. `judgeOutbound` refuses a won deal
 * outright ("the next message here is a person's"), so handing it the deal that
 * CREATED the lifecycle would produce a refusal every time; and handing it no
 * deal at all makes the relationship read as `none`, which only ever earns a
 * check-in after 45 days of silence. A renewal is an open opportunity, so the
 * trigger opens one — which is also the honest thing for the forecast, since a
 * renewal that nothing represents in the pipeline is revenue nobody has counted.
 *
 * Every query carries the organisation predicate explicitly. RLS is the
 * backstop; this reads what each customer pays and who owns them.
 *
 * This is now on the cron surface, and the reasoning that used to sit here still
 * holds: there is no `@nestjs/schedule` and no `@Cron` anywhere in `src/`, and
 * none was invented for this. What the repository has, and had all along, is 47
 * endpoints behind `assertCronSecret` that the deployment's own scheduler drives
 * — billing, HR, notifications, support and Build all reach their sweeps that
 * way. The renewal loop simply was not on it.
 *
 * `CronCrmLifecycleService` (`POST /cron/crm-lifecycle-triggers-sweep`) walks the
 * organisations and calls THIS, which is what the export was for. The decision
 * about what is due, what has already been offered and whether to open a
 * conversation stays here, in one place.
 *
 * `POST /crm/lifecycle-triggers/sweep` remains, for one tenant on demand.
 */
@Injectable()
export class LifecycleTriggersService {
  private readonly logger = new Logger("LifecycleTriggers");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly deals: DealsService,
    private readonly outbound: OutboundService,
  ) {}

  // ── The sweep ─────────────────────────────────────────────────────────────

  /**
   * Consider the renewal book and offer what is due to the outbound loop.
   *
   * Bounded by `limit` rather than running the whole book, because each due
   * candidate can cost a provider call and an unbounded sweep is an unbounded
   * bill. The order is the renewal date, so a truncated sweep truncates the far
   * end of the book rather than an arbitrary slice of it — the contracts left
   * for the next pass are the ones with the most time left.
   */
  async sweep(organizationId: string, query: SweepTriggersQuery): Promise<SweepReport> {
    const asOf = query.asOf ?? new Date();
    const candidates = await this.loadCandidates(organizationId, {
      asOf,
      limit: query.limit,
      customerLifecycleId: null,
    });

    const entries: SweepEntry[] = [];
    for (const candidate of candidates) {
      entries.push(await this.act(organizationId, candidate, asOf));
    }

    return {
      asOf,
      considered: candidates.length,
      opened: entries.filter((e) => e.action === "opened").length,
      reoffered: entries.filter((e) => e.action === "reoffered").length,
      held: entries.filter((e) => e.outcome === "held").length,
      entries,
    };
  }

  /**
   * The same decision for one contract, on demand.
   *
   * It runs `decideTrigger` rather than skipping it. A "force" door that opened
   * a conversation the decider would have stood down on would be a second set of
   * rules reachable by anybody with the key, and the first thing it would bypass
   * is the once-per-term claim.
   */
  async consider(
    organizationId: string,
    customerLifecycleId: string,
    asOf: Date = new Date(),
  ): Promise<SweepEntry> {
    const [candidate] = await this.loadCandidates(organizationId, {
      asOf,
      limit: 1,
      customerLifecycleId,
    });

    if (!candidate) throw new NotFoundException("No such customer lifecycle.");
    return this.act(organizationId, candidate, asOf);
  }

  /** The trigger log: what fired, why, and what the loop said. Newest first. */
  async list(organizationId: string, query: ListTriggersQuery) {
    const conditions: SQL[] = [eq(customerLifecycleTriggers.organizationId, organizationId)];
    if (query.kind) conditions.push(eq(customerLifecycleTriggers.kind, query.kind));
    if (query.outcome) conditions.push(eq(customerLifecycleTriggers.outcome, query.outcome));
    if (query.partyId) conditions.push(eq(customerLifecycleTriggers.partyId, query.partyId));

    const rows = await this.db
      .select({
        customerLifecycleTriggerId: customerLifecycleTriggers.customerLifecycleTriggerId,
        customerLifecycleId: customerLifecycleTriggers.customerLifecycleId,
        partyId: customerLifecycleTriggers.partyId,
        partyName: businessParties.name,
        kind: customerLifecycleTriggers.kind,
        termStartedOn: customerLifecycleTriggers.termStartedOn,
        renewalOn: customerLifecycleTriggers.renewalOn,
        dueOn: customerLifecycleTriggers.dueOn,
        riskScore: customerLifecycleTriggers.riskScore,
        healthScore: customerLifecycleTriggers.healthScore,
        opportunityDealId: customerLifecycleTriggers.opportunityDealId,
        attempts: customerLifecycleTriggers.attempts,
        lastAttemptAt: customerLifecycleTriggers.lastAttemptAt,
        outcome: customerLifecycleTriggers.outcome,
        refusalStage: customerLifecycleTriggers.refusalStage,
        refusalReason: customerLifecycleTriggers.refusalReason,
        autonomyHoldId: customerLifecycleTriggers.autonomyHoldId,
        autonomousDecisionId: customerLifecycleTriggers.autonomousDecisionId,
        outboundMessageId: customerLifecycleTriggers.outboundMessageId,
        firedAt: customerLifecycleTriggers.firedAt,
      })
      .from(customerLifecycleTriggers)
      /**
       * An explicit join rather than the relational include API. `deals`,
       * `business_parties` and this table sit in three schema files that already
       * import each other's neighbours, and a relation declared across them is
       * the import cycle this codebase has paid for once.
       */
      .leftJoin(
        businessParties,
        and(
          eq(businessParties.organizationId, customerLifecycleTriggers.organizationId),
          eq(businessParties.partyId, customerLifecycleTriggers.partyId),
        ),
      )
      .where(and(...conditions))
      .orderBy(sql`${customerLifecycleTriggers.firedAt} DESC`)
      .limit(query.limit)
      .offset(query.offset);

    return { triggers: rows, limit: query.limit, offset: query.offset };
  }

  // ── Acting on one candidate ───────────────────────────────────────────────

  private async act(
    organizationId: string,
    candidate: LoadedCandidate,
    asOf: Date,
  ): Promise<SweepEntry> {
    const decision = decideTrigger(toTriggerCandidate(candidate, asOf));

    if (decision.action === "stand-down")
      return base(candidate, { action: "stood-down", reason: decision.reason });

    if (decision.action === "reoffer") {
      const triggerId = candidate.triggerId;
      // Unreachable: `decideTrigger` only returns `reoffer` when `existing` is
      // set, and `existing` is set only when this id is. Narrowing, not a check.
      if (!triggerId) return base(candidate, { action: "stood-down", reason: "not-due" });

      const dealId = candidate.opportunityDealId
        ? candidate.opportunityDealId
        : await this.openOpportunity(organizationId, candidate, candidate.triggerKind ?? "renewal-due", candidate.dueOn ?? formatIsoDate(calendarDateOf(asOf)), triggerId);

      if (typeof dealId !== "number")
        return base(candidate, { action: "stood-down", reason: dealId.reason });

      return this.offerToLoop(organizationId, candidate, triggerId, dealId, "reoffered");
    }

    return this.open(organizationId, candidate, decision, asOf);
  }

  /**
   * Claim the term, then open the opportunity, then hand it over.
   *
   * The claim is FIRST and it is an insert, not a read-then-write. Two sweeps
   * racing on one contract — a cron and a person pressing the button — would
   * both see no trigger, both open an opportunity, and the customer would appear
   * in the pipeline twice for one renewal. `uniq_customer_lifecycle_triggers_term`
   * makes the second insert a no-op, and because the claim precedes the deal the
   * loser has nothing to orphan.
   */
  private async open(
    organizationId: string,
    candidate: LoadedCandidate,
    decision: Extract<TriggerDecision, { action: "open" }>,
    asOf: Date,
  ): Promise<SweepEntry> {
    const claimed = await this.db
      .insert(customerLifecycleTriggers)
      .values({
        organizationId,
        customerLifecycleId: candidate.customerLifecycleId,
        partyId: candidate.partyId,
        kind: decision.kind,
        termStartedOn: candidate.startedOn,
        renewalOn: candidate.renewalOn,
        dueOn: decision.dueOn,
        riskScore: candidate.riskScore,
        healthScore: candidate.healthScore,
        firedAt: asOf,
      })
      .onConflictDoNothing({
        target: [
          customerLifecycleTriggers.organizationId,
          customerLifecycleTriggers.customerLifecycleId,
          customerLifecycleTriggers.termStartedOn,
        ],
      })
      .returning({ id: customerLifecycleTriggers.customerLifecycleTriggerId });

    const triggerId = claimed[0]?.id;
    /**
     * Another sweep owns this term. Reported rather than retried: retrying would
     * re-read a row that sweep is still writing, and the next pass will find the
     * trigger and take the re-offer path with a full picture of it.
     */
    if (!triggerId) return base(candidate, { action: "stood-down", reason: "claimed-elsewhere" });

    const dealId = await this.openOpportunity(
      organizationId,
      candidate,
      decision.kind,
      decision.dueOn,
      triggerId,
    );

    if (typeof dealId !== "number")
      return base(candidate, { action: "opened", reason: dealId.reason, triggerId });

    return this.offerToLoop(organizationId, candidate, triggerId, dealId, "opened");
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
  private async openOpportunity(
    organizationId: string,
    candidate: LoadedCandidate,
    kind: LifecycleTriggerKind,
    dueOn: string,
    triggerId: string,
  ): Promise<number | { reason: string }> {
    if (!candidate.ownerUserId) {
      const reason = "Nobody owns the deal this contract came from, so there is nobody to write as.";
      await this.recordRefusal(organizationId, triggerId, "opportunity", reason);
      return { reason };
    }

    const stage = await this.resolveOpeningStage(organizationId);
    const customerName = candidate.companyName ?? candidate.partyName ?? "";

    let dealId: number;
    try {
      const created = await this.deals.createDeal(organizationId, candidate.ownerUserId, {
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
      this.logger.warn(`lifecycle trigger ${triggerId}: ${reason}`);
      await this.recordRefusal(organizationId, triggerId, "opportunity", reason);
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
    await this.db
      .update(deals)
      .set({
        valueMinor: candidate.contractValueMinor,
        nextStep: renewalNextStep(kind, candidate.renewalOn),
        followUpDate: new Date(`${dueOn}T00:00:00.000Z`),
        pipelineId: stage?.pipelineId ?? null,
      })
      .where(and(eq(deals.orgId, organizationId), eq(deals.id, dealId)));

    await this.db
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
  private async offerToLoop(
    organizationId: string,
    candidate: LoadedCandidate,
    triggerId: string,
    dealId: number,
    action: "opened" | "reoffered",
  ): Promise<SweepEntry> {
    let update: Partial<typeof customerLifecycleTriggers.$inferInsert>;
    let entry: Partial<SweepEntry>;

    try {
      const outcome = await this.outbound.composeAndHold({
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
      this.logger.warn(`lifecycle trigger ${triggerId}: the loop could not be reached — ${reason}`);
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

    await this.db
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

  private async recordRefusal(
    organizationId: string,
    triggerId: string,
    stage: string,
    reason: string,
  ): Promise<void> {
    await this.db
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

  // ── Reading ───────────────────────────────────────────────────────────────

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
  private async resolveOpeningStage(
    organizationId: string,
  ): Promise<{ key: string; pipelineId: string } | null> {
    const [row] = await this.db
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
  private async loadCandidates(
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

    return this.db
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
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shapes
 * ──────────────────────────────────────────────────────────────────────────── */

interface LoadedCandidate {
  readonly customerLifecycleId: string;
  readonly partyId: string;
  readonly status: string;
  readonly startedOn: string;
  readonly renewalOn: string;
  readonly riskScore: number;
  readonly lastSignalAt: Date | null;
  /** An ISO timestamp as the driver returned it; see the projection. */
  readonly expansionSignalAt: string | null;
  readonly contractValueMinor: number;
  readonly healthScore: number | null;
  readonly healthStatus: string | null;
  readonly partyName: string | null;
  readonly companyName: string | null;
  readonly ownerUserId: string | null;
  readonly triggerId: string | null;
  readonly triggerKind: LifecycleTriggerKind | null;
  readonly dueOn: string | null;
  readonly opportunityDealId: number | null;
  readonly attempts: number | null;
  readonly lastAttemptAt: Date | null;
  readonly autonomyHoldId: string | null;
}

export interface SweepEntry {
  readonly customerLifecycleId: string;
  readonly partyId: string;
  readonly renewalOn: string;
  readonly action: "opened" | "reoffered" | "stood-down";
  /** Set when the loop was actually asked. */
  readonly outcome: "held" | "skipped" | null;
  /** The stand-down reason, or the loop's own refusal sentence. */
  readonly reason: string | null;
  readonly triggerId: string | null;
  readonly opportunityDealId: number | null;
  readonly autonomyHoldId: string | null;
}

export interface SweepReport {
  readonly asOf: Date;
  readonly considered: number;
  readonly opened: number;
  readonly reoffered: number;
  readonly held: number;
  readonly entries: readonly SweepEntry[];
}

/**
 * The database row, as the pure decider's input.
 *
 * A function rather than a cast, so a column added to the query cannot silently
 * become a field the decider reads: every value it uses is named here.
 */
function toTriggerCandidate(candidate: LoadedCandidate, asOf: Date): TriggerCandidate {
  return {
    status: candidate.status,
    renewalOn: candidate.renewalOn,
    termStartedOn: candidate.startedOn,
    riskScore: candidate.riskScore,
    healthStatus: candidate.healthStatus,
    lastSignalAt: candidate.lastSignalAt,
    expansionSignalAt: toDate(candidate.expansionSignalAt),
    existing: candidate.triggerId
      ? {
          hasOpportunity: candidate.opportunityDealId !== null,
          attempts: candidate.attempts ?? 0,
          lastAttemptAt: candidate.lastAttemptAt,
          holdPlaced: candidate.autonomyHoldId !== null,
        }
      : null,
    asOf,
  };
}

function base(
  candidate: LoadedCandidate,
  over: { action: SweepEntry["action"]; reason?: string; triggerId?: string },
): SweepEntry {
  return {
    customerLifecycleId: candidate.customerLifecycleId,
    partyId: candidate.partyId,
    renewalOn: candidate.renewalOn,
    action: over.action,
    outcome: null,
    reason: over.reason ?? null,
    triggerId: over.triggerId ?? candidate.triggerId,
    opportunityDealId: candidate.opportunityDealId,
    autonomyHoldId: null,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

/**
 * The one place a raw-SQL timestamp becomes a Date.
 *
 * An unparseable value is treated as absent rather than passed on as an Invalid
 * Date, which would compare false against everything and make an expansion
 * signal silently stop working rather than fail.
 */
function toDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
