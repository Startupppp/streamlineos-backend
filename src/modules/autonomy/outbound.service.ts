import { Inject, Injectable, Logger } from "@nestjs/common";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { runWithTenantContext } from "../../common/tenant/tenant-context";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { EmailSuppressionService } from "../email/email-suppression.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { shouldAct } from "./decision-record";
import { decisionKindFor, OUTBOUND_CLASS_LABELS, type OutboundClass } from "./outbound-classes";
import { draftRefusalSummary, judgeDraft } from "./outbound-draft";
import { judgeOutbound, outboundRefusalSummary } from "./outbound-eligibility";
import type { ColdTrackFacts } from "./cold-outbound-gate";
import type { SendTimeFacts } from "./send-guardrails";
import {
  outboundSwitchAllows,
  pauseColdOutboundTrack,
  readColdTrackFacts,
} from "./lib/outbound-cold-track";
import { loadComposeContext } from "./lib/outbound-compose-context";
import { draftOutboundMessage } from "./lib/outbound-compose-draft";
import type {
  ComposeOutcome,
  OutboundHoldDeps,
  OutboundHoldInput,
  SendTimeMessage,
} from "./lib/outbound-compose.types";
import { placeOutboundHold, recordOutboundRefusal } from "./lib/outbound-hold-placement";
import { resolveOutboundRecipient } from "./lib/outbound-party-reads";
import { readSendTimeFacts } from "./lib/outbound-send-facts";

/**
 * The workflow name the placer and the runner both use. Declared beside the
 * placement, in `lib/outbound-hold-placement.ts`, and re-exported here because
 * the runner and its spec import it from the service.
 */
export { OUTBOUND_WORKFLOW } from "./lib/outbound-hold-placement";
export type { ComposeOutcome } from "./lib/outbound-compose.types";

