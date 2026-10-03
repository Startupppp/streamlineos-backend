import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties } from "../../db/schema/party";
import { customerLifecycleTriggers } from "../../db/schema/crm/lifecycle";
import { DealsService } from "../deals/deals.service";
import { OutboundService } from "../autonomy/outbound.service";
import { calendarDateOf, formatIsoDate } from "./lifecycle-terms";
import { decideTrigger, type TriggerDecision } from "./renewal-triggers";
import type { SweepTriggersQuery, ListTriggersQuery } from "./dto/triggers.schemas";
import type { LoadedCandidate, SweepEntry, SweepReport } from "./lifecycle-triggers.types";
import { offerToLoop, openOpportunity, type TriggerActionDeps } from "./lib/lifecycle-trigger-actions";
import { loadCandidates } from "./lib/lifecycle-trigger-candidates";
import { base, toTriggerCandidate } from "./lib/lifecycle-trigger-shapes";

export type { SweepEntry, SweepReport } from "./lifecycle-triggers.types";

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

  /**
   * The collaborators the opportunity and hand-off steps act through. Those
   * steps, and the candidate reads, live in `lib/` — see
   * `lifecycle-trigger-actions.ts` and `lifecycle-trigger-candidates.ts`.
   */
  private deps(): TriggerActionDeps {
    return { db: this.db, deals: this.deals, outbound: this.outbound, logger: this.logger };
  }

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
    const candidates = await loadCandidates(this.db, organizationId, {
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
    const [candidate] = await loadCandidates(this.db, organizationId, {
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
      .limit(query.limit + 1)
      .offset(query.offset);

    return {
      triggers: rows.slice(0, query.limit),
      limit: query.limit,
      offset: query.offset,
      hasMore: rows.length > query.limit,
    };
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
        : await openOpportunity(this.deps(), organizationId, candidate, candidate.triggerKind ?? "renewal-due", candidate.dueOn ?? formatIsoDate(calendarDateOf(asOf)), triggerId);

      if (typeof dealId !== "number")
        return base(candidate, { action: "stood-down", reason: dealId.reason });

      return offerToLoop(this.deps(), organizationId, candidate, triggerId, dealId, "reoffered");
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

    const dealId = await openOpportunity(
      this.deps(),
      organizationId,
      candidate,
      decision.kind,
      decision.dueOn,
      triggerId,
    );

    if (typeof dealId !== "number")
      return base(candidate, { action: "opened", reason: dealId.reason, triggerId });

    return offerToLoop(this.deps(), organizationId, candidate, triggerId, dealId, "opened");
  }
}
