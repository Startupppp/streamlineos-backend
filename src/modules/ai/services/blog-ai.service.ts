import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { blogPosts } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";

import { unwrapAiResult } from "./gateway-result.util";

@Injectable()
export class BlogAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  private async assertPost(postId: string) {
    const [post] = await this.db
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

  async improveWriting(userId: string, postId: string, draft: { content: string }) {
    const post = await this.assertPost(postId);

    const sourceContent = (draft.content || post.content || post.title).slice(0, 3000);

    const system =
      "You are a professional content editor. Rewrite the provided blog post content to improve clarity, flow, and engagement while preserving the author's voice. Output only the improved content as plain text (no HTML). Keep it under 4000 characters.";
    const user = `Post title: "${post.title}"\nContent to improve:\n${sourceContent}\n\nProvide improved content.`;

    const result = await this.gateway.invokeText({
      actor: { orgId: "", userId },
      feature: "blog.improve-writing",
      prompt: { system, user },
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    const content = unwrapAiResult(result);
    this.audit.log({ action: "ai.blog.improve-writing", userId, orgId: "", resourceType: "blog_post", resourceId: postId });
    return { content: content.slice(0, 4000) };
  }

  async suggestTitle(userId: string, postId: string, draft?: { content?: string; excerpt?: string }) {
    const post = await this.assertPost(postId);

    const sourceText = (draft?.content || post.content || post.excerpt || "").slice(0, 1500);

    const system =
      "You are a content strategist. Suggest one compelling, SEO-friendly blog post title. Output ONLY the title text, nothing else.";
    const user = `Current title: "${post.title}"\nContent excerpt:\n${sourceText}\n\nSuggest an improved title.`;

    const result = await this.gateway.invokeText({
      actor: { orgId: "", userId },
      feature: "blog.suggest-title",
      prompt: { system, user },
      tier: "fast",
      maxTokens: 128,
      charge: true,
    });

    const title = unwrapAiResult(result);
    return { title: title.trim().replace(/^["']|["']$/g, "").slice(0, 256) };
  }

  async summarize(userId: string, postId: string, draft?: { content?: string }) {
    const post = await this.assertPost(postId);

    const sourceText = (draft?.content || post.content || "").slice(0, 2000);

    const system =
      "You are a content editor. Write a 1-2 sentence excerpt/summary for the blog post. Output ONLY the excerpt, under 500 characters.";
    const user = `Post title: "${post.title}"\nContent:\n${sourceText}\n\nWrite a concise excerpt.`;

    const result = await this.gateway.invokeText({
      actor: { orgId: "", userId },
      feature: "blog.summarize",
      prompt: { system, user },
      tier: "fast",
      maxTokens: 200,
      charge: true,
    });

    const excerpt = unwrapAiResult(result);
    return { excerpt: excerpt.trim().slice(0, 500) };
  }
}
