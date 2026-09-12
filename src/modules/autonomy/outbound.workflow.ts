import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { WorkflowRegistry } from "../../common/workflow";
import type { StepContext, WorkflowRunContext } from "../../common/workflow";
import { EmailOutboxService } from "../email/email-outbox.service";
import { claimOutboundSend } from "./lib/outbound-claim";
import { loadOutboundHold } from "./lib/outbound-hold-state";
import { performOutboundSend } from "./lib/outbound-perform-send";
import type {
  ClaimResult,
  LoadedHold,
  OutboundSendDeps,
  SendTarget,
} from "./lib/outbound-send.types";
import { OUTBOUND_WORKFLOW, OutboundService } from "./outbound.service";
import { MAX_WORKING_HOUR_DEFERRALS } from "./send-guardrails";

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

  // ── The step bodies ───────────────────────────────────────────────────────
  //
  // Declared above, performed in lib/: the claim and the second look that
  // precedes it in `outbound-claim.ts`, the send and its record in
  // `outbound-perform-send.ts`, the hold row in `outbound-hold-state.ts`. The
  // step names, their order and the transactions around them stay here.

  private stepDeps(): OutboundSendDeps {
    return { db: this.db, logger: this.logger, outbound: this.outbound, outbox: this.outbox };
  }

  private claimSend(organizationId: string, holdId: string): Promise<ClaimResult> {
    return claimOutboundSend(this.stepDeps(), organizationId, holdId);
  }

  private performSend(
    organizationId: string,
    holdId: string,
    target: SendTarget,
  ): Promise<{ outcome: string }> {
    return performOutboundSend(this.stepDeps(), organizationId, holdId, target);
  }

  private loadHold(organizationId: string, holdId: string): Promise<LoadedHold | null> {
    return loadOutboundHold(this.stepDeps(), organizationId, holdId);
  }
}
