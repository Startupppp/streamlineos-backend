import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { SupportKbEngagementService } from "./support-kb-engagement.service";
import { KbAskService } from "../../kb/retrieval/kb-ask.service";
import { KbArticleReindexService } from "../../kb/retrieval/kb-article-reindex.service";
import {
  createKbAttachmentSchema,
  createKbCommentSchema,
  kbAskSchema,
  type CreateKbAttachmentInput,
  type CreateKbCommentInput,
  type KbAskInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { NoTenantTransaction } from "../../../common/tenant";
import {
  kbFeedbackListSchema,
  kbCommentListSchema,
  kbCommentRowSchema,
  kbAttachmentListSchema,
  kbAttachmentRowSchema,
  kbAttachmentDownloadSchema,
  kbAskResultSchema,
  kbIndexStatusSchema,
  kbReindexArticleSchema,
  kbReindexAllSchema,
  successSchema as kbEngSuccessSchema,
} from "./dto/support-kb-response.schemas";
import { z } from "zod";

const articleIdParams = z.object({ articleId: z.coerce.number().int().positive() }).strict();
const reindexAllQuery = z
  .object({ afterArticleId: z.coerce.number().int().min(0).default(0) })
  .strict();
type ReindexAllQuery = z.infer<typeof reindexAllQuery>;
const articleAndAttachmentIdParams = z
  .object({
    articleId: z.coerce.number().int().positive(),
    attachmentId: z.coerce.number().int().positive(),
  })
  .strict();

@RequireModule("support")
@Controller("support/kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportKbEngagementController {
  constructor(
    private readonly kbEngagement: SupportKbEngagementService,
    private readonly ask: KbAskService,
    private readonly reindex: KbArticleReindexService,
  ) {}

  @Get("articles/:articleId/feedback")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @ResponseSchema(kbFeedbackListSchema)
  listFeedback(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.listFeedback(u.orgId, articleId);
  }

  @Get("articles/:articleId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @ResponseSchema(kbCommentListSchema)
  listComments(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.listComments(u.orgId, articleId);
  }

  @Post("articles/:articleId/comments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ body: createKbCommentSchema })
  @ResponseSchema(kbCommentRowSchema)
  createComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: CreateKbCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.createComment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/comments/:commentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @ResponseSchema(kbEngSuccessSchema)
  deleteComment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.deleteComment(u.orgId, articleId, commentId);
  }

  @Get("articles/:articleId/attachments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @ResponseSchema(kbAttachmentListSchema)
  listAttachments(
    @Param("articleId", ParseIntPipe) articleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.listAttachments(u.orgId, articleId);
  }

  @Post("articles/:articleId/attachments")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @HttpCode(201)
  @Validate({ params: articleIdParams, body: createKbAttachmentSchema })
  @ResponseSchema(kbAttachmentRowSchema)
  createAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Body() body: CreateKbAttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.createAttachment(u.orgId, articleId, u.userId, body);
  }

  @Delete("articles/:articleId/attachments/:attachmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:manage")
  @Validate({ params: articleAndAttachmentIdParams })
  @ResponseSchema(kbEngSuccessSchema)
  deleteAttachment(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.deleteAttachment(u.orgId, articleId, attachmentId);
  }

  @Get("articles/:articleId/attachments/:attachmentId/download")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @Validate({ params: articleAndAttachmentIdParams })
  @ResponseSchema(kbAttachmentDownloadSchema)
  getAttachmentDownloadUrl(
    @Param("articleId", ParseIntPipe) articleId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.kbEngagement.getAttachmentDownloadUrl(u.orgId, articleId, attachmentId);
  }

  @Post("ask")
  @NoTenantTransaction()
  @UseGuards(PermissionGuard)
  @RequirePermission("support:kb:view")
  @HttpCode(200)
  @Validate({ body: kbAskSchema })
  @ResponseSchema(kbAskResultSchema)
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
  @ResponseSchema(kbIndexStatusSchema)
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
  @ResponseSchema(kbReindexArticleSchema)
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
  @Validate({ query: reindexAllQuery })
  @ResponseSchema(kbReindexAllSchema)
  reindexAll(@Query() query: ReindexAllQuery, @CurrentUser() u: CurrentUserContext) {
    return this.reindex.reindexAll(u.orgId, query.afterArticleId);
  }
}
