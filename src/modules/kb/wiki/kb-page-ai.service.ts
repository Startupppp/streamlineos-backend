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

  /**
   * The single place either representation of an action reads the page, and the
   * reason it is a method rather than two call sites: the accessible-project
   * lookup and the visibility predicate must run in a transaction that COMMITS
   * before the provider call, on the buffered path exactly as on the streamed
   * one.
   *
   * This only releases the connection because the route carries
   * `@NoTenantTransaction()`. `runInTenantTransaction` reuses an ambient request
   * transaction rather than opening a short one, so on a route that keeps the
   * request transaction this wrapper is a no-op and the pooled connection stays
   * pinned for the whole provider round trip regardless — which is what the four
   * buffered handlers did until they were given the decorator.
   */
  private loadPage(user: CurrentUserContext, pageId: number) {
    return runInTenantTransaction(this.db, () => this.assertPageVisible(user, pageId), {
      orgId: user.orgId,
    });
  }

  private auditAction(user: CurrentUserContext, pageId: number, action: KbDocAiAction): void {
    this.audit.log({
      action: `ai.kb.page-${action}`,
      userId: user.userId,
      orgId: user.orgId,
      targetType: "kb_page",
      targetId: String(pageId),
      resourceType: "kb_page",
      resourceId: String(pageId),
    });
  }

  /**
   * The buffered representation. It reads through `loadPage` for the same reason
   * `stream` does: `invokeTextWithUsage` is a provider round trip, and a pooled
   * connection held open across it is idle-in-transaction for the whole of it.
   * `withTenant` sets `idle_in_transaction_session_timeout` to 60s, so a slow
   * provider does not merely make one request slow — the server kills the
   * transaction while the borrow is still outstanding, which under pool pressure
   * is a tenant-wide failure shape rather than a latency one.
   */
  private async run(
    user: CurrentUserContext,
    pageId: number,
    action: KbDocAiAction,
    question?: string,
  ): Promise<{ text: string; aiUsage?: AiUsageMeta }> {
    const doc = await this.loadPage(user, pageId);
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
   * the buffered sibling, so the two cannot start metering differently.
   *
   * The visibility check goes through the same `loadPage` as the buffered
   * sibling, so its short tenant transaction COMMITS BEFORE the provider call,
   * which is the whole point: the route carries `@NoTenantTransaction()` because
   * `respondWithAiTextStream` awaits the pipe, so the request-scoped transaction
   * would otherwise stay open and idle for the entire stream — up to the 60s
   * stream deadline, which is the same 60s as the
   * `idle_in_transaction_session_timeout` `withTenant` sets — pinning a pooled
   * connection to the provider for its duration.
   */
  async stream(
    user: CurrentUserContext,
    pageId: number,
    action: KbDocAiAction,
    question?: string,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const doc = await this.loadPage(user, pageId);
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
