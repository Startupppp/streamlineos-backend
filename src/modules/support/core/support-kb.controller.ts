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
import { SupportKbService } from "./support-kb.service";
import { KbAskService } from "../../kb/retrieval/kb-ask.service";
import { KbArticleReindexService } from "../../kb/retrieval/kb-article-reindex.service";
import {
  createKbArticleSchema,
  createKbAttachmentSchema,
  createKbCategorySchema,
  createKbCommentSchema,
  kbAskSchema,
  listKbArticlesSchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
  type CreateKbArticleInput,
  type CreateKbAttachmentInput,
  type CreateKbCategoryInput,
  type CreateKbCommentInput,
  type KbAskInput,
  type ListKbArticlesInput,
  type UpdateKbArticleInput,
  type UpdateKbCategoryInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();
const articleAndAttachmentIdParams = z
  .object({
    articleId: z.coerce.number().int().positive(),
    attachmentId: z.coerce.number().int().positive(),
  })
  .strict();

@RequireModule("support")
@Controller("support/kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportKbController {
  constructor(
    private readonly kb: SupportKbService,
    private readonly ask: KbAskService,
    private readonly reindex: KbArticleReindexService,
  ) {}

  @Get("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.kb.listCategories(u.orgId);
  }

  @Post("categories")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ body: createKbCategorySchema })
  createCategory(
    @Body() body: CreateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createCategory(u.orgId, body);
  }

  @Patch("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @Validate({ body: updateKbCategorySchema })
  updateCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body() body: UpdateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.updateCategory(u.orgId, categoryId, body);
  }

  @Delete("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  deleteCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteCategory(u.orgId, categoryId);
  }

  @Get("articles")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @Validate({ query: listKbArticlesSchema })
  listArticles(
    @Query() query: ListKbArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listArticles(u.orgId, query);
  }

  @Post("articles")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ body: createKbArticleSchema })
  createArticle(
    @Body() body: CreateKbArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createArticle(u.orgId, u.userId, body);
  }

  @Get("articles/:articleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  getArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.getArticle(u.orgId, articleId);
  }

  @Patch("articles/:articleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @Validate({ body: updateKbArticleSchema })
  updateArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: UpdateKbArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.updateArticle(u.orgId, articleId, body);
  }

  @Delete("articles/:articleId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  deleteArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteArticle(u.orgId, articleId);
  }

  @Get("articles/:articleId/feedback")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  listFeedback(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listFeedback(u.orgId, articleId);
  }

  @Get("articles/:articleId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  listComments(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listComments(u.orgId, articleId);
  }

  @Post("articles/:articleId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ body: createKbCommentSchema })
  createComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: CreateKbCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createComment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/comments/:commentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  deleteComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteComment(u.orgId, articleId, commentId);
  }

  @Get("articles/:articleId/attachments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  listAttachments(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listAttachments(u.orgId, articleId);
  }

  @Post("articles/:articleId/attachments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ params: articleIdParams, body: createKbAttachmentSchema })
  createAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: CreateKbAttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createAttachment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/attachments/:attachmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @Validate({ params: articleAndAttachmentIdParams })
  deleteAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteAttachment(u.orgId, articleId, attachmentId);
  }

  @Get("articles/:articleId/attachments/:attachmentId/download")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @Validate({ params: articleAndAttachmentIdParams })
  getAttachmentDownloadUrl(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.getAttachmentDownloadUrl(u.orgId, articleId, attachmentId);
  }

  @Post("ask")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @HttpCode(200)
  @Validate({ body: kbAskSchema })
  askQuestion(
    @Body() body: KbAskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ask.ask(u, { question: body.question });
  }

  @Get("articles/:articleId/index-status")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @Validate({ params: articleIdParams })
  getArticleIndexStatus(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reindex.getArticleIndexStatus(u.orgId, articleId);
  }

  @Post("articles/:articleId/reindex")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(200)
  @Validate({ params: articleIdParams })
  reindexArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reindex.reindexArticle(u.orgId, articleId);
  }

  @Post("reindex-all")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(200)
  reindexAll(@CurrentUser() u: CurrentUserContext) {
    return this.reindex.reindexAll(u.orgId);
  }
}
