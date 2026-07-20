import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { kbPages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { AuditService } from "../../common/audit/audit.service";
import { getFeatureCost } from "../ai/billing/ai-cost-catalog";
import { pageVisibleTo } from "./kb-page-visibility";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AiUsageMeta } from "../ai/gateway/ai-gateway.types";
import { throwOnAiFailure } from "../ai/services/gateway-result.util";

const MAX_PAGE_TEXT = 4000;

@Injectable()
export class KbPageAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertPageVisible(user: CurrentUserContext, pageId: number) {
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        pageVisibleTo(user),
      ),
      columns: { id: true, title: true, contentText: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    return page;
  }

  async summarize(user: CurrentUserContext, pageId: number): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const page = await this.assertPageVisible(user, pageId);
    const content = (page.contentText ?? "").slice(0, MAX_PAGE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.page-summarize",
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("kb.page-summarize") },
      prompt: {
        system: "You are a knowledge base assistant. Summarize the provided document concisely. Write 3-5 bullet points covering the key points. Be factual and direct. Do not pad or repeat the title.",
        user: `Document title: "${page.title}"\n\nContent:\n${content || "(no content yet)"}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.page-summarize", userId: user.userId, orgId: user.orgId, resourceType: "kb_page", resourceId: String(pageId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async ask(user: CurrentUserContext, pageId: number, question: string): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const page = await this.assertPageVisible(user, pageId);
    const content = (page.contentText ?? "").slice(0, MAX_PAGE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.page-ask",
      tier: "fast",
      maxTokens: 512,
      charge: { credits: getFeatureCost("kb.page-ask") },
      prompt: {
        system: "You are a knowledge base assistant. Answer the user's question using ONLY the content of the document provided. If the document does not contain the answer, say so clearly. Never fabricate information.",
        user: `Document title: "${page.title}"\n\nContent:\n${content || "(no content yet)"}\n\nQuestion: ${question}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.page-ask", userId: user.userId, orgId: user.orgId, resourceType: "kb_page", resourceId: String(pageId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async improve(user: CurrentUserContext, pageId: number): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const page = await this.assertPageVisible(user, pageId);
    const content = (page.contentText ?? "").slice(0, MAX_PAGE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.page-improve",
      tier: "fast",
      maxTokens: 1024,
      charge: { credits: getFeatureCost("kb.page-improve") },
      prompt: {
        system: "You are a technical writer. Rewrite the provided document content for clarity, conciseness, and professional quality. Fix grammar and structure. Output ONLY the improved plain text (no markdown fences, no preamble). Preserve all factual information.",
        user: `Document title: "${page.title}"\n\nContent to improve:\n${content || "(no content yet)"}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.page-improve", userId: user.userId, orgId: user.orgId, resourceType: "kb_page", resourceId: String(pageId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }

  async suggestRelated(user: CurrentUserContext, pageId: number): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const page = await this.assertPageVisible(user, pageId);
    const content = (page.contentText ?? "").slice(0, MAX_PAGE_TEXT);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "kb.page-suggest-related",
      tier: "fast",
      maxTokens: 384,
      charge: { credits: getFeatureCost("kb.page-suggest-related") },
      prompt: {
        system: "You are a knowledge base curator. Based on the document content, suggest 4-6 related topics or pages that would complement it. Format as a simple bullet list of topic titles. Be specific and actionable.",
        user: `Document title: "${page.title}"\n\nContent:\n${content || "(no content yet)"}`,
      },
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.audit.log({ action: "ai.kb.page-suggest-related", userId: user.userId, orgId: user.orgId, resourceType: "kb_page", resourceId: String(pageId) });
    return { text: result.data, aiUsage: result.aiUsage };
  }
}
