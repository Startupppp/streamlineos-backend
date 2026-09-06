import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { supportTicketMessages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { redactSensitiveData } from "../../ai/core/redaction.util";
import { logger } from "../../../common/logger/logger.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { OrgFeaturesService } from "../../ai/core/services/org-features.service";
import { SupportAiEmbeddingsHelper } from "./support-ai-embeddings.helper";
import { SupportAiTriageDataService } from "./support-ai-triage-data.service";
import { analysisSchema, rootCauseSchema } from "./support-ai-triage.schemas";

@Injectable()
export class SupportAiTriageAnalysisService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly data: SupportAiTriageDataService,
    private readonly aiGateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly embHelper: SupportAiEmbeddingsHelper,
  ) {}

  async analyzeTicket(orgId: string, ticketId: number, userId: string) {
    if (!(await this.data.isAvailable(orgId))) return null;
    const ticket = await this.data.getTicketOrThrow(orgId, ticketId);
    const messages = await this.db.query.supportTicketMessages.findMany({
      where: eq(supportTicketMessages.ticketId, ticketId),
      orderBy: [supportTicketMessages.createdAt],
      limit: 20,
      columns: { body: true, isInternal: true, createdAt: true },
    });
    const thread = messages
      .filter((m) => !m.isInternal)
      .map((m) => `- ${redactSensitiveData(m.body)}`)
      .join("\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId },
      feature: "support.analysis",
      tier: "fast",
      schema: analysisSchema,
      charge: true,
      prompt: {
        system:
          "You are an assistant helping a support team triage tickets. Analyze the ticket below and return structured data only. Never invent facts not present in the ticket.",
        user: `Title: ${redactSensitiveData(ticket.title)}\nCategory: ${ticket.category ?? "none"}\nDescription: ${redactSensitiveData(ticket.description ?? "none")}\n\nConversation so far:\n${thread || "(no replies yet)"}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({
          message: gatewayResult.message,
        });
      logger.error("support ticket AI analysis failed", {
        orgId,
        ticketId,
        kind: gatewayResult.kind,
      });
      return null;
    }
    const result = gatewayResult.data;
    await this.data.replacePendingSuggestions(orgId, ticketId, [
      "summary",
      "sentiment",
      "category",
      "priority",
      "spam",
    ]);
    const rows = await Promise.all([
      this.data.insertSuggestion(
        orgId,
        ticketId,
        "summary",
        { text: result.summary },
        result.confidence,
      ),
      this.data.insertSuggestion(
        orgId,
        ticketId,
        "sentiment",
        { sentiment: result.sentiment },
        result.confidence,
      ),
      result.category
        ? this.data.insertSuggestion(
            orgId,
            ticketId,
            "category",
            { category: result.category },
            result.confidence,
          )
        : null,
      this.data.insertSuggestion(
        orgId,
        ticketId,
        "priority",
        { priority: result.suggestedPriority },
        result.confidence,
      ),
      result.isSpam
        ? this.data.insertSuggestion(
            orgId,
            ticketId,
            "spam",
            { isSpam: true },
            result.confidence,
          )
        : null,
    ]);
    return rows.filter(Boolean);
  }

  async findDuplicates(orgId: string, ticketId: number) {
    const ticket = await this.data.getTicketOrThrow(orgId, ticketId);
    if (!this.aiGateway.isEmbeddingConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const candidates = await this.embHelper.upsertAndSearchSimilar(
      orgId,
      ticketId,
      ticket.title,
      ticket.description,
      1,
    );
    const best = candidates[0];
    if (!best || best.similarity < this.embHelper.getDuplicateThreshold())
      return null;
    await this.data.replacePendingSuggestions(orgId, ticketId, ["duplicate"]);
    return this.data.insertSuggestion(
      orgId,
      ticketId,
      "duplicate",
      { candidateTicketId: best.candidateTicketId, title: best.title },
      best.similarity,
    );
  }

  async findRootCauseCluster(orgId: string, ticketId: number, userId?: string) {
    const ticket = await this.data.getTicketOrThrow(orgId, ticketId);
    if (!this.aiGateway.isEmbeddingConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const candidates = await this.embHelper.upsertAndSearchSimilar(
      orgId,
      ticketId,
      ticket.title,
      ticket.description,
      5,
    );
    const related = candidates.filter(
      (c) => c.similarity >= this.embHelper.getRootCauseThreshold(),
    );
    if (related.length === 0) return null;
    const catalog = [
      { title: ticket.title },
      ...related.map((r) => ({ title: r.title })),
    ]
      .map((t, i) => `${i + 1}. ${redactSensitiveData(t.title)}`)
      .join("\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.root-cause",
      tier: "fast",
      schema: rootCauseSchema,
      charge: true,
      prompt: {
        system:
          "You look at a set of similar support tickets and name the likely shared root cause. If they don't actually look related, say so plainly in the summary.",
        user: `These tickets were flagged as similar:\n${catalog}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({
          message: gatewayResult.message,
        });
      logger.error("support root-cause clustering failed", {
        orgId,
        ticketId,
        kind: gatewayResult.kind,
      });
      return null;
    }
    await this.data.replacePendingSuggestions(orgId, ticketId, [
      "root_cause_cluster",
    ]);
    return this.data.insertSuggestion(
      orgId,
      ticketId,
      "root_cause_cluster",
      {
        relatedTicketIds: related.map((r) => r.candidateTicketId),
        rootCause: gatewayResult.data.rootCause,
        summary: gatewayResult.data.summary,
      },
      related[0]!.similarity,
    );
  }
}
