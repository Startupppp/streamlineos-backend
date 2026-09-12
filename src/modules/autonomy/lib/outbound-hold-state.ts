import { and, eq } from "drizzle-orm";
import { autonomousDecisions, autonomyHolds, crmOutboundMessages } from "../../../db/schema";
import { isOutboundClass, type OutboundClass } from "../outbound-classes";
import type { LoadedHold, OutboundSendDeps } from "./outbound-send.types";

/*
  The hold row, and the two rows that have to agree with it: reading the hold
  a step is about, and stopping it in all three places at once. Used by the
  workflow's pre-step read and by `claim-send-N` in `outbound-claim.ts`.
*/

/**
 * Stop it, in all three places that have to agree.
 *
 * The hold, the message and the ledger row are updated together: a message
 * left at `held` with a cancelled hold would show in the review feed as still
 * about to send, and a ledger row still saying `held` would tell the scoreboard
 * a decision is in flight that nothing will ever resolve.
 */
export async function stopOutboundHold(
  deps: OutboundSendDeps,
  organizationId: string,
  holdId: string,
  current: LoadedHold,
  how: {
    holdStatus: "cancelled" | "failed";
    messageStatus: "cancelled" | "blocked" | "failed";
    blockedReason: string;
    summary: string;
    decisionOutcome: "skipped" | "reversed" | "failed";
  },
): Promise<void> {
  await deps.db
    .update(autonomyHolds)
    .set(
      how.holdStatus === "cancelled"
        ? { status: "cancelled", cancelledAt: new Date(), cancelReason: how.summary }
        : { status: "failed", sentAt: null },
    )
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.autonomyHoldId, holdId),
        // Conditional, so a human cancelling in the same instant as a
        // guardrail refusing resolves one way and never both.
        eq(autonomyHolds.status, "held"),
      ),
    );

  await deps.db
    .update(crmOutboundMessages)
    .set({ status: how.messageStatus, blockedReason: how.blockedReason })
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.outboundMessageId, current.outboundMessageId),
      ),
    );

  await deps.db
    .update(autonomousDecisions)
    .set(
      how.decisionOutcome === "reversed"
        ? { outcome: "reversed", reversedAt: new Date(), reversedReason: how.summary }
        : { outcome: how.decisionOutcome, summary: how.summary },
    )
    .where(
      and(
        eq(autonomousDecisions.organizationId, organizationId),
        eq(autonomousDecisions.autonomousDecisionId, current.decisionId),
      ),
    );
}

export async function loadOutboundHold(
  deps: OutboundSendDeps,
  organizationId: string,
  holdId: string,
): Promise<LoadedHold | null> {
  const [row] = await deps.db
    .select({
      status: autonomyHolds.status,
      holdUntil: autonomyHolds.holdUntil,
      decisionId: autonomyHolds.autonomousDecisionId,
      outboundMessageId: autonomyHolds.outboundMessageId,
      partyId: crmOutboundMessages.partyId,
      contactId: crmOutboundMessages.contactId,
      dealId: crmOutboundMessages.dealId,
      outboundClass: crmOutboundMessages.outboundClass,
      subject: crmOutboundMessages.subject,
      body: crmOutboundMessages.body,
      draftedAt: crmOutboundMessages.createdAt,
      workingHourDeferrals: crmOutboundMessages.workingHourDeferrals,
    })
    .from(autonomyHolds)
    // An explicit join rather than the relational include API: `db/schema` is
    // one barrel over every module, and a relational query here would drag the
    // whole graph in to resolve two columns.
    .leftJoin(
      crmOutboundMessages,
      and(
        eq(crmOutboundMessages.organizationId, autonomyHolds.organizationId),
        eq(crmOutboundMessages.outboundMessageId, autonomyHolds.outboundMessageId),
      ),
    )
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.autonomyHoldId, holdId),
      ),
    )
    .limit(1);

  if (!row || !row.outboundMessageId || !row.partyId) return null;

  /**
   * A class the code does not recognise ends the run rather than defaulting.
   *
   * `chk_crm_outbound_messages_class` makes this unreachable from a write this
   * repository performs; it is here because the alternative — falling back to
   * `follow_up` — would put an unrecognised class on the engaged track, and
   * the one class that is not on it is the one whose gate matters most.
   */
  if (!isOutboundClass(row.outboundClass ?? "")) {
    deps.logger.error(
      `outbound hold ${holdId} names an unknown class "${row.outboundClass}"; refusing to send`,
    );
    return null;
  }

  return {
    status: row.status,
    holdUntil: row.holdUntil,
    decisionId: row.decisionId,
    outboundMessageId: row.outboundMessageId,
    partyId: row.partyId,
    contactId: row.contactId ?? null,
    dealId: row.dealId ?? null,
    outboundClass: row.outboundClass as OutboundClass,
    subject: row.subject ?? "",
    body: row.body ?? "",
    draftedAt: row.draftedAt ?? new Date(0),
    workingHourDeferrals: row.workingHourDeferrals ?? 0,
  };
}
