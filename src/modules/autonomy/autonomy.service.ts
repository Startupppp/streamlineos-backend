import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, activityParticipants, crmPipelineStages } from "../../db/schema";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { AutonomyActionsService } from "./autonomy-actions.service";
import { classifyDelivery } from "./deterministic";
import {
  buildDecision,
  capText,
  RECORDED_CONVERSATION_CHARS,
  redactForModel,
} from "./decision-record";
import { judgeEligibility, refusalSummary } from "./eligibility";
import {
  buildThreadWindow,
  windowMessages,
  windowStart,
  THREAD_WINDOW_MAX_MESSAGES,
  type ThreadActivity,
} from "./thread-window";
import {
  buildExtractionPrompt,
  extractionSchema,
  EXTRACTION_FEATURE,
  EXTRACTION_PROMPT_KEY,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  type Extraction,
} from "./extraction.schemas";

/**
 * Hard caps, so a long thread cannot become an unbounded context window.
 *
 * The conversation's cap lives in `thread-window.ts` now, with the two bounds it
 * has to be read alongside — a character budget stated apart from the count and
 * time bounds it shares a window with is a number nobody can check.
 */
const MAX_STAGES = 40;

@Injectable()
export class AutonomyService {
  private readonly logger = new Logger("Autonomy");

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly actions: AutonomyActionsService,
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
    const activity = await this.loadActivity(organizationId, activityId);
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
          dealId: activity.dealId,
          activityId,
          summary: `Not a reply — classified as ${delivery}. Nothing extracted.`,
        }),
      );
      return;
    }

    /**
     * The message, read with the messages around it.
     *
     * A burst of fragments is one decision and no single fragment carries it, so
     * reading one activity at a time could not recover it however good the
     * prompt was. `thread-window.ts` holds the three bounds and the reason for
     * each; the one that matters to a bill is that the character bound is the
     * cap a single message already had, so the ceiling has not moved.
     */
    const window = buildThreadWindow(activity, await this.loadThread(organizationId, activity));
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
          dealId: activity.dealId,
          activityId,
          summary: refusalSummary(eligibility.reason),
        }),
      );
      return;
    }

    const deal = activity.dealId ? await this.actions.loadDeal(organizationId, activity.dealId) : null;
    const availableStages = deal ? await this.loadStages(organizationId, deal.pipelineId) : [];

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
          dealId: activity.dealId,
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
    if (deal)
      await this.actions.applyStageAdvance(organizationId, activityId, deal.id, extraction, model, inputs, availableStages);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The activity, and who sent it.
   *
   * The sender lives on `activity_participants`, not on the activity, so reading
   * the activity alone leaves `classifyDelivery` with an empty `fromAddress` and
   * only its subject-phrase check alive — which is how a bounce from
   * `mailer-daemon@` was read as a customer replying. Joined rather than fetched
   * separately: it is one row either way, and this is on the path of every
   * inbound message.
   */
  private async loadActivity(organizationId: string, activityId: string) {
    const [row] = await this.db
      .select({
        // The window needs the same shape a neighbour has, so the message being
        // judged goes through the same rules as everything read beside it.
        activityId: activities.activityId,
        kind: activities.kind,
        occurredAt: activities.occurredAt,
        threadId: activities.threadId,
        actorKind: activities.actorKind,
        source: activities.source,
        subject: activities.subject,
        body: activities.body,
        partyId: activities.partyId,
        dealId: activities.dealId,
        fromAddress: activityParticipants.address,
      })
      .from(activities)
      .leftJoin(
        activityParticipants,
        and(
          eq(activityParticipants.organizationId, activities.organizationId),
          eq(activityParticipants.activityId, activities.activityId),
          eq(activityParticipants.role, "from"),
        ),
      )
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
          isNull(activities.deletedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * The last few things on this message's thread, and nothing older.
   *
   * The bounds are applied twice on purpose. Here, so the read itself is small:
   * `idx_activities_thread_window` is ordered `(organization_id, thread_id,
   * occurred_at desc, activity_id desc)`, so this is a range scan that stops
   * after ten rows instead of fetching a whole thread and sorting it — and on a
   * channel that threads on a pair of phone numbers forever, a whole thread is
   * every message ever exchanged with that customer. And again in
   * `buildThreadWindow`, which is the authority: the bounds are decided by a
   * pure function that can be argued with, not by a query plan.
   *
   * The upper bound is a row comparison rather than a timestamp one because
   * timestamps collide — an imported mail folder writes hundreds in the same
   * second — and "before this message" has to mean something then too.
   */
  private async loadThread(
    organizationId: string,
    trigger: { activityId: string; threadId: string | null; occurredAt: Date },
  ): Promise<ThreadActivity[]> {
    // A message the seam could not thread has no neighbours by definition, and
    // asking for them would scan every unthreaded activity in the organisation.
    if (!trigger.threadId) return [];

    const rows = await this.db
      .select({
        activityId: activities.activityId,
        kind: activities.kind,
        subject: activities.subject,
        body: activities.body,
        occurredAt: activities.occurredAt,
        actorKind: activities.actorKind,
        source: activities.source,
      })
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.threadId, trigger.threadId),
          gte(activities.occurredAt, windowStart(trigger.occurredAt)),
          sql`(${activities.occurredAt}, ${activities.activityId}) <= (${trigger.occurredAt}, ${trigger.activityId})`,
          isNull(activities.deletedAt),
        ),
      )
      .orderBy(desc(activities.occurredAt), desc(activities.activityId))
      .limit(THREAD_WINDOW_MAX_MESSAGES);

    return rows;
  }

  /** The tenant's own stage keys — the only ones a decision may name. */
  private async loadStages(organizationId: string, pipelineId: string | null): Promise<string[]> {
    if (!pipelineId) return [];

    const rows = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(
        and(
          eq(crmPipelineStages.orgId, organizationId),
          eq(crmPipelineStages.pipelineId, pipelineId),
          eq(crmPipelineStages.isActive, true),
        ),
      )
      .limit(MAX_STAGES);

    return rows.map((row) => row.key);
  }
}
