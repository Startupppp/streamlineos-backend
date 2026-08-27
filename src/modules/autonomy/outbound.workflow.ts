import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, crmOutboundMessages } from "../../db/schema";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { EmailOutboxService } from "../email/email-outbox.service";
import { coldBlockSummary, evaluateColdGate } from "./cold-outbound-gate";
import { resolveHold } from "./hold-window";
import { isOutboundClass, trackFor, type OutboundClass } from "./outbound-classes";
import { OUTBOUND_WORKFLOW, OutboundService } from "./outbound.service";
import {
  evaluateGuardrails,
  guardrailSummary,
  MAX_WORKING_HOUR_DEFERRALS,
} from "./send-guardrails";

/**
 * The wait, the second look at the world, and the send.
 *
 * The shape is `AutonomyHoldWorkflow`'s, deliberately — the sleep is the
 * runtime's rather than a poller's, the pre-step read opens its own tenant
 * transaction, and claiming is split from sending because they must be two
 * transactions. What is new here is the middle: at the far end of the window
 * this takes a FRESH snapshot of the facts and runs `evaluateGuardrails` over
 * it, inside the same step that claims the send.
 *
 * That placement is the whole ticket rather than a detail of it. Every fact the
 * guardrails read can change while a message waits — they reply, the deal
 * closes, somebody clicks unsubscribe, a colleague mails them, the clock crosses
 * into the evening. Evaluating at compose time would enforce a reading of the
 * world from before the window and call it enforcement. `outbound.spec.ts` pins
 * the ordering directly, so moving the snapshot earlier fails a test rather than
 * quietly becoming the new behaviour.
 *
 * The cold gate runs after the guardrails and only for the cold track, because
 * it answers a different question — not "may we write to this person" but "may
 * this domain send anything today". A message that is both outside working hours
 * and going out on an unwarmed domain is reported as the domain, since the
 * deferral would schedule a send the domain still could not make.
 */
