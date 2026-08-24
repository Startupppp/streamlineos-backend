import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { AuditService } from "../../common/audit/audit.service";
import { MailService } from "./mail.service";
import { MailAiService } from "./mail-ai.service";
import {
  getAttachmentQuerySchema,
  getMessageQuerySchema,
  getThreadQuerySchema,
  listMessagesQuerySchema,
  mailActionSchema,
  replyMailSchema,
  sendMailSchema,
  type GetAttachmentQuery,
  type GetMessageQuery,
  type GetThreadQuery,
  type ListMessagesQuery,
  type MailActionInput,
  type ReplyMailInput,
  type SendMailInput,
} from "./dto/mail-schemas";
import {
  draftBodySchema,
  inboxSummaryBodySchema,
  threadSummaryBodySchema,
  type DraftInput,
  type InboxSummaryInput,
  type ThreadSummaryInput,
} from "./dto/mail-ai-schemas";

@Controller("mail")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class MailController {
  constructor(
    private readonly mail: MailService,
    private readonly mailAi: MailAiService,
    private readonly audit: AuditService,
  ) {}

  @Get("accounts")
  @RequirePermission("mail:inbox:view")
  listAccounts(@CurrentUser() u: CurrentUserContext) {
    return this.mail.listAccounts(u.orgId, u.userId);
  }

  @Get("messages")
  @RequirePermission("mail:inbox:view")
  listMessages(
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.listMessages(
      u.orgId,
      u.userId,
      query.folder,
      query.accountId,
      query.limit,
      query.cursor,
      query.q,
    );
  }

  @Get("messages/:messageId")
  @RequirePermission("mail:inbox:view")
  getMessage(
    @Param("messageId") messageId: string,
    @Query(new ZodValidationPipe(getMessageQuerySchema)) query: GetMessageQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.getMessage(u.orgId, u.userId, messageId, query.accountId);
  }

  @Get("threads/:threadId")
  @RequirePermission("mail:inbox:view")
  getThread(
    @Param("threadId") threadId: string,
    @Query(new ZodValidationPipe(getThreadQuerySchema)) query: GetThreadQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.getThread(u.orgId, u.userId, threadId, query.accountId);
  }

  @Post("send")
  @HttpCode(200)
  @RequirePermission("mail:messages:send")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("mail:send")
  async sendMail(
    @Body(new ZodValidationPipe(sendMailSchema)) body: SendMailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.mail.sendMail(u.orgId, u.userId, body.accountId, body.to, body.subject, body.bodyHtml, body.cc, body.bcc);
    this.audit.log({ action: "mail.send", userId: u.userId, orgId: u.orgId, metadata: { accountId: body.accountId, to: body.to, subject: body.subject } });
    return { sent: true };
  }

  @Post("reply")
  @HttpCode(200)
  @RequirePermission("mail:messages:send")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("mail:reply")
  async replyMail(
    @Body(new ZodValidationPipe(replyMailSchema)) body: ReplyMailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.mail.replyMail(u.orgId, u.userId, body.accountId, body.messageId, body.threadId, body.bodyHtml, body.cc);
    this.audit.log({ action: "mail.reply", userId: u.userId, orgId: u.orgId, metadata: { accountId: body.accountId, messageId: body.messageId } });
    return { sent: true };
  }

  @Post("messages/:messageId/actions")
  @HttpCode(200)
  @RequirePermission("mail:messages:manage")
  performAction(
    @Param("messageId") messageId: string,
    @Body(new ZodValidationPipe(mailActionSchema)) body: MailActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.performAction(u.orgId, u.userId, messageId, body.accountId, body.action, body.threadId);
  }

  @Get("messages/:messageId/attachments/:attachmentId")
  @RequirePermission("mail:inbox:view")
  getAttachment(
    @Param("messageId") messageId: string,
    @Param("attachmentId") attachmentId: string,
    @Query(new ZodValidationPipe(getAttachmentQuerySchema)) query: GetAttachmentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.getAttachment(u.orgId, u.userId, messageId, attachmentId, query.accountId, query.fileName);
  }

  @Post("ai/inbox-summary")
  @HttpCode(200)
  @RequirePermission("mail:ai:use")
  async aiInboxSummary(
    @Body(new ZodValidationPipe(inboxSummaryBodySchema)) body: InboxSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailAi.inboxSummary(u, body.accountId);
  }

  @Post("ai/thread-summary")
  @HttpCode(200)
  @RequirePermission("mail:ai:use")
  async aiThreadSummary(
    @Body(new ZodValidationPipe(threadSummaryBodySchema)) body: ThreadSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailAi.threadSummary(u, body.accountId, body.threadId);
  }

  @Post("ai/draft")
  @HttpCode(200)
  @RequirePermission("mail:ai:use")
  async aiDraft(
    @Body(new ZodValidationPipe(draftBodySchema)) body: DraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailAi.draft(u, body);
  }
}
