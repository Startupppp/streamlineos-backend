import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { blogPosts } from "../../../../db/schema";
import { AuditService } from "../../../../common/audit/audit.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../../common/tenant/with-tenant";
import { unwrapAiResult } from "./gateway-result.util";
import type { AiTextStream } from "../gateway/ai-gateway-stream.helper";

interface BlogPostContext {
  title: string;
  excerpt: string | null;
  content: string | null;
}

const IMPROVE_WRITING_SYSTEM =
  "You are a professional content editor. Rewrite the provided blog post content to improve clarity, flow, and engagement while preserving the author's voice. Output only the improved content as plain text (no HTML). Keep it under 4000 characters.";
const SUGGEST_TITLE_SYSTEM =
  "You are a content strategist. Suggest one compelling, SEO-friendly blog post title. Output ONLY the title text, nothing else.";
const SUMMARIZE_SYSTEM =
  "You are a content editor. Write a 1-2 sentence excerpt/summary for the blog post. Output ONLY the excerpt, under 500 characters.";

/**
 * Shared by the buffered route and its streaming sibling. Two copies of a prompt
 * drift the moment either is tuned, and the streamed answer would stop matching
 * the one the buffered route returns.
 */
function improveWritingPrompt(post: BlogPostContext, draft: { content: string }) {
  const sourceContent = (draft.content || post.content || post.title).slice(0, 3000);
  return {
    system: IMPROVE_WRITING_SYSTEM,
    user: `Post title: "${post.title}"\nContent to improve:\n${sourceContent}\n\nProvide improved content.`,
  };
}

function suggestTitlePrompt(post: BlogPostContext, draft?: { content?: string }) {
  const sourceText = (draft?.content || post.content || post.excerpt || "").slice(0, 1500);
  return {
    system: SUGGEST_TITLE_SYSTEM,
    user: `Current title: "${post.title}"\nContent excerpt:\n${sourceText}\n\nSuggest an improved title.`,
  };
}

function summarizePrompt(post: BlogPostContext, draft?: { content?: string }) {
  const sourceText = (draft?.content || post.content || "").slice(0, 2000);
  return {
    system: SUMMARIZE_SYSTEM,
    user: `Post title: "${post.title}"\nContent:\n${sourceText}\n\nWrite a concise excerpt.`,
  };
}

@Injectable()
export class BlogAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertPost(postId: string, tx: TenantTx) {
    const [post] = await tx
      .select({
        id: blogPosts.id,
        title: blogPosts.title,
        excerpt: blogPosts.excerpt,
        content: blogPosts.content,
      })
      .from(blogPosts)
      .where(eq(blogPosts.id, postId))
      .limit(1);

    if (!post) throw new NotFoundException("Post not found");
    return post;
  }

  async improveWriting(orgId: string, userId: string, postId: string, draft: { content: string }) {
    const post = await runInTenantTransaction(
      this.db,
      (tx) => this.assertPost(postId, tx),
      { orgId },
    );

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "blog.improve-writing",
      prompt: improveWritingPrompt(post, draft),
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    const content = unwrapAiResult(result);
    this.audit.log({ action: "ai.blog.improve-writing", userId, orgId, resourceType: "blog_post", resourceId: postId });
    return { content: content.slice(0, 4000) };
  }

  async suggestTitle(orgId: string, userId: string, postId: string, draft?: { content?: string }) {
    const post = await runInTenantTransaction(
      this.db,
      (tx) => this.assertPost(postId, tx),
      { orgId },
    );

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "blog.suggest-title",
      prompt: suggestTitlePrompt(post, draft),
      tier: "fast",
      maxTokens: 128,
      charge: true,
    });

    const title = unwrapAiResult(result);
    return { title: title.trim().replace(/^["']|["']$/g, "").slice(0, 256) };
  }

  async summarize(orgId: string, userId: string, postId: string, draft?: { content?: string }) {
    const post = await runInTenantTransaction(
      this.db,
      (tx) => this.assertPost(postId, tx),
      { orgId },
    );

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: "blog.summarize",
      prompt: summarizePrompt(post, draft),
      tier: "fast",
      maxTokens: 200,
      charge: true,
    });

    const excerpt = unwrapAiResult(result);
    return { excerpt: excerpt.trim().slice(0, 500) };
  }

  private loadPost(orgId: string, postId: string): Promise<BlogPostContext> {
    return runInTenantTransaction(this.db, (tx) => this.assertPost(postId, tx), { orgId });
  }

  async streamImproveWriting(
    orgId: string,
    userId: string,
    postId: string,
    draft: { content: string },
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const post = await this.loadPost(orgId, postId);
    this.audit.log({ action: "ai.blog.improve-writing", userId, orgId, resourceType: "blog_post", resourceId: postId });
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "blog.improve-writing",
      prompt: improveWritingPrompt(post, draft),
      maxTokens: 1024,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async streamSuggestTitle(
    orgId: string,
    userId: string,
    postId: string,
    draft: { content?: string; excerpt?: string } | undefined,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const post = await this.loadPost(orgId, postId);
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "blog.suggest-title",
      prompt: suggestTitlePrompt(post, draft),
      maxTokens: 128,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async streamSummarize(
    orgId: string,
    userId: string,
    postId: string,
    draft: { content?: string } | undefined,
    signal?: AbortSignal,
  ): Promise<AiTextStream> {
    const post = await this.loadPost(orgId, postId);
    return this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "blog.summarize",
      prompt: summarizePrompt(post, draft),
      maxTokens: 200,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}
