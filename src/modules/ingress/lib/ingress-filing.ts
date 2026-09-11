import { and, eq } from "drizzle-orm";
import {
  activities,
  activityParticipants,
  autonomousDecisions,
  inboundEvents,
} from "../../../db/schema";
import { buildDecision } from "../../autonomy/decision-record";
import {
  activityKindFor,
  externalParticipants,
  identifierKindOf,
  normaliseIdentifier,
  threadIdentity,
  type InboundCommunicationEvent,
} from "../inbound-event";
import type { IngressStepDeps } from "./ingress-resolve-party";

/*
  The filing steps of `InboundIngressWorkflow` after the party is known:
  `log-activity`, `record-participants`, `shadow-score` and `mark-processed`.
  Each is the body of the `step.run` of that name, which is where the order,
  the retries and the reasons for each step being its own are written down.
*/

type Context = { readonly organizationId: string };
type Party = { readonly partyId: string | null };
type Activity = { readonly activityId: string };

/** One activity produces at most a task and a stage move; the cap is a backstop. */
const MAX_SCORED_PER_RUN = 10;

/** `log-activity`: the communication on the party's timeline, filed as the system. */
export async function logInboundActivity(
  deps: IngressStepDeps,
  context: Context,
  inboundEventId: string,
  event: InboundCommunicationEvent,
  party: Party,
) {
  const [row] = await deps.db
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
  await deps.db.insert(autonomousDecisions).values(
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
}

/** `record-participants`: everyone on the message, the sender resolved to the party. */
export async function recordInboundParticipants(
  deps: IngressStepDeps,
  context: Context,
  event: InboundCommunicationEvent,
  party: Party,
  activity: Activity,
) {
  const external = externalParticipants(event, []);
  if (external.length === 0) return null;

  await deps.db.insert(activityParticipants).values(
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
}

/** `shadow-score`: the second opinion on the decisions extraction just made. Never throws outward. */
export async function shadowScoreInbound(
  deps: IngressStepDeps,
  context: Context,
  activity: Activity,
) {
  if (!deps.scoring) return null;

  const decisions = await deps.db
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
      await deps.scoring.scoreDecision(context.organizationId, decision.id);
    } catch (error) {
      deps.logger.warn(
        `shadow score failed for ${decision.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { scored: decisions.length };
}

/** `mark-processed`: the receipt closed against the party and activity it produced. */
export async function markInboundProcessed(
  deps: IngressStepDeps,
  context: Context,
  inboundEventId: string,
  party: Party,
  activity: Activity,
) {
  await deps.db
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
}
