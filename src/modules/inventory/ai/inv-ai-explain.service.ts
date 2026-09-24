import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invAiInsights } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  VendorScorecardService,
  type VendorScorecard,
} from "../vendors/vendor-scorecard.service";
import { InvAiService, type InventoryOpsBrief } from "./inv-ai.service";
import { readEvidence } from "./lib/inv-ai-read-evidence";
import {
  INV_AI_CONTRACT_VERSION,
  invAiNarrativeResponseSchema,
} from "./dto/inv-ai-contract";
import {
  buildNarrationSystemPrompt,
  buildSystemPrompt,
  referencesFrom,
  toNarration,
  type InsightNarration,
} from "./inv-ai-narration";

export type { ExplainFactor, InsightNarration } from "./inv-ai-narration";

const FEATURE_KEY = "inv.insight-explain" as const;
const DELAY_FEATURE_KEY = "inv.supplier-delay-briefing" as const;
const OPS_BRIEF_FEATURE_KEY = "inv.ops-brief" as const;

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

export interface SupplierDelayBriefingResult {
  vendors: Array<{
    vendorId: number;
    vendorName: string;
    insightCount: number;
    insights: Array<{
      id: number;
      title: string;
      body: string;
      severity: string;
    }>;
    performance: VendorScorecard;
  }>;
  narration: string;
  generatedAt: Date;
}

function buildOpsBriefUserPrompt(brief: InventoryOpsBrief): string {
  const lines = brief.signals
    .filter((signal) => signal.count > 0)
    .map(
      (signal) =>
        `- ${signal.label}: ${signal.count} (worst severity ${signal.severity})`,
    );
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

function buildDelayBriefingUserPrompt(
  vendors: Array<{
    vendorId: number;
    vendorName: string;
    insightCount: number;
    performance: VendorScorecard;
  }>,
): string {
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
  /**
   * F4. `AiConfirmationService`, `InvReplenishmentService` and `AccessService`
   * left with the reorder proposal — it is `InvAiProposalService`'s now, and
   * this service no longer proposes, confirms or asserts anything. What remains
   * reads insights and narrates them.
   */
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly scorecards: VendorScorecardService,
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
    /*
     * The only database access on this path, in a short tenant transaction that
     * COMMITS before the gateway call below. The route is
     * `@NoTenantTransaction()`, so this opens a real transaction rather than
     * reusing an ambient one; `getOpsBrief` reads RLS-protected inventory
     * tables and would be refused on a bare pool connection. Everything after
     * it is projection over an aggregate already in memory.
     */
    const brief = await readEvidence(this.db, orgId, () =>
      this.insights.getOpsBrief(orgId),
    );

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

  async explainInsight(
    orgId: string,
    userId: string,
    insightId: number,
  ): Promise<InsightNarration> {
    const insight = await runInTenantTransaction(
      this.db,
      () =>
        this.db.query.invAiInsights.findFirst({
          where: and(
            eq(invAiInsights.id, insightId),
            eq(invAiInsights.orgId, orgId),
          ),
        }),
      { orgId },
    );

    if (!insight) throw new NotFoundException("Insight not found");

    const sourceRefs = insight.sourceRefs ?? {};

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

  async getDigest(
    orgId: string,
    userId: string,
    narrate: boolean,
  ): Promise<InventoryDigest> {
    const rows = await readEvidence(this.db, orgId, () =>
      this.db.query.invAiInsights.findMany({
        where: and(
          eq(invAiInsights.orgId, orgId),
          eq(invAiInsights.status, "NEW"),
        ),
        columns: {
          id: true,
          insightType: true,
          severity: true,
          title: true,
          body: true,
        },
        limit: 100,
      }),
    );

    const groupMap = new Map<string, DigestGroup>();
    for (const row of rows) {
      let group = groupMap.get(row.insightType);
      if (!group) {
        group = {
          insightType: row.insightType,
          count: 0,
          severityCounts: {},
          samples: [],
        };
        groupMap.set(row.insightType, group);
      }
      group.count++;
      group.severityCounts[row.severity] =
        (group.severityCounts[row.severity] ?? 0) + 1;
      if (group.samples.length < 3) {
        group.samples.push({
          id: row.id,
          title: row.title,
          body: row.body,
          severity: row.severity,
        });
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

  async getSupplierDelayBriefing(
    orgId: string,
    userId: string,
    vendorId?: number,
  ): Promise<SupplierDelayBriefingResult> {
    const insightRows = await readEvidence(this.db, orgId, () =>
      this.db.query.invAiInsights.findMany({
        where: and(
          eq(invAiInsights.orgId, orgId),
          eq(invAiInsights.insightType, "vendor_delay"),
        ),
        columns: {
          id: true,
          title: true,
          body: true,
          severity: true,
          sourceRefs: true,
        },
        limit: 100,
      }),
    );

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

    // C4. One batched read rather than a scorecard per vendor: the old shape ran
    // seven queries for every delayed supplier in the briefing.
    const scorecards = await readEvidence(this.db, orgId, () =>
      this.scorecards.scorecardsFor(orgId, Array.from(vendorMap.keys())),
    );
    const vendors = Array.from(vendorMap.entries()).flatMap(([vId, entry]) => {
      const performance = scorecards.get(vId);
      if (!performance) return [];
      return [
        {
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
        },
      ];
    });

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
            if (!result.ok)
              throw new ServiceUnavailableException(result.message);
            return result.data;
          })();

    return { vendors, narration, generatedAt: new Date() };
  }
}
