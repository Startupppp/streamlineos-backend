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
import { KbCommentsService } from "./kb-comments.service";
import {
  createCommentSchema,
  updateCommentSchema,
  type CreateCommentInput,
  type UpdateCommentInput,
} from "./dto/kb-comments.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbCommentsController {
  constructor(private readonly comments: KbCommentsService) {}

  @Get("articles/:articleId/comments")
  @RequirePermission("kb:articles:view")
  list(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.comments.list(u.orgId, articleId);
  }

  @Post("articles/:articleId/comments")
  @RequirePermission("kb:articles:view")
  create(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(createCommentSchema)) body: CreateCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.comments.create(u.orgId, articleId, u.userId, body);
  }

  @Patch("comments/:commentId")
  @RequirePermission("kb:articles:view")
  update(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body(new ZodValidationPipe(updateCommentSchema)) body: UpdateCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.comments.update(u.orgId, commentId, u.userId, body);
  }

  @Delete("comments/:commentId")
  @HttpCode(204)
  @RequirePermission("kb:articles:view")
  remove(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.comments.remove(u.orgId, commentId, u.userId);
  }

  @Post("comments/:commentId/resolve")
  @RequirePermission("kb:articles:update")
  resolve(
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.comments.resolve(u.orgId, commentId);
  }
}
