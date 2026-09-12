import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { AutonomyActionsService } from "./autonomy-actions.service";
import { AutonomyHoldService } from "./autonomy-hold.service";
import { AutonomyScoringService } from "./autonomy-scoring.service";
import { SequenceReplyExitService } from "./sequences/sequence-reply-exit.service";
import { classifyDelivery } from "./deterministic";
import { decisionDealId,
  buildDecision,
  capText,
  RECORDED_CONVERSATION_CHARS,
  redactForModel,
} from "./decision-record";
import { judgeEligibility, refusalSummary } from "./eligibility";
import { buildThreadWindow, windowMessages } from "./thread-window";
import {
  buildExtractionPrompt,
  extractionSchema,
  EXTRACTION_FEATURE,
  EXTRACTION_PROMPT_KEY,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  type Extraction,
} from "./extraction.schemas";
import { loadAutonomyActivity, loadAutonomyStages, loadAutonomyThread } from "./lib/autonomy-activity-reads";
import { maybeDraftAutonomyQuote, type AutonomyQuoteDeps } from "./lib/autonomy-quote-leg";

@Injectable()
export class AutonomyService {
  private readonly logger = new Logger("Autonomy");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly actions: AutonomyActionsService,
    private readonly holds: AutonomyHoldService,
    private readonly scoring: AutonomyScoringService,
    private readonly replyExit: SequenceReplyExitService,
  ) {}

  /**
   * Reads one activity and writes the consequences, asking nobody.
   *
   * The order here is the ticket: everything deterministic first, then the
   * cheapest possible model call, then a threshold, then the write — and a
   * decision row whatever the outcome, including when the answer was to do
   * nothing. A skipped decision nobody recorded is indistinguishable from a
   * decision that never ran.
   */
  async processActivity(organizationId: string, activityId: string): Promise<void> {
    const activity = await loadAutonomyActivity(this.db, organizationId, activityId);
    if (!activity) return;

    /**
     * Deterministic gate, before any spend.
     *
     * A bounce read as engagement advances a deal on the strength of a mail
     * server saying the customer never received anything, and an out-of-office
     * does it with a robot's words. Neither costs a model call to recognise.
     *
     * Three of the five signals `classifyDelivery` decides on are headers —
     * `Auto-Submitted`, `X-Autoreply`, `X-Failed-Recipients` — and none of them
     * can be passed, because nothing persists them: `InboundCommunicationEvent`
     * has no headers field, the mail adapter never reads one, and
     * `inbound_events.payload` stores that same normalised event rather than the
     * raw message. (`activities.metadata` would be the place, and its own
     * contract says it is never read for a lifecycle decision.) So they are dead
     * here until the seam carries them, and the cost of that is specific: a
     * localised Exchange out-of-office ("Abwesenheitsnotiz: …") carrying
     * `Auto-Submitted: auto-replied` still reads as `delivered` and reaches the
     * model as a genuine reply. The sender prefix and the subject phrases — both
     * of which this now actually supplies — catch the English-language majority.
     */
    const delivery = classifyDelivery({
      fromAddress: activity.fromAddress ?? "",
      subject: activity.subject,
      body: activity.body,
    });

    if (delivery !== "delivered") {
      await this.actions.record(
        buildDecision({
          organizationId,
          kind: "task.extracted",
          outcome: "skipped",
          triggerType: "activity",
          triggerId: activityId,
          partyId: activity.partyId,
          dealId: decisionDealId(activity.dealId),
          activityId,
          summary: `Not a reply — classified as ${delivery}. Nothing extracted.`,
        }),
      );
      return;
    }

    /**
     * They replied, so stop every sequence aimed at them — before anything else.
     *
     * Placed here for two reasons, and both are about where the boundaries sit.
     *
     * After the delivery gate, because a bounce or an out-of-office must not end
     * a sequence: the automation stopping because a robot answered is the same
     * mistake as sending over a person, inverted.
     *
     * Before the eligibility gate, because "thanks" is a reply. `judgeEligibility`
     * refuses to spend a provider call on a message with nothing in it, and it is
     * right to — but a customer writing two words has still written in, and the
     * message already drafted and counting down in its hold window has to be
     * cancelled whether or not there is anything here worth extracting. Putting
     * this after that gate would exit sequences only for customers who said
     * something substantial.
     *
     * It never throws; the service guarantees that and this relies on it. A
     * failure to tidy up a sequence must not dead-letter the delivery of a
     * customer's message, and it is self-correcting — the next wake reaches
     * `resolveCadence`, which checks the reply first.
     */
    await this.replyExit.onInboundReply(organizationId, activity.partyId, { activityId });

    /**
     * The message, read with the messages around it.
     *
     * A burst of fragments is one decision and no single fragment carries it, so
     * reading one activity at a time could not recover it however good the
     * prompt was. `thread-window.ts` holds the three bounds and the reason for
     * each; the one that matters to a bill is that the character bound is the
     * cap a single message already had, so the ceiling has not moved.
     */
    const window = buildThreadWindow(activity, await loadAutonomyThread(this.db, organizationId, activity));
    const conversation = window.conversation;

    /**
     * No provider call at all when there is nothing to work with — recorded all
     * the same, for the reason in this method's docblock: a decision nobody wrote
     * down is indistinguishable from one that never ran, and the correction rate
     * needs a denominator that includes the messages there was nothing to do with.
     *
     * Judged over the window's messages rather than the joined text: "a fragment
     * with nothing around it" is a fact about how many of them carry content,
     * and joining them first throws it away. `eligibility.ts` has the argument
     * for what replaced the twenty-character floor.
     */
    const eligibility = judgeEligibility(windowMessages(window));

    if (!eligibility.eligible) {
      await this.actions.record(
        buildDecision({
          organizationId,
          kind: "task.extracted",
          outcome: "skipped",
          triggerType: "activity",
          triggerId: activityId,
          partyId: activity.partyId,
          dealId: decisionDealId(activity.dealId),
          activityId,
          summary: refusalSummary(eligibility.reason),
        }),
      );
      return;
    }

    const deal = activity.dealId ? await this.actions.loadDeal(organizationId, activity.dealId) : null;
    const availableStages = deal ? await loadAutonomyStages(this.db, organizationId, deal.pipelineId) : [];

    /**
     * Redacted before it is built into a prompt, not after.
     *
     * Permission data must never egress to a provider, and no model output may
     * influence an authorization decision. Nothing in this context is
     * permission-shaped by construction; this is the last line that catches the
     * field somebody adds later without thinking.
     */
    const { context: safeContext, removed } = redactForModel({
      dealName: deal?.name ?? null,
      currentStage: deal?.stage ?? null,
      conversation,
    });

    if (removed.length > 0)
      this.logger.warn(`autonomy: stripped ${removed.length} forbidden field(s) before inference`);

    const result = await this.gateway.invokeStructuredWithUsage<Extraction>({
      actor: { orgId: organizationId, userId: null },
      feature: EXTRACTION_FEATURE,
      // Classification and extraction are the small model's job. Nothing here
      // escalates: if it needs frontier reasoning, it needs a human.
      tier: "fast",
      schema: extractionSchema,
      charge: true,
      prompt: {
        system: EXTRACTION_SYSTEM_PROMPT,
        user: buildExtractionPrompt({
          dealName: (safeContext.dealName as string | null) ?? null,
          currentStage: (safeContext.currentStage as string | null) ?? null,
          availableStages,
          conversation: (safeContext.conversation as string) ?? "",
        }),
        promptKey: EXTRACTION_PROMPT_KEY,
        promptVersion: EXTRACTION_PROMPT_VERSION,
      },
    });

    if (!result.ok) {
      // The gateway already released the reservation; this only records that a
      // decision was attempted, so a provider outage is visible as an absence of
      // actions rather than as silence.
      await this.actions.record(
        buildDecision({
          organizationId,
          kind: "task.extracted",
          outcome: "failed",
          triggerType: "activity",
          triggerId: activityId,
          partyId: activity.partyId,
          dealId: decisionDealId(activity.dealId),
          activityId,
          promptVersion: String(EXTRACTION_PROMPT_VERSION),
          summary: `Extraction did not complete: ${result.kind}.`,
        }),
      );
      return;
    }

    const extraction = result.data;
    const model = result.aiUsage.model;
    const inputs = {
      conversation: capText(conversation, RECORDED_CONVERSATION_CHARS),
      availableStages,
      /**
       * What the window actually cost, per decision.
       *
       * Recorded because a thread-shaped prompt is bigger than a message-shaped
       * one and "bigger" is not a number anybody can act on. With this, the
       * spend on the busiest channel is a query against the ledger rather than
       * an argument, and a window that starts growing is visible before the
       * invoice is.
       */
      threadWindow: {
        messages: window.messages.length,
        characters: conversation.length,
        dropped: window.dropped,
      },
    };

    await this.actions.applyNextStep(organizationId, activityId, activity, window, extraction, model, inputs);
    if (deal) {
      const advanced = await this.actions.applyStageAdvance(
        organizationId, activityId, deal.id, extraction, model, inputs, availableStages,
      );
      if (advanced)
        await maybeDraftAutonomyQuote(this.quoteDeps(), organizationId, activityId, deal.id, extraction);
    }
  }

  /** What the quote leg, in `lib/autonomy-quote-leg.ts`, reads and writes through. */
  private quoteDeps(): AutonomyQuoteDeps {
    return {
      db: this.db,
      logger: this.logger,
      actions: this.actions,
      holds: this.holds,
      scoring: this.scoring,
    };
  }
}
