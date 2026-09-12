import { and, eq } from "drizzle-orm";
import { autonomyHolds, crmOutboundMessages } from "../../../db/schema";
import { coldBlockSummary, evaluateColdGate } from "../cold-outbound-gate";
import { resolveHold } from "../hold-window";
import { trackFor } from "../outbound-classes";
import { evaluateGuardrails, guardrailSummary } from "../send-guardrails";
import { loadOutboundHold, stopOutboundHold } from "./outbound-hold-state";
import type { ClaimResult, OutboundSendDeps } from "./outbound-send.types";

/*
  The body of the `claim-send-N` step of `OutboundWorkflow`. The loop that
  names one pair of steps per deferral, and the reason claiming and sending are
  two steps rather than one, are written down where the steps are declared, in
  `outbound.workflow.ts`.
*/

/**
 * Read the world again, judge it, and only then take the send.
 *
 * Everything before the UPDATE is a re-read. The guardrail snapshot is taken
 * HERE, three lines above the statement that claims the message, which is as
 * late as it can be taken and still be inside the transaction that claims it.
 */
export async function claimOutboundSend(
  deps: OutboundSendDeps,
  organizationId: string,
  holdId: string,
): Promise<ClaimResult> {
  const nothing = (outcome: string): ClaimResult => ({
    outcome,
    waitMs: 0,
    outboundMessageId: null,
    decisionId: null,
    recipientEmail: null,
    subject: null,
    body: null,
  });

  const current = await loadOutboundHold(deps, organizationId, holdId);
  if (!current) return nothing("gone");

  const outboundClass = current.outboundClass;

  const resolution = resolveHold(
    { status: current.status, holdUntil: current.holdUntil },
    await deps.outbound.switchAllows(organizationId, outboundClass),
    new Date(),
  );

  if (resolution.action === "skip") return nothing(resolution.reason);

  if (resolution.action === "cancel") {
    await stopOutboundHold(deps, organizationId, holdId, current, {
      holdStatus: "cancelled",
      messageStatus: "cancelled",
      blockedReason: "switched-off",
      summary: "Autonomous sending was switched off during the hold.",
      decisionOutcome: "reversed",
    });
    return nothing("cancelled-by-switch");
  }

  /**
   * The address, resolved now rather than copied from the draft. A contact who
   * changed their mail during the window must not receive it at the old one —
   * and the suppression check below is meaningless against an address the send
   * would not have used.
   */
  const recipientEmail = await deps.outbound.resolveRecipient(organizationId, current.partyId);

  if (!recipientEmail) {
    await stopOutboundHold(deps, organizationId, holdId, current, {
      holdStatus: "failed",
      messageStatus: "failed",
      blockedReason: "no-reachable-address",
      summary: "There was no address to send it to when the window closed.",
      decisionOutcome: "failed",
    });
    return nothing("no-address");
  }

  // ── The late snapshot. Everything above is a read; nothing above has
  // decided anything, and nothing below reads the world again.
  const facts = await deps.outbound.sendTimeFacts(organizationId, {
    outboundMessageId: current.outboundMessageId,
    partyId: current.partyId,
    contactId: current.contactId,
    dealId: current.dealId,
    outboundClass,
    draftedAt: current.draftedAt,
    workingHourDeferrals: current.workingHourDeferrals,
    recipientEmail,
  });

  const verdict = evaluateGuardrails(facts);

  if (verdict.allow === false && verdict.action === "defer") {
    /**
     * Put off, not refused. The deferral count is incremented here rather than
     * when the run wakes, because the run may never wake — and a count that
     * only rises on a successful wake would let a message that has been
     * deferred all week present itself as fresh.
     */
    await deps.db
      .update(crmOutboundMessages)
      .set({
        workingHourDeferrals: current.workingHourDeferrals + 1,
        timezoneUsed: verdict.timezoneUsed,
        timezoneSource: verdict.timezoneSource,
      })
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.outboundMessageId, current.outboundMessageId),
        ),
      );

    return {
      ...nothing("deferred"),
      waitMs: Math.max(0, verdict.notBefore.getTime() - facts.now.getTime()),
    };
  }

  if (verdict.allow === false) {
    await stopOutboundHold(deps, organizationId, holdId, current, {
      holdStatus: "cancelled",
      messageStatus: "blocked",
      blockedReason: verdict.reason,
      summary: guardrailSummary(verdict.reason),
      /**
       * `skipped`, not `reversed`. Nobody reversed anything — the system read
       * the world at the last moment and declined. `reversed` is reserved for
       * a human undoing a decision, and blurring the two would make the
       * correction rate count the guardrails' own successes as mistakes.
       */
      decisionOutcome: "skipped",
    });
    return nothing(`blocked:${verdict.reason}`);
  }

  /**
   * The cold gate, after the guardrails and only for the cold track.
   *
   * `trackFor` rather than a comparison against the class, so a sixth class
   * added to `outbound-classes.ts` is routed by that file's total map instead
   * of by an expression here that would silently send it down the engaged
   * path.
   */
  if (trackFor(outboundClass) === "cold") {
    const cold = evaluateColdGate(await deps.outbound.coldTrackFacts(organizationId));

    if (!cold.allow) {
      if (cold.pauseTrack) await deps.outbound.pauseColdTrack(organizationId, cold.reason);

      await stopOutboundHold(deps, organizationId, holdId, current, {
        holdStatus: "cancelled",
        messageStatus: "blocked",
        blockedReason: cold.reason,
        summary: coldBlockSummary(cold.reason),
        decisionOutcome: "skipped",
      });
      return nothing(`cold-blocked:${cold.reason}`);
    }
  }

  const claimed = await deps.db
    .update(autonomyHolds)
    .set({ status: "sent", sentAt: new Date() })
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.autonomyHoldId, holdId),
        eq(autonomyHolds.status, "held"),
      ),
    )
    .returning({ id: autonomyHolds.autonomyHoldId });

  if (claimed.length === 0) return nothing("lost-the-race");

  await deps.db
    .update(crmOutboundMessages)
    .set({ timezoneUsed: verdict.timezoneUsed, timezoneSource: verdict.timezoneSource })
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.outboundMessageId, current.outboundMessageId),
      ),
    );

  return {
    outcome: "claimed",
    waitMs: 0,
    outboundMessageId: current.outboundMessageId,
    decisionId: current.decisionId,
    recipientEmail,
    subject: current.subject,
    body: current.body,
  };
}
