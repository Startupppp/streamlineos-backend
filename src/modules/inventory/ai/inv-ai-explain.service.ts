import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { invAiInsights } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AiConfirmationService } from "../../ai/confirmation/ai-confirmation.service";
import { InvReplenishmentService } from "../replenishment/inv-replenishment.service";
import { InvVendorsService } from "../vendors/inv-vendors.service";
import { InvAiService, type InventoryOpsBrief } from "./inv-ai.service";
import {
  INV_AI_ACTIONS,
  INV_AI_CONTRACT_VERSION,
  invAiNarrativeResponseSchema,
  type InvAiFactor,
  type InvAiNarrativeResponse,
  type InvAiProvenance,
  type InvEvidenceKind,
  type InvEvidenceReference,
} from "./dto/inv-ai-contract";
import {
  InvAiEvidenceError,
  buildEvidenceAllowlist,
  resolveInvAiActions,
  type ResolvedInvAiAction,
} from "./inv-ai-action-resolver";

const FEATURE_KEY = "inv.insight-explain" as const;
const REORDER_FEATURE_KEY = "inv.reorder-explain" as const;
const DELAY_FEATURE_KEY = "inv.supplier-delay-briefing" as const;
const OPS_BRIEF_FEATURE_KEY = "inv.ops-brief" as const;

export type ExplainFactor = InvAiFactor;

/**
 * INV-102. The response shape is the contract now: a status envelope, bounded
 * strict fields, and actions that arrive as an enum the server resolves rather
 * than as free model text. `suggestedActions: string[]` is gone -- a sentence
 * the model wrote is not an action, and rendering it as one made the model the
 * author of what an operator was invited to do next.
 */
export interface InsightNarration {
  status: InvAiNarrativeResponse["status"];
  explanation: string;
  factors: ExplainFactor[];
  actions: ResolvedInvAiAction[];
  evidenceSnapshot: Record<string, unknown>;
  provenance: InvAiProvenance;
}

/**
 * A fingerprint of the numbers a proposal was reasoned about.
 *
 * A proposal is a promise about a moment. Between proposing "order 42" and
 * confirming it, a receipt can land, a transfer can arrive, or another operator
 * can raise the same PO -- and the confirmation would still post 42 against
 * evidence that no longer exists. Hashing the material figures at propose time
 * and re-checking them at confirm time makes that staleness visible instead of
 * silently actionable.
 *
 * Only the figures that would change the decision are hashed. Including
 * cosmetic fields would make every proposal look stale the moment a product was
 * renamed, and an alarm that cries wolf gets clicked through.
 */
export function hashReorderEvidence(evidence: {
  productVariantId: unknown;
  currentOnHand: unknown;
  suggestedOrderQty: unknown;
  vendorId: unknown;
}): string {
  const material = [
    evidence.productVariantId,
    evidence.currentOnHand,
    evidence.suggestedOrderQty,
    evidence.vendorId,
  ]
    .map((value) => String(value ?? ""))
    .join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** Maps whatever ids the deterministic layer actually read into references. */
function referencesFrom(
  entries: ReadonlyArray<[InvEvidenceKind, unknown]>,
): InvEvidenceReference[] {
  const refs: InvEvidenceReference[] = [];
  for (const [kind, raw] of entries) {
    const id = typeof raw === "string" ? Number(raw) : raw;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) {
      refs.push({ kind, id });
    }
  }
  return refs;
}

/**
 * One place where a validated model response becomes a narration. A citation
 * the server cannot vouch for fails the call rather than being dropped: the
 * sentence it supported would otherwise survive with its support removed.
 */
