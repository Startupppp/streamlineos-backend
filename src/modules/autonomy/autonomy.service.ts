import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
  activityParticipants,
  autonomousDecisions,
  autonomySwitches,
  crmPipelineStages,
  deals,
} from "../../db/schema";
import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { DealsService } from "../deals/deals.service";
import { classifyDelivery } from "./deterministic";
import {
  buildDecision,
  capText,
  RECORDED_CONVERSATION_CHARS,
  redactForModel,
  shouldAct,
} from "./decision-record";
import { judgeEligibility, refusalSummary } from "./eligibility";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
import {
  alreadyHandled,
  buildThreadWindow,
  windowMessages,
  windowStart,
  THREAD_WINDOW_MAX_MESSAGES,
  type ThreadActivity,
  type ThreadWindow,
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

/** The label a decision wears when the system, not a person, made it. */
const SYSTEM_ACTOR_LABEL = `extraction@${EXTRACTION_PROMPT_VERSION}`;

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
    private readonly dealsService: DealsService,
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
      await this.record(
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
      await this.record(
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

    const deal = activity.dealId ? await this.loadDeal(organizationId, activity.dealId) : null;
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
      await this.record(
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

    await this.applyNextStep(organizationId, activityId, activity, window, extraction, model, inputs);
    if (deal)
      await this.applyStageAdvance(organizationId, activityId, deal.id, extraction, model, inputs, availableStages);
  }

  // ── The two things it may do ──────────────────────────────────────────────

  private async applyNextStep(
    organizationId: string,
    activityId: string,
    activity: { partyId: string | null; dealId: string | null; threadId: string | null },
    window: ThreadWindow,
    extraction: Extraction,
    model: string,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    const step = extraction.nextStep;

    /**
     * A task is only ours to do.
     *
     * "They will send the contract" is a real next step for the customer and a
     * task nobody here can complete — creating it produces a to-do list full of
     * other people's work, which is how a list stops being read.
     *
     * Recorded rather than dropped: the extraction was paid for either way, and
     * "the model found a next step and it was theirs" is a different fact from
     * "nothing ran", which is exactly the distinction the ledger exists to keep.
     */
    if (!step.description || step.owner !== "us") {
      await this.record(
        buildDecision({
          organizationId,
          kind: "task.extracted",
          outcome: "skipped",
          triggerType: "activity",
          triggerId: activityId,
          partyId: activity.partyId,
          dealId: activity.dealId,
          activityId,
          model,
          promptVersion: String(EXTRACTION_PROMPT_VERSION),
          confidence: extraction.confidence,
          inputs,
          decision: { nextStep: step },
          summary: step.description
            ? `Next step found, but it is the customer's to do: ${step.description}`
            // "Conversation" rather than "message": what was read may be a
            // thread, and a summary that says otherwise misreports what was
            // looked at when somebody comes back to ask why nothing happened.
            : "No next step in this conversation.",
        }),
      );
      return;
    }

    /**
     * The same next step, found twice, is still one next step.
     *
     * A window makes a request reachable from every message that follows it, so
     * without this a burst would put a task on somebody's list per fragment —
     * a defect introduced by the fix. Refused where the thread is known rather
     * than left for whoever reads the list to notice, and recorded rather than
     * dropped: "already done" is a different fact from "nothing ran".
     */
    if (alreadyHandled(window, step.description)) {
      await this.record(
        buildDecision({
          organizationId,
          kind: "task.extracted",
          outcome: "skipped",
          triggerType: "activity",
          triggerId: activityId,
          partyId: activity.partyId,
          dealId: activity.dealId,
          activityId,
          model,
          promptVersion: String(EXTRACTION_PROMPT_VERSION),
          confidence: extraction.confidence,
          inputs,
          decision: { nextStep: step },
          summary: `This thread already produced that next step: ${step.description}`,
        }),
      );
      return;
    }

    const allowed = await this.isAllowed(organizationId, "task.extracted");
    const act = allowed.allowed && shouldAct("task.extracted", extraction.confidence);

    let createdActivityId: string | null = null;

    if (act) {
      const [row] = await this.db
        .insert(activities)
        .values({
          organizationId,
          kind: "task",
          occurredAt: new Date(),
          subject: step.description,
          // The task belongs to the conversation it came out of: a reader
          // following a thread finds what it caused, and the duplicate check
          // above reads this column — a task with no thread is one the next
          // message on the thread cannot see.
          threadId: activity.threadId,
          partyId: activity.partyId,
          dealId: activity.dealId,
          actorKind: "system",
          actorLabel: SYSTEM_ACTOR_LABEL,
          dueAt: step.dueDate ? new Date(`${step.dueDate}T09:00:00.000Z`) : null,
          source: "extraction",
        })
        .returning({ activityId: activities.activityId });

      createdActivityId = row?.activityId ?? null;
    }

    await this.record(
      buildDecision({
        organizationId,
        kind: "task.extracted",
        outcome: act ? "applied" : "skipped",
        triggerType: "activity",
        triggerId: activityId,
        partyId: activity.partyId,
        dealId: activity.dealId,
        activityId: createdActivityId ?? activityId,
        model,
        promptVersion: String(EXTRACTION_PROMPT_VERSION),
        confidence: extraction.confidence,
        inputs,
        decision: { nextStep: step },
        summary: act
          ? `Created a task: ${step.description}`
          : allowed.allowed
            ? `Next step found but confidence ${extraction.confidence.toFixed(2)} was below the threshold.`
            : `Task extraction is switched off (${allowed.decidedBy}).`,
      }),
    );
  }

  /**
   * Move the deal, but never over the top of a person.
   *
   * Takes the deal id rather than the row read before the provider call. Seconds
   * pass during that call, and a rep dragging the card in the meantime used to be
   * silently overwritten — with the ledger then recording the *stale* stage as
   * `fromStage` while `deal_stage_transitions`, which re-reads for itself,
   * recorded the real one. Two ledgers disagreeing is bad on its own; it also
   * disarmed the reversal guard, which compares `toStage` against the deal's
   * current stage and so waved through a "reverse" that restored a stage the deal
   * had not been in for days.
   */
  private async applyStageAdvance(
    organizationId: string,
    activityId: string,
    dealId: number,
    extraction: Extraction,
    model: string,
    inputs: Record<string, unknown>,
    availableStages: readonly string[],
  ): Promise<void> {
    const suggested = extraction.stage.suggestedStage;
    if (!suggested) return;

    // Re-read after the provider call, so every judgement below — "is this
    // already the stage", the version passed for the write, and the `fromStage`
    // written to the ledger — is made against what the deal is now.
    const deal = await this.loadDeal(organizationId, String(dealId));

    if (!deal) {
      await this.record(
        buildDecision({
          organizationId,
          kind: "stage.advanced",
          outcome: "skipped",
          triggerType: "activity",
          triggerId: activityId,
          dealId: String(dealId),
          model,
          promptVersion: String(EXTRACTION_PROMPT_VERSION),
          confidence: extraction.confidence,
          inputs,
          decision: { suggestedStage: suggested },
          summary: "The deal was deleted while the extraction was running.",
        }),
      );
      return;
    }

    if (suggested === deal.stage) return;

    /**
     * A stage the tenant does not have is a rejected decision, not a new stage.
     *
     * The model sees the configured list, but nothing stops it returning
     * something else, and creating a stage because a language model named one
     * would let a conversation reshape a tenant's pipeline.
     */
    if (!availableStages.includes(suggested)) {
      await this.record(
        buildDecision({
          organizationId,
          kind: "stage.advanced",
          outcome: "skipped",
          triggerType: "activity",
          triggerId: activityId,
          dealId: String(deal.id),
          model,
          promptVersion: String(EXTRACTION_PROMPT_VERSION),
          confidence: extraction.confidence,
          inputs,
          decision: { suggestedStage: suggested },
          summary: `Suggested a stage this organisation does not use ("${suggested}").`,
        }),
      );
      return;
    }

    const allowed = await this.isAllowed(organizationId, "stage.advanced");
    const act = allowed.allowed && shouldAct("stage.advanced", extraction.confidence);

    let outcome: "applied" | "skipped" | "failed" = "skipped";
    let fromStage = deal.stage;
    let refusal: string | null = null;

    if (act) {
      try {
        const moved = await this.dealsService.updateDeal(
          organizationId,
          // Carried for the legacy activity log only; the ledger records the
          // system as the actor, which is the record that counts.
          "system",
          deal.id,
          {
            stage: suggested,
            stageChangeReason: extraction.stage.evidence ?? undefined,
            /**
             * Optimistic concurrency, so a race is a refusal rather than a
             * clobber. `updateDeal` compares this against the row's live
             * `updated_at` and returns `version_conflict` if somebody wrote in
             * between — which is the whole difference between losing a rep's
             * move and declining to make one.
             */
            version: deal.updatedAt?.toISOString(),
          },
          { kind: "system", label: SYSTEM_ACTOR_LABEL },
        );

        if (!moved.ok) {
          // A conflict is not a failure of this system; somebody got there
          // first, which is the outcome the version was passed to produce.
          outcome = moved.reason === "version_conflict" ? "skipped" : "failed";
          refusal =
            moved.reason === "version_conflict"
              ? "Somebody moved the deal while the extraction was running, so it was left alone."
              : "The deal was gone by the time the move was attempted.";
        } else if (moved.approvalPending || !moved.stageChanged) {
          /**
           * `ok` is not the same as "it moved". A pipeline blueprint requiring
           * approval returns success having only raised a request, and recording
           * that as `applied` would put a move in the feed that never happened.
           */
          outcome = "skipped";
          refusal = moved.approvalPending
            ? "The pipeline requires approval for this move, so it was requested rather than made."
            : "The deal was already in that stage.";
        } else {
          outcome = "applied";
          // The authoritative from-stage: what `updateDeal` itself read, and what
          // `deal_stage_transitions` recorded, so the two ledgers cannot disagree.
          fromStage = moved.previousStage ?? deal.stage;
        }
      } catch (error) {
        /**
         * A blueprint rule can reject the transition outright. Recorded as a
         * failed decision rather than allowed to propagate: thrown, it would
         * retry the whole workflow five times and dead-letter it, having written
         * no decision row at all — the one outcome this module treats as worse
         * than a wrong answer.
         */
        outcome = "failed";
        refusal = error instanceof Error ? error.message : String(error);
      }
    }

    await this.record(
      buildDecision({
        organizationId,
        kind: "stage.advanced",
        outcome,
        triggerType: "activity",
        triggerId: activityId,
        dealId: String(deal.id),
        model,
        promptVersion: String(EXTRACTION_PROMPT_VERSION),
        confidence: extraction.confidence,
        inputs,
        decision: { fromStage, toStage: suggested, evidence: extraction.stage.evidence },
        summary:
          outcome === "applied"
            ? `Moved ${deal.name} from ${fromStage} to ${suggested}. ${extraction.stage.evidence ?? ""}`.trim()
            : (refusal ??
              (allowed.allowed
                ? `Stage change suggested but confidence ${extraction.confidence.toFixed(2)} was below the threshold.`
                : `Stage advance is switched off (${allowed.decidedBy}).`)),
      }),
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async isAllowed(organizationId: string, kind: DecisionKind) {
    const rows = await this.db
      .select({
        organizationId: autonomySwitches.organizationId,
        kind: autonomySwitches.kind,
        enabled: autonomySwitches.enabled,
        reason: autonomySwitches.reason,
      })
      .from(autonomySwitches)
      .where(
        or(
          isNull(autonomySwitches.organizationId),
          eq(autonomySwitches.organizationId, organizationId),
        ),
      );

    return resolveSwitch(organizationId, kind, switchesFor(organizationId, rows as SwitchRow[]));
  }

  private async record(row: ReturnType<typeof buildDecision>): Promise<void> {
    await this.db.insert(autonomousDecisions).values(row);
  }

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

  private async loadDeal(organizationId: string, dealId: string) {
    const numeric = Number(dealId);
    if (!Number.isInteger(numeric)) return null;

    const [row] = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        stage: deals.stage,
        pipelineId: deals.pipelineId,
        // The optimistic-concurrency token `updateDeal` compares against.
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .where(
        and(eq(deals.orgId, organizationId), eq(deals.id, numeric), isNull(deals.deletedAt)),
      )
      .limit(1);

    return row ?? null;
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
