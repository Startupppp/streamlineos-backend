import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbArticles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { AuditService } from "../../common/audit/audit.service";
import { KbAccessService } from "./kb-access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AiUsageMeta } from "../ai/gateway/ai-gateway.types";
import { throwOnAiFailure } from "../ai/services/gateway-result.util";

const MAX_ARTICLE_TEXT = 4000;

@Injectable()
export class KbArticleAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertArticle(user: CurrentUserContext, articleId: number) {
    const row = await this.db.query.kbArticles.findFirst({
      where: and(eq(kbArticles.id, articleId), eq(kbArticles.orgId, user.orgId)),
      columns: { id: true, orgId: true, spaceId: true, title: true, contentText: true },
    });
    if (!row) throw new NotFoundException("Article not found");
    await this.access.assertCanViewArticle(user, row);
    return row;
  }

  async summarize(user: CurrentUserContext, articleId: number): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const article = await this.assertArticle(user, articleId);
    const content = (article.contentText ?? "").slice(0, MAX_ARTICLE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.article-summarize",
      tier: "fast",
      maxTokens: 512,
      charge: true,
      prompt: {
        system: "You are a knowledge base assistant. Summarize the provided article concisely in 3-5 bullet points covering the key points. Be factual and direct.",
        user: `Article title: "${article.title}"\n\nContent:\n${content || "(no content yet)"}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.article-summarize", userId: user.userId, orgId: user.orgId, resourceType: "kb_article", resourceId: String(articleId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async ask(user: CurrentUserContext, articleId: number, question: string): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const article = await this.assertArticle(user, articleId);
    const content = (article.contentText ?? "").slice(0, MAX_ARTICLE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.article-ask",
      tier: "fast",
      maxTokens: 512,
      charge: true,
      prompt: {
        system: "You are a knowledge base assistant. Answer the user's question using ONLY the content of the article provided. If the article does not contain the answer, say so clearly. Never fabricate information.",
        user: `Article title: "${article.title}"\n\nContent:\n${content || "(no content yet)"}\n\nQuestion: ${question}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.article-ask", userId: user.userId, orgId: user.orgId, resourceType: "kb_article", resourceId: String(articleId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async improve(user: CurrentUserContext, articleId: number): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const article = await this.assertArticle(user, articleId);
    const content = (article.contentText ?? "").slice(0, MAX_ARTICLE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.article-improve",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      prompt: {
        system: "You are a technical writer. Rewrite the provided article content for clarity, conciseness, and professional quality. Fix grammar and structure. Output ONLY the improved plain text. Preserve all factual information.",
        user: `Article title: "${article.title}"\n\nContent to improve:\n${content || "(no content yet)"}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.article-improve", userId: user.userId, orgId: user.orgId, resourceType: "kb_article", resourceId: String(articleId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async suggestRelated(user: CurrentUserContext, articleId: number): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const article = await this.assertArticle(user, articleId);
    const content = (article.contentText ?? "").slice(0, MAX_ARTICLE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.article-suggest-related",
      tier: "fast",
      maxTokens: 384,
      charge: true,
      prompt: {
        system: "You are a knowledge base curator. Based on the article content, suggest 4-6 related topics or articles that would complement it. Format as a simple bullet list of topic titles. Be specific and actionable.",
        user: `Article title: "${article.title}"\n\nContent:\n${content || "(no content yet)"}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.article-suggest-related", userId: user.userId, orgId: user.orgId, resourceType: "kb_article", resourceId: String(articleId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }
}
