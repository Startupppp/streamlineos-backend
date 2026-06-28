import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import {
  kbArticleAttachments,
  kbArticleChunks,
  kbArticles,
  kbSpaces,
  tenantAiCredits,
  tenantAiCreditTransactions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EmbeddingsService } from "../providers/embeddings.service";
import { LlmService } from "../providers/llm.service";

const DEFAULT_TOP_K = 6;
const SEARCH_POOL_K = DEFAULT_TOP_K * 4;
const MIN_DISPLAY_SIMILARITY = 0.2;

export interface KbAnswerSource {
  articleId: number;
  title: string;
  slug: string;
  attachmentId: number | null;
  attachmentName: string | null;
  similarity: number;
}

export interface KbAnswer {
  answer: string;
  sources: KbAnswerSource[];
  hasContext: boolean;
}

interface KbSearchResult {
  id: number;
  articleId: number;
  attachmentId: number | null;
  source: string;
  content: string;
  title: string;
  slug: string;
  attachmentName: string | null;
  similarity: number;
}

interface AnswerOptions {
  orgId: string;
  question: string;
  articleId?: number;
  publicOnly?: boolean;
}

@Injectable()
export class KbRagService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
    private readonly llm: LlmService,
  ) {}

  isEmbeddingConfigured(): boolean {
    return this.embeddings.isConfigured();
  }

  private async searchChunks(opts: AnswerOptions): Promise<KbSearchResult[]> {
    const { orgId, question, articleId, publicOnly = false } = opts;
    const vector = this.embeddings.toVectorLiteral(await this.embeddings.embedQuery(question));
    const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;

    const conditions: SQL[] = [eq(kbArticleChunks.orgId, orgId)];
    if (articleId) conditions.push(eq(kbArticleChunks.articleId, articleId));
    if (publicOnly) {
      conditions.push(eq(kbArticles.status, "published"));
      conditions.push(eq(kbArticles.visibility, "public"));
      conditions.push(inArray(kbSpaces.audience, ["public", "mixed"]));
      conditions.push(isNull(kbSpaces.deletedAt));
    }

    let query = this.db
      .select({
        id: kbArticleChunks.id,
        articleId: kbArticleChunks.articleId,
        attachmentId: kbArticleChunks.attachmentId,
        source: kbArticleChunks.source,
        content: kbArticleChunks.content,
        title: kbArticles.title,
        slug: kbArticles.slug,
        attachmentName: kbArticleAttachments.fileName,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(kbArticleChunks)
      .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
      .leftJoin(kbArticleAttachments, eq(kbArticleAttachments.id, kbArticleChunks.attachmentId))
      .$dynamic();
    if (publicOnly) {
      query = query.innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id));
    }

    const pool = await query
      .where(and(...conditions))
      .orderBy(distance)
      .limit(SEARCH_POOL_K);
    return pool.slice(0, DEFAULT_TOP_K);
  }

  private dedupeSources(results: KbSearchResult[]): KbAnswerSource[] {
    const seen = new Set<string>();
    const sources: KbAnswerSource[] = [];
    for (const r of results) {
      if (r.similarity < MIN_DISPLAY_SIMILARITY) continue;
      const key = `${r.articleId}:${r.attachmentId ?? "body"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        articleId: r.articleId,
        title: r.title,
        slug: r.slug,
        attachmentId: r.attachmentId,
        attachmentName: r.attachmentName,
        similarity: r.similarity,
      });
    }
    return sources;
  }

  private async generateAnswer(system: string, user: string): Promise<string> {
    if (this.llm.isConfigured()) {
      return this.llm.invokeText({ model: "fast", system, user, temperature: 0.2 });
    }
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      const { text } = await generateText({
        model: google("gemini-2.0-flash"),
        system,
        prompt: user,
        temperature: 0.2,
      });
      return text;
    }
    throw new Error("No AI provider configured");
  }

  private async hasPublishedPublicArticles(orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: kbArticles.id })
      .from(kbArticles)
      .innerJoin(kbSpaces, eq(kbArticles.spaceId, kbSpaces.id))
      .where(
        and(
          eq(kbArticles.orgId, orgId),
          eq(kbArticles.status, "published"),
          eq(kbArticles.visibility, "public"),
          inArray(kbSpaces.audience, ["public", "mixed"]),
          isNull(kbSpaces.deletedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  private async consumeCredit(orgId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tenantAiCredits)
        .set({ balance: sql`${tenantAiCredits.balance} - 1` })
        .where(and(eq(tenantAiCredits.orgId, orgId), gte(tenantAiCredits.balance, 1)))
        .returning({ balance: tenantAiCredits.balance });
      if (!row) return false;
      await tx.insert(tenantAiCreditTransactions).values({
        orgId,
        delta: -1,
        balanceAfter: row.balance,
        reason: "public_kb_ask",
        feature: "kb_rag_public",
      });
      return true;
    });
  }

  private async refundCredit(orgId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(tenantAiCredits)
        .set({ balance: sql`${tenantAiCredits.balance} + 1` })
        .where(eq(tenantAiCredits.orgId, orgId))
        .returning({ balance: tenantAiCredits.balance });
      if (!row) return;
      await tx.insert(tenantAiCreditTransactions).values({
        orgId,
        delta: 1,
        balanceAfter: row.balance,
        reason: "public_kb_ask_refund",
        feature: "kb_rag_public",
      });
    });
  }

  private async runAnswer(opts: AnswerOptions): Promise<KbAnswer> {
    const results = await this.searchChunks(opts);

    if (results.length === 0) {
      return {
        answer: "I couldn't find anything related to that in the knowledge base yet.",
        sources: [],
        hasContext: false,
      };
    }

    const context = results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}${r.attachmentName ? ` — ${r.attachmentName}` : ""}\n${r.content}`,
      )
      .join("\n\n---\n\n");

    const system =
      "You are a knowledge base assistant. Answer the user's question using ONLY the provided context excerpts. " +
      "Be concise and accurate. Cite supporting excerpts inline using their bracket number, e.g. [1]. " +
      "If the context does not contain the answer, clearly say you don't have that information in the knowledge base. " +
      "Never invent facts that are not in the context.";

    const user = `Context excerpts:\n\n${context}\n\nQuestion: ${opts.question}`;

    const answer = await this.generateAnswer(system, user);

    return {
      answer: answer.trim(),
      sources: this.dedupeSources(results),
      hasContext: true,
    };
  }

  async answerQuestion(opts: AnswerOptions): Promise<KbAnswer> {
    if (!opts.publicOnly) return this.runAnswer(opts);

    const hasArticles = await this.hasPublishedPublicArticles(opts.orgId);
    if (!hasArticles) {
      return {
        answer: "I couldn't find anything related to that in the knowledge base yet.",
        sources: [],
        hasContext: false,
      };
    }

    const consumed = await this.consumeCredit(opts.orgId);
    if (!consumed) {
      return {
        answer: "The AI assistant isn't available right now. Please try again later.",
        sources: [],
        hasContext: false,
      };
    }

    try {
      return await this.runAnswer(opts);
    } catch (err) {
      await this.refundCredit(opts.orgId);
      throw err;
    }
  }
}
