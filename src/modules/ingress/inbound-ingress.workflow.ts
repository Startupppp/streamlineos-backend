import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
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
import { getRegionRegistry, hasRegionRegistry } from "../../common/region/region-registry";
import { AutonomyService } from "../autonomy/autonomy.service";
import { AutonomyScoringService } from "../autonomy/autonomy-scoring.service";
import { buildDecision } from "../autonomy/decision-record";
import { INBOUND_WORKFLOW } from "./inbound-ingress.service";
import {
  activityKindFor,
  externalParticipants,
  normaliseAddress,
  partyNameFor,
  senderOf,
  threadIdentity,
  type InboundCommunicationEvent,
} from "./inbound-event";

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
     * Read outside a step, deliberately.
     *
     * The runtime's rule is that anything with an effect belongs in a step; a
     * read has none, so re-reading on each attempt is both correct and cheaper
     * than memoising a whole payload into the step log. It also means a retry
     * sees the current receipt rather than a snapshot of it.
     */
    const event = await this.loadEvent(inboundEventId);

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

      const address = normaliseAddress(sender.address);

      /**
       * A known sender matches; an unknown one becomes a party.
       *
       * Matched on the normalised address, which is why the seam lower-cases it —
       * `Priya@Example.com` and `priya@example.com` are one person, and matching
       * on the raw string is how the same customer becomes three records.
       */
      const [existing] = await this.db
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, context.organizationId),
            eq(businessParties.email, address),
            isNull(businessParties.deletedAt),
          ),
        )
        .limit(1);

      if (existing) return { partyId: existing.partyId, created: false };

      const [created] = await this.db
        .insert(businessParties)
        .values({
          organizationId: context.organizationId,
          name: partyNameFor(sender),
          email: address,
          partyType: "CUSTOMER",
        })
        .returning({ partyId: businessParties.partyId });

      if (!created) throw new Error("inbound: could not create a party for the sender");

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
          inputs: { address, channel: event.channel },
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
          address: normaliseAddress(participant.address),
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
        .where(eq(inboundEvents.inboundEventId, inboundEventId));

      return null;
    });

    this.logger.log(
      `inbound ${event.channel} processed — party ${party.created ? "created" : "matched"}`,
    );
  }

  private async loadEvent(inboundEventId: string): Promise<InboundCommunicationEvent> {
    const [row] = await this.db
      .select({ payload: inboundEvents.payload })
      .from(inboundEvents)
      .where(eq(inboundEvents.inboundEventId, inboundEventId))
      .limit(1);

    if (!row) throw new Error(`inbound: receipt ${inboundEventId} not found`);
    return row.payload as unknown as InboundCommunicationEvent;
  }
}
