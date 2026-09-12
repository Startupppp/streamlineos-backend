import type { Logger } from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { autonomousDecisions, businessParties } from "../../../db/schema";
import type { AutonomyScoringService } from "../../autonomy/autonomy-scoring.service";
import { buildDecision } from "../../autonomy/decision-record";
import { evaluateAutonomousWrite, upgradePrompt } from "../../autonomy/autonomous-write-guard";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { identifierOf, partyNameFor, senderOf, type InboundCommunicationEvent } from "../inbound-event";
import {
  COLUMN_FOR_KIND,
  claimIdentifiers,
  resolvePartyByIdentifier,
} from "../../party/party-identifiers";

/**
 * The workflow's own collaborators, passed to the step bodies rather than
 * reached for. `planLimits` and `scoring` stay optional exactly as they are on
 * `InboundIngressWorkflow`, and each step treats their absence the same way.
 */
export interface IngressStepDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly planLimits?: PlanLimitsService;
  readonly scoring?: AutonomyScoringService;
}

/**
 * The `resolve-party` step of `InboundIngressWorkflow`: match the sender
 * through `party_identifiers`, or create a party for them if the plan allows it
 * and record the decision either way. Runs inside `step.run`, so every write
 * here commits with the step's tenant transaction or not at all.
 */
export async function resolveInboundParty(
  deps: IngressStepDeps,
  context: { readonly organizationId: string },
  inboundEventId: string,
  event: InboundCommunicationEvent,
) {
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
    deps.db,
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
  const limit = deps.planLimits
    ? await deps.planLimits.limitFor(context.organizationId, "crmContacts")
    : null;

  const [live] = await deps.db
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
    await deps.db.insert(autonomousDecisions).values(
      buildDecision({
        organizationId: context.organizationId,
        triggerType: "inbound-event",
        triggerId: inboundEventId,
        inputs: { address, identifierKind: kind, channel: event.channel },
        ...verdict.decision,
        summary: upgradePrompt(verdict),
      }),
    );

    deps.logger.warn(
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

  const [created] = await deps.db
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
  await claimIdentifiers(deps.db, context.organizationId, created.partyId, [
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
  await deps.db.insert(autonomousDecisions).values(
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
}