@Injectable()
export class OutboundWorkflow implements OnModuleInit {
  private readonly logger = new Logger("Outbound");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
    private readonly outbound: OutboundService,
    private readonly outbox: EmailOutboxService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: OUTBOUND_WORKFLOW,
      maxAttempts: 5,
      handler: (step, context) => this.handle(step, context),
    });
  }

  private async handle(step: StepContext, context: WorkflowRunContext): Promise<void> {
    const holdId = String(context.input.autonomyHoldId ?? "");
    if (!holdId) throw new Error("outbound: run started without an autonomyHoldId");

    /**
     * Opened explicitly, because a workflow body is not inside a transaction.
     *
     * Only a `step.run` gets one from the runner, so this read — which happens
     * before the first step — would otherwise hit the raw pool with no
     * `app.organization_id` set. Both `autonomy_holds` and
     * `crm_outbound_messages` have NOT NULL tenant columns, so their policies
     * call the raising `app.current_org_id()` and the read is 42501 in
     * production: five failed attempts and a dead-lettered run whose message
     * never sends. Dev never sees it, because `DATABASE_URL` connects as an
     * owner with BYPASSRLS.
     *
     * Deliberately not a `step.run`: memoising it would freeze `holdUntil` at
     * the first attempt's value, and a read has no effect worth checkpointing.
     */
    const hold = await runInNewTenantTransaction(this.db, context.organizationId, () =>
      this.loadHold(context.organizationId, holdId),
    );

    if (!hold) {
      this.logger.warn(`outbound hold ${holdId} no longer exists; ending run`);
      return;
    }

    /**
     * The remainder, not the whole window. A run re-claimed after a deploy has
     * already spent some of it, and sleeping the full duration again would
     * silently double every hold that happened to span a restart.
     */
    await step.sleep("hold-window", Math.max(0, hold.holdUntil.getTime() - Date.now()));

    /**
     * A bounded number of attempts, with a step name per attempt.
     *
     * Step names identify a memo and must be unique within a run, so a deferral
     * cannot re-enter one loop body — each pass gets its own pair. The bound is
     * `MAX_WORKING_HOUR_DEFERRALS + 1` because that is exactly how many claims
     * can happen before `evaluateGuardrails` itself refuses: two deferrals, then
     * a third claim that reports `deferred-too-often` and stops. The loop cannot
     * outlive the rule, which is what keeps the count in one place.
     */
    for (let attempt = 0; attempt <= MAX_WORKING_HOUR_DEFERRALS; attempt += 1) {
      const claim = await step.run(`claim-send-${attempt}`, async () =>
        this.claimSend(context.organizationId, holdId),
      );

      if (claim.outcome === "deferred") {
        await step.sleep(`defer-${attempt}`, Math.max(0, claim.waitMs));
        continue;
      }

      if (claim.outcome !== "claimed") return;

      /**
       * Claiming and sending are two steps, because they are two transactions.
       *
       * `WHERE status = 'held'` only makes the send at-most-once if the claim is
       * durable BEFORE the send happens. In one step it is not: `withinStep`
       * wraps the body in a single transaction, so a pod killed — or an
       * `idle_in_transaction_session_timeout` fired while the transaction sat
       * idle waiting on the provider — after the mail left and before COMMIT
       * rolls the claim back to `held`, the lease expires, the run is re-claimed
       * and the customer gets the message twice.
       *
       * Split, the claim commits alone and a re-run finds no claimable row. The
       * residual failure moves to the other side: a crash between the two steps
       * leaves a hold marked sent with nothing sent, which an operator can see.
       * At-most-once is the right direction for a message that cannot be recalled.
       */
      await step.run("perform-send", async () =>
        this.performSend(context.organizationId, holdId, {
          outboundMessageId: claim.outboundMessageId ?? "",
          decisionId: claim.decisionId ?? "",
          recipientEmail: claim.recipientEmail ?? "",
          subject: claim.subject ?? "",
          body: claim.body ?? "",
        }),
      );
      return;
    }
  }

  // ── The claim, and the second look that precedes it ───────────────────────

  /**
   * Read the world again, judge it, and only then take the send.
   *
   * Everything before the UPDATE is a re-read. The guardrail snapshot is taken
   * HERE, three lines above the statement that claims the message, which is as
   * late as it can be taken and still be inside the transaction that claims it.
   */
  private async claimSend(organizationId: string, holdId: string): Promise<ClaimResult> {
    const nothing = (outcome: string): ClaimResult => ({
      outcome,
      waitMs: 0,
      outboundMessageId: null,
      decisionId: null,
      recipientEmail: null,
      subject: null,
      body: null,
    });

    const current = await this.loadHold(organizationId, holdId);
    if (!current) return nothing("gone");

    const outboundClass = current.outboundClass;

    const resolution = resolveHold(
      { status: current.status, holdUntil: current.holdUntil },
      await this.outbound.switchAllows(organizationId, outboundClass),
      new Date(),
    );

    if (resolution.action === "skip") return nothing(resolution.reason);

    if (resolution.action === "cancel") {
      await this.stop(organizationId, holdId, current, {
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
    const recipientEmail = await this.outbound.resolveRecipient(organizationId, current.partyId);

    if (!recipientEmail) {
      await this.stop(organizationId, holdId, current, {
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
    const facts = await this.outbound.sendTimeFacts(organizationId, {
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
      await this.db
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
      await this.stop(organizationId, holdId, current, {
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
      const cold = evaluateColdGate(await this.outbound.coldTrackFacts(organizationId));

      if (!cold.allow) {
        if (cold.pauseTrack) await this.outbound.pauseColdTrack(organizationId, cold.reason);

        await this.stop(organizationId, holdId, current, {
          holdStatus: "cancelled",
          messageStatus: "blocked",
          blockedReason: cold.reason,
          summary: coldBlockSummary(cold.reason),
          decisionOutcome: "skipped",
        });
        return nothing(`cold-blocked:${cold.reason}`);
      }
    }

    const claimed = await this.db
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

    await this.db
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
  private async performSend(
    organizationId: string,
    holdId: string,
    target: {
      outboundMessageId: string;
      decisionId: string;
      recipientEmail: string;
      subject: string;
      body: string;
    },
  ): Promise<{ outcome: string }> {
    try {
      await this.outbox.enqueueAndTry({
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
      return this.markSendFailed(
        organizationId,
        holdId,
        target,
        error instanceof Error ? error.message : String(error),
      );
    }

    await this.db
      .update(crmOutboundMessages)
      .set({ status: "sent", sentAt: new Date(), recipientEmail: target.recipientEmail })
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.outboundMessageId, target.outboundMessageId),
        ),
      );

    await this.db
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
  private async markSendFailed(
    organizationId: string,
    holdId: string,
    target: { outboundMessageId: string; decisionId: string },
    reason: string,
  ): Promise<{ outcome: string }> {
    await this.db
      .update(autonomyHolds)
      .set({ status: "failed", sentAt: null })
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, holdId),
        ),
      );

    await this.db
      .update(crmOutboundMessages)
      .set({ status: "failed", blockedReason: "send-failed" })
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.outboundMessageId, target.outboundMessageId),
        ),
      );

    await this.db
      .update(autonomousDecisions)
      .set({ outcome: "failed" })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, target.decisionId),
        ),
      );

    this.logger.error(`outbound hold ${holdId} claimed but the send did not happen: ${reason}`);
    return { outcome: "send-failed" };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Stop it, in all three places that have to agree.
   *
   * The hold, the message and the ledger row are updated together: a message
   * left at `held` with a cancelled hold would show in the review feed as still
   * about to send, and a ledger row still saying `held` would tell the scoreboard
   * a decision is in flight that nothing will ever resolve.
   */
  private async stop(
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
    await this.db
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

    await this.db
      .update(crmOutboundMessages)
      .set({ status: how.messageStatus, blockedReason: how.blockedReason })
      .where(
        and(
          eq(crmOutboundMessages.organizationId, organizationId),
          eq(crmOutboundMessages.outboundMessageId, current.outboundMessageId),
        ),
      );

    await this.db
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

  private async loadHold(organizationId: string, holdId: string): Promise<LoadedHold | null> {
    const [row] = await this.db
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
      this.logger.error(
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
}

interface LoadedHold {
  status: "held" | "sent" | "cancelled" | "failed";
  holdUntil: Date;
  decisionId: string;
  outboundMessageId: string;
  partyId: string;
  contactId: number | null;
  dealId: string | null;
  outboundClass: OutboundClass;
  subject: string;
  body: string;
  draftedAt: Date;
  workingHourDeferrals: number;
}

/**
 * The claim step's memo, and therefore JSON.
 *
 * Every field is a primitive because a recorded step is replayed out of
 * `workflow_steps.output` — a `Date` here would come back as a string on the
 * second attempt and the difference would show up as an arithmetic error days
 * later. `waitMs` rather than a `notBefore` instant for exactly that reason.
 */
type ClaimResult = {
  outcome: string;
  waitMs: number;
  outboundMessageId: string | null;
  decisionId: string | null;
  recipientEmail: string | null;
  subject: string | null;
  body: string | null;
};

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
