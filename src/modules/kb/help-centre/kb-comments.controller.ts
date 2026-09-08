import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbCommentsService } from "./kb-comments.service";
import {
  createCommentSchema,
  updateCommentSchema,
  type CreateCommentInput,
  type UpdateCommentInput,
} from "./dto/kb-comments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  kbArticleCommentListSchema,
  kbArticleCommentSchema,
  kbArticleCommentWithAuthorSchema,
} from "./dto/kb-helpcenter-response.schemas";
import { z } from "zod";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();
const commentIdParams = z.object({ commentId: z.coerce.number().int().positive() }).strict();
const cursorQuery = z.object({
  afterCreatedAt: z.string().optional(),
  afterId: z.coerce.number().int().positive().optional(),
}).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbCommentsController {
  constructor(private readonly comments: KbCommentsService) {}

  @Get("articles/:articleId/comments")
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams, query: cursorQuery })
  @ResponseSchema(kbArticleCommentListSchema)
  async list(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Query("afterCreatedAt") afterCreatedAt: string | undefined,
    @Query("afterId") afterId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const cursor = afterCreatedAt && afterId
      ? { sortValue: afterCreatedAt, id: afterId }
      : undefined;
    return this.comments.list(u, articleId, cursor);
  }

  @Post("articles/:articleId/comments")
  @RequirePermission("kb:articles:create")
  @HttpCode(201)
  @Validate({ params: articleIdParams, body: createCommentSchema })
  @ResponseSchema(kbArticleCommentSchema)
  async create(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: CreateCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.create(u, articleId, body);
  }

  @Patch("comments/:commentId")
  @RequirePermission("kb:articles:update")
  @Validate({ params: commentIdParams, body: updateCommentSchema })
  @ResponseSchema(kbArticleCommentSchema)
  async update(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: UpdateCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.update(u, commentId, body);
  }

  @Delete("comments/:commentId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("kb:articles:update")
  @Validate({ params: commentIdParams })
  async remove(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.comments.remove(u, commentId);
  }

  @Post("comments/:commentId/resolve")
  @BodylessAction()
  @RequirePermission("kb:articles:update")
  @HttpCode(200)
  @Validate({ params: commentIdParams })
  @ResponseSchema(kbArticleCommentSchema)
  async resolve(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.resolve(u, commentId);
  }
}
