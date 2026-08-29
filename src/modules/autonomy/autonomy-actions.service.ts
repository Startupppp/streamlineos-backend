import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, autonomousDecisions, autonomySwitches, deals } from "../../db/schema";
import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";
import { DealsService } from "../deals/deals.service";
import { decisionDealId, buildDecision, shouldAct } from "./decision-record";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
import { alreadyHandled, type ThreadWindow } from "./thread-window";
import { EXTRACTION_PROMPT_VERSION, type Extraction } from "./extraction.schemas";

/** The label a decision wears when the system, not a person, made it. */
const SYSTEM_ACTOR_LABEL = `extraction@${EXTRACTION_PROMPT_VERSION}`;

/**
 * The two things the system may do, and the record it leaves doing them.
 *
 * `autonomy.service.ts` had already drawn this line for itself with a comment;
 * this makes the compiler agree. One half decides — reads the message, judges
 * whether it is worth a model call, spends it — and this half writes. Nothing
 * here chooses to act: by the time either method runs the extraction is bought
 * and paid for, and all that is left is a switch, a threshold and a row.
 *
 * A service rather than a file of exported functions, because `this.db` is the
 * tenant-aware proxy: it resolves on every property access to the request's
 * ambient transaction, and a function handed a database would have been handed
 * whichever handle its caller happened to hold — which on this path is the
 * difference between a write inside the tenant's transaction and one outside
 * it, with no GUC set.
 *
 * It owns `record` and `isAllowed` because both halves reach them and a ledger
 * with two writers is a ledger nobody can reason about, and `loadDeal` because
 * `applyStageAdvance` re-reads the deal after the provider call rather than
 * trusting the row read before it. That re-read is part of the action, not part
 * of the decision — handing it a row would look like tidying and would restore
 * the stale-stage clobber it exists to prevent.
 */
@Injectable()
export class AutonomyActionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dealsService: DealsService,
  ) {}

  async applyNextStep(
    organizationId: string,
    activityId: string,
    activity: { partyId: string | null; dealId: number | null; threadId: string | null },
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
          dealId: decisionDealId(activity.dealId),
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
          dealId: decisionDealId(activity.dealId),
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
          // The column, not `decisionDealId`: this writes an `activities` row,
          // where `deal_id` is the integer foreign key. The conversion is only
          // for the decision ledger, which keeps its own text column.
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
        dealId: decisionDealId(activity.dealId),
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
  async applyStageAdvance(
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
    const deal = await this.loadDeal(organizationId, dealId);

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

  // ── Shared with the decision path ─────────────────────────────────────────

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

  async record(row: ReturnType<typeof buildDecision>): Promise<void> {
    await this.db.insert(autonomousDecisions).values(row);
  }

  async loadDeal(organizationId: string, dealId: number) {

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
        and(eq(deals.orgId, organizationId), eq(deals.id, dealId), isNull(deals.deletedAt)),
      )
      .limit(1);

    return row ?? null;
  }
}
