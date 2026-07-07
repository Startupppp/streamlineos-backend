import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  supportAiSuggestions,
  supportTicketEmbeddings,
  supportTicketLinks,
  supportTickets,
  supportTicketMessages,
  supportMacros,
  kbArticleChunks,
  kbArticles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { LlmService } from "../ai/providers/llm.service";
import { EmbeddingsService, EMBEDDING_MODEL } from "../ai/providers/embeddings.service";
import { AiUsageService } from "../ai/services/ai-usage.service";
import { OrgFeaturesService } from "../ai/services/org-features.service";
import { redactSensitiveData } from "../ai/redaction.util";
import { logger } from "../../common/logger/logger.service";
import type { ResolveAiSuggestionInput } from "./dto/support.schemas";

const AI_FEATURE_NAME = "support.ai";
const DUPLICATE_SIMILARITY_THRESHOLD = 0.86;
const ROOT_CAUSE_SIMILARITY_THRESHOLD = 0.75;
const KB_SIMILARITY_THRESHOLD = 0.2;

const analysisSchema = z.object({
  summary: z.string().describe("A 1-3 sentence summary of the ticket for an agent picking it up cold"),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  category: z.string().nullable().describe("A short category label, or null if unclear"),
  suggestedPriority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  isSpam: z.boolean(),
  confidence: z.number().min(0).max(1),
});

const macroPickSchema = z.object({
  macroId: z.number().int().nullable().describe("The id of the best-matching macro, or null if none fit well"),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});

const translationSchema = z.object({
  translatedText: z.string(),
  detectedSourceLanguage: z.string().describe("Best guess at the source language, e.g. 'Spanish'"),
});

const handoffSummarySchema = z.object({
  summary: z.string().describe("A 2-4 sentence summary of the ticket for an agent it's being handed off to"),
  keyPoints: z.array(z.string()).max(6).describe("Short bullet points of what's been tried / decided so far"),
  suggestedNextStep: z.string().describe("The single most useful next action for the new assignee"),
});

const rootCauseSchema = z.object({
  rootCause: z.string().describe("A short (1 sentence) name for the likely shared underlying issue"),
  summary: z.string().describe("A 1-3 sentence explanation of why these tickets look related"),
});

type SuggestionType = (typeof supportAiSuggestions.$inferInsert)["type"];

