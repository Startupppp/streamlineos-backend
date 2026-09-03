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
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../streaming";
import type { Request, Response } from "express";

const postIdParams = z.object({ postId: z.string().min(1) }).strict();

const improveWritingSchema = z.object({ content: z.string().min(1).max(10000) });
const suggestTitleSchema = z.object({
  content: z.string().max(10000).optional(),
});
const summarizeSchema = z.object({ content: z.string().max(10000).optional() });

type ImproveWritingInput = z.infer<typeof improveWritingSchema>;
type SuggestTitleInput = z.infer<typeof suggestTitleSchema>;
type SummarizeInput = z.infer<typeof summarizeSchema>;

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
  @Validate({ params: postIdParams, body: improveWritingSchema })
  async improveWriting(
    @Param("postId") postId: string,
    @Body() body: ImproveWritingInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.blogAi.improveWriting(u.orgId, u.userId, postId, body);
  }

  @Post("blog/posts/:postId/suggest-title")
  @RequirePermission("blog:ai:use")
  @Validate({ params: postIdParams, body: suggestTitleSchema })
  async suggestTitle(
    @Param("postId") postId: string,
    @Body() body: SuggestTitleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.blogAi.suggestTitle(u.orgId, u.userId, postId, body);
  }

  @Post("blog/posts/:postId/summarize")
  @RequirePermission("blog:ai:use")
  @Validate({ params: postIdParams, body: summarizeSchema })
  async summarize(
    @Param("postId") postId: string,
    @Body() body: SummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.blogAi.summarize(u.orgId, u.userId, postId, body);
  }

  @Post("blog/posts/:postId/improve-writing/stream")
  @RequirePermission("blog:ai:use")
  @Validate({ params: postIdParams, body: improveWritingSchema })
  async improveWritingStream(
    @Req() req: Request,
    @Param("postId") postId: string,
    @Body() body: ImproveWritingInput,
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
  @Validate({ params: postIdParams, body: suggestTitleSchema })
  async suggestTitleStream(
    @Req() req: Request,
    @Param("postId") postId: string,
    @Body() body: SuggestTitleInput,
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
  @Validate({ params: postIdParams, body: summarizeSchema })
  async summarizeStream(
    @Req() req: Request,
    @Param("postId") postId: string,
    @Body() body: SummarizeInput,
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
