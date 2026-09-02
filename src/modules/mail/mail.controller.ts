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
import { actingMembershipId } from "../../common/auth/principal";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { AuditService } from "../../common/audit/audit.service";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
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
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const messageIdParams = z.object({ messageId: z.string().min(1) }).strict();
const threadIdParams = z.object({ threadId: z.string().min(1) }).strict();
const messageIdattachmentIdParams = z.object({ messageId: z.string().min(1), attachmentId: z.string().min(1) }).strict();

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
  @Validate({ query: listMessagesQuerySchema })
  listMessages(
    @Query() query: ListMessagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.listMessages(
      u.orgId,
      u.userId,
      actingMembershipId(u.principal),
      query.folder,
      query.accountId,
      query.limit,
      query.cursor,
      query.q,
    );
  }

  @Get("messages/:messageId")
  @RequirePermission("mail:inbox:view")
  @Validate({ params: messageIdParams, query: getMessageQuerySchema })
  getMessage(
    @Param("messageId") messageId: string,
    @Query() query: GetMessageQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.getMessage(u.orgId, u.userId, messageId, query.accountId);
  }

  @Get("threads/:threadId")
  @RequirePermission("mail:inbox:view")
  @Validate({ params: threadIdParams, query: getThreadQuerySchema })
  getThread(
    @Param("threadId") threadId: string,
    @Query() query: GetThreadQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.getThread(u.orgId, u.userId, threadId, query.accountId);
  }

  @Post("send")
  @HttpCode(200)
  @Idempotent("mail.send")
  @RequirePermission("mail:messages:send")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("mail:send")
  @Validate({ body: sendMailSchema })
  async sendMail(
    @Body() body: SendMailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.mail.sendMail(u.orgId, u.userId, body.accountId, body.to, body.subject, body.bodyHtml, body.cc, body.bcc);
    this.audit.log({ action: "mail.send", userId: u.userId, orgId: u.orgId, metadata: { accountId: body.accountId, to: body.to, subject: body.subject } });
    return { sent: true };
  }

  @Post("reply")
  @HttpCode(200)
  @Idempotent("mail.reply")
  @RequirePermission("mail:messages:send")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("mail:reply")
  @Validate({ body: replyMailSchema })
  async replyMail(
    @Body() body: ReplyMailInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.mail.replyMail(u.orgId, u.userId, body.accountId, body.messageId, body.threadId, body.bodyHtml, body.cc);
    this.audit.log({ action: "mail.reply", userId: u.userId, orgId: u.orgId, metadata: { accountId: body.accountId, messageId: body.messageId } });
    return { sent: true };
  }

  @Post("messages/:messageId/actions")
  @HttpCode(200)
  @RequirePermission("mail:messages:manage")
  @Validate({ params: messageIdParams, body: mailActionSchema })
  performAction(
    @Param("messageId") messageId: string,
    @Body() body: MailActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.performAction(u.orgId, u.userId, actingMembershipId(u.principal), messageId, body.accountId, body.action, body.threadId);
  }

  @Get("messages/:messageId/attachments/:attachmentId")
  @RequirePermission("mail:inbox:view")
  @Validate({ params: messageIdattachmentIdParams, query: getAttachmentQuerySchema })
  getAttachment(
    @Param("messageId") messageId: string,
    @Param("attachmentId") attachmentId: string,
    @Query() query: GetAttachmentQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mail.getAttachment(u.orgId, u.userId, messageId, attachmentId, query.accountId, query.fileName);
  }

  @Post("ai/inbox-summary")
  @HttpCode(200)
  @RequirePermission("mail:ai:use")
  @Validate({ body: inboxSummaryBodySchema })
  async aiInboxSummary(
    @Body() body: InboxSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailAi.inboxSummary(u, body.accountId);
  }

  @Post("ai/thread-summary")
  @HttpCode(200)
  @RequirePermission("mail:ai:use")
  @Validate({ body: threadSummaryBodySchema })
  async aiThreadSummary(
    @Body() body: ThreadSummaryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailAi.threadSummary(u, body.accountId, body.threadId);
  }

  @Post("ai/draft")
  @HttpCode(200)
  @RequirePermission("mail:ai:use")
  @Validate({ body: draftBodySchema })
  async aiDraft(
    @Body() body: DraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mailAi.draft(u, body);
  }
}
