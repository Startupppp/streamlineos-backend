import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, autonomySwitches, quotes } from "../../db/schema";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { isSendNotDraft, QuotesLifecycleService } from "../quotes/quotes-lifecycle.service";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
import { resolveHold } from "./hold-window";
import { HOLD_WORKFLOW } from "./autonomy-hold.service";

/**
 * The wait, and what happens at the end of it.
 *
 * Written on the runtime's sleep primitive rather than a polling job for three
 * reasons the ticket names: polling adds latency to every send, a crash
 * mid-batch leaves no record of what completed, and a hold has to survive a
 * deploy. `step.sleep` releases the run and re-claims it later, so a sixty
 * second wait and a six hour one cost the same nothing while they wait.
 */
@Injectable()
export class AutonomyHoldWorkflow implements OnModuleInit {
  private readonly logger = new Logger("AutonomyHold");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: WorkflowRegistry,
    private readonly quotesLifecycle: QuotesLifecycleService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: HOLD_WORKFLOW,
      maxAttempts: 5,
      handler: (step, context) => this.handle(step, context),
    });
  }

  private async handle(step: StepContext, context: WorkflowRunContext): Promise<void> {
    const holdId = String(context.input.autonomyHoldId ?? "");
    if (!holdId) throw new Error("hold: run started without an autonomyHoldId");

    /**
     * Opened explicitly, because a workflow body is not inside a transaction.
     *
     * Only a `step.run` gets one from the runner, and this read runs before the
     * first step — so `this.db` resolves to the raw pool with no
     * `app.organization_id` set. `autonomy_holds.organization_id` is NOT NULL, so
     * 0381's relaxation to the non-raising `current_org_id_or_null()` skipped the
     * table and its policy still calls `app.current_org_id()`, which raises 42501
     * when the GUC is unset. Dev never sees it because `DATABASE_URL` connects as
     * an owner with BYPASSRLS; production sees five failed attempts and a
     * dead-lettered run whose quote never sends.
     *
     * Deliberately not a `step.run`: memoising this would freeze `holdUntil` at
     * whatever it was on the first attempt, and a read has no effect worth
     * checkpointing.
     */
    const hold = await runInNewTenantTransaction(this.db, context.organizationId, () =>
      this.loadHold(context.organizationId, holdId),
    );

    if (!hold) {
      // The hold was deleted with its organisation. Nothing to wait for.
      this.logger.warn(`hold ${holdId} no longer exists; ending run`);
      return;
    }

    /**
     * Wait out the remainder, not the whole window.
     *
     * A run re-claimed after a deploy has already spent some of it, and sleeping
     * the full duration again would silently double every hold that happened to
     * span a restart.
     */
    const remainingMs = Math.max(0, hold.holdUntil.getTime() - Date.now());
    await step.sleep("hold-window", remainingMs);

    /**
     * Claiming and sending are two steps, because they are two transactions.
     *
     * `WHERE status = 'held'` only makes the send exactly-once if the claim is
     * durable *before* the send happens. In one step it is not: `withinStep`
     * wraps the whole body in a single transaction, so a pod killed — or an
     * `idle_in_transaction_session_timeout` fired, sixty seconds by default,
     * while the transaction sat idle waiting on the send — after `send()` ran
     * and before COMMIT rolls the claim back to `held`, the lease expires,
     * `claimDueRuns` re-claims, and the customer gets the quote twice.
     *
     * Split, the claim commits on its own and a re-run of the second step finds
     * no claimable row. The residual failure moves to the other side: a crash
     * between the two steps leaves the hold at `sent` with nothing sent, which
     * the resumed run then performs — and if the run dead-letters first, an
     * operator sees a hold marked sent rather than a customer seeing two quotes.
     * At-most-once is the right direction for a message that cannot be recalled.
     */
    const claim = await step.run("claim-send", async () => this.claimSend(context.organizationId, holdId));

    if (claim.outcome !== "claimed" || claim.quoteId === null || claim.decisionId === null) return;
    const { quoteId, decisionId, sendAsUserId } = claim;

    await step.run("perform-send", async () =>
      this.performSend(context.organizationId, holdId, {
        quoteId,
        decisionId,
        sendAsUserId: sendAsUserId ?? "system",
      }),
    );
  }

  // ── The two halves of the send ────────────────────────────────────────────

  /**
   * Take the send, or find out somebody else already did.
   *
   * Everything here is a re-read: a human may have cancelled while the run was
   * released, and an operator may have killed the action type entirely. The
   * conditional UPDATE is the concurrency control — a cancel racing the expiry
   * resolves one way or the other and never both.
   */
  private async claimSend(
    organizationId: string,
    holdId: string,
  ): Promise<{
    outcome: string;
    quoteId: number | null;
    decisionId: string | null;
    sendAsUserId: string | null;
  }> {
    const nothingClaimed = (outcome: string) => ({
      outcome,
      quoteId: null,
      decisionId: null,
      sendAsUserId: null,
    });

    const current = await this.loadHold(organizationId, holdId);
    if (!current) return nothingClaimed("gone");

    const switchAllows = await this.switchAllows(organizationId);
    const resolution = resolveHold(
      { status: current.status, holdUntil: current.holdUntil },
      switchAllows,
      new Date(),
    );

    if (resolution.action === "skip") return nothingClaimed(resolution.reason);

    if (resolution.action === "cancel") {
      await this.markCancelled(organizationId, holdId, current.decisionId);
      return nothingClaimed("cancelled-by-switch");
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

    if (claimed.length === 0) return nothingClaimed("lost-the-race");

    return {
      outcome: "claimed",
      quoteId: current.quoteId,
      decisionId: current.decisionId,
      sendAsUserId: current.sendAsUserId,
    };
  }

  /**
   * Send it, and record what actually happened rather than what was intended.
   *
   * `QuotesLifecycleService.send` does not throw on its two likeliest failures:
   * it returns `null` when the quote is gone and `{ error: "not_draft" }` when it
   * is no longer a draft. Both were previously discarded and the ledger wrote
   * `applied` regardless — so the common case where the deal owner reads the
   * "about to send" notification and sends the quote himself was recorded as the
   * system's send, crediting a human's action to the machine and padding the
   * denominator the correction rate is measured against.
   *
   * `not_draft` is also what a re-run sees in the rare case where the first
   * attempt's send committed but its transaction did not. Recording that as
   * failed understates what the system did; the alternative — treating any
   * already-sent quote as our own success — overstates it, and overstating is
   * the direction that makes the scoreboard a lie.
   */
  private async performSend(
    organizationId: string,
    holdId: string,
    target: { quoteId: number; decisionId: string; sendAsUserId: string },
  ): Promise<{ outcome: string }> {
    let sent: Awaited<ReturnType<QuotesLifecycleService["send"]>>;

    try {
      sent = await this.quotesLifecycle.send(organizationId, target.sendAsUserId, target.quoteId);
    } catch (error) {
      return this.markSendFailed(
        organizationId,
        holdId,
        target.decisionId,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (sent === null)
      return this.markSendFailed(
        organizationId,
        holdId,
        target.decisionId,
        "the quote no longer exists",
      );

    if (isSendNotDraft(sent))
      return this.markSendFailed(
        organizationId,
        holdId,
        target.decisionId,
        "the quote was no longer a draft — somebody had already sent it",
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
   * Recorded as failed rather than returned to `held`: a hold that goes back to
   * waiting would send on the next attempt with no window, which is the one
   * thing this whole mechanism exists to prevent.
   */
  private async markSendFailed(
    organizationId: string,
    holdId: string,
    decisionId: string,
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
      .update(autonomousDecisions)
      .set({ outcome: "failed" })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      );

    this.logger.error(`hold ${holdId} claimed but the send did not happen: ${reason}`);
    return { outcome: "send-failed" };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadHold(organizationId: string, holdId: string) {
    const [row] = await this.db
      .select({
        status: autonomyHolds.status,
        holdUntil: autonomyHolds.holdUntil,
        quoteId: autonomyHolds.quoteId,
        decisionId: autonomyHolds.autonomousDecisionId,
        sendAsUserId: quotes.createdById,
      })
      .from(autonomyHolds)
      .leftJoin(
        quotes,
        and(eq(quotes.orgId, autonomyHolds.organizationId), eq(quotes.id, autonomyHolds.quoteId)),
      )
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, holdId),
        ),
      )
      .limit(1);

    if (!row || row.quoteId === null) return null;
    return { ...row, quoteId: row.quoteId };
  }

  private async markCancelled(organizationId: string, holdId: string, decisionId: string) {
    await this.db
      .update(autonomyHolds)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelReason: "Autonomous sending was switched off during the hold",
      })
      .where(
        and(
          eq(autonomyHolds.organizationId, organizationId),
          eq(autonomyHolds.autonomyHoldId, holdId),
          eq(autonomyHolds.status, "held"),
        ),
      );

    await this.db
      .update(autonomousDecisions)
      .set({
        outcome: "reversed",
        reversedAt: new Date(),
        reversedReason: "Autonomous sending was switched off during the hold",
      })
      .where(
        and(
          eq(autonomousDecisions.organizationId, organizationId),
          eq(autonomousDecisions.autonomousDecisionId, decisionId),
        ),
      );
  }

  private async switchAllows(organizationId: string): Promise<boolean> {
    const rows = await this.db
      .select({
        organizationId: autonomySwitches.organizationId,
        kind: autonomySwitches.kind,
        enabled: autonomySwitches.enabled,
        reason: autonomySwitches.reason,
      })
      .from(autonomySwitches)
      // Scoped like both sibling call sites. `switchesFor` discards the rest in
      // JS and RLS discards them in production, so this is not a leak — but an
      // unscoped read pulls every tenant's switches back on every hold expiry.
      .where(
        or(
          isNull(autonomySwitches.organizationId),
          eq(autonomySwitches.organizationId, organizationId),
        ),
      );

    return resolveSwitch(
      organizationId,
      "quote.sent",
      switchesFor(organizationId, rows as SwitchRow[]),
    ).allowed;
  }
}