function toNarration(
  data: InvAiNarrativeResponse,
  allowed: readonly InvEvidenceReference[],
  evidenceSnapshot: Record<string, unknown>,
  provenance: InvAiProvenance,
): InsightNarration {
  if (data.status === "insufficient_evidence") {
    return {
      status: data.status,
      explanation: `Not enough evidence to explain this: ${data.missing.join("; ")}`,
      factors: [],
      actions: [],
      evidenceSnapshot,
      provenance,
    };
  }
  if (data.status === "refused") {
    return {
      status: data.status,
      explanation: data.reason,
      factors: [],
      actions: [],
      evidenceSnapshot,
      provenance,
    };
  }

  try {
    return {
      status: data.status,
      explanation: data.explanation,
      factors: data.factors,
      actions: resolveInvAiActions(
        data.recommendations,
        buildEvidenceAllowlist(allowed),
      ),
      evidenceSnapshot,
      provenance,
    };
  } catch (error) {
    if (error instanceof InvAiEvidenceError) {
      throw new ServiceUnavailableException(error.message);
    }
    throw error;
  }
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
  explanation: InsightNarration;
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

/**
 * The restraint rules, which every call gets. They are about arithmetic and
 * evidence, not about output shape, so a prose briefing needs them just as much
 * as a structured one does.
 */
const RESTRAINT_RULES = [
  "You are an inventory operations analyst. Your only job is to narrate and explain pre-computed evidence.",
  "CRITICAL RULES you must never violate:",
  "1. You MUST NOT compute, invent, or derive any numbers. Every quantity, value, date, and percentage is provided to you.",
  "2. You MUST NOT contradict the evidence. Reference the exact figures given.",
  "3. Your explanation narrates WHY these computed facts are operationally significant.",
  "4. isFactual=true means the fact comes directly from the evidence data. isFactual=false means it is your operational suggestion.",
  "5. Keep explanations concise (2-4 sentences).",
];

/**
 * Prose narration -- the digest and the supplier-delay briefing. These call
 * `invokeText` and are rendered as a paragraph, so telling them about a status
 * envelope and an action enum would describe a shape they cannot return.
 */
function buildNarrationSystemPrompt(): string {
  return RESTRAINT_RULES.join("\n");
}

/** Structured calls, held to the INV-102 contract. */
function buildSystemPrompt(): string {
  return [
    ...RESTRAINT_RULES,
    "6. Reply with status \"ok\" when the evidence supports an answer, \"insufficient_evidence\" (naming what is missing) when it does not, or \"refused\" when the request is not yours to answer. Do not answer anyway.",
    `7. Every recommendation names one action from this exact list and nothing else: ${INV_AI_ACTIONS.join(", ")}. You do not describe an action, choose a route, or name a permission -- the server does that.`,
    "8. Cite evidence as {kind, id} pairs drawn only from the evidence given to you. An id you were not given will be rejected and the whole answer discarded.",
  ].join("\n");
}

function buildOpsBriefUserPrompt(brief: InventoryOpsBrief): string {
  const lines = brief.signals
    .filter((signal) => signal.count > 0)
    .map((signal) => `- ${signal.label}: ${signal.count} (worst severity ${signal.severity})`);
  return [
    "These counts were computed by the inventory engine. Do not recompute or adjust them.",
    ...lines,
    "Write a short operational brief explaining which of these deserves attention first and why.",
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
    private readonly insights: InvAiService,
  ) {}

  /**
   * INV-101. The deterministic half, passed straight through so the controller
   * stays thin and the card has one place to ask.
   */
  getOpsBrief(orgId: string): Promise<InventoryOpsBrief> {
    return this.insights.getOpsBrief(orgId);
  }

  /**
   * The paid half, and only on request. `charge: true` means a human asked for
   * this; nothing on this path runs because a page rendered.
   */
  async narrateOpsBrief(
    orgId: string,
    userId: string,
  ): Promise<{ brief: InventoryOpsBrief; narration: InsightNarration }> {
    const brief = await this.insights.getOpsBrief(orgId);

    if (brief.totalSignals === 0) {
      // Short-circuit before the provider. Paying a model to write "nothing is
      // wrong" is money for a sentence we can write ourselves, and the gateway
      // rules say to stop before the call when there is no eligible context.
      return {
        brief,
        narration: {
          status: "ok",
          explanation: "No open inventory signals.",
          factors: [],
          actions: [],
          evidenceSnapshot: { ...brief },
          provenance: {
            contractVersion: INV_AI_CONTRACT_VERSION,
            promptKey: "inv.ops-brief",
            promptVersion: 1,
            model: "none",
            correlationId: "not-invoked",
          },
        },
      };
    }

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: OPS_BRIEF_FEATURE_KEY,
      tier: "fast",
      maxTokens: 512,
      charge: true,
      redact: false,
      schema: invAiNarrativeResponseSchema,
      prompt: {
        system: buildSystemPrompt(),
        user: buildOpsBriefUserPrompt(brief),
        promptKey: "inv.ops-brief",
        promptVersion: 1,
      },
    });

    if (!result.ok) throw new ServiceUnavailableException(result.message);

    return {
      brief,
      // The brief is an aggregate, so there are no row ids to cite and the
      // allowlist is empty. A model that invents one is refused by the same
      // path that refuses one anywhere else.
      narration: toNarration(
        result.data,
        [],
        { ...brief },
        {
          contractVersion: INV_AI_CONTRACT_VERSION,
          promptKey: "inv.ops-brief",
          promptVersion: 1,
          model: result.model,
          correlationId: result.correlationId,
        },
      ),
    };
  }

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
      charge: true,
      redact: false,
      schema: invAiNarrativeResponseSchema,
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

    // The allowlist is the rows this method actually read. Anything else the
    // model cites is invented, however plausible the number looks.
    // These are the keys `collectCandidates` actually writes into sourceRefs --
    // `variantId`, not `productVariantId`. Guessing the name here would have
    // produced an empty allowlist, which rejects every citation as invented and
    // fails every explain call.
    const allowed = referencesFrom([
      ["insight", insight.id],
      ["product_variant", sourceRefs["variantId"]],
      ["vendor", sourceRefs["vendorId"]],
      ["lot", sourceRefs["lotId"]],
      ["purchase_order", sourceRefs["poId"]],
    ]);

    return toNarration(
      result.data,
      allowed,
      {
        insightId: insight.id,
        insightType: insight.insightType,
        severity: insight.severity,
        title: insight.title,
        body: insight.body,
        sourceRefs,
        createdAt: insight.createdAt,
      },
      {
        contractVersion: INV_AI_CONTRACT_VERSION,
        promptKey: "inv.insight-explain",
        promptVersion: 1,
        model: result.model,
        correlationId: result.correlationId,
      },
    );
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
          system: buildNarrationSystemPrompt(),
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
      schema: invAiNarrativeResponseSchema,
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

    const narration = toNarration(
      result.data,
      referencesFrom([
        ["product_variant", suggestion.productVariantId],
        ["vendor", suggestion.vendorId],
        ["warehouse", suggestion.warehouseId],
      ]),
      evidence,
      {
        contractVersion: INV_AI_CONTRACT_VERSION,
        promptKey: "inv.reorder-explain",
        promptVersion: 1,
        model: result.model,
        correlationId: result.correlationId,
      },
    );

    const proposal = await this.confirmation.propose({
      orgId,
      userId,
      action: "inventory:create-draft-po",
      // The quantity comes from the deterministic suggestion, never from the
      // narration -- the model is a commentator on this payload, not a source
      // for it.
      payload: {
        suggestion,
        explanation: narration,
        evidenceHash: hashReorderEvidence({
          productVariantId: suggestion.productVariantId,
          currentOnHand: suggestion.currentOnHand,
          suggestedOrderQty: suggestion.suggestedQty,
          vendorId: suggestion.vendorId,
        }),
      } as Record<string, unknown>,
      // A3. `Date.now()` used to be part of this key, which made it unique per
      // call and so defeated the only thing a key is for: `propose` replays a
      // live PROPOSED row with a matching key, and no two calls ever matched.
      // Every refresh of the screen minted another independently-confirmable
      // proposal for the same shortfall, and confirming two of them raises two
      // draft purchase orders. The identity of the proposal is the position it
      // is about -- this variant, in this warehouse -- so that is the key.
      idempotencyKey: `reorder:${orgId}:${variantId}:${suggestion.warehouseId ?? "any"}`,
      ttlSeconds: 120,
    });

    return { evidence, explanation: narration, proposal };
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
    const suggestion = payload["suggestion"] as {
      productVariantId: number;
      suggestedQty: number;
      currentOnHand: number;
      vendorId: number | null;
      warehouseId: number | null;
    };

    // The evidence is re-read, not trusted from the payload: if the position
    // moved while the proposal sat waiting for a human, posting the original
    // quantity would be acting on a world that no longer exists. The re-read
    // only happens when there is a hash to compare it against, so a proposal
    // that predates the hash costs no extra query.
    const expectedHash = payload["evidenceHash"];
    if (typeof expectedHash === "string") {
      const current = await this.replenishment.getSuggestionForVariant(
        orgId,
        suggestion.productVariantId,
        suggestion.warehouseId ?? undefined,
      );
      const actualHash = current
        ? hashReorderEvidence({
            productVariantId: current.productVariantId,
            currentOnHand: current.currentOnHand,
            suggestedOrderQty: current.suggestedQty,
            vendorId: current.vendorId,
          })
        : null;
      if (expectedHash !== actualHash) {
        throw new ConflictException(
          "The stock position changed after this proposal was made. Review the current figures and propose again.",
        );
      }
    }

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
      // Derived from the proposal, not minted per call: confirming the same
      // AI proposal twice must raise one purchase order, and the proposal id is
      // the only thing that is stable across those two attempts.
    }, `ai-reorder-proposal:${confirmed.proposalId}`);

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
          const refs = (r.sourceRefs ?? {}) as Record<string, unknown>;
          return Number(refs["vendorId"]) === vendorId;
        })
      : insightRows;

    const vendorMap = new Map<
      number,
      { vendorName: string; insights: typeof filteredInsights }
    >();

    for (const insight of filteredInsights) {
      const refs = (insight.sourceRefs ?? {}) as Record<string, unknown>;
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
                system: buildNarrationSystemPrompt(),
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
