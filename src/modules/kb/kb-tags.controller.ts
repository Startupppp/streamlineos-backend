import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
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
import { KbTagsService } from "./kb-tags.service";
import {
  createTagSchema,
  setArticleTagsSchema,
  type CreateTagInput,
  type SetArticleTagsInput,
} from "./dto/kb-tags.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbTagsController {
  constructor(private readonly tags: KbTagsService) {}

  @Get("tags")
  @RequirePermission("kb:spaces:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.tags.list(u.orgId);
  }

  @Post("tags")
  @RequirePermission("kb:articles:manage")
  create(
    @Body(new ZodValidationPipe(createTagSchema)) body: CreateTagInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tags.create(u.orgId, body);
  }

  @Delete("tags/:tagId")
  @RequirePermission("kb:articles:manage")
  remove(
    @Param("tagId", ParseIntPipe) tagId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tags.remove(u.orgId, tagId);
  }

  @Get("articles/:articleId/tags")
  @RequirePermission("kb:articles:view")
  getArticleTags(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tags.getArticleTags(u.orgId, articleId);
  }

  @Put("articles/:articleId/tags")
  @RequirePermission("kb:articles:update")
  setArticleTags(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(setArticleTagsSchema)) body: SetArticleTagsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tags.setArticleTags(u.orgId, articleId, body);
  }
}
