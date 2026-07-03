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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { KbPageCommentsService } from "./kb-page-comments.service";
import {
  createPageCommentSchema,
  updatePageCommentSchema,
  type CreatePageCommentInput,
  type UpdatePageCommentInput,
} from "./dto/kb-page-comments.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbPageCommentsController {
  constructor(
    private readonly comments: KbPageCommentsService,
    private readonly access: AccessService,
  ) {}

  @Get("pages/:pageId/comments")
  @RequirePermission("kb:pages:view")
  async list(
    @Param("pageId", ParseIntPipe) pageId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.list(u, pageId);
  }

  @Post("pages/:pageId/comments")
  @RequirePermission("kb:pages:view")
  async create(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body(new ZodValidationPipe(createPageCommentSchema)) body: CreatePageCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.create(u, pageId, body);
  }

  @Patch("page-comments/:commentId")
  @RequirePermission("kb:pages:view")
  async update(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body(new ZodValidationPipe(updatePageCommentSchema)) body: UpdatePageCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const perms = await this.access.resolveUserPermissions(u.userId, u.orgId);
    const isAdmin = perms.has("kb:pages:manage");
    return this.comments.update(u.orgId, commentId, u.userId, isAdmin, body);
  }

  @Delete("page-comments/:commentId")
  @HttpCode(204)
  @RequirePermission("kb:pages:view")
  async remove(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    const perms = await this.access.resolveUserPermissions(u.userId, u.orgId);
    const isAdmin = perms.has("kb:pages:manage");
    await this.comments.remove(u.orgId, commentId, u.userId, isAdmin);
  }

  @Post("page-comments/:commentId/resolve")
  @RequirePermission("kb:pages:view")
  async resolve(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.comments.resolve(u.orgId, commentId);
  }
}
