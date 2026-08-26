import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  autonomousDecisions,
  businessParties,
  inboundEvents,
} from "../../db/schema";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { getRegionRegistry, hasRegionRegistry } from "../../common/region/region-registry";
import { AutonomyService } from "../autonomy/autonomy.service";
import { AutonomyScoringService } from "../autonomy/autonomy-scoring.service";
import { buildDecision } from "../autonomy/decision-record";
import {
  evaluateAutonomousWrite,
  upgradePrompt,
} from "../autonomy/autonomous-write-guard";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { INBOUND_WORKFLOW } from "./inbound-ingress.service";
import {
  activityKindFor,
  externalParticipants,
  identifierKindOf,
  identifierOf,
  normaliseIdentifier,
  partyNameFor,
  senderOf,
  threadIdentity,
  type InboundCommunicationEvent,
} from "./inbound-event";
import {
  COLUMN_FOR_KIND,
  claimIdentifiers,
  resolvePartyByIdentifier,
} from "../party/party-identifiers";

/** One activity produces at most a task and a stage move; the cap is a backstop. */
const MAX_SCORED_PER_RUN = 10;

/**
 * What happens after a communication arrives.
 *
 * Written as a durable workflow rather than a request handler because every step
 * has an external consequence and the whole thing has to survive a deploy, a
 * provider timeout and a database blip without repeating the half it already
 * did. Each `step.run` records its result, so a retry resumes rather than
 * re-creates — which is what stops a retried delivery from producing a second
 * party for the same sender.
 */
