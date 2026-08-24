import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  activities,
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
  hasEligibleContext,
  redactForModel,
  shouldAct,
} from "./decision-record";
import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";
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

/** Hard caps, so a long thread cannot become an unbounded context window. */
const MAX_BODY_CHARS = 4_000;
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
     */
    const delivery = classifyDelivery({
      fromAddress: "",
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

    const conversation = capText(
      [activity.subject, activity.body].filter(Boolean).join("\n\n"),
      MAX_BODY_CHARS,
    );

    // No provider call at all when there is nothing to work with.
    if (!hasEligibleContext([conversation])) return;

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
    const inputs = { conversation: capText(conversation, 500), availableStages };

    await this.applyNextStep(organizationId, activityId, activity, extraction, model, inputs);
    if (deal)
      await this.applyStageAdvance(organizationId, activityId, deal, extraction, model, inputs, availableStages);
  }

  // ── The two things it may do ──────────────────────────────────────────────

  private async applyNextStep(
    organizationId: string,
    activityId: string,
    activity: { partyId: string | null; dealId: string | null },
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
     */
    if (!step.description || step.owner !== "us") return;

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

  private async applyStageAdvance(
    organizationId: string,
    activityId: string,
    deal: { id: number; stage: string; name: string },
    extraction: Extraction,
    model: string,
    inputs: Record<string, unknown>,
    availableStages: readonly string[],
  ): Promise<void> {
    const suggested = extraction.stage.suggestedStage;
    if (!suggested || suggested === deal.stage) return;

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

    if (act) {
      const moved = await this.dealsService.updateDeal(
        organizationId,
        // Carried for the legacy activity log only; the ledger records the
        // system as the actor, which is the record that counts.
        "system",
        deal.id,
        { stage: suggested, stageChangeReason: extraction.stage.evidence ?? undefined },
        { kind: "system", label: SYSTEM_ACTOR_LABEL },
      );
      outcome = moved.ok ? "applied" : "failed";
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
        decision: { fromStage: deal.stage, toStage: suggested, evidence: extraction.stage.evidence },
        summary:
          outcome === "applied"
            ? `Moved ${deal.name} from ${deal.stage} to ${suggested}. ${extraction.stage.evidence ?? ""}`.trim()
            : allowed.allowed
              ? `Stage change suggested but confidence ${extraction.confidence.toFixed(2)} was below the threshold.`
              : `Stage advance is switched off (${allowed.decidedBy}).`,
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

  private async loadActivity(organizationId: string, activityId: string) {
    const [row] = await this.db
      .select({
        subject: activities.subject,
        body: activities.body,
        partyId: activities.partyId,
        dealId: activities.dealId,
      })
      .from(activities)
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

  private async loadDeal(organizationId: string, dealId: string) {
    const numeric = Number(dealId);
    if (!Number.isInteger(numeric)) return null;

    const [row] = await this.db
      .select({
        id: deals.id,
        name: deals.name,
        stage: deals.stage,
        pipelineId: deals.pipelineId,
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