/**
 * Deciding to write to a customer, and reading the world again when it leaves.
 *
 * This is the seam between the six pure modules in this directory and the
 * database. Every judgement lives in one of those files as a pure function of an
 * explicit snapshot; everything here is the reading that builds a snapshot and
 * the writing that records what the judgement decided. Nothing in this file
 * decides anything, which is what keeps the rules arguable without a database.
 *
 * The one property worth stating twice: `sendTimeFacts` is NOT called from
 * `composeAndHold`. Its whole reason to exist is to be called at the far end of
 * the hold window, inside the step that claims the send — see
 * `send-guardrails.ts`, whose first paragraph is the argument. A caller that
 * took the snapshot when it drafted would be enforcing a reading of the world
 * from an hour ago at the only moment that matters, and every one of these
 * facts — a reply, an unsubscribe, a colleague's mail, the clock — is one that
 * changes inside that hour.
 *
 * The reads and writes themselves live in `lib/outbound-*.ts`, one file per
 * moment — compose-time context, the draft, send-time facts, the cold track
 * and the switch, placing the hold — and this class is their entry point.
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger("Outbound");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly scoring: AutonomyScoringService,
    private readonly notifications: NotificationsService,
    private readonly suppression: EmailSuppressionService,
  ) {}

  // ── Compose time ──────────────────────────────────────────────────────────

  /**
   * Decide whether to write to somebody, write it, and start the interval in
   * which a human can stop it.
   *
   * The order is the ticket, and it runs cheapest-refusal-first: the relationship
   * is judged before a provider is paid, the draft is judged before a row is
   * written, and the confidence threshold is applied before anything is held.
   * Every one of those exits records a decision — a skip nobody wrote down is
   * indistinguishable from a loop that never ran, and the correction rate needs
   * a denominator that includes the messages there was nothing to say in.
   *
   * There is no approval step. The decision is recorded as `held` rather than
   * `applied` because it has not happened yet; a reviewer seeing "sent" for
   * something still waiting would be reading a lie.
   */
  async composeAndHold(input: {
    organizationId: string;
    partyId: string;
    dealId?: string | null;
  }): Promise<ComposeOutcome> {
    const { organizationId, partyId } = input;
    const context = await loadComposeContext(this.db, organizationId, partyId, input.dealId ?? null);

    if (!context) return { held: false, stage: "eligibility", reason: "That customer is not on file." };

    const verdict = judgeOutbound(context.snapshot);

    if (!verdict.act) {
      const summary = outboundRefusalSummary(verdict.reason);
      await recordOutboundRefusal(this.db, organizationId, input, "outbound.sent", summary);
      return { held: false, stage: "eligibility", reason: summary };
    }

    const outboundClass = verdict.outboundClass;
    const kind = decisionKindFor(outboundClass);

    /**
     * The kill switch is read here as well as on wake, and the two readings do
     * different jobs.
     *
     * On wake it stops a message that was already decided. Here it stops the
     * provider call that would have decided one — an operator who has switched
     * outbound off should not still be paying for drafts nobody may send. The
     * wake-time read stays authoritative, because a switch thrown during the
     * hold window is exactly the case this one cannot see.
     */
    if (!(await this.switchAllows(organizationId, outboundClass))) {
      const summary = "Autonomous sending is switched off; nothing was drafted.";
      await recordOutboundRefusal(this.db, organizationId, input, kind, summary);
      return { held: false, stage: "eligibility", reason: summary };
    }

    /**
     * `judgeDraft`'s `no-sender-name` refusal, made before the money is spent.
     *
     * It would refuse the draft anyway — there is no salesperson to write as —
     * and the only difference between checking here and letting it fail there is
     * a provider call the tenant is billed for on every sweep over a party
     * nobody owns. The check is duplicated rather than moved: `judgeDraft` is
     * the authority and stays the last gate, because a second caller assembling
     * its own context must not be able to skip it.
     */
    if (!context.senderName.trim()) {
      const summary = "Nobody here is on the deal to write as, so nothing was drafted.";
      await recordOutboundRefusal(this.db, organizationId, input, kind, summary);
      return { held: false, stage: "draft", reason: summary };
    }

    // The one provider call. The context is redacted before the prompt is built.
    const { result, conversation, recipientName, senderName } = await draftOutboundMessage(
      { gateway: this.gateway, logger: this.logger },
      organizationId,
      context,
      outboundClass,
    );

    if (!result.ok) {
      // The gateway has already released its reservation. This only records that
      // a decision was attempted, so a provider outage reads as a visible run of
      // failures rather than as silence.
      await recordOutboundRefusal(
        this.db,
        organizationId,
        input,
        kind,
        `Drafting did not complete: ${result.kind}.`,
        "failed",
      );
      return { held: false, stage: "draft", reason: "Drafting did not complete." };
    }

    const judged = judgeDraft(result.data, { recipientName, senderName, conversation });

    if (!judged.ok) {
      const summary = draftRefusalSummary(judged.reason);
      await recordOutboundRefusal(this.db, organizationId, input, kind, summary, "skipped", {
        model: result.aiUsage.model,
        confidence: result.data.confidence,
      });
      return { held: false, stage: "draft", reason: summary };
    }

    const draft = judged.draft;

    /**
     * The threshold, applied after the draft rather than before it.
     *
     * It cannot be applied earlier: the confidence is the model's own, and there
     * is nothing to threshold until it has answered. `decision-record.ts` sets
     * cold higher than engaged, which is why the kind is derived from the class
     * rather than fixed.
     */
    if (!shouldAct(kind, draft.confidence)) {
      const summary = `Drafted a ${OUTBOUND_CLASS_LABELS[outboundClass].toLowerCase()} but was not confident enough to send it.`;
      await recordOutboundRefusal(this.db, organizationId, input, kind, summary, "skipped", {
        model: result.aiUsage.model,
        confidence: draft.confidence,
      });
      return { held: false, stage: "confidence", reason: summary };
    }

    return this.holdOutboundSend({
      organizationId,
      partyId,
      dealId: input.dealId ?? null,
      contactId: context.contactId,
      outboundClass,
      draft,
      model: result.aiUsage.model,
      reason: verdict.reason,
    });
  }

  /**
   * Write the message down and start its clock. The rows, and the order they
   * are written in, are `placeOutboundHold`'s in `lib/outbound-hold-placement.ts`.
   */
  private async holdOutboundSend(input: OutboundHoldInput): Promise<ComposeOutcome> {
    /*
      One tenant transaction for the whole hold.

      `autonomy_holds` is under row-level security, and these writes went
      through `(tx as unknown as Db)` with no organisation set — so the insert was refused by
      the policy and composing a held send 500'd. The decision, the message, the
      hold and its workflow run also belong together: a hold with no run never
      opens, and a run with no hold has nothing to release.
    */
    return runInNewTenantTransaction(this.db, input.organizationId, (tx) =>
      runWithTenantContext(
        { orgId: input.organizationId, audience: "INTERNAL", tx },
        async () => placeOutboundHold(this.holdDeps(), tx, input),
      ),
    );
  }

  private holdDeps(): OutboundHoldDeps {
    return {
      db: this.db,
      logger: this.logger,
      scoring: this.scoring,
      notifications: this.notifications,
    };
  }

  // ── Send time ─────────────────────────────────────────────────────────────

  /**
   * The world, read as late as it can be read: called from inside the claim
   * step and nowhere else. `lib/outbound-send-facts.ts` has the reasons.
   */
  async sendTimeFacts(organizationId: string, message: SendTimeMessage): Promise<SendTimeFacts> {
    return readSendTimeFacts(
      { db: this.db, suppression: this.suppression },
      organizationId,
      message,
    );
  }

  /** The cold track's own facts, read at send time for the same reason. */
  async coldTrackFacts(organizationId: string): Promise<ColdTrackFacts> {
    return readColdTrackFacts(this.db, organizationId);
  }

  /** The address, resolved at send time rather than copied from the draft. */
  async resolveRecipient(organizationId: string, partyId: string): Promise<string | null> {
    return resolveOutboundRecipient(this.db, organizationId, partyId);
  }

  /** Whether the kill switch for this class allows anything at all. */
  async switchAllows(organizationId: string, outboundClass: OutboundClass): Promise<boolean> {
    return outboundSwitchAllows(this.db, organizationId, outboundClass);
  }

  /** The track stops itself, and only a person starts it again. */
  async pauseColdTrack(organizationId: string, reason: string): Promise<void> {
    return pauseColdOutboundTrack(this.db, organizationId, reason);
  }
}
