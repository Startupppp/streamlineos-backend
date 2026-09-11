import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import {
  businessParties,
  contactPartyMap,
  crmOutboundMessages,
  relationshipStates,
} from "../../../db/schema";
import { capText, RECORDED_CONVERSATION_CHARS } from "../decision-record";
import type { RelationshipSnapshot } from "../outbound-eligibility";
import type { ComposeContext } from "./outbound-compose.types";
import { DAY_MS, loadOutboundDeal, resolveOutboundRecipient } from "./outbound-party-reads";

/*
  What `composeAndHold` knows before it decides anything: the relationship
  snapshot `judgeOutbound` is run over, and the names and the conversation the
  drafter is shown.
*/

/**
 * Everything compose time needs, in one read per table.
 *
 * Explicit joins rather than the relational include API: `db/schema` re-exports
 * every module's tables through one barrel, and a relational query here would
 * pull the whole graph in to resolve names it does not use.
 *
 * THE DEAL IS THE ANCHOR, and that is a real limit rather than an accident.
 * The deal supplies the salesperson to write as, the name of the thing being
 * discussed, what was agreed, and the only conversation this module can reach
 * without taking a dependency on `activities` and `thread-window.ts`. A party
 * with no deal therefore produces no message — which means `judgeOutbound`'s
 * `check_in` branch, the one that fires on a long silence with nothing open,
 * cannot be reached from this caller today even though the pure module answers
 * it correctly. Stated rather than papered over: signing a message with the
 * organisation's name would contradict the prompt's own premise, which is one
 * salesperson writing to a customer they already know.
 */
export async function loadComposeContext(
  db: Db,
  organizationId: string,
  partyId: string,
  dealId: string | null,
): Promise<ComposeContext | null> {
  const [party] = await db
    .select({ name: businessParties.name, companyName: businessParties.companyName })
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        eq(businessParties.partyId, partyId),
      ),
    )
    .limit(1);

  if (!party) return null;

  const [relationship] = await db
    .select({
      lastInboundAt: relationshipStates.lastInboundAt,
      lastOutboundAt: relationshipStates.lastOutboundAt,
      awaitingReplySince: relationshipStates.awaitingReplySince,
      /**
       * How fast this customer normally answers, which decides when they can
       * be said to have gone quiet. Stored since relationships shipped and
       * read by nothing until CRM-P2-10; null until enough replies have been
       * seen to have a median at all.
       */
      replyP50Seconds: relationshipStates.replyP50Seconds,
    })
    .from(relationshipStates)
    .where(
      and(
        eq(relationshipStates.organizationId, organizationId),
        eq(relationshipStates.partyId, partyId),
      ),
    )
    .limit(1);

  const [lastAutonomous] = await db
    .select({ sentAt: crmOutboundMessages.sentAt })
    .from(crmOutboundMessages)
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.partyId, partyId),
        eq(crmOutboundMessages.status, "sent"),
      ),
    )
    .orderBy(desc(crmOutboundMessages.sentAt))
    .limit(1);

  const deal = dealId ? await loadOutboundDeal(db, organizationId, dealId) : null;
  const recipient = await resolveOutboundRecipient(db, organizationId, partyId);

  /**
   * The legacy integer id, carried so consent is reachable at send time.
   *
   * `crm_contact_channel_consent` is keyed on `contact_id` and its party
   * column is an additive expand that nothing populates for every row yet, so
   * resolving the number here is what makes `SendTimeFacts.consent` something
   * other than a permanent UNKNOWN. Null where the party was never a contact —
   * a lead minted straight into `business_parties`, for instance — and UNKNOWN
   * is then the honest answer rather than a lookup that silently found nothing.
   */
  const [mapped] = await db
    .select({ contactId: contactPartyMap.contactId })
    .from(contactPartyMap)
    .where(
      and(
        eq(contactPartyMap.organizationId, organizationId),
        eq(contactPartyMap.partyId, partyId),
      ),
    )
    .limit(1);
  const now = new Date();

  const snapshot: RelationshipSnapshot = {
    now,
    lastInboundAt: relationship?.lastInboundAt ?? null,
    lastOutboundAt: relationship?.lastOutboundAt ?? null,
    lastAutonomousOutboundAt: lastAutonomous?.sentAt ?? null,
    dealState: deal?.state ?? "none",
    /**
     * `awaiting_reply_since` records when the ball entered THEIR court, so a
     * value means it is theirs and a null means it is ours. `awaitingUs` is
     * the opposite question, which is why this is negated rather than copied —
     * getting it the wrong way round would make the loop chase people who are
     * waiting on us, which is the one refusal `outbound-eligibility.ts` calls
     * "the-ball-is-ours".
     */
    awaitingUs: !relationship?.awaitingReplySince,
    nextStepDueAt: deal?.followUpDate ?? null,
    hasReachableAddress: Boolean(recipient),
    replyP50Seconds: relationship?.replyP50Seconds ?? null,
  };

  return {
    snapshot,
    contactId: mapped?.contactId ?? null,
    recipientName: party.name,
    senderName: deal?.senderName ?? "",
    companyName: party.companyName ?? null,
    dealName: deal?.name ?? null,
    agreedNextStep: capText(deal?.nextStep ?? null, AGREED_NEXT_STEP_CHARS),
    daysSinceLastContact: daysBetween(relationship?.lastOutboundAt ?? null, now),
    conversation: capText(deal?.notes ?? null, RECORDED_CONVERSATION_CHARS),
  };
}

/** What the model may be told was agreed. Capped for the same reason the conversation is. */
const AGREED_NEXT_STEP_CHARS = 200;

function daysBetween(from: Date | null, now: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}
