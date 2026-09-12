import { and, eq } from "drizzle-orm";
import { autonomousDecisions, autonomyHolds, crmOutboundMessages } from "../../../db/schema";
import type { OutboundSendDeps, SendTarget } from "./outbound-send.types";

/*
  The body of the `perform-send` step of `OutboundWorkflow`, and the record of
  a send that did not happen after the claim did. It runs only once
  `claim-send-N` has committed the claim on its own — the reason the two are
  separate steps is written beside them in `outbound.workflow.ts`.
*/

/**
 * Put it on the wire, and record what actually happened.
 *
 * `EmailOutboxService.enqueueAndTry` rather than the provider directly: it
 * writes a durable outbox row before it attempts delivery and re-applies the
 * platform suppression list, so a provider outage retries instead of losing
 * the message. It throws on a configuration failure and on an exhausted send,
 * which is why the whole call is inside the try — a throw that escaped would
 * retry the STEP, and a step retry here is a second copy of a message that
 * cannot be recalled.
 *
 * The engaged track only. This sends from the platform's transactional domain,
 * which is precisely the reputation `cold-outbound-gate.ts` exists to stop the
 * cold track borrowing — and the gate cannot see it, because it only judges
 * the domain it is told about. Cold has no entry point yet (`judgeOutbound`
 * never proposes `cold_outreach`), so nothing reaches here on that track
 * today; when something does, it needs its own sender on its own domain rather
 * than this one.
 */
export async function performOutboundSend(
  deps: OutboundSendDeps,
  organizationId: string,
  holdId: string,
  target: SendTarget,
): Promise<{ outcome: string }> {
  try {
    await deps.outbox.enqueueAndTry({
      organizationId,
      to: target.recipientEmail,
      subject: target.subject,
      // The draft is plain text by contract — `outboundDraftSchema` says so and
      // the system prompt asks for it — so the paragraphs are the only markup
      // it can carry, and escaping is what stops a customer's own name
      // becoming markup in the message we wrote about them.
      html: toPlainHtml(target.body),
      text: target.body,
    });
  } catch (error) {
    return markOutboundSendFailed(
      deps,
      organizationId,
      holdId,
      target,
      error instanceof Error ? error.message : String(error),
    );
  }

  await deps.db
    .update(crmOutboundMessages)
    .set({ status: "sent", sentAt: new Date(), recipientEmail: target.recipientEmail })
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.outboundMessageId, target.outboundMessageId),
      ),
    );

  await deps.db
    .update(autonomousDecisions)
    .set({ outcome: "applied" })
    .where(
      and(
        eq(autonomousDecisions.organizationId, organizationId),
        eq(autonomousDecisions.autonomousDecisionId, target.decisionId),
      ),
    );

  return { outcome: "sent" };
}

/**
 * The send did not happen after the claim did.
 *
 * Recorded as failed rather than returned to `held`: a hold that went back to
 * waiting would send on the next attempt with no window, which is the one
 * thing the whole mechanism exists to prevent.
 */
async function markOutboundSendFailed(
  deps: OutboundSendDeps,
  organizationId: string,
  holdId: string,
  target: { outboundMessageId: string; decisionId: string },
  reason: string,
): Promise<{ outcome: string }> {
  await deps.db
    .update(autonomyHolds)
    .set({ status: "failed", sentAt: null })
    .where(
      and(
        eq(autonomyHolds.organizationId, organizationId),
        eq(autonomyHolds.autonomyHoldId, holdId),
      ),
    );

  await deps.db
    .update(crmOutboundMessages)
    .set({ status: "failed", blockedReason: "send-failed" })
    .where(
      and(
        eq(crmOutboundMessages.organizationId, organizationId),
        eq(crmOutboundMessages.outboundMessageId, target.outboundMessageId),
      ),
    );

  await deps.db
    .update(autonomousDecisions)
    .set({ outcome: "failed" })
    .where(
      and(
        eq(autonomousDecisions.organizationId, organizationId),
        eq(autonomousDecisions.autonomousDecisionId, target.decisionId),
      ),
    );

  deps.logger.error(`outbound hold ${holdId} claimed but the send did not happen: ${reason}`);
  return { outcome: "send-failed" };
}

/**
 * Plain text into the minimum HTML that renders it as written.
 *
 * Escaped first, then paragraphed. A customer called `O'Brien & Sons <Ltd>`
 * appears in the body the drafter wrote about them, and an unescaped `<` there
 * turns the rest of the message into markup nobody sees.
 */
function toPlainHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return escaped
    .split(/\r?\n\r?\n/)
    .map((paragraph) => `<p>${paragraph.replace(/\r?\n/g, "<br />")}</p>`)
    .join("\n");
}