@Injectable()
export class InboundIngressWorkflow implements OnModuleInit {
  private readonly logger = new Logger("InboundIngress");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
    /**
     * Optional so the seam stands on its own.
     *
     * Ticket 10's whole point is that a communication is filed correctly with no
     * human involved; whether the system then reasons about it is ticket 12's
     * concern, and the ingress path must not stop working if that is unwired.
     */
    @Optional() private readonly autonomy?: AutonomyService,
    /** Optional for the same reason as `autonomy`: measurement must not gate filing. */
    @Optional() private readonly scoring?: AutonomyScoringService,
    /**
     * Optional, but the absence is a decision rather than a default.
     *
     * Unwired, this workflow creates parties without consulting a plan, which is
     * the gap ticket 07 exists to close. It is optional only so the seam's own
     * tests can stand it up without a billing module behind them; every
     * composition that serves a tenant provides it, and
     * `party/party-creation-invariant.spec.ts` is what stops a future party
     * insert going in without asking the same question.
     */
    @Optional() private readonly planLimits?: PlanLimitsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: INBOUND_WORKFLOW,
      maxAttempts: 5,
      handler: (step, context) => this.handle(step, context),
    });
  }

  private async handle(step: StepContext, context: WorkflowRunContext): Promise<void> {
    const inboundEventId = String(context.input.inboundEventId ?? "");
    if (!inboundEventId) throw new Error("inbound: run started without an inboundEventId");

    /**
     * Read outside a step, deliberately — but inside a tenant transaction.
     *
     * The runtime's rule is that anything with an effect belongs in a step; a
     * read has none, so re-reading on each attempt is both correct and cheaper
     * than memoising a whole payload into the step log. It also means a retry
     * sees the current receipt rather than a snapshot of it.
     *
     * The transaction is not optional, though, and it is the half that was
     * missing. Only a `step.run` body gets an ambient tenant context, so a read
     * in the workflow body falls through the tenant-aware proxy to the raw pool
     * with no `app.organization_id` set. `inbound_events.organization_id` is NOT
     * NULL, so its policy still calls `app.current_org_id()`, which raises
     * 42501 with no GUC — invisible in dev, where `DATABASE_URL` connects as an
     * owner with BYPASSRLS, and five failed attempts and a dead-lettered
     * delivery in production.
     */
    const event = await runInNewTenantTransaction(this.db, context.organizationId, () =>
      this.loadEvent(context.organizationId, inboundEventId),
    );

    /**
     * Resolve the placement before touching tenant data.
     *
     * Every tenant transaction runs against the organisation's own region, and a
     * background continuation has no ambient request to inherit it from — so it
     * is resolved explicitly and recorded, which also makes it visible in the
     * run's steps when a delivery lands in the wrong place.
     */
    await step.run("resolve-region", async () => {
      if (!hasRegionRegistry()) return { region: "primary" };
      const region = await getRegionRegistry().regionForOrg(context.organizationId);
      return { region: region ?? "primary" };
    });

    const party = await step.run("resolve-party", async () => {
      const sender = senderOf(event);
      if (!sender) throw new Error("inbound: event has no sender");

      /**
       * The sender as an identity, not as a string.
       *
       * `identifierOf` pairs the address with the kind the ADAPTER stated —
       * never with one inferred from the characters. This step used to compare
       * the address against `business_parties.email` and, on a miss, insert it
       * into that column, so a telephone number arrived as an email address:
       * the row looked right, the caller's next email did not match it, and the
       * record they were actually filed under was unreachable by the only
       * channel that was wired.
       */
      const identifier = identifierOf(event, sender);
      if (!identifier) throw new Error("inbound: the sender's address carries no identifier");

      const { kind, normalisedValue: address } = identifier;

      /**
       * A known sender matches; an unknown one becomes a party.
       *
       * Matched through `party_identifiers` on the normalised value, which is
       * why every kind has a normaliser — `Priya@Example.com` and
       * `priya@example.com` are one person, and so are `+44 20 7123 4567` and
       * `+442071234567`. Matching raw strings is how the same customer becomes
       * three records.
       */
      const existingPartyId = await resolvePartyByIdentifier(
        this.db,
        context.organizationId,
        kind,
        sender.address,
      );

      if (existingPartyId) return { partyId: existingPartyId, created: false };

      /**
       * The plan, consulted before the system creates a record nobody asked for.
       *
       * Every limit in the platform was written for a request a person made, so
       * every one of them is enforced by throwing: the handler unwinds and the
       * person is told to upgrade. That is exactly wrong here. Throwing would
       * unwind an ingest carrying a customer's message, and refusing to record
       * that an email arrived — because a plan limit was reached — loses the
       * message. So the limit is read rather than asserted, and the refusal is
       * a decision the tenant can see.
       *
       * **The count is deliberately not `assertWithinLimit`'s.** That one counts
       * parties joined to a `*_party_map` row, which was equivalent to "the
       * tenant's contacts" while every contact was written through the legacy
       * mirror. This path writes `business_parties` directly and creates no map
       * row, so those parties are invisible to it — which is how autonomous
       * creation was unbounded even though the tenant had a contact limit. The
       * count here is what this path actually produces: live parties. The two
       * numbers therefore differ for any tenant using ingress, and that
       * divergence is recorded in ticket 07 rather than silently resolved by
       * changing what every existing tenant is billed against.
       */
      const limit = this.planLimits
        ? await this.planLimits.limitFor(context.organizationId, "crmContacts")
        : null;

      const [live] = await this.db
        .select({ current: count() })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, context.organizationId),
            isNull(businessParties.deletedAt),
            // The type this path creates, and only that one. A tenant's vendors
            // and partners are not customer records and counting them here
            // would refuse an inbound message because the purchasing ledger is
            // busy -- a connection no one could be expected to make from the
            // refusal.
            eq(businessParties.partyType, "CUSTOMER"),
          ),
        );

      const verdict = evaluateAutonomousWrite({
        kind: "party.created",
        limitKey: "customer records",
        limit,
        current: live?.current ?? 0,
      });

      if (!verdict.allowed) {
        /**
         * The receipt survives; the derived record is what is refused.
         *
         * Returning no party leaves the activity unattributed rather than
         * unrecorded — the message is filed, visible, and a person can attach it
         * to somebody by hand. Nothing about the communication is lost, which is
         * the property that makes refusing safe enough to do at all.
         */
        await this.db.insert(autonomousDecisions).values(
          buildDecision({
            organizationId: context.organizationId,
            triggerType: "inbound-event",
            triggerId: inboundEventId,
            inputs: { address, identifierKind: kind, channel: event.channel },
            ...verdict.decision,
            summary: upgradePrompt(verdict),
          }),
        );

        this.logger.warn(
          `inbound: plan limit reached for ${context.organizationId}; ` +
            `filed the message without creating a party`,
        );

        return { partyId: null, created: false };
      }

      /**
       * The display column the kind belongs in, and only that one.
       *
       * A handle has none, and a party created from one carries no contact
       * column at all — which is correct, and is the case the old code could
       * not express without lying about what the value was.
       */
      const contact: { email?: string; phone?: string; whatsappPhone?: string } = {};
      const column = COLUMN_FOR_KIND[kind];
      if (column) contact[column] = address;

      const [created] = await this.db
        .insert(businessParties)
        .values({
          organizationId: context.organizationId,
          name: partyNameFor(sender),
          partyType: "CUSTOMER",
          ...contact,
        })
        .returning({ partyId: businessParties.partyId });

      if (!created) throw new Error("inbound: could not create a party for the sender");

      /**
       * The claim, in the same statement stream as the party.
       *
       * A party with no identifier is a party the next message from the same
       * person will not match, so it would silently become two records — the
       * exact failure this table exists to end. Both writes are inside the
       * step, so they commit with the tenant transaction or not at all.
       */
      await claimIdentifiers(this.db, context.organizationId, created.partyId, [
        { kind, value: sender.address },
      ]);

      /**
       * Recorded here rather than by the extractor, because this is an
       * autonomous write in its own right — nobody filled in a form. Writing it
       * inside the step means it commits in the same tenant transaction as the
       * party and as the memo that the step ran, so a crash cannot leave a party
       * that the review feed has no entry for.
       *
       * No model, no confidence: this decision was deterministic, and recording
       * a score for it would invent one.
       */
      await this.db.insert(autonomousDecisions).values(
        buildDecision({
          organizationId: context.organizationId,
          kind: "party.created",
          outcome: "applied",
          triggerType: "inbound-event",
          triggerId: inboundEventId,
          partyId: created.partyId,
          inputs: { address, identifierKind: kind, channel: event.channel },
          decision: { partyId: created.partyId, name: partyNameFor(sender) },
          summary: `Created a record for ${address}, who was not on file, after they made contact by ${event.channel}.`,
        }),
      );

      return { partyId: created.partyId, created: true };
    });

    const activity = await step.run("log-activity", async () => {
      const [row] = await this.db
        .insert(activities)
        .values({
          organizationId: context.organizationId,
          kind: activityKindFor(event.channel),
          occurredAt: new Date(event.occurredAt),
          subject: event.subject ?? null,
          body: event.body ?? null,
          threadId: threadIdentity(event),
          partyId: party.partyId,
          // Nobody typed this. Recording it as the system is what lets a reader
          // tell, and what ticket 13's review feed reads.
          actorKind: "system",
          actorLabel: `ingress:${event.channel}`,
          source: event.provider,
        })
        .returning({ activityId: activities.activityId });

      if (!row) throw new Error("inbound: could not log the activity");

      /**
       * Filing a communication is deterministic and effectively always right,
       * so the feed hides this kind by default — but it is still recorded, for
       * two reasons. The audit trail is meant to be complete rather than
       * interesting, and the correction rate needs a denominator that includes
       * the actions nobody ever had to correct.
       */
      await this.db.insert(autonomousDecisions).values(
        buildDecision({
          organizationId: context.organizationId,
          kind: "activity.logged",
          outcome: "applied",
          triggerType: "inbound-event",
          triggerId: inboundEventId,
          partyId: party.partyId,
          activityId: row.activityId,
          inputs: { channel: event.channel, provider: event.provider },
          decision: { activityId: row.activityId, threadId: threadIdentity(event) },
          summary: `Filed a ${event.channel} message${event.subject ? ` — "${event.subject}"` : ""} against the party's timeline.`,
        }),
      );

      return { activityId: row.activityId };
    });

    await step.run("record-participants", async () => {
      const external = externalParticipants(event, []);
      if (external.length === 0) return null;

      await this.db.insert(activityParticipants).values(
        external.map((participant) => ({
          organizationId: context.organizationId,
          activityId: activity.activityId,
          // Only the sender is resolved to a party in this ticket; the rest keep
          // their address, which is exactly what the nullable columns are for.
          partyId: participant.role === "from" ? party.partyId : null,
          // Normalised by kind rather than as an address, so a call's `from`
          // row holds the number in the one shape everything else matches on.
          address:
            normaliseIdentifier(identifierKindOf(event, participant), participant.address) ||
            participant.address.trim(),
          role: participant.role,
        })),
      );

      return null;
    });

    /**
     * The autonomous half, as its own step.
     *
     * Separate from logging the activity on purpose: extraction calls a provider
     * and a provider is the thing most likely to fail here. Its own step means a
     * retry re-runs the inference without creating a second party and a second
     * activity first — and a permanent extraction failure still leaves the
     * communication filed correctly, which is the half that must never be lost.
     */
    await step.run("extract-and-act", async () => {
      if (!this.autonomy) return null;
      await this.autonomy.processActivity(context.organizationId, activity.activityId);
      return null;
    });

    /**
     * The second opinion, as its own step again.
     *
     * After the decisions exist, never alongside them. Scoring is another
     * provider call, and putting it inside `extract-and-act` would mean a
     * scorer outage retried the extraction — spending twice and risking a
     * second set of writes to undo the first ones.
     *
     * It never throws outward. A decision that went unscored is a gap in a
     * measurement; a workflow that fails because the measurement failed would
     * be a gap in the product.
     */
    await step.run("shadow-score", async () => {
      if (!this.scoring) return null;

      const decisions = await this.db
        .select({ id: autonomousDecisions.autonomousDecisionId })
        .from(autonomousDecisions)
        .where(
          and(
            eq(autonomousDecisions.organizationId, context.organizationId),
            eq(autonomousDecisions.triggerType, "activity"),
            eq(autonomousDecisions.triggerId, activity.activityId),
          ),
        )
        .limit(MAX_SCORED_PER_RUN);

      for (const decision of decisions) {
        try {
          await this.scoring.scoreDecision(context.organizationId, decision.id);
        } catch (error) {
          this.logger.warn(
            `shadow score failed for ${decision.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { scored: decisions.length };
    });

    await step.run("mark-processed", async () => {
      await this.db
        .update(inboundEvents)
        .set({
          status: "PROCESSED",
          processedAt: new Date(),
          partyId: party.partyId,
          activityId: activity.activityId,
        })
        // Scoped by tenant as well as by id. RLS would refuse another
        // organisation's receipt anyway, but a write that relies on the policy
        // to be correct is a write that stops being correct the day the policy
        // is relaxed — and every other statement in this workflow says so too.
        .where(
          and(
            eq(inboundEvents.organizationId, context.organizationId),
            eq(inboundEvents.inboundEventId, inboundEventId),
          ),
        );

      return null;
    });

    this.logger.log(
      `inbound ${event.channel} processed — party ${party.created ? "created" : "matched"}`,
    );
  }

  /**
   * The receipt, scoped to the organisation the run belongs to.
   *
   * The tenant predicate is stated rather than left to RLS: the run's
   * organisation is the authority on what this run may read, and a receipt id
   * that does not belong to it is "not found" here rather than at the policy.
   */
  private async loadEvent(
    organizationId: string,
    inboundEventId: string,
  ): Promise<InboundCommunicationEvent> {
    const [row] = await this.db
      .select({ payload: inboundEvents.payload })
      .from(inboundEvents)
      .where(
        and(
          eq(inboundEvents.organizationId, organizationId),
          eq(inboundEvents.inboundEventId, inboundEventId),
        ),
      )
      .limit(1);

    if (!row) throw new Error(`inbound: receipt ${inboundEventId} not found`);
    return row.payload as unknown as InboundCommunicationEvent;
  }
}
