import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { autonomousDecisions, autonomyHolds, autonomySwitches, quotes } from "../../db/schema";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { QuotesLifecycleService } from "../quotes/quotes-lifecycle.service";
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

    const hold = await this.loadHold(context.organizationId, holdId);
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

    await step.run("send-or-cancel", async () => {
      // Re-read: a human may have cancelled while the run was released, and an
      // operator may have killed the action type entirely.
      const current = await this.loadHold(context.organizationId, holdId);
      if (!current) return { outcome: "gone" };

      const switchAllows = await this.switchAllows(context.organizationId);
      const resolution = resolveHold(
        { status: current.status, holdUntil: current.holdUntil },
        switchAllows,
      );

      if (resolution.action === "skip") return { outcome: resolution.reason };

      if (resolution.action === "cancel") {
        await this.markCancelled(context.organizationId, holdId, current.decisionId);
        return { outcome: "cancelled-by-switch" };
      }

      /**
       * Claim the send before performing it.
       *
       * `WHERE status = 'held'` is the whole of "sends exactly once, even across
       * a restart mid-hold": a resumed run whose send already committed matches
       * no row here and does nothing, and a cancel racing the expiry loses or
       * wins cleanly rather than both happening.
       */
      const claimed = await this.db
        .update(autonomyHolds)
        .set({ status: "sent", sentAt: new Date() })
        .where(
          and(
            eq(autonomyHolds.organizationId, context.organizationId),
            eq(autonomyHolds.autonomyHoldId, holdId),
            eq(autonomyHolds.status, "held"),
          ),
        )
        .returning({ id: autonomyHolds.autonomyHoldId });

      if (claimed.length === 0) return { outcome: "lost-the-race" };

      try {
        await this.quotesLifecycle.send(
          context.organizationId,
          current.sendAsUserId ?? "system",
          current.quoteId,
        );
      } catch (error) {
        /**
         * The send failed after the claim. Recorded as failed rather than
         * returned to `held`: a hold that goes back to waiting would send on the
         * next attempt with no window, which is the one thing this whole
         * mechanism exists to prevent.
         */
        await this.db
          .update(autonomyHolds)
          .set({ status: "failed", sentAt: null })
          .where(
            and(
              eq(autonomyHolds.organizationId, context.organizationId),
              eq(autonomyHolds.autonomyHoldId, holdId),
            ),
          );

        await this.db
          .update(autonomousDecisions)
          .set({ outcome: "failed" })
          .where(
            and(
              eq(autonomousDecisions.organizationId, context.organizationId),
              eq(autonomousDecisions.autonomousDecisionId, current.decisionId),
            ),
          );

        this.logger.error(
          `hold ${holdId} claimed but the send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { outcome: "send-failed" };
      }

      await this.db
        .update(autonomousDecisions)
        .set({ outcome: "applied" })
        .where(
          and(
            eq(autonomousDecisions.organizationId, context.organizationId),
            eq(autonomousDecisions.autonomousDecisionId, current.decisionId),
          ),
        );

      return { outcome: "sent" };
    });
  }

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
      .from(autonomySwitches);

    return resolveSwitch(
      organizationId,
      "quote.sent",
      switchesFor(organizationId, rows as SwitchRow[]),
    ).allowed;
  }
}
