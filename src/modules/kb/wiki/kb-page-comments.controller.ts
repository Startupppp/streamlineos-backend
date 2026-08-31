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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbPageCommentsService } from "./kb-page-comments.service";
import {
  createPageCommentSchema,
  updatePageCommentSchema,
  type CreatePageCommentInput,
  type UpdatePageCommentInput,
} from "./dto/kb-page-comments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const pageIdParams = z.object({ pageId: z.coerce.number().int().positive() }).strict();
const commentIdParams = z.object({ commentId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard)
export class KbPageCommentsController {
  constructor(
    private readonly comments: KbPageCommentsService,
    private readonly access: AccessService,
  ) {}

  @Get("pages/:pageId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:view")
  @Validate({ params: pageIdParams })
  async list(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.list(u, pageId);
  }

  @Post("pages/:pageId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(201)
  @Validate({ params: pageIdParams, body: createPageCommentSchema })
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
  async update(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: UpdatePageCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const isAdmin = await this.access.holds(u, "kb:pages:manage");
    return this.comments.update(u.orgId, commentId, u.userId, isAdmin, body);
  }

  @Delete("page-comments/:commentId")
  @UseGuards(PermissionGuard)
  @HttpCode(204)
  @RequirePermission("kb:pages:update")
  @Validate({ params: commentIdParams })
  async remove(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    const isAdmin = await this.access.holds(u, "kb:pages:manage");
    await this.comments.remove(u.orgId, commentId, u.userId, isAdmin);
  }

  @Post("page-comments/:commentId/resolve")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("kb:pages:update")
  @HttpCode(200)
  @Validate({ params: commentIdParams })
  async resolve(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.resolve(u.orgId, commentId);
  }
}