@Injectable()
export class SupportAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly embeddings: EmbeddingsService,
    private readonly aiUsage: AiUsageService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  private async isAvailable(orgId: string): Promise<boolean> {
    if (!this.llm.isConfigured()) return false;
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
      .where(
        and(
          eq(supportAiSuggestions.orgId, orgId),
          eq(supportAiSuggestions.ticketId, ticketId),
          inArray(supportAiSuggestions.type, types),
          eq(supportAiSuggestions.status, "pending"),
        ),
      );
  }

  private async insertSuggestion(
    orgId: string,
    ticketId: number,
    type: SuggestionType,
    payload: Record<string, unknown>,
    confidence: number | null,
  ) {
    const [row] = await this.db
      .insert(supportAiSuggestions)
      .values({ orgId, ticketId, type, payload, confidence: confidence !== null ? confidence.toFixed(3) : null })
      .returning();
    return row;
  }

  /** Ticket summary, sentiment, category, priority suggestion, and spam flag — one LLM call. */
  async analyzeTicket(orgId: string, ticketId: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

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

    const system =
      "You are an assistant helping a support team triage tickets. Analyze the ticket below and return " +
      "structured data only. Never invent facts not present in the ticket.";
    const user = `Title: ${redactSensitiveData(ticket.title)}\nCategory: ${ticket.category ?? "none"}\nDescription: ${
      redactSensitiveData(ticket.description ?? "none")
    }\n\nConversation so far:\n${thread || "(no replies yet)"}`;

    let result: z.infer<typeof analysisSchema>;
    try {
      result = await this.llm.invokeStructured({
        model: "fast",
        schema: analysisSchema,
        schemaName: "ticket_analysis",
        system,
        user,
      });
    } catch (error) {
      logger.error("support ticket AI analysis failed", { orgId, ticketId, error });
      return null;
    }

    void this.aiUsage
      .track({ orgId, feature: AI_FEATURE_NAME, model: "gpt-4o-mini" })
      .catch(() => undefined);

    await this.replacePendingSuggestions(orgId, ticketId, ["summary", "sentiment", "category", "priority", "spam"]);

    const rows = await Promise.all([
      this.insertSuggestion(orgId, ticketId, "summary", { text: result.summary }, result.confidence),
      this.insertSuggestion(orgId, ticketId, "sentiment", { sentiment: result.sentiment }, result.confidence),
      result.category
        ? this.insertSuggestion(orgId, ticketId, "category", { category: result.category }, result.confidence)
        : null,
      this.insertSuggestion(
        orgId,
        ticketId,
        "priority",
        { priority: result.suggestedPriority },
        result.confidence,
      ),
      result.isSpam
        ? this.insertSuggestion(orgId, ticketId, "spam", { isSpam: true }, result.confidence)
        : null,
    ]);

    return rows.filter(Boolean);
  }

  /** On-demand: draft a reply for the agent to review, edit, and send themselves. */
  async suggestReply(orgId: string, ticketId: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

    const messages = await this.db.query.supportTicketMessages.findMany({
      where: and(eq(supportTicketMessages.ticketId, ticketId), eq(supportTicketMessages.isInternal, false)),
      orderBy: [supportTicketMessages.createdAt],
      limit: 20,
      columns: { body: true, authorId: true, createdAt: true },
    });

    const thread = messages
      .map((m) => `${m.authorId ? "Agent" : "Customer"}: ${redactSensitiveData(m.body)}`)
      .join("\n\n");
    const system =
      "You draft support-agent replies. Write a helpful, concise, professional reply the agent can review " +
      "and edit before sending. Never claim to have taken an action that hasn't happened.";
    const user = `Ticket: ${redactSensitiveData(ticket.title)}\n\nConversation:\n${
      thread || redactSensitiveData(ticket.description ?? "") || "(no messages yet)"
    }`;

    let body: string;
    try {
      body = await this.llm.invokeText({ model: "fast", system, user });
    } catch (error) {
      logger.error("support suggest-reply failed", { orgId, ticketId, error });
      return null;
    }

    void this.aiUsage.track({ orgId, feature: AI_FEATURE_NAME, model: "gpt-4o-mini" }).catch(() => undefined);
    await this.replacePendingSuggestions(orgId, ticketId, ["reply"]);
    return this.insertSuggestion(orgId, ticketId, "reply", { body: body.trim() }, null);
  }

  /** On-demand: pick the best-fitting macro from the org's available macros, if any. */
  async suggestMacro(orgId: string, userId: string, ticketId: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

    const macros = await this.db.query.supportMacros.findMany({
      where: and(
        eq(supportMacros.orgId, orgId),
        or(sql`${supportMacros.visibility} != 'private'`, eq(supportMacros.createdBy, userId))!,
      ),
      columns: { id: true, title: true, body: true },
      limit: 100,
    });
    if (macros.length === 0) return null;

    const catalog = macros
      .map((m) => `#${m.id}: ${m.title} — ${redactSensitiveData(m.body.slice(0, 200))}`)
      .join("\n");
    const system =
      "Pick the single macro (canned response) that best fits replying to this ticket. If none are a good fit, return null.";
    const user = `Ticket: ${redactSensitiveData(ticket.title)}\n${
      redactSensitiveData(ticket.description ?? "")
    }\n\nAvailable macros:\n${catalog}`;

    let result: z.infer<typeof macroPickSchema>;
    try {
      result = await this.llm.invokeStructured({
        model: "fast",
        schema: macroPickSchema,
        schemaName: "macro_pick",
        system,
        user,
      });
    } catch (error) {
      logger.error("support suggest-macro failed", { orgId, ticketId, error });
      return null;
    }

    void this.aiUsage.track({ orgId, feature: AI_FEATURE_NAME, model: "gpt-4o-mini" }).catch(() => undefined);
    if (result.macroId === null || !macros.some((m) => m.id === result.macroId)) return null;

    await this.replacePendingSuggestions(orgId, ticketId, ["macro"]);
    return this.insertSuggestion(
      orgId,
      ticketId,
      "macro",
      { macroId: result.macroId, reason: result.reason },
      result.confidence,
    );
  }

  /** Embeds the ticket's title+description and searches the KB for relevant articles. */
  async suggestKbArticles(orgId: string, ticketId: number) {
    if (!this.embeddings.isConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

    const query = redactSensitiveData(`${ticket.title}\n${ticket.description ?? ""}`.trim());
    const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(query));
    const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;

    const results = await this.db
      .select({
        articleId: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(kbArticleChunks)
      .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
      .where(eq(kbArticleChunks.orgId, orgId))
      .orderBy(distance)
      .limit(12);

    const seen = new Set<number>();
    const articles = results
      .filter((r) => r.similarity >= KB_SIMILARITY_THRESHOLD)
      .filter((r) => (seen.has(r.articleId) ? false : (seen.add(r.articleId), true)))
      .slice(0, 3);

    if (articles.length === 0) return null;

    await this.replacePendingSuggestions(orgId, ticketId, ["kb_article"]);
    return this.insertSuggestion(orgId, ticketId, "kb_article", { articles }, articles[0].similarity);
  }

  /** Upserts the ticket's embedding, then searches for similar open/in-progress tickets in the same org. */
  async findDuplicates(orgId: string, ticketId: number) {
    if (!this.embeddings.isConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

    const text = redactSensitiveData(`${ticket.title}\n${ticket.description ?? ""}`.trim());
    const vector = await this.embeddings.embedQuery(text);
    const vectorLiteral = this.embeddings.toVectorLiteral(vector);

    await this.db
      .insert(supportTicketEmbeddings)
      .values({ orgId, ticketId, embedding: vector, embeddingModel: EMBEDDING_MODEL })
      .onConflictDoUpdate({
        target: supportTicketEmbeddings.ticketId,
        set: { embedding: vector, embeddingModel: EMBEDDING_MODEL, updatedAt: new Date() },
      });

    const distance = sql`${supportTicketEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
    const conditions: SQL[] = [
      eq(supportTicketEmbeddings.orgId, orgId),
      ne(supportTicketEmbeddings.ticketId, ticketId),
      or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS"))!,
    ];

    const candidates = await this.db
      .select({
        candidateTicketId: supportTicketEmbeddings.ticketId,
        title: supportTickets.title,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(supportTicketEmbeddings)
      .innerJoin(supportTickets, eq(supportTickets.id, supportTicketEmbeddings.ticketId))
      .where(and(...conditions))
      .orderBy(distance)
      .limit(1);

    const best = candidates[0];
    if (!best || best.similarity < DUPLICATE_SIMILARITY_THRESHOLD) return null;

    await this.replacePendingSuggestions(orgId, ticketId, ["duplicate"]);
    return this.insertSuggestion(
      orgId,
      ticketId,
      "duplicate",
      { candidateTicketId: best.candidateTicketId, title: best.title },
      best.similarity,
    );
  }

  /** On-demand, stateless: translate a single message's body into the requested language. */
  async translateMessage(orgId: string, ticketId: number, messageId: number, targetLanguage: string) {
    if (!(await this.isAvailable(orgId))) return null;
    await this.getTicketOrThrow(orgId, ticketId);

    const message = await this.db.query.supportTicketMessages.findFirst({
      where: and(eq(supportTicketMessages.id, messageId), eq(supportTicketMessages.ticketId, ticketId)),
      columns: { body: true },
    });
    if (!message) throw new NotFoundException("Message not found");

    const system =
      "You translate support-ticket messages faithfully, preserving tone and meaning. Return only the " +
      "translation and your best guess at the source language — never add commentary.";
    const user = `Translate the following message into ${targetLanguage}:\n\n${redactSensitiveData(message.body)}`;

    let result: z.infer<typeof translationSchema>;
    try {
      result = await this.llm.invokeStructured({
        model: "fast",
        schema: translationSchema,
        schemaName: "message_translation",
        system,
        user,
      });
    } catch (error) {
      logger.error("support message translation failed", { orgId, ticketId, messageId, error });
      return null;
    }

    void this.aiUsage.track({ orgId, feature: AI_FEATURE_NAME, model: "gpt-4o-mini" }).catch(() => undefined);
    return result;
  }

  /** On-demand: a condensed briefing for an agent a ticket is being reassigned to. */
  async generateHandoffSummary(orgId: string, ticketId: number) {
    if (!(await this.isAvailable(orgId))) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

    const messages = await this.db.query.supportTicketMessages.findMany({
      where: eq(supportTicketMessages.ticketId, ticketId),
      orderBy: [supportTicketMessages.createdAt],
      limit: 40,
      columns: { body: true, isInternal: true, authorId: true },
    });

    const thread = messages
      .map((m) => `${m.isInternal ? "Internal note" : m.authorId ? "Agent" : "Customer"}: ${redactSensitiveData(m.body)}`)
      .join("\n\n");

    const system =
      "You brief a support agent who is picking up a ticket from a teammate. Be concrete about what's " +
      "already been tried and what's still unresolved. Never invent facts not present below.";
    const user = `Ticket: ${redactSensitiveData(ticket.title)}\nStatus: ${ticket.status}\nPriority: ${
      ticket.priority
    }\n\nFull history (including internal notes):\n${thread || "(no messages yet)"}`;

    let result: z.infer<typeof handoffSummarySchema>;
    try {
      result = await this.llm.invokeStructured({
        model: "fast",
        schema: handoffSummarySchema,
        schemaName: "handoff_summary",
        system,
        user,
      });
    } catch (error) {
      logger.error("support handoff summary failed", { orgId, ticketId, error });
      return null;
    }

    void this.aiUsage.track({ orgId, feature: AI_FEATURE_NAME, model: "gpt-4o-mini" }).catch(() => undefined);
    await this.replacePendingSuggestions(orgId, ticketId, ["handoff_summary"]);
    return this.insertSuggestion(orgId, ticketId, "handoff_summary", { ...result }, null);
  }

  /**
   * Finds other open/in-progress tickets similar enough to this one to suggest a shared
   * root cause (a broader similarity band than findDuplicates(), and requires >=1 match).
   */
  async findRootCauseCluster(orgId: string, ticketId: number) {
    if (!this.embeddings.isConfigured()) return null;
    const flags = await this.orgFeatures.getFlags(orgId);
    if (!flags.supportAi) return null;
    const ticket = await this.getTicketOrThrow(orgId, ticketId);

    const text = redactSensitiveData(`${ticket.title}\n${ticket.description ?? ""}`.trim());
    const vector = await this.embeddings.embedQuery(text);
    const vectorLiteral = this.embeddings.toVectorLiteral(vector);

    await this.db
      .insert(supportTicketEmbeddings)
      .values({ orgId, ticketId, embedding: vector, embeddingModel: EMBEDDING_MODEL })
      .onConflictDoUpdate({
        target: supportTicketEmbeddings.ticketId,
        set: { embedding: vector, embeddingModel: EMBEDDING_MODEL, updatedAt: new Date() },
      });

    const distance = sql`${supportTicketEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
    const conditions: SQL[] = [
      eq(supportTicketEmbeddings.orgId, orgId),
      ne(supportTicketEmbeddings.ticketId, ticketId),
      or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS"))!,
    ];

    const candidates = await this.db
      .select({
        candidateTicketId: supportTicketEmbeddings.ticketId,
        title: supportTickets.title,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(supportTicketEmbeddings)
      .innerJoin(supportTickets, eq(supportTickets.id, supportTicketEmbeddings.ticketId))
      .where(and(...conditions))
      .orderBy(distance)
      .limit(5);

    const related = candidates.filter((c) => c.similarity >= ROOT_CAUSE_SIMILARITY_THRESHOLD);
    if (related.length === 0) return null;

    const catalog = [{ title: ticket.title }, ...related.map((r) => ({ title: r.title }))]
      .map((t, i) => `${i + 1}. ${redactSensitiveData(t.title)}`)
      .join("\n");

    const system =
      "You look at a set of similar support tickets and name the likely shared root cause. If they don't " +
      "actually look related, say so plainly in the summary.";
    const user = `These tickets were flagged as similar:\n${catalog}`;

    let result: z.infer<typeof rootCauseSchema>;
    try {
      result = await this.llm.invokeStructured({
        model: "fast",
        schema: rootCauseSchema,
        schemaName: "root_cause_cluster",
        system,
        user,
      });
    } catch (error) {
      logger.error("support root-cause clustering failed", { orgId, ticketId, error });
      return null;
    }

    void this.aiUsage.track({ orgId, feature: AI_FEATURE_NAME, model: "gpt-4o-mini" }).catch(() => undefined);
    await this.replacePendingSuggestions(orgId, ticketId, ["root_cause_cluster"]);
    return this.insertSuggestion(
      orgId,
      ticketId,
      "root_cause_cluster",
      {
        relatedTicketIds: related.map((r) => r.candidateTicketId),
        rootCause: result.rootCause,
        summary: result.summary,
      },
      related[0].similarity,
    );
  }

  /** Fire-and-forget entrypoint called after ticket creation: analysis + duplicate + KB suggestions. */
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

    if (input.status === "accepted") {
      await this.applySuggestion(orgId, suggestion);
    }

    const [updated] = await this.db
      .update(supportAiSuggestions)
      .set({
        status: input.status,
        feedback: input.feedback ?? null,
        resolvedAt: new Date(),
        resolvedBy: userId,
      })
      .where(eq(supportAiSuggestions.id, suggestionId))
      .returning();
    return updated;
  }

  private async applySuggestion(orgId: string, suggestion: typeof supportAiSuggestions.$inferSelect): Promise<void> {
    const payload = suggestion.payload as Record<string, unknown>;
    switch (suggestion.type) {
      case "priority":
        await this.db
          .update(supportTickets)
          .set({ priority: payload.priority as (typeof supportTickets.$inferInsert)["priority"], updatedAt: new Date() })
          .where(and(eq(supportTickets.id, suggestion.ticketId), eq(supportTickets.orgId, orgId)));
        return;
      case "category":
        await this.db
          .update(supportTickets)
          .set({ category: payload.category as string, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, suggestion.ticketId), eq(supportTickets.orgId, orgId)));
        return;
      case "duplicate":
        await this.db
          .insert(supportTicketLinks)
          .values({
            orgId,
            ticketId: suggestion.ticketId,
            linkedTicketId: payload.candidateTicketId as number,
            relation: "duplicate",
            createdBy: null,
          })
          .onConflictDoNothing();
        return;
      default:
        return;
    }
  }
}
