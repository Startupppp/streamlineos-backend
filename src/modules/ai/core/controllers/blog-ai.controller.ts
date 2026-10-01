import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import { LlmService } from "../providers/llm.service";
import { BlogAiService } from "../services/blog-ai.service";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ApiOkResponse } from "@nestjs/swagger";
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../streaming";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  blogImproveWritingResponseSchema,
  blogSuggestTitleResponseSchema,
  blogSummarizeResponseSchema,
} from "../dto/ai-response.schemas";
import {
  blogImproveWritingSchema,
  blogSuggestTitleSchema,
  blogSummarizeSchema,
  type BlogImproveWritingInput,
  type BlogSuggestTitleInput,
  type BlogSummarizeInput,
} from "../dto/request.schemas";
import type { Request, Response } from "express";

const postIdParams = z.object({ postId: z.string().min(1) }).strict();

/**
 * Editorial writing assistance for the marketing blog. It has had no caller since the in-app blog
 * admin UI moved to the standalone admin (`Startupppp/blogs`), which does its own editing; the
 * routes stay because `blog:ai:use` is a granted permission and withdrawing a grantable key needs
 * its own migration. Note that it reads `blog_posts`, whose columns are the PUBLISHED projection
 * after migration 1705 — a draft's text lives in `blog_post_revisions` and is not visible here, so
 * do not reuse this as a draft-editing surface without reading the working revision instead.
 */
@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
export class BlogAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly blogAi: BlogAiService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException("AI is not configured.");
  }

  @Post("blog/posts/:postId/improve-writing")
  @RequirePermission("blog:ai:use")
  @ResponseSchema(blogImproveWritingResponseSchema)
  @Validate({ params: postIdParams, body: blogImproveWritingSchema })
  async improveWriting(
    @Param("postId") postId: string,
    @Body() body: BlogImproveWritingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.blogAi.improveWriting(u.orgId, u.userId, postId, body);
  }

  @Post("blog/posts/:postId/suggest-title")
  @RequirePermission("blog:ai:use")
  @ResponseSchema(blogSuggestTitleResponseSchema)
  @Validate({ params: postIdParams, body: blogSuggestTitleSchema })
  async suggestTitle(
    @Param("postId") postId: string,
    @Body() body: BlogSuggestTitleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.blogAi.suggestTitle(u.orgId, u.userId, postId, body);
  }

  @Post("blog/posts/:postId/summarize")
  @RequirePermission("blog:ai:use")
  @ResponseSchema(blogSummarizeResponseSchema)
  @Validate({ params: postIdParams, body: blogSummarizeSchema })
  async summarize(
    @Param("postId") postId: string,
    @Body() body: BlogSummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.blogAi.summarize(u.orgId, u.userId, postId, body);
  }

  @Post("blog/posts/:postId/improve-writing/stream")
  @RequirePermission("blog:ai:use")
  @ApiOkResponse({ description: "AI text stream", content: { "text/plain": { schema: { type: "string" } } } })
  @Validate({ params: postIdParams, body: blogImproveWritingSchema })
  async improveWritingStream(
    @Req() req: Request,
    @Param("postId") postId: string,
    @Body() body: BlogImproveWritingInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    this.ensureLlm();
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "blog.improve-writing",
        orgId: u.orgId,
        route: "POST /ai/blog/posts/:postId/improve-writing/stream",
      },
      (signal) => this.blogAi.streamImproveWriting(u.orgId, u.userId, postId, body, signal),
    );
  }

  @Post("blog/posts/:postId/suggest-title/stream")
  @RequirePermission("blog:ai:use")
  @ApiOkResponse({ description: "AI text stream", content: { "text/plain": { schema: { type: "string" } } } })
  @Validate({ params: postIdParams, body: blogSuggestTitleSchema })
  async suggestTitleStream(
    @Req() req: Request,
    @Param("postId") postId: string,
    @Body() body: BlogSuggestTitleInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    this.ensureLlm();
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "blog.suggest-title",
        orgId: u.orgId,
        route: "POST /ai/blog/posts/:postId/suggest-title/stream",
      },
      (signal) => this.blogAi.streamSuggestTitle(u.orgId, u.userId, postId, body, signal),
    );
  }

  @Post("blog/posts/:postId/summarize/stream")
  @RequirePermission("blog:ai:use")
  @ApiOkResponse({ description: "AI text stream", content: { "text/plain": { schema: { type: "string" } } } })
  @Validate({ params: postIdParams, body: blogSummarizeSchema })
  async summarizeStream(
    @Req() req: Request,
    @Param("postId") postId: string,
    @Body() body: BlogSummarizeInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    this.ensureLlm();
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "blog.summarize",
        orgId: u.orgId,
        route: "POST /ai/blog/posts/:postId/summarize/stream",
      },
      (signal) => this.blogAi.streamSummarize(u.orgId, u.userId, postId, body, signal),
    );
  }
}
