import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { AuditService } from "../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { pageVisibleTo } from "../retrieval/kb-page-visibility";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import type { AiTextStream } from "../../ai/core/gateway/ai-gateway-stream.helper";
import { throwOnAiFailure } from "../../ai/core/services/gateway-result.util";
import type { KbDocAiAction } from "../retrieval/dto/kb-ai.schemas";

const MAX_PAGE_TEXT = 4000;

interface KbPageAiActionSpec {
  maxTokens: number;
  system: string;
  user(title: string, content: string, question: string | undefined): string;
}

function body(title: string, content: string): string {
  return `Document title: "${title}"\n\nContent:\n${content || "(no content yet)"}`;
}

/**
 * One row per action, so the buffered and the streamed representation of an
 * action are the same prompt, the same ceiling and the same feature key by
 * construction rather than by two copies staying in step. The prompts are
 * unchanged from the four methods this table replaced.
 */
const PAGE_AI_ACTIONS: Readonly<Record<KbDocAiAction, KbPageAiActionSpec>> = {
  summarize: {
    maxTokens: 512,
    system:
      "You are a knowledge base assistant. Summarize the provided document concisely. Write 3-5 bullet points covering the key points. Be factual and direct. Do not pad or repeat the title.",
    user: (title, content) => body(title, content),
  },
  ask: {
    maxTokens: 512,
    system:
      "You are a knowledge base assistant. Answer the user's question using ONLY the content of the document provided. If the document does not contain the answer, say so clearly. Never fabricate information.",
    user: (title, content, question) => `${body(title, content)}\n\nQuestion: ${question ?? ""}`,
  },
  improve: {
    maxTokens: 1024,
    system:
      "You are a technical writer. Rewrite the provided document content for clarity, conciseness, and professional quality. Fix grammar and structure. Output ONLY the improved plain text (no markdown fences, no preamble). Preserve all factual information.",
    user: (title, content) =>
      `Document title: "${title}"\n\nContent to improve:\n${content || "(no content yet)"}`,
  },
  "suggest-related": {
    maxTokens: 384,
    system:
      "You are a knowledge base curator. Based on the document content, suggest 4-6 related topics or pages that would complement it. Format as a simple bullet list of topic titles. Be specific and actionable.",
    user: (title, content) => body(title, content),
  },
};

@Injectable()
export class KbPageAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertPageVisible(user: CurrentUserContext, pageId: number) {
    const projectIds = await getAccessibleProjectIds(this.db, user);
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        pageVisibleTo(user, projectIds),
      ),
      columns: { id: true, title: true, contentText: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    return { title: page.title, content: (page.contentText ?? "").slice(0, MAX_PAGE_TEXT) };
  }

  private prompt(action: KbDocAiAction, doc: { title: string; content: string }, question?: string) {
    const spec = PAGE_AI_ACTIONS[action];
    return { spec, prompt: { system: spec.system, user: spec.user(doc.title, doc.content, question) } };
  }

  private auditAction(user: CurrentUserContext, pageId: number, action: KbDocAiAction): void {
    this.audit.log({
      action: `ai.kb.page-${action}`,
      userId: user.userId,
      orgId: user.orgId,
      resourceType: "kb_page",
      resourceId: String(pageId),
    });
  }

  private async run(
    user: CurrentUserContext,
    pageId: number,
    action: KbDocAiAction,
    question?: string,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const doc = await this.assertPageVisible(user, pageId);
    const { spec, prompt } = this.prompt(action, doc, question);

    const result = await this.gateway.invokeTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: `kb.page-${action}`,
      tier: "fast",
      maxTokens: spec.maxTokens,
      charge: true,
      prompt,
    });

    if (!result.ok) return throwOnAiFailure(result);
    this.auditAction(user, pageId, action);
    return { text: result.data, aiUsage: result.aiUsage };
  }

  /**
   * The streamed representation of the same four actions, and the one the wiki
   * panel opens. It goes through the same gateway under the same feature key as
   * the buffered sibling, so the two cannot start metering differently. The
   * visibility check opens its own tenant transaction: a streaming route must
   * carry `@NoTenantTransaction()`, or the request-scoped transaction commits
   * the instant the handler hands the stream off.
   */
  async stream(
    user: CurrentUserContext,
    pageId: number,
    action: KbDocAiAction,
    question?: string,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const doc = await runInTenantTransaction(
      this.db,
      () => this.assertPageVisible(user, pageId),
      { orgId: user.orgId },
    );
    const { spec, prompt } = this.prompt(action, doc, question);

    const stream = await this.gateway.streamTextWithUsage({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: `kb.page-${action}`,
      maxTokens: spec.maxTokens,
      charge: true,
      prompt,
      ...(signal !== undefined ? { signal } : {}),
    });

    this.auditAction(user, pageId, action);
    return stream;
  }

  summarize(user: CurrentUserContext, pageId: number) {
    return this.run(user, pageId, "summarize");
  }

  ask(user: CurrentUserContext, pageId: number, question: string) {
    return this.run(user, pageId, "ask", question);
  }

  improve(user: CurrentUserContext, pageId: number) {
    return this.run(user, pageId, "improve");
  }

  suggestRelated(user: CurrentUserContext, pageId: number) {
    return this.run(user, pageId, "suggest-related");
  }
}
