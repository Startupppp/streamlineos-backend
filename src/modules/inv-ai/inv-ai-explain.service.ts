import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import { invAiInsights } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { getFeatureCost } from "../ai/billing/ai-cost-catalog";

const FEATURE_KEY = "inv.insight-explain" as const;

const ExplainFactorSchema = z.object({
  label: z.string(),
  value: z.string(),
  isFactual: z.boolean(),
});

const ExplainResponseSchema = z.object({
  explanation: z.string(),
  factors: z.array(ExplainFactorSchema),
  suggestedActions: z.array(z.string()),
});

export type ExplainFactor = z.infer<typeof ExplainFactorSchema>;
export type ExplainResponse = z.infer<typeof ExplainResponseSchema>;

export interface InsightNarration {
  explanation: string;
  factors: ExplainFactor[];
  suggestedActions: string[];
  evidenceSnapshot: Record<string, unknown>;
}

interface DigestGroup {
  insightType: string;
  count: number;
  severityCounts: Record<string, number>;
  samples: Array<{ id: number; title: string; body: string; severity: string }>;
}

export interface InventoryDigest {
  groups: DigestGroup[];
  totalNew: number;
  narration?: string;
}

function buildSystemPrompt(): string {
  return [
    "You are an inventory operations analyst. Your only job is to narrate and explain pre-computed evidence.",
    "CRITICAL RULES you must never violate:",
    "1. You MUST NOT compute, invent, or derive any numbers. Every quantity, value, date, and percentage is provided to you.",
    "2. You MUST NOT contradict the evidence. Reference the exact figures given.",
    "3. Your explanation narrates WHY these computed facts are operationally significant.",
    "4. isFactual=true means the fact comes directly from the evidence data. isFactual=false means it is your operational suggestion.",
    "5. Keep explanations concise (2-4 sentences). SuggestedActions should be actionable steps (2-4 items).",
  ].join("\n");
}

function buildInsightUserPrompt(insight: {
  insightType: string;
  severity: string;
  title: string;
  body: string;
  sourceRefs: Record<string, unknown>;
}): string {
  return [
    `Insight type: ${insight.insightType}`,
    `Severity: ${insight.severity}`,
    `Title: ${insight.title}`,
    `Summary: ${insight.body}`,
    `Evidence data (source of truth — do not modify these numbers):`,
    JSON.stringify(insight.sourceRefs, null, 2),
    "",
    "Narrate why this evidence is operationally significant. Extract the factual numbers from evidence into the factors array (isFactual: true). Add operational suggestions as separate factors (isFactual: false).",
    "Return valid JSON matching: { explanation: string, factors: [{label, value, isFactual}], suggestedActions: string[] }",
  ].join("\n");
}

function buildDigestUserPrompt(groups: DigestGroup[]): string {
  return [
    `Current inventory insight digest (${groups.length} types):`,
    JSON.stringify(groups, null, 2),
    "",
    "Write a 2-3 sentence operational summary of the current inventory health based on these counts and types. Do not invent numbers.",
  ].join("\n");
}

@Injectable()
export class InvAiExplainService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async explainInsight(orgId: string, userId: string, insightId: number): Promise<InsightNarration> {
    const insight = await this.db.query.invAiInsights.findFirst({
      where: and(eq(invAiInsights.id, insightId), eq(invAiInsights.orgId, orgId)),
    });

    if (!insight) throw new NotFoundException("Insight not found");

    const sourceRefs = (insight.sourceRefs ?? {}) as Record<string, unknown>;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: {
        credits: getFeatureCost(FEATURE_KEY),
        idempotencyKey: `inv-explain-${orgId}-${insightId}-${randomUUID()}`,
      },
      redact: false,
      schema: ExplainResponseSchema,
      prompt: {
        system: buildSystemPrompt(),
        user: buildInsightUserPrompt({
          insightType: insight.insightType,
          severity: insight.severity,
          title: insight.title,
          body: insight.body,
          sourceRefs,
        }),
        promptKey: "inv.insight-explain",
        promptVersion: 1,
      },
    });

    if (!result.ok) {
      throw new ServiceUnavailableException(result.message);
    }

    return {
      explanation: result.data.explanation,
      factors: result.data.factors,
      suggestedActions: result.data.suggestedActions,
      evidenceSnapshot: {
        insightId: insight.id,
        insightType: insight.insightType,
        severity: insight.severity,
        title: insight.title,
        body: insight.body,
        sourceRefs,
        createdAt: insight.createdAt,
      },
    };
  }

  async getDigest(orgId: string, userId: string, narrate: boolean): Promise<InventoryDigest> {
    const rows = await this.db.query.invAiInsights.findMany({
      where: and(eq(invAiInsights.orgId, orgId), eq(invAiInsights.status, "NEW")),
      columns: { id: true, insightType: true, severity: true, title: true, body: true },
      limit: 100,
    });

    const groupMap = new Map<string, DigestGroup>();
    for (const row of rows) {
      let group = groupMap.get(row.insightType);
      if (!group) {
        group = { insightType: row.insightType, count: 0, severityCounts: {}, samples: [] };
        groupMap.set(row.insightType, group);
      }
      group.count++;
      group.severityCounts[row.severity] = (group.severityCounts[row.severity] ?? 0) + 1;
      if (group.samples.length < 3) {
        group.samples.push({ id: row.id, title: row.title, body: row.body, severity: row.severity });
      }
    }

    const groups = Array.from(groupMap.values());
    const digest: InventoryDigest = { groups, totalNew: rows.length };

    if (narrate && groups.length > 0) {
      const result = await this.gateway.invokeText({
        actor: { orgId, userId },
        feature: FEATURE_KEY,
        tier: "fast",
        maxTokens: 256,
        charge: {
          credits: getFeatureCost(FEATURE_KEY),
          idempotencyKey: `inv-digest-${orgId}-${randomUUID()}`,
        },
        redact: false,
        prompt: {
          system: buildSystemPrompt(),
          user: buildDigestUserPrompt(groups),
          promptKey: "inv.digest-narrate",
          promptVersion: 1,
        },
      });
      if (result.ok) {
        digest.narration = result.data;
      }
    }

    return digest;
  }
}
