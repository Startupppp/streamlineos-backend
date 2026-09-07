import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { invAiInsights } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AiConfirmationService } from "../../ai/confirmation/ai-confirmation.service";
import { InvReplenishmentService } from "../replenishment/inv-replenishment.service";
import { InvVendorsService } from "../vendors/inv-vendors.service";

const FEATURE_KEY = "inv.insight-explain" as const;
const REORDER_FEATURE_KEY = "inv.reorder-explain" as const;
const DELAY_FEATURE_KEY = "inv.supplier-delay-briefing" as const;

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

const ReorderSuggestionPayloadSchema = z.object({
  productVariantId: z.number(),
  suggestedQty: z.number(),
  vendorId: z.number().nullable(),
  warehouseId: z.number().nullable(),
});

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

export interface ReorderProposalResult {
  evidence: Record<string, unknown>;
  explanation: ExplainResponse;
  proposal: { proposalId: number; token: string; expiresAt: Date };
}

interface VendorPerformance {
  vendorId: number;
  onTimeRate: number;
  fillRate: number;
  avgLeadTimeDays: number;
  returnRate: number;
  openPoCount: number;
  totalSpend: string;
}

export interface SupplierDelayBriefingResult {
  vendors: Array<{
    vendorId: number;
    vendorName: string;
    insightCount: number;
    insights: Array<{ id: number; title: string; body: string; severity: string }>;
    performance: VendorPerformance;
  }>;
  narration: string;
  generatedAt: Date;
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

function buildReorderUserPrompt(evidence: Record<string, unknown>): string {
  return [
    "Reorder proposal evidence (all numbers are pre-computed — do not modify or re-derive them):",
    JSON.stringify(evidence, null, 2),
    "",
    "Explain why this reorder is operationally necessary based on the evidence above.",
    "Extract factual quantities/dates/thresholds as factors (isFactual: true). Add procurement suggestions as factors (isFactual: false).",
    "Return valid JSON: { explanation: string, factors: [{label, value, isFactual}], suggestedActions: string[] }",
  ].join("\n");
}

function buildDelayBriefingUserPrompt(vendors: Array<{ vendorId: number; vendorName: string; insightCount: number; performance: VendorPerformance }>): string {
  return [
    "Supplier delay briefing — all performance figures are pre-computed (do not invent or modify any numbers):",
    JSON.stringify(vendors, null, 2),
    "",
    "Write a 3-5 sentence operational narrative summarising vendor delay risk across the listed suppliers.",
    "Reference the exact on-time rates, lead times, and open PO counts provided. Do not invent any figures.",
  ].join("\n");
}

@Injectable()
export class InvAiExplainService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly confirmation: AiConfirmationService,
    private readonly replenishment: InvReplenishmentService,
    private readonly vendors: InvVendorsService,
  ) {}

  async explainInsight(orgId: string, userId: string, insightId: number): Promise<InsightNarration> {
    const insight = await this.db.query.invAiInsights.findFirst({
      where: and(eq(invAiInsights.id, insightId), eq(invAiInsights.orgId, orgId)),
    });

    if (!insight) throw new NotFoundException("Insight not found");

    const sourceRefs = insight.sourceRefs ?? {};

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: true,
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
        charge: true,
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

  async getReorderProposal(
    orgId: string,
    userId: string,
    variantId: number,
    warehouseId?: number,
  ): Promise<ReorderProposalResult> {
    const suggestion = await this.replenishment.getSuggestionForVariant(orgId, variantId, warehouseId);

    if (!suggestion) {
      throw new NotFoundException("No reorder suggestion found for this variant — it may not be below the reorder threshold");
    }

    const evidence: Record<string, unknown> = {
      productVariantId: suggestion.productVariantId,
      variantSku: suggestion.variantSku,
      variantName: suggestion.variantName,
      productName: suggestion.productName,
      currentOnHand: suggestion.currentOnHand,
      forecastedQty: suggestion.forecasted,
      suggestedOrderQty: suggestion.suggestedQty,
      vendorId: suggestion.vendorId,
      leadTimeDays: suggestion.leadTimeDays,
      expectedDeliveryDate: suggestion.expectedDate,
      reorderReason: suggestion.reason,
      warehouseId: suggestion.warehouseId,
      warehouseName: suggestion.warehouseName,
    };

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: REORDER_FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: true,
      redact: false,
      schema: ExplainResponseSchema,
      prompt: {
        system: buildSystemPrompt(),
        user: buildReorderUserPrompt(evidence),
        promptKey: "inv.reorder-explain",
        promptVersion: 1,
      },
    });

    if (!result.ok) {
      throw new ServiceUnavailableException(result.message);
    }

    const proposal = await this.confirmation.propose({
      orgId,
      userId,
      action: "inventory:create-draft-po",
      payload: { suggestion, explanation: result.data },
      idempotencyKey: `reorder-${orgId}-${variantId}-${Date.now()}`,
      ttlSeconds: 120,
    });

    return { evidence, explanation: result.data, proposal };
  }

  async confirmReorderProposal(
    orgId: string,
    userId: string,
    proposalId: number,
    token: string,
  ) {
    const confirmed = await this.confirmation.confirm({
      token,
      actor: { orgId, userId },
    });

    const payload = confirmed.payload;
    const parsedSuggestion = ReorderSuggestionPayloadSchema.safeParse(payload["suggestion"]);
    if (!parsedSuggestion.success) {
      throw new ServiceUnavailableException("Reorder proposal payload is malformed");
    }
    const suggestion = parsedSuggestion.data;

    if (!suggestion.vendorId) {
      throw new NotFoundException("No vendor associated with this reorder suggestion — assign a vendor to the reorder rule first");
    }

    const po = await this.replenishment.generatePo(orgId, userId, {
      vendorId: suggestion.vendorId,
      warehouseId: suggestion.warehouseId ?? undefined,
      suggestions: [
        {
          productVariantId: suggestion.productVariantId,
          suggestedQty: suggestion.suggestedQty,
          unitCost: 0,
        },
      ],
    });

    await this.confirmation.markExecuted(confirmed.proposalId, { poId: po.id }, orgId);
    return po;
  }

  async getSupplierDelayBriefing(
    orgId: string,
    userId: string,
    vendorId?: number,
  ): Promise<SupplierDelayBriefingResult> {
    const insightRows = await this.db.query.invAiInsights.findMany({
      where: and(eq(invAiInsights.orgId, orgId), eq(invAiInsights.insightType, "vendor_delay")),
      columns: { id: true, title: true, body: true, severity: true, sourceRefs: true },
      limit: 100,
    });

    const filteredInsights = vendorId
      ? insightRows.filter((r) => {
          const refs = r.sourceRefs ?? {};
          return Number(refs["vendorId"]) === vendorId;
        })
      : insightRows;

    const vendorMap = new Map<
      number,
      { vendorName: string; insights: typeof filteredInsights }
    >();

    for (const insight of filteredInsights) {
      const refs = insight.sourceRefs ?? {};
      const vId = Number(refs["vendorId"]);
      const vName = String(refs["vendorName"] ?? "Unknown");
      if (!vId) continue;
      const entry = vendorMap.get(vId) ?? { vendorName: vName, insights: [] };
      entry.insights.push(insight);
      vendorMap.set(vId, entry);
    }

    const vendors = await Promise.all(
      Array.from(vendorMap.entries()).map(async ([vId, entry]) => {
        const performance = await this.vendors.getVendorPerformance(orgId, vId);
        return {
          vendorId: vId,
          vendorName: entry.vendorName,
          insightCount: entry.insights.length,
          insights: entry.insights.map((i) => ({
            id: i.id,
            title: i.title,
            body: i.body,
            severity: i.severity,
          })),
          performance,
        };
      }),
    );

    const narration =
      vendors.length === 0
        ? "No active supplier delay alerts detected."
        : await (async () => {
            const result = await this.gateway.invokeText({
              actor: { orgId, userId },
              feature: DELAY_FEATURE_KEY,
              tier: "fast",
              maxTokens: 512,
              charge: true,
              redact: false,
              prompt: {
                system: buildSystemPrompt(),
                user: buildDelayBriefingUserPrompt(vendors),
                promptKey: "inv.supplier-delay-briefing",
                promptVersion: 1,
              },
            });
            if (!result.ok) throw new ServiceUnavailableException(result.message);
            return result.data;
          })();

    return { vendors, narration, generatedAt: new Date() };
  }
}
