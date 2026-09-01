import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NoTenantTransaction } from "../../../../common/tenant";
import { logger } from "../../../../common/logger/logger.service";
import { z } from "zod";
import { ChatAssistantService } from "../services/chat-assistant.service";
import { ChatHistoryService } from "../services/chat-history.service";
import { OrgFeaturesService } from "../services/org-features.service";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ProjectsTicketsService } from "../../../build/core/projects-tickets.service";
import { ProjectsTicketCommentsService } from "../../../build/core/projects-ticket-comments.service";
import { CalendarService } from "../../../calendar/calendar.service";
import { EmailOutboxService } from "../../../email/email-outbox.service";
import { ChatMessagesService } from "../../../chat/chat-messages.service";
import { EngagementService } from "../../../hr/performance/engagement.service";
import { BonusesService } from "../../../payroll/hr-payroll/bonuses.service";
import { createBonusSchema } from "../../../payroll/hr-payroll/dto/payroll.schemas";
import { MailService } from "../../../mail/mail.service";
import { MailAccountsService } from "../../../mail/mail-accounts.service";
import { tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { and, eq } from "drizzle-orm";
import type { CreateRecognitionInput } from "../../../hr/performance/dto/engagement.schemas";
import {
  chatHistoryQuerySchema,
  chatRequestSchema,
  conversationCreateSchema,
  conversationMessagesQuerySchema,
  conversationRenameSchema,
  conversationsListQuerySchema,
} from "../dto/request.schemas";
import { ToolAccessService } from "../tool-access.service";
import { AI_EVENT_TIMEZONE } from "../ai-event-timezone";
import { Validate } from "../../../../common/validation/validate.decorator";
import { actingMembershipId } from "../../../../common/auth/principal";

const conversationIdParams = z.object({ conversationId: z.string().min(1) }).strict();

const TICKET_TYPES = ["TASK", "BUG", "STORY", "EPIC", "SUBTASK"] as const;
const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const RECOGNITION_CATEGORIES = ["KUDOS", "TEAMWORK", "INNOVATION", "LEADERSHIP", "ABOVE_AND_BEYOND"] as const;

type TicketType = (typeof TICKET_TYPES)[number];
type TicketPriority = (typeof TICKET_PRIORITIES)[number];
type RecognitionCategory = (typeof RECOGNITION_CATEGORIES)[number];

function pickTicketType(v: unknown): TicketType {
  const s = String(v ?? "TASK").toUpperCase();
  return (TICKET_TYPES as readonly string[]).includes(s) ? (s as TicketType) : "TASK";
}

function pickPriority(v: unknown): TicketPriority {
  const s = String(v ?? "MEDIUM").toUpperCase();
  return (TICKET_PRIORITIES as readonly string[]).includes(s) ? (s as TicketPriority) : "MEDIUM";
}

function pickCategory(v: unknown): RecognitionCategory {
  const s = String(v ?? "KUDOS").toUpperCase();
  return (RECOGNITION_CATEGORIES as readonly string[]).includes(s) ? (s as RecognitionCategory) : "KUDOS";
}

const CONFIRMABLE_ACTIONS = [
  "ticket.create",
  "ticket.updateStatus",
  "ticket.addComment",
  "calendar.createReminder",
  "email.send",
  "chat.postChannel",
  "hr.grantRecognition",
  "hr.grantBonus",
  "mail.send",
] as const;

type ConfirmableAction = (typeof CONFIRMABLE_ACTIONS)[number];

function isConfirmableAction(s: string): s is ConfirmableAction {
  return (CONFIRMABLE_ACTIONS as readonly string[]).includes(s);
}

const confirmActionBodySchema = z.object({ token: z.string().min(1) });

@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatAssistantController {
  constructor(
    private readonly chat: ChatAssistantService,
    private readonly history: ChatHistoryService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly confirmation: AiConfirmationService,
    private readonly toolAccess: ToolAccessService,
    private readonly moduleRef: ModuleRef,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  @Get("history")
  @RequirePermission("ai:chat:use")
  async getHistory(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = chatHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.list(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Delete("history")
  @RequirePermission("ai:chat:use")
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0);
    return { success: true };
  }

  @Get("conversations")
  @RequirePermission("ai:chat:use")
  async listConversations(@Query() query: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = conversationsListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listConversations(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Post("conversations")
  @HttpCode(201)
  @RequirePermission("ai:chat:use")
  @Validate({ body: conversationCreateSchema })
  async createConversation(@Body() body: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = conversationCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.history.createConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, parsed.data.title);
  }

  @Patch("conversations/:conversationId")
  @RequirePermission("ai:chat:use")
  @Validate({ params: conversationIdParams, body: conversationRenameSchema })
  async renameConversation(
    @Param("conversationId") conversationIdParam: string,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const conversationId = parseInt(conversationIdParam, 10);
    if (isNaN(conversationId)) throw new BadRequestException("Invalid conversation ID");
    const parsed = conversationRenameSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.history.renameConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, conversationId, parsed.data.title);
  }

  @Delete("conversations/:conversationId")
  @RequirePermission("ai:chat:use")
  @Validate({ params: conversationIdParams })
  async deleteConversation(
    @Param("conversationId") conversationIdParam: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    const conversationId = parseInt(conversationIdParam, 10);
    if (isNaN(conversationId)) throw new BadRequestException("Invalid conversation ID");
    await this.history.deleteConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, conversationId);
    return { success: true };
  }

  @Get("conversations/:conversationId/messages")
  @RequirePermission("ai:chat:use")
  @Validate({ params: conversationIdParams })
  async getConversationMessages(
    @Param("conversationId") conversationIdParam: string,
    @Query() query: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const conversationId = parseInt(conversationIdParam, 10);
    if (isNaN(conversationId)) throw new BadRequestException("Invalid conversation ID");
    const parsed = conversationMessagesQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("Invalid query parameters");
    return this.history.listMessages(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, conversationId, {
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
  }

  @Post()
  @RequirePermission("ai:chat:use")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:chat")
  @NoTenantTransaction()
  @Validate({ body: chatRequestSchema })
  async chatAssistant(
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");

    const flags = await this.orgFeatures.getFlags(u.orgId);
    if (!flags.aiChat) {
      throw new ForbiddenException("AI chat is disabled for this organization.");
    }

    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const deadline = AbortSignal.timeout(120_000);
    const combined = (() => {
      const ctrl = new AbortController();
      const abort = () => ctrl.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      deadline.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted || deadline.aborted) ctrl.abort();
      return ctrl.signal;
    })();

    try {
      const result = await this.chat.processChat(
        parsed.data.messages,
        u,
        parsed.data.conversationId,
        parsed.data.persona,
        combined,
      );
      result.pipeTextStreamToResponse(res);
    } catch (error) {
      logger.error("Chat route error", { error });
      throw new InternalServerErrorException("Internal server error");
    }
  }

  @Post("confirm")
  @RequirePermission("ai:chat:use")
  @Validate({ body: confirmActionBodySchema })
  async confirmAction(@Body() body: unknown, @CurrentUser() u: CurrentUserContext) {
    const parsed = confirmActionBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");

    const confirmed = await this.confirmation.confirm({ token: parsed.data.token, actor: { orgId: u.orgId, userId: u.userId } });
    const { proposalId, action, payload } = confirmed;

    if (!isConfirmableAction(action)) {
      throw new BadRequestException(`Unknown action type: ${action}`);
    }

    const confirmedAction = action;
    let result: Record<string, unknown>;
    let summary: string;

    switch (confirmedAction) {
      case "ticket.create": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "build:tickets:create");
        if (deny) throw new ForbiddenException(deny);
        const svc = this.moduleRef.get(ProjectsTicketsService, { strict: false });
        const createInput = {
          title: String(payload["title"]),
          type: pickTicketType(payload["type"]),
          priority: pickPriority(payload["priority"]),
          ...(payload["description"] !== undefined && { description: String(payload["description"]) }),
          ...(payload["assigneeId"] !== undefined && { assigneeId: String(payload["assigneeId"]) }),
        };
        const ticket = await svc.createTicket(u, Number(payload["projectId"]), createInput);
        result = { ticketId: ticket.id, title: ticket.title };
        summary = `Ticket created: ${ticket.title}`;
        break;
      }

      case "ticket.updateStatus": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "build:tickets:update");
        if (deny) throw new ForbiddenException(deny);
        const ticketId = Number(payload["ticketId"]);
        const status = String(payload["status"]);
        await this.db
          .update(tickets)
          .set({ status })
          .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)));
        result = { ticketId, status };
        summary = `Ticket #${ticketId} status updated to ${status}`;
        break;
      }

      case "ticket.addComment": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "build:tickets:update");
        if (deny) throw new ForbiddenException(deny);
        const commentSvc = this.moduleRef.get(ProjectsTicketCommentsService, { strict: false });
        const comment = await commentSvc.addComment(u, Number(payload["ticketId"]), { content: String(payload["comment"]) });
        result = { commentId: comment.id };
        summary = `Comment added to ticket #${String(payload["ticketId"])}`;
        break;
      }

      case "calendar.createReminder": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "calendar:write");
        if (deny) throw new ForbiddenException(deny);
        const calSvc = this.moduleRef.get(CalendarService, { strict: false });
        const { event } = await calSvc.createEvent(u.orgId, u.userId, {
          title: String(payload["title"]),
          startDate: String(payload["startDate"]),
          endDate: String(payload["endDate"]),
          timezone: AI_EVENT_TIMEZONE,
          description: payload["description"] !== undefined ? String(payload["description"]) : undefined,
          category: "reminder",
          color: "blue",
        });
        result = { eventId: event?.id };
        summary = `Reminder created: ${String(payload["title"])}`;
        break;
      }

      case "email.send": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "chat:messages:write");
        if (deny) throw new ForbiddenException(deny);
        const emailSvc = this.moduleRef.get(EmailOutboxService, { strict: false });
        const bodyText = String(payload["body"]);
        await emailSvc.enqueueAndTry({
          to: String(payload["toEmail"]),
          subject: String(payload["subject"]),
          html: `<p>${bodyText}</p>`,
          text: bodyText,
        });
        result = { queued: true };
        summary = `Email sent to ${String(payload["toEmail"])}`;
        break;
      }

      case "chat.postChannel": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "chat:messages:write");
        if (deny) throw new ForbiddenException(deny);
        const msgSvc = this.moduleRef.get(ChatMessagesService, { strict: false });
        await msgSvc.send(Number(payload["channelId"]), u.userId, u.orgId, { content: String(payload["message"]) });
        result = { sent: true };
        summary = `Message posted to #${String(payload["channelName"])}`;
        break;
      }

      case "hr.grantRecognition": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "hr:engagement:manage");
        if (deny) throw new ForbiddenException(deny);
        const engSvc = this.moduleRef.get(EngagementService, { strict: false });
        const recognitionInput: CreateRecognitionInput = {
          toUserId: String(payload["toUserId"]),
          message: String(payload["message"]),
          category: pickCategory(payload["category"]),
        };
        const recognition = await engSvc.createRecognition(u, recognitionInput);
        result = { recognitionId: recognition.id };
        summary = `Recognition sent`;
        break;
      }

      case "hr.grantBonus": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "hr:bonuses:manage");
        if (deny) throw new ForbiddenException(deny);
        const bonusInput = createBonusSchema.parse({
          userId: payload["employeeId"],
          type: payload["type"],
          amount: payload["amount"],
          reason: payload["reason"],
          month: payload["month"],
          taxable: payload["taxable"],
        });
        const bonusSvc = this.moduleRef.get(BonusesService, { strict: false });
        const bonus = await bonusSvc.createBonus(u.orgId, bonusInput);
        result = { bonusId: bonus.id, status: bonus.status, amount: bonus.amount };
        summary = `Bonus created (PENDING payroll approval): ${bonus.amount}`;
        break;
      }

      case "mail.send": {
        const deny = await this.toolAccess.denyReason(u.orgId, u.userId, "mail:messages:send");
        if (deny) throw new ForbiddenException(deny);
        const mailSendPayloadSchema = z.object({
          accountId: z.number().int().positive(),
          toEmail: z.string().email(),
          subject: z.string().min(1).max(500),
          body: z.string().min(1),
        });
        const mailPayload = mailSendPayloadSchema.parse(payload);
        const mailAccountsSvc = this.moduleRef.get(MailAccountsService, { strict: false });
        await mailAccountsSvc.assertOwnedConnection(u.orgId, u.userId, mailPayload.accountId);
        const mailSvc = this.moduleRef.get(MailService, { strict: false });
        await mailSvc.sendMail(
          u.orgId,
          u.userId,
          mailPayload.accountId,
          [mailPayload.toEmail],
          mailPayload.subject,
          `<p>${mailPayload.body}</p>`,
        );
        result = { sent: true };
        summary = `Email sent to ${mailPayload.toEmail}`;
        break;
      }

      default: {
        const _exhaustive: never = confirmedAction;
        throw new BadRequestException(`Unknown action type: ${String(_exhaustive)}`);
      }
    }

    await this.confirmation.markExecuted(proposalId, result, u.orgId);
    return { ok: true, result, summary };
  }
}
