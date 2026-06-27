import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
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
@UseGuards(JwtAuthGuard, ModuleGuard, AbilityGuard)
@RequireModule("kb")
export class KbArticlesController {
  constructor(private readonly articles: KbArticlesService) {}

  @Get("articles")
  @CheckAbility("view", "kb:articles")
  list(
    @Query(new ZodValidationPipe(listArticlesSchema)) query: ListArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.list(u, query);
  }

  @Post("articles")
  @CheckAbility("create", "kb:articles")
  create(
    @Body(new ZodValidationPipe(createArticleSchema)) body: CreateArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.create(u, body);
  }

  @Get("articles/:articleId")
  @CheckAbility("view", "kb:articles")
  get(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.get(u, articleId);
  }

  @Patch("articles/:articleId")
  @CheckAbility("update", "kb:articles")
  update(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(updateArticleSchema)) body: UpdateArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.update(u, articleId, body);
  }

  @Delete("articles/:articleId")
  @CheckAbility("delete", "kb:articles")
  remove(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.archive(u.orgId, articleId);
  }

  @Post("articles/:articleId/publish")
  @CheckAbility("manage", "kb:articles")
  publish(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.publish(u, articleId);
  }

  @Post("articles/:articleId/unpublish")
  @CheckAbility("manage", "kb:articles")
  unpublish(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.unpublish(u, articleId);
  }

  @Post("articles/:articleId/verify")
  @CheckAbility("manage", "kb:articles")
  verify(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(verifyArticleSchema)) body: VerifyArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.verify(u.orgId, u.userId, articleId, body);
  }

  @Post("articles/:articleId/vote")
  @CheckAbility("view", "kb:articles")
  vote(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(voteArticleSchema)) body: VoteArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.vote(u.orgId, articleId, body, u.userId);
  }

  @Get("articles/:articleId/versions")
  @CheckAbility("view", "kb:articles")
  versions(@Param("articleId", ParseIntPipe) articleId: number, @CurrentUser() u: CurrentUserContext) {
    return this.articles.listVersions(u, articleId);
  }

  @Post("articles/:articleId/versions/:versionNumber/restore")
  @CheckAbility("update", "kb:articles")
  restore(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.articles.restoreVersion(u, articleId, versionNumber);
  }
}
