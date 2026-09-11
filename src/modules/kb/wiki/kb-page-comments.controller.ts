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
import { KbPageCommentsService } from "./kb-page-comments.service";
import {
  createPageCommentSchema,
  updatePageCommentSchema,
  type CreatePageCommentInput,
  type UpdatePageCommentInput,
} from "./dto/kb-page-comments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  kbPageCommentListSchema,
  kbPageCommentWithAuthorSchema,
} from "./dto/kb-wiki-response.schemas";
import { z } from "zod";
import { kbCommentCursorQuerySchema } from "../core/dto/kb.schemas";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();
const commentIdParams = z.object({ commentId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard)
export class KbPageCommentsController {
  constructor(private readonly comments: KbPageCommentsService) {}

  @Get("pages/:pageId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams, query: kbCommentCursorQuerySchema })
  @ResponseSchema(kbPageCommentListSchema)
  async list(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Query("afterCreatedAt") afterCreatedAt: string | undefined,
    @Query("afterId") afterId: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const cursor = afterCreatedAt && afterId
      ? { sortValue: afterCreatedAt, id: afterId }
      : undefined;
    return this.comments.list(u, pageId, cursor);
  }

  @Post("pages/:pageId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(201)
  @Validate({ params: pageIdParams, body: createPageCommentSchema })
  @ResponseSchema(kbPageCommentWithAuthorSchema)
  async create(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: CreatePageCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.create(u, pageId, body);
  }

  @Patch("page-comments/:commentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @Validate({ params: commentIdParams, body: updatePageCommentSchema })
  @ResponseSchema(kbPageCommentWithAuthorSchema)
  async update(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: UpdatePageCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.update(u, commentId, body);
  }

  @Delete("page-comments/:commentId")
  @UseGuards(PermissionGuard)
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("kb:pages:update")
  @Validate({ params: commentIdParams })
  async remove(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.comments.remove(u, commentId);
  }

  @Post("page-comments/:commentId/resolve")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  @Validate({ params: commentIdParams })
  @ResponseSchema(kbPageCommentWithAuthorSchema)
  async resolve(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.resolve(u, commentId);
  }
}
