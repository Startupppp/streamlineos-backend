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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SupportKbService } from "./support-kb.service";
import { KbAskService } from "../../kb/retrieval/kb-ask.service";
import { KbIndexingService } from "../../kb/retrieval/kb-indexing.service";
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

@RequireModule("support")
@Controller("support/kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportKbController {
  constructor(
    private readonly kb: SupportKbService,
    private readonly ask: KbAskService,
    private readonly indexing: KbIndexingService,
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
  createCategory(
    @Body(new ZodValidationPipe(createKbCategorySchema)) body: CreateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createCategory(u.orgId, body);
  }

  @Patch("categories/:categoryId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  updateCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body(new ZodValidationPipe(updateKbCategorySchema)) body: UpdateKbCategoryInput,
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
  listArticles(
    @Query(new ZodValidationPipe(listKbArticlesSchema)) query: ListKbArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listArticles(u.orgId, query);
  }

  @Post("articles")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  createArticle(
    @Body(new ZodValidationPipe(createKbArticleSchema)) body: CreateKbArticleInput,
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
  updateArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(updateKbArticleSchema)) body: UpdateKbArticleInput,
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
  createComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(createKbCommentSchema)) body: CreateKbCommentInput,
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
  createAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(createKbAttachmentSchema)) body: CreateKbAttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createAttachment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/attachments/:attachmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  deleteAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteAttachment(u.orgId, articleId, attachmentId);
  }

  @Post("ask")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @HttpCode(200)
  askQuestion(
    @Body(new ZodValidationPipe(kbAskSchema)) body: KbAskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ask.ask(u, { question: body.question });
  }

  @Get("articles/:articleId/index-status")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  getArticleIndexStatus(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.indexing.getArticleIndexStatus(u.orgId, articleId);
  }

  @Post("articles/:articleId/reindex")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(200)
  reindexArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.indexing.reindexArticle(u.orgId, articleId);
  }

  @Post("reindex-all")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(200)
  reindexAll(@CurrentUser() u: CurrentUserContext) {
    return this.indexing.reindexAll(u.orgId);
  }
}
