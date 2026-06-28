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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbArticlesService } from "./kb-articles.service";
import {
  createArticleSchema,
  listArticlesSchema,
  updateArticleSchema,
  verifyArticleSchema,
  voteArticleSchema,
  type CreateArticleInput,
  type ListArticlesInput,
  type UpdateArticleInput,
  type VerifyArticleInput,
  type VoteArticleInput,
} from "./dto/kb.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbArticlesController {
  constructor(private readonly articles: KbArticlesService) {}

  @Get("articles")
  @RequirePermission("kb:articles:view")
  list(
    @Query(new ZodValidationPipe(listArticlesSchema)) query: ListArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.list(u, query);
  }

  @Post("articles")
  @RequirePermission("kb:articles:create")
  create(
    @Body(new ZodValidationPipe(createArticleSchema)) body: CreateArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.create(u, body);
  }

  @Get("articles/:articleId")
  @RequirePermission("kb:articles:view")
  get(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.get(u, articleId);
  }

  @Patch("articles/:articleId")
  @RequirePermission("kb:articles:update")
  update(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(updateArticleSchema)) body: UpdateArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.update(u, articleId, body);
  }

  @Delete("articles/:articleId")
  @RequirePermission("kb:articles:delete")
  remove(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.archive(u, articleId);
  }

  @Post("articles/:articleId/publish")
  @RequirePermission("kb:articles:manage")
  publish(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.publish(u, articleId);
  }

  @Post("articles/:articleId/unpublish")
  @RequirePermission("kb:articles:manage")
  unpublish(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.unpublish(u, articleId);
  }

  @Post("articles/:articleId/verify")
  @RequirePermission("kb:articles:manage")
  verify(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(verifyArticleSchema)) body: VerifyArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.verify(u, articleId, body);
  }

  @Post("articles/:articleId/vote")
  @RequirePermission("kb:articles:view")
  vote(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(voteArticleSchema)) body: VoteArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.vote(u, articleId, body);
  }

  @Post("articles/:articleId/view")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  recordView(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.recordView(u, articleId);
  }

  @Get("articles/:articleId/versions")
  @RequirePermission("kb:articles:view")
  versions(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.listVersions(u, articleId);
  }

  @Post("articles/:articleId/versions/:versionNumber/restore")
  @RequirePermission("kb:articles:update")
  restore(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.restoreVersion(u, articleId, versionNumber);
  }
}
