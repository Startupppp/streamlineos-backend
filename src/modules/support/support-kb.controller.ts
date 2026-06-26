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
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SupportKbService } from "./support-kb.service";
import {
  createKbArticleSchema,
  createKbAttachmentSchema,
  createKbCategorySchema,
  createKbCommentSchema,
  listKbArticlesSchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
  type CreateKbArticleInput,
  type CreateKbAttachmentInput,
  type CreateKbCategoryInput,
  type CreateKbCommentInput,
  type ListKbArticlesInput,
  type UpdateKbArticleInput,
  type UpdateKbCategoryInput,
} from "./dto/support.schemas";

@Controller("support/kb")
@UseGuards(JwtAuthGuard)
export class SupportKbController {
  constructor(private readonly kb: SupportKbService) {}

  @Get("categories")
  @UseGuards(AbilityGuard)
  @CheckAbility("view", "support:kb")
  listCategories(@CurrentUser() u: CurrentUserContext) {
    return this.kb.listCategories(u.orgId);
  }

  @Post("categories")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  @HttpCode(201)
  createCategory(
    @Body(new ZodValidationPipe(createKbCategorySchema)) body: CreateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createCategory(u.orgId, body);
  }

  @Patch("categories/:categoryId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  updateCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @Body(new ZodValidationPipe(updateKbCategorySchema)) body: UpdateKbCategoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.updateCategory(u.orgId, categoryId, body);
  }

  @Delete("categories/:categoryId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  deleteCategory(
    @Param("categoryId", ParseIntPipe) categoryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteCategory(u.orgId, categoryId);
  }

  @Get("articles")
  @UseGuards(AbilityGuard)
  @CheckAbility("view", "support:kb")
  listArticles(
    @Query(new ZodValidationPipe(listKbArticlesSchema)) query: ListKbArticlesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listArticles(u.orgId, query);
  }

  @Post("articles")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  @HttpCode(201)
  createArticle(
    @Body(new ZodValidationPipe(createKbArticleSchema)) body: CreateKbArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createArticle(u.orgId, u.userId, body);
  }

  @Get("articles/:articleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("view", "support:kb")
  getArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.getArticle(u.orgId, articleId);
  }

  @Patch("articles/:articleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  updateArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(updateKbArticleSchema)) body: UpdateKbArticleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.updateArticle(u.orgId, articleId, body);
  }

  @Delete("articles/:articleId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  deleteArticle(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteArticle(u.orgId, articleId);
  }

  @Get("articles/:articleId/feedback")
  @UseGuards(AbilityGuard)
  @CheckAbility("view", "support:kb")
  listFeedback(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listFeedback(u.orgId, articleId);
  }

  @Get("articles/:articleId/comments")
  @UseGuards(AbilityGuard)
  @CheckAbility("view", "support:kb")
  listComments(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listComments(u.orgId, articleId);
  }

  @Post("articles/:articleId/comments")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  @HttpCode(201)
  createComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(createKbCommentSchema)) body: CreateKbCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createComment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/comments/:commentId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  deleteComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteComment(u.orgId, articleId, commentId);
  }

  @Get("articles/:articleId/attachments")
  @UseGuards(AbilityGuard)
  @CheckAbility("view", "support:kb")
  listAttachments(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.listAttachments(u.orgId, articleId);
  }

  @Post("articles/:articleId/attachments")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  @HttpCode(201)
  createAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body(new ZodValidationPipe(createKbAttachmentSchema)) body: CreateKbAttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.createAttachment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/attachments/:attachmentId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "support:kb")
  deleteAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kb.deleteAttachment(u.orgId, articleId, attachmentId);
  }
}
