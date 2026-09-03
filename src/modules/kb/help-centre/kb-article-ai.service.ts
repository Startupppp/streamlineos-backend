import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { KbAccessService } from "../core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import type { AiTextStream } from "../../ai/core/gateway/ai-gateway-stream.helper";
import { throwOnAiFailure } from "../../ai/core/services/gateway-result.util";
import type { KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const MAX_ARTICLE_TEXT = 4000;

interface KbArticleAiActionSpec {
  maxTokens: number;
  system: string;
  user(title: string, content: string, question: string | undefined): string;
}

function body(title: string, content: string): string {
  return `Article title: "${title}"\n\nContent:\n${content || "(no content yet)"}`;
}

/**
 * One row per action, so the buffered and the streamed representation of an
 * action are the same prompt, the same ceiling and the same feature key by
 * construction rather than by two copies staying in step. The prompts are
 * unchanged from the four methods this table replaced, and they are NOT the
 * wiki page prompts — the two surfaces word theirs differently and a shared
 * table would have silently rewritten eight of them.
 */
const ARTICLE_AI_ACTIONS: Readonly<Record<KbDocAiAction, KbArticleAiActionSpec>> = {
  summarize: {
    maxTokens: 512,
    system:
      "You are a knowledge base assistant. Summarize the provided article concisely in 3-5 bullet points covering the key points. Be factual and direct.",
    user: (title, content) => body(title, content),
  },
  ask: {
    maxTokens: 512,
    system:
      "You are a knowledge base assistant. Answer the user's question using ONLY the content of the article provided. If the article does not contain the answer, say so clearly. Never fabricate information.",
    user: (title, content, question) => `${body(title, content)}\n\nQuestion: ${question ?? ""}`,
  },
  improve: {
    maxTokens: 1024,
    system:
      "You are a technical writer. Rewrite the provided article content for clarity, conciseness, and professional quality. Fix grammar and structure. Output ONLY the improved plain text. Preserve all factual information.",
    user: (title, content) =>
      `Article title: "${title}"\n\nContent to improve:\n${content || "(no content yet)"}`,
  },
  "suggest-related": {
    maxTokens: 384,
    system:
      "You are a knowledge base curator. Based on the article content, suggest 4-6 related topics or articles that would complement it. Format as a simple bullet list of topic titles. Be specific and actionable.",
    user: (title, content) => body(title, content),
  },
};

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
    return { title: row.title, content: (row.contentText ?? "").slice(0, MAX_ARTICLE_TEXT) };
  }

  private prompt(action: KbDocAiAction, doc: { title: string; content: string }, question?: string) {
    const spec = ARTICLE_AI_ACTIONS[action];
    return { spec, prompt: { system: spec.system, user: spec.user(doc.title, doc.content, question) } };
  }

  private auditAction(user: CurrentUserContext, articleId: number, action: KbDocAiAction): void {
    this.audit.log({
      action: `ai.kb.article-${action}`,
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_article",
      resourceId: String(articleId),
    });
  }

  private async run(
    user: CurrentUserContext,
    articleId: number,
    action: KbDocAiAction,
    question?: string,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const doc = await this.assertArticle(user, articleId);
    const { spec, prompt } = this.prompt(action, doc, question);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: `kb.article-${action}`,
      tier: "fast",
      maxTokens: spec.maxTokens,
      charge: true,
      prompt,
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.auditAction(user, articleId, action);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  /**
   * The streamed representation of the same four actions, and the one the help
   * centre panel opens. Same gateway, same feature key as the buffered sibling,
   * so the two cannot start metering differently.
   *
   * The visibility check opens its own short tenant transaction and that
   * transaction COMMITS BEFORE the provider call, which is the whole point: the
   * route carries `@NoTenantTransaction()` because `respondWithAiTextStream`
   * awaits the pipe, so the request-scoped transaction would otherwise stay open
   * and idle for the entire stream — up to the 60s stream deadline, which is the
   * same 60s as the `idle_in_transaction_session_timeout` `withTenant` sets —
   * pinning a pooled connection to the provider for its duration.
   */
  async stream(
    user: CurrentUserContext,
    articleId: number,
    action: KbDocAiAction,
    question?: string,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const doc = await runInTenantTransaction(
      this.db,
      () => this.assertArticle(user, articleId),
      { orgId: user.orgId },
    );
    const { spec, prompt } = this.prompt(action, doc, question);

    const stream = await this.gateway.streamTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: `kb.article-${action}`,
      maxTokens: spec.maxTokens,
      charge: true,
      prompt,
      ...(signal !== undefined ? { signal } : {}),
    });

    this.auditAction(user, articleId, action);
    return stream;
  }

  summarize(user: CurrentUserContext, articleId: number) {
    return this.run(user, articleId, "summarize");
  }

  ask(user: CurrentUserContext, articleId: number, question: string) {
    return this.run(user, articleId, "ask", question);
  }

  improve(user: CurrentUserContext, articleId: number) {
    return this.run(user, articleId, "improve");
  }

  suggestRelated(user: CurrentUserContext, articleId: number) {
    return this.run(user, articleId, "suggest-related");
  }
}
