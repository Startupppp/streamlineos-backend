import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  supportAiSuggestions,
  supportTicketLinks,
  supportTickets,
  supportTicketMessages,
  supportTicketDrafts,
  supportMacros,
  kbArticleChunks,
  kbArticleRestrictions,
  kbArticles,
  kbSpaces,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EmbeddingsService } from "../../ai/core/providers/embeddings.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { OrgFeaturesService } from "../../ai/core/services/org-features.service";
import { redactSensitiveData } from "../../ai/core/redaction.util";
import { logger } from "../../../common/logger/logger.service";
import { SupportAiSettingsService } from "./support-ai-settings.service";
import { SupportAiEmbeddingsHelper } from "./support-ai-embeddings.helper";
import { SupportAiReportHelper, type AiReportFilters } from "./support-ai-report.helper";
import type { ResolveAiSuggestionInput } from "./dto/support.schemas";

const KB_SIMILARITY_THRESHOLD = 0.2;

const analysisSchema = z.object({
  summary: z.string(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  category: z.string().nullable(),
  suggestedPriority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  isSpam: z.boolean(),
  confidence: z.number().min(0).max(1),
});

const macroPickSchema = z.object({
  macroId: z.number().int().nullable(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

const translationSchema = z.object({
  translatedText: z.string(),
  detectedSourceLanguage: z.string(),
});

const handoffSummarySchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()).max(6),
  suggestedNextStep: z.string(),
});

const rootCauseSchema = z.object({
  rootCause: z.string(),
  summary: z.string(),
});

const improveReplyOutputSchema = z.object({
  improved: z.string(),
  changes: z.array(z.string()).max(5),
});

type SuggestionType = (typeof supportAiSuggestions.$inferInsert)["type"];
type KbSource = { articleId: number; title: string; url: string };

@Injectable()
export class SupportAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly embeddings: EmbeddingsService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly aiSettings: SupportAiSettingsService,
    private readonly embHelper: SupportAiEmbeddingsHelper,
    private readonly reportHelper: SupportAiReportHelper,
  ) {}

  private async isAvailable(orgId: string): Promise<boolean> {
    const flags = await this.orgFeatures.getFlags(orgId);
    return flags.supportAi;
  }

  private async getTicketOrThrow(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  private async replacePendingSuggestions(orgId: string, ticketId: number, types: SuggestionType[]): Promise<void> {
    await this.db
      .update(supportAiSuggestions)
      .set({ status: "rejected", feedback: "superseded", resolvedAt: new Date() })
      .where(and(eq(supportAiSuggestions.orgId, orgId), eq(supportAiSuggestions.ticketId, ticketId), inArray(supportAiSuggestions.type, types), eq(supportAiSuggestions.status, "pending")));
  }

  private async insertSuggestion(orgId: string, ticketId: number, type: SuggestionType, payload: Record<string, unknown>, confidence: number | null) {
    const [row] = await this.db
      .insert(supportAiSuggestions)
      .values({ orgId, ticketId, type, payload, confidence: confidence !== null ? confidence.toFixed(3) : null })
      .returning();
    return row;
  }

  private async searchKbForTicket(orgId: string, query: string): Promise<KbSource[]> {
    if (!this.embeddings.isConfigured()) return [];
    const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
    const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
    const results = await this.db
      .select({ articleId: kbArticles.id, title: kbArticles.title, slug: kbArticles.slug, similarity: sql<number>`(1 - (${distance}))::float8` })
      .from(kbArticleChunks)
      .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
      .innerJoin(kbSpaces, and(eq(kbSpaces.id, kbArticles.spaceId), isNull(kbSpaces.deletedAt)))
      .where(and(
        eq(kbArticleChunks.orgId, orgId),
        eq(kbArticles.status, "published"),
        sql`NOT EXISTS (SELECT 1 FROM ${kbArticleRestrictions} r WHERE r.article_id = ${kbArticles.id} AND r.org_id = ${orgId} AND r.level = 'view')`,
      ))
      .orderBy(distance)
      .limit(12);
    const seen = new Set<number>();
    return results
      .filter((r) => r.similarity >= KB_SIMILARITY_THRESHOLD)
      .filter((r) => (seen.has(r.articleId) ? false : (seen.add(r.articleId), true)))
      .slice(0, 3)
      .map((r) => ({ articleId: r.articleId, title: r.title, url: `/support/kb/articles/${r.slug}` }));
  }

  private async getTicketConfidence(orgId: string, ticketId: number): Promise<number> {
    const row = await this.db.query.supportAiSuggestions.findFirst({
      where: and(eq(supportAiSuggestions.orgId, orgId), eq(supportAiSuggestions.ticketId, ticketId), eq(supportAiSuggestions.type, "summary"), eq(supportAiSuggestions.status, "pending")),
      columns: { confidence: true },
      orderBy: [desc(supportAiSuggestions.createdAt)],
    });
    return row?.confidence !== null && row?.confidence !== undefined ? Number(row.confidence) : 1.0;
  }

  async analyzeTicket(orgId: string, ticketId: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const messages = await this.db.query.supportTicketMessages.findMany({
      where: eq(supportTicketMessages.ticketId, ticketId),
      orderBy: [supportTicketMessages.createdAt],
      limit: 20,
      columns: { body: true, isInternal: true, createdAt: true },
    });
    const thread = messages.filter((m) => !m.isInternal).map((m) => `- ${redactSensitiveData(m.body)}`).join("\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: null },
      feature: "support.analysis",
      tier: "fast",
      schema: analysisSchema,
      prompt: {
        system: "You are an assistant helping a support team triage tickets. Analyze the ticket below and return structured data only. Never invent facts not present in the ticket.",
        user: `Title: ${redactSensitiveData(ticket.title)}\nCategory: ${ticket.category ?? "none"}\nDescription: ${redactSensitiveData(ticket.description ?? "none")}\n\nConversation so far:\n${thread || "(no replies yet)"}`,
      },
    });
    if (!gatewayResult.ok) {
      logger.error("support ticket AI analysis failed", { orgId, ticketId, kind: gatewayResult.kind });
      return null;
    }
    const result = gatewayResult.data;
    await this.replacePendingSuggestions(orgId, ticketId, ["summary", "sentiment", "category", "priority", "spam"]);
    const rows = await Promise.all([
      this.insertSuggestion(orgId, ticketId, "summary", { text: result.summary }, result.confidence),
      this.insertSuggestion(orgId, ticketId, "sentiment", { sentiment: result.sentiment }, result.confidence),
      result.category ? this.insertSuggestion(orgId, ticketId, "category", { category: result.category }, result.confidence) : null,
      this.insertSuggestion(orgId, ticketId, "priority", { priority: result.suggestedPriority }, result.confidence),
      result.isSpam ? this.insertSuggestion(orgId, ticketId, "spam", { isSpam: true }, result.confidence) : null,
    ]);
    return rows.filter(Boolean);
  }

  async suggestReply(orgId: string, ticketId: number, userId?: string) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const [messages, sources, confidence, { confidenceThreshold }] = await Promise.all([
      this.db.query.supportTicketMessages.findMany({
        where: and(eq(supportTicketMessages.ticketId, ticketId), eq(supportTicketMessages.isInternal, false)),
        orderBy: [supportTicketMessages.createdAt],
        limit: 20,
        columns: { body: true, authorId: true },
      }),
      this.searchKbForTicket(orgId, redactSensitiveData(`${ticket.title}\n${ticket.description ?? ""}`.trim())),
      this.getTicketConfidence(orgId, ticketId),
      this.aiSettings.getSettings(orgId),
    ]);
    const thread = messages.map((m) => `${m.authorId ? "Agent" : "Customer"}: ${redactSensitiveData(m.body)}`).join("\n\n");
    const kbCtx = sources.length > 0 ? `\n\nRelevant KB articles:\n${sources.map((s) => `- ${s.title} (${s.url})`).join("\n")}` : "";
    const gatewayResult = await this.aiGateway.invokeText({
      actor: { orgId, userId: userId ?? null },
      feature: "support.reply",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      prompt: {
        system: "You draft support-agent replies. Write a helpful, concise, professional reply the agent can review and edit before sending. Never claim to have taken an action that hasn't happened.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\n\nConversation:\n${thread || redactSensitiveData(ticket.description ?? "") || "(no messages yet)"}${kbCtx}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new ServiceUnavailableException("AI assistant is temporarily unavailable");
    }
    await this.replacePendingSuggestions(orgId, ticketId, ["reply"]);
    return this.insertSuggestion(orgId, ticketId, "reply", { body: gatewayResult.data.trim(), sources, escalated: confidence < confidenceThreshold }, null);
  }

  async suggestMacro(orgId: string, userId: string, ticketId: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const macros = await this.db.query.supportMacros.findMany({
      where: and(eq(supportMacros.orgId, orgId), or(sql`${supportMacros.visibility} != 'private'`, eq(supportMacros.createdBy, userId))!),
      columns: { id: true, title: true, body: true },
      limit: 100,
    });
    if (macros.length === 0) return null;
    const catalog = macros.map((m) => `#${m.id}: ${m.title} — ${redactSensitiveData(m.body.slice(0, 200))}`).join("\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId },
      feature: "support.macro",
      tier: "fast",
      schema: macroPickSchema,
      charge: true,
      prompt: {
        system: "Pick the single macro (canned response) that best fits replying to this ticket. If none are a good fit, return null.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\n${redactSensitiveData(ticket.description ?? "")}\n\nAvailable macros:\n${catalog}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      logger.error("support suggest-macro failed", { orgId, ticketId, kind: gatewayResult.kind });
      return null;
    }
    const result = gatewayResult.data;
    if (result.macroId === null || !macros.some((m) => m.id === result.macroId)) return null;
    await this.replacePendingSuggestions(orgId, ticketId, ["macro"]);
    return this.insertSuggestion(orgId, ticketId, "macro", { macroId: result.macroId, reason: result.reason }, result.confidence);
  }

  async suggestKbArticles(orgId: string, ticketId: number) {
    if (!this.embeddings.isConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const articles = await this.searchKbForTicket(orgId, redactSensitiveData(`${ticket.title}\n${ticket.description ?? ""}`.trim()));
    if (articles.length === 0) return null;
    await this.replacePendingSuggestions(orgId, ticketId, ["kb_article"]);
    return this.insertSuggestion(orgId, ticketId, "kb_article", { articles }, null);
  }

  async findDuplicates(orgId: string, ticketId: number) {
    if (!this.embeddings.isConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const candidates = await this.embHelper.upsertAndSearchSimilar(orgId, ticketId, ticket.title, ticket.description, 1);
    const best = candidates[0];
    if (!best || best.similarity < this.embHelper.getDuplicateThreshold()) return null;
    await this.replacePendingSuggestions(orgId, ticketId, ["duplicate"]);
    return this.insertSuggestion(orgId, ticketId, "duplicate", { candidateTicketId: best.candidateTicketId, title: best.title }, best.similarity);
  }

  async translateMessage(orgId: string, ticketId: number, messageId: number, targetLanguage: string, userId?: string) {
    if (!(await this.isAvailable(orgId))) return null;
    await this.getTicketOrThrow(orgId, ticketId);
    const message = await this.db.query.supportTicketMessages.findFirst({
      where: and(eq(supportTicketMessages.id, messageId), eq(supportTicketMessages.ticketId, ticketId)),
      columns: { body: true },
    });
    if (!message) throw new NotFoundException("Message not found");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.translate",
      tier: "fast",
      schema: translationSchema,
      charge: true,
      prompt: {
        system: "You translate support-ticket messages faithfully, preserving tone and meaning. Return only the translation and your best guess at the source language — never add commentary.",
        user: `Translate the following message into ${targetLanguage}:\n\n${redactSensitiveData(message.body)}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      logger.error("support message translation failed", { orgId, ticketId, messageId, kind: gatewayResult.kind });
      return null;
    }
    return gatewayResult.data;
  }

  async translateDraft(orgId: string, ticketId: number, language: string, content?: string, userId?: string) {
    if (!(await this.isAvailable(orgId))) return null;
    await this.getTicketOrThrow(orgId, ticketId);
    let body = content;
    if (!body && userId) {
      const draft = await this.db.query.supportTicketDrafts.findFirst({
        where: and(eq(supportTicketDrafts.ticketId, ticketId), eq(supportTicketDrafts.userId, userId)),
        columns: { body: true },
      });
      body = draft?.body;
    }
    if (!body) throw new BadRequestException("No content to translate");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.translate",
      tier: "fast",
      schema: translationSchema,
      charge: true,
      prompt: {
        system: "You translate support-agent draft replies faithfully, preserving tone and meaning. Return only the translation and source language — never add commentary.",
        user: `Translate the following draft into ${language}:\n\n${redactSensitiveData(body)}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new ServiceUnavailableException("AI assistant is temporarily unavailable");
    }
    return gatewayResult.data;
  }

  async improveReply(orgId: string, ticketId: number, content: string, userId?: string, macroId?: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    let macroCtx = "";
    if (macroId) {
      const macro = await this.db.query.supportMacros.findFirst({
        where: and(eq(supportMacros.id, macroId), eq(supportMacros.orgId, orgId)),
        columns: { title: true, body: true },
      });
      if (macro) macroCtx = `\n\nMacro to incorporate: "${macro.title}"\n${macro.body}`;
    }
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.reply",
      tier: "fast",
      schema: improveReplyOutputSchema,
      charge: true,
      prompt: {
        system: "You improve support-agent reply drafts. Make them clearer, more empathetic, and professional while preserving the agent's intent. Return the improved reply and a short list of what changed.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\n\nCurrent draft:\n${redactSensitiveData(content)}${macroCtx}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new ServiceUnavailableException("AI assistant is temporarily unavailable");
    }
    return gatewayResult.data;
  }

  async generateHandoffSummary(orgId: string, ticketId: number, userId?: string) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const [messages, sources] = await Promise.all([
      this.db.query.supportTicketMessages.findMany({
        where: eq(supportTicketMessages.ticketId, ticketId),
        orderBy: [supportTicketMessages.createdAt],
        limit: 40,
        columns: { body: true, isInternal: true, authorId: true },
      }),
      this.searchKbForTicket(orgId, redactSensitiveData(`${ticket.title}\n${ticket.description ?? ""}`.trim())),
    ]);
    const thread = messages.map((m) => `${m.isInternal ? "Internal note" : m.authorId ? "Agent" : "Customer"}: ${redactSensitiveData(m.body)}`).join("\n\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.handoff",
      tier: "fast",
      schema: handoffSummarySchema,
      charge: true,
      prompt: {
        system: "You brief a support agent who is picking up a ticket from a teammate. Be concrete about what's already been tried and what's still unresolved. Never invent facts not present below.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\nStatus: ${ticket.status}\nPriority: ${ticket.priority}\n\nFull history (including internal notes):\n${thread || "(no messages yet)"}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      logger.error("support handoff summary failed", { orgId, ticketId, kind: gatewayResult.kind });
      return null;
    }
    await this.replacePendingSuggestions(orgId, ticketId, ["handoff_summary"]);
    return this.insertSuggestion(orgId, ticketId, "handoff_summary", { ...gatewayResult.data, sources }, null);
  }

  async findRootCauseCluster(orgId: string, ticketId: number, userId?: string) {
    if (!this.embeddings.isConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);
    const candidates = await this.embHelper.upsertAndSearchSimilar(orgId, ticketId, ticket.title, ticket.description, 5);
    const related = candidates.filter((c) => c.similarity >= this.embHelper.getRootCauseThreshold());
    if (related.length === 0) return null;
    const catalog = [{ title: ticket.title }, ...related.map((r) => ({ title: r.title }))].map((t, i) => `${i + 1}. ${redactSensitiveData(t.title)}`).join("\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.root-cause",
      tier: "fast",
      schema: rootCauseSchema,
      charge: true,
      prompt: {
        system: "You look at a set of similar support tickets and name the likely shared root cause. If they don't actually look related, say so plainly in the summary.",
        user: `These tickets were flagged as similar:\n${catalog}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      logger.error("support root-cause clustering failed", { orgId, ticketId, kind: gatewayResult.kind });
      return null;
    }
    await this.replacePendingSuggestions(orgId, ticketId, ["root_cause_cluster"]);
    return this.insertSuggestion(orgId, ticketId, "root_cause_cluster", {
      relatedTicketIds: related.map((r) => r.candidateTicketId),
      rootCause: gatewayResult.data.rootCause,
      summary: gatewayResult.data.summary,
    }, related[0].similarity);
  }

  getAiReport(orgId: string, filters: AiReportFilters) {
    return this.reportHelper.getAiReport(orgId, filters);
  }

  async runFullAnalysis(orgId: string, ticketId: number): Promise<void> {
    if (!(await this.isAvailable(orgId))) return;
    await Promise.allSettled([
      this.analyzeTicket(orgId, ticketId),
      this.findDuplicates(orgId, ticketId),
      this.suggestKbArticles(orgId, ticketId),
    ]);
  }

  listSuggestions(orgId: string, ticketId: number) {
    return this.db.query.supportAiSuggestions.findMany({
      where: and(eq(supportAiSuggestions.orgId, orgId), eq(supportAiSuggestions.ticketId, ticketId)),
      orderBy: [desc(supportAiSuggestions.createdAt)],
    });
  }

  async resolveSuggestion(orgId: string, suggestionId: number, userId: string, input: ResolveAiSuggestionInput) {
    const suggestion = await this.db.query.supportAiSuggestions.findFirst({
      where: and(eq(supportAiSuggestions.id, suggestionId), eq(supportAiSuggestions.orgId, orgId)),
    });
    if (!suggestion) throw new NotFoundException("Suggestion not found");
    if (suggestion.status !== "pending") throw new ForbiddenException("Suggestion already resolved");
    if (input.status === "accepted") await this.applySuggestion(orgId, suggestion);
    const [updated] = await this.db
      .update(supportAiSuggestions)
      .set({ status: input.status, feedback: input.feedback ?? null, resolvedAt: new Date(), resolvedBy: userId })
      .where(and(eq(supportAiSuggestions.id, suggestionId), eq(supportAiSuggestions.orgId, orgId)))
      .returning();
    return updated;
  }

  private async applySuggestion(orgId: string, suggestion: typeof supportAiSuggestions.$inferSelect): Promise<void> {
    const payload = suggestion.payload;
    switch (suggestion.type) {
      case "priority": {
        const VALID_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
        type ValidPriority = (typeof VALID_PRIORITIES)[number];
        const raw = String(payload.priority ?? "");
        if (!VALID_PRIORITIES.includes(raw as ValidPriority)) return;
        await this.db.update(supportTickets)
          .set({ priority: raw as ValidPriority, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, suggestion.ticketId), eq(supportTickets.orgId, orgId)));
        return;
      }
      case "category": {
        const category = String(payload.category ?? "");
        if (!category) return;
        await this.db.update(supportTickets)
          .set({ category, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, suggestion.ticketId), eq(supportTickets.orgId, orgId)));
        return;
      }
      case "duplicate": {
        const candidateTicketId = Number(payload.candidateTicketId);
        if (!Number.isInteger(candidateTicketId) || candidateTicketId <= 0) return;
        await this.db.insert(supportTicketLinks)
          .values({ orgId, ticketId: suggestion.ticketId, linkedTicketId: candidateTicketId, relation: "duplicate", createdBy: null })
          .onConflictDoNothing();
        return;
      }
      default:
        return;
    }
  }
}
