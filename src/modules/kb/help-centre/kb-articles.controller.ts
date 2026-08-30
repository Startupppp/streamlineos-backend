import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { KbArticlesService } from "./kb-articles.service";
import { resolveKbArticlesViewScope } from "../core/kb-scope";
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
} from "../core/dto/kb.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();
const articleIdversionNumberParams = z.object({ articleId: z.coerce.number().int().positive(), versionNumber: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbArticlesController {
  constructor(
    private readonly articles: KbArticlesService,
    private readonly access: AccessService,
  ) {}

  @Get("articles")
  @RequirePermission("kb:articles:view")
  @Validate({ query: listArticlesSchema })
  async list(
    @Query() query: ListArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    const scope = await resolveKbArticlesViewScope(this.access, u);
    return await this.articles.list(u, query, scope);
  }

  @Post("articles")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission("kb:articles:create")
  @Validate({ body: createArticleSchema })
  async create(
    @Body() body: CreateArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.create(u, body);
  }

  @Get("articles/:articleId")
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async get(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.get(u, articleId);
  }

  @Patch("articles/:articleId")
  @RequirePermission("kb:articles:update")
  @Validate({ params: articleIdParams, body: updateArticleSchema })
  async update(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: UpdateArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.update(u, articleId, body);
  }

  @Delete("articles/:articleId")
  @RequirePermission("kb:articles:delete")
  @Validate({ params: articleIdParams })
  async remove(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.archive(u, articleId);
  }

  @Post("articles/:articleId/publish")
  @Idempotent("kb.article.publish")
  @RequirePermission("kb:articles:manage")
  @HttpCode(200)
  @Validate({ params: articleIdParams })
  async publish(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.publish(u, articleId);
  }

  @Post("articles/:articleId/unpublish")
  @RequirePermission("kb:articles:manage")
  @HttpCode(200)
  @Validate({ params: articleIdParams })
  async unpublish(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.unpublish(u, articleId);
  }

  @Post("articles/:articleId/verify")
  @RequirePermission("kb:articles:manage")
  @HttpCode(200)
  @Validate({ params: articleIdParams, body: verifyArticleSchema })
  async verify(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: VerifyArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.verify(u, articleId, body);
  }

  @Post("articles/:articleId/vote")
  @RequirePermission("kb:articles:view")
  @HttpCode(200)
  @Validate({ params: articleIdParams, body: voteArticleSchema })
  async vote(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: VoteArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.vote(u, articleId, body);
  }

  @Post("articles/:articleId/view")
  @HttpCode(200)
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async recordView(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.recordView(u, articleId);
  }

  @Get("articles/:articleId/versions")
  @RequirePermission("kb:articles:view")
  @Validate({ params: articleIdParams })
  async versions(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.listVersions(u, articleId);
  }

  @Post("articles/:articleId/versions/:versionNumber/restore")
  @RequirePermission("kb:articles:update")
  @HttpCode(200)
  @Validate({ params: articleIdversionNumberParams })
  async restore(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("versionNumber", ParseIntPipe) versionNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.articles.restoreVersion(u, articleId, versionNumber);
  }
}
