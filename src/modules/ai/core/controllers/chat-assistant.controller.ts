import {
  BadRequestException,
  Body,
  Inject,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NoTenantTransaction } from "../../../../common/tenant";
import { z } from "zod";
import { ChatAssistantService } from "../services/chat-assistant.service";
import { ChatHistoryService } from "../services/chat-history.service";
import { OrgFeaturesService } from "../services/org-features.service";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ProjectsTicketsService } from "../../../build/core/projects-tickets.service";
import { ProjectsTicketCommentsService } from "../../../build/core/projects-ticket-comments.service";
import { CalendarService } from "../../../calendar/calendar.service";
import { EmailOutboxService } from "../../../email/email-outbox.service";
import { escapeHtml } from "../../../email/templates/base";
import { ChatMessagesService } from "../../../chat/chat-messages.service";
import { ChatChannelsService } from "../../../chat/chat-channels.service";
import { EngagementService } from "../../../hr/performance/engagement.service";
import { BonusesService } from "../../../payroll/hr-payroll/bonuses.service";
import { createBonusSchema } from "../../../payroll/hr-payroll/dto/payroll.schemas";
import { MailComposeService } from "../../../mail/mail-compose.service";
import { MailAccountsService } from "../../../mail/mail-accounts.service";
import type { CreateRecognitionInput } from "../../../hr/performance/dto/engagement.schemas";
import { LeavesWriteService } from "../../../hr/time/leaves-write.service";
import { createLeaveSchema } from "../../../hr/time/dto/leaves.schemas";
import { ExpensesWriteService } from "../../../expenses/expenses-write.service";
import { createExpenseSchema } from "../../../expenses/dto/expense.schemas";
import { EntriesService } from "../../../timesheets/core/entries.service";
import { RecruitmentSourcingService } from "../../../hr/recruitment/recruitment-sourcing.service";
import { LeadsService } from "../../../leads/leads.service";
import { LeadsDetailService } from "../../../leads/leads-detail.service";
import { createSchema as createLeadSchema } from "../../../leads/dto/lead.schemas";
import {
  chatHistoryQuerySchema,
  chatRequestSchema,
  confirmActionBodySchema,
  conversationCreateSchema,
  conversationMessagesQuerySchema,
  conversationRenameSchema,
  conversationsListQuerySchema,
  mailSendPayloadSchema,
  scheduleMeetingPayloadSchema,
  sendDirectMessagePayloadSchema,
  ticketStatusUpdatePayloadSchema,
} from "../dto/request.schemas";
import { ToolAccessService } from "../tool-access.service";
import { resolveOrgTimezone } from "../services/ask-os-actor";
import { Validate } from "../../../../common/validation/validate.decorator";
import { actingMembershipId } from "../../../../common/auth/principal";
import {
  createStreamAbortSignal,
  pipeAiUiMessageStream,
  rethrowStreamRouteError,
} from "../streaming";
import { AiRequestAbortInterceptor } from "../streaming";
import { ApiOkResponse } from "@nestjs/swagger";
import { ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  chatHistoryResponseSchema,
  chatClearHistoryResponseSchema,
  listConversationsResponseSchema,
  aiConversationSchema,
  deleteConversationResponseSchema,
  confirmActionResponseSchema,
} from "../dto/ai-response.schemas";

export const CHAT_STREAM_DEADLINE_MS = 120_000;

const conversationIdParams = z.object({ conversationId: z.string().min(1) }).strict();

const TICKET_TYPES = ["TASK", "BUG", "STORY", "EPIC", "SUBTASK"] as const;
const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const RECOGNITION_CATEGORIES = ["KUDOS", "TEAMWORK", "INNOVATION", "LEADERSHIP", "ABOVE_AND_BEYOND"] as const;

type TicketType = (typeof TICKET_TYPES)[number];
type TicketPriority = (typeof TICKET_PRIORITIES)[number];
type RecognitionCategory = (typeof RECOGNITION_CATEGORIES)[number];

function pickFromEnum<T extends string>(candidates: readonly T[], v: unknown, fallback: T): T {
  const s = String(v ?? fallback).toUpperCase();
  return candidates.find((candidate) => candidate === s) ?? fallback;
}

function pickTicketType(v: unknown): TicketType {
  return pickFromEnum(TICKET_TYPES, v, "TASK");
}

function pickPriority(v: unknown): TicketPriority {
  return pickFromEnum(TICKET_PRIORITIES, v, "MEDIUM");
}

function pickCategory(v: unknown): RecognitionCategory {
  return pickFromEnum(RECOGNITION_CATEGORIES, v, "KUDOS");
}

export const CONFIRMABLE_ACTIONS = [
  "ticket.create",
  "ticket.updateStatus",
  "ticket.addComment",
  "calendar.createReminder",
  "email.send",
  "chat.postChannel",
  "hr.grantRecognition",
  "hr.grantBonus",
  "mail.send",
  "self.applyLeave",
  "self.submitExpense",
  "self.logTimesheet",
  "self.submitReferral",
  "crm.createLead",
  "crm.logActivity",
  "ticket.assign",
  "ticket.moveToSprint",
  "calendar.createEvent",
  "mail.reply",
  "calendar.scheduleMeeting",
  "chat.sendDirect",
] as const;

type ConfirmableAction = (typeof CONFIRMABLE_ACTIONS)[number];

/**
 * DELIBERATE, PENDING AN OWNER'S DECISION (findings register #241): "email.send"
 * is gated on `chat:messages:write`, so anyone who may post a chat message may
 * also send outbound email through `EmailOutboxService.enqueueAndTry`. The
 * matching key is `mail:messages:send`, which "mail.send" below already uses.
 * Tightening this key would lock out callers who use the path today, so it is
 * left exactly as it was until an owner decides; do not "fix" it silently.
 */
export const CONFIRM_ACTION_PERMISSION: Record<ConfirmableAction, string> = {
  "ticket.create": "build:tickets:create",
  "ticket.updateStatus": "build:tickets:update",
  "ticket.addComment": "build:tickets:update",
  "calendar.createReminder": "calendar:write",
  "email.send": "chat:messages:write",
  "chat.postChannel": "chat:messages:write",
  "hr.grantRecognition": "hr:engagement:manage",
  "hr.grantBonus": "hr:bonuses:manage",
  "mail.send": "mail:messages:send",
  "self.applyLeave": "self:leaves",
  "self.submitExpense": "self:expenses",
  "self.logTimesheet": "timesheets:entries:create",
  "self.submitReferral": "self:referrals",
  "crm.createLead": "crm:leads:create",
  "crm.logActivity": "crm:activities:manage",
  "ticket.assign": "build:tickets:update",
  "ticket.moveToSprint": "build:tickets:update",
  "calendar.createEvent": "calendar:write",
  "mail.reply": "mail:messages:send",
  "calendar.scheduleMeeting": "calendar:write",
  "chat.sendDirect": "chat:messages:write",
};


function isConfirmableAction(s: string): s is ConfirmableAction {
  return CONFIRMABLE_ACTIONS.some((action) => action === s);
}

@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class ChatAssistantController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly chat: ChatAssistantService,
    private readonly history: ChatHistoryService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly confirmation: AiConfirmationService,
    private readonly toolAccess: ToolAccessService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get("history")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(chatHistoryResponseSchema)
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
  @ResponseSchema(chatClearHistoryResponseSchema)
  async clearHistory(@CurrentUser() u: CurrentUserContext): Promise<{ success: boolean }> {
    await this.history.clear(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0);
    return { success: true };
  }

  @Get("conversations")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(listConversationsResponseSchema)
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
  @ResponseSchema(aiConversationSchema)
  @Validate({ body: conversationCreateSchema })
  async createConversation(@Body() body: z.infer<typeof conversationCreateSchema>, @CurrentUser() u: CurrentUserContext) {
    const parsed = conversationCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.history.createConversation(u.orgId, u.userId, actingMembershipId(u.principal) ?? 0, parsed.data.title);
  }

  @Patch("conversations/:conversationId")
  @RequirePermission("ai:chat:use")
  @ResponseSchema(aiConversationSchema)
  @Validate({ params: conversationIdParams, body: conversationRenameSchema })
  async renameConversation(
    @Param("conversationId") conversationIdParam: string,
    @Body() body: z.infer<typeof conversationRenameSchema>,
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
  @ResponseSchema(deleteConversationResponseSchema)
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
  @ResponseSchema(chatHistoryResponseSchema)
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
  @ApiOkResponse({ description: "AI UI message stream", content: { "text/event-stream": { schema: { type: "string" } } } })
  @Validate({ body: chatRequestSchema })
  async chatAssistant(
    @Req() req: Request,
    @Body() body: z.infer<typeof chatRequestSchema>,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");

    const flags = await this.orgFeatures.getFlags(u.orgId);
    if (!flags.aiChat) {
      throw new ForbiddenException("AI chat is disabled for this organization.");
    }

    const abort = createStreamAbortSignal(req, res, CHAT_STREAM_DEADLINE_MS);

    try {
      const result = await this.chat.processChat(
        parsed.data.messages,
        u,
        parsed.data.conversationId,
        parsed.data.persona,
        abort.signal,
      );
      await pipeAiUiMessageStream(res, result, { feature: "ai.chat", orgId: u.orgId });
    } catch (error) {
      rethrowStreamRouteError(error, { route: "POST /chat" });
    } finally {
      abort.dispose();
    }
  }

  @Post("confirm")
  @RequirePermission("ai:chat:use")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("ai:chat")
  @ResponseSchema(confirmActionResponseSchema)
  @Validate({ body: confirmActionBodySchema })
  async confirmAction(@Body() body: z.infer<typeof confirmActionBodySchema>, @CurrentUser() u: CurrentUserContext) {
    const parsed = confirmActionBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");

    const flags = await this.orgFeatures.getFlags(u.orgId);
    if (!flags.aiChat) {
      throw new ForbiddenException("AI chat is disabled for this organization.");
    }

    const confirmed = await this.confirmation.confirm({ token: parsed.data.token, actor: { orgId: u.orgId, userId: u.userId } });
    const { proposalId, action, payload } = confirmed;

    if (!isConfirmableAction(action)) {
      throw new BadRequestException(`Unknown action type: ${action}`);
    }

    const denyReason = await this.toolAccess.denyReason(
      u,
      CONFIRM_ACTION_PERMISSION[action],
    );
    if (denyReason) throw new ForbiddenException(denyReason);

    let result: Record<string, unknown>;
    let summary: string;

    switch (action) {
      case "ticket.create": {
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

      /**
       * Goes through the same service the other eight branches use.
       *
       * The branch used to be a raw `db.update(tickets).set({ status })`, which
       * is not a shortcut to `updateTicket` — it is a different operation.
       * It matched on `(id, org_id)` with no `deleted_at` predicate, so a
       * soft-deleted ticket was updated; it skipped `checkProjectAccess`, so a
       * caller holding `build:tickets:update` but no access to the ticket's
       * project succeeded; it skipped `validateTicketStatus`,
       * `enforceWipLimitForStatus` and `assertTransitionAllowed`, so an unknown
       * status reached the composite FK `fk_tickets_status` as an opaque 500
       * instead of `ProjectsInvalidTicketStatusException`; it left `updated_at`
       * and `version` untouched, so the next optimistic check compared a stale
       * timestamp; and it emitted no `build.ticket.status_changed` outbox row,
       * no activity-log entry, no review notification, no automation run and no
       * `projects:analytics:<org>:<project>` cache eviction — so the analytics
       * panel served the pre-change status until the key expired.
       */
      case "ticket.updateStatus": {
        const parsedStatusUpdate = ticketStatusUpdatePayloadSchema.safeParse(payload);
        if (!parsedStatusUpdate.success)
          throw new BadRequestException("Invalid ticket status update payload");
        const { ticketId, status } = parsedStatusUpdate.data;
        const svc = this.moduleRef.get(ProjectsTicketsService, { strict: false });
        await svc.updateTicket(u, ticketId, { status });
        result = { ticketId, status };
        summary = `Ticket #${ticketId} status updated to ${status}`;
        break;
      }

      case "ticket.addComment": {
        const commentSvc = this.moduleRef.get(ProjectsTicketCommentsService, { strict: false });
        const comment = await commentSvc.addComment(u, Number(payload["ticketId"]), { content: String(payload["comment"]) });
        result = { commentId: comment.id };
        summary = `Comment added to ticket #${String(payload["ticketId"])}`;
        break;
      }

      case "calendar.createReminder": {
        const calSvc = this.moduleRef.get(CalendarService, { strict: false });
        const { event } = await calSvc.createEvent(u.orgId, u.userId, {
          title: String(payload["title"]),
          startDate: String(payload["startDate"]),
          endDate: String(payload["endDate"]),
          timezone: await resolveOrgTimezone(this.db, u.orgId),
          description: payload["description"] !== undefined ? String(payload["description"]) : undefined,
          category: "reminder",
          color: "blue",
        });
        result = { eventId: event?.id };
        summary = `Reminder created: ${String(payload["title"])}`;
        break;
      }

      case "email.send": {
        const emailSvc = this.moduleRef.get(EmailOutboxService, { strict: false });
        const bodyText = String(payload["body"]);
        await emailSvc.enqueueAndTry({
          to: String(payload["toEmail"]),
          subject: String(payload["subject"]),
          html: `<p>${escapeHtml(bodyText)}</p>`,
          text: bodyText,
        });
        result = { queued: true };
        summary = `Email sent to ${String(payload["toEmail"])}`;
        break;
      }

      case "chat.postChannel": {
        const msgSvc = this.moduleRef.get(ChatMessagesService, { strict: false });
        await msgSvc.send(Number(payload["channelId"]), u.userId, u.orgId, { content: String(payload["message"]) });
        result = { sent: true };
        summary = `Message posted to #${String(payload["channelName"])}`;
        break;
      }

      case "hr.grantRecognition": {
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
        const mailPayload = mailSendPayloadSchema.parse(payload);
        const mailAccountsSvc = this.moduleRef.get(MailAccountsService, { strict: false });
        await mailAccountsSvc.assertOwnedConnection(u.orgId, u.userId, mailPayload.accountId);
        const mailSvc = this.moduleRef.get(MailComposeService, { strict: false });
        await mailSvc.sendMail(
          u.orgId,
          u.userId,
          mailPayload.accountId,
          [mailPayload.toEmail],
          mailPayload.subject,
          `<p>${escapeHtml(mailPayload.body)}</p>`,
        );
        result = { sent: true };
        summary = `Email sent to ${mailPayload.toEmail}`;
        break;
      }

      case "self.applyLeave": {
        const leaveInput = createLeaveSchema.parse({
          leaveTypeId: Number(payload["leaveTypeId"]),
          startDate: String(payload["startDate"]),
          endDate: String(payload["endDate"]),
          reason: payload["reason"] !== null && payload["reason"] !== undefined ? String(payload["reason"]) : undefined,
        });
        const leaveSvc = this.moduleRef.get(LeavesWriteService, { strict: false });
        const leaveOutcome = await leaveSvc.create(u, leaveInput);
        result = { success: leaveOutcome.success };
        summary = `Leave request submitted from ${leaveInput.startDate} to ${leaveInput.endDate}`;
        break;
      }

      case "self.submitExpense": {
        const expenseInput = createExpenseSchema.parse({
          category: String(payload["category"]),
          amount: Number(payload["amount"]),
          description: payload["description"] !== null && payload["description"] !== undefined ? String(payload["description"]) : undefined,
          expenseDate: String(payload["date"]),
        });
        const expenseSvc = this.moduleRef.get(ExpensesWriteService, { strict: false });
        const expense = await expenseSvc.create(u.orgId, u.userId, expenseInput);
        result = { expenseId: expense.id };
        summary = `Expense submitted: ${expenseInput.category} — ${expenseInput.amount}`;
        break;
      }

      case "self.logTimesheet": {
        const entrySvc = this.moduleRef.get(EntriesService, { strict: false });
        const entry = await entrySvc.createEntry(u, {
          date: String(payload["date"]),
          hours: Number(payload["hours"]),
          projectId: payload["projectId"] !== null && payload["projectId"] !== undefined ? Number(payload["projectId"]) : undefined,
          description: payload["description"] !== null && payload["description"] !== undefined ? String(payload["description"]) : undefined,
        });
        result = { entryId: entry.id };
        summary = `Logged ${String(payload["hours"])}h on ${String(payload["date"])}`;
        break;
      }

      case "self.submitReferral": {
        const candidateName = String(payload["candidateName"]);
        const spaceIdx = candidateName.indexOf(" ");
        const firstName = spaceIdx === -1 ? candidateName : candidateName.slice(0, spaceIdx);
        const lastName = spaceIdx === -1 ? "" : candidateName.slice(spaceIdx + 1);
        const referralSvc = this.moduleRef.get(RecruitmentSourcingService, { strict: false });
        const referral = await referralSvc.createReferral(
          u.orgId,
          u.userId,
          {
            firstName,
            lastName,
            email: String(payload["candidateEmail"]),
            jobPostingId: payload["jobPostingId"] !== null && payload["jobPostingId"] !== undefined ? Number(payload["jobPostingId"]) : undefined,
            notes: payload["notes"] !== null && payload["notes"] !== undefined ? String(payload["notes"]) : undefined,
          },
          actingMembershipId(u.principal),
        );
        result = { referralId: referral?.id };
        summary = `Referral submitted for ${candidateName}`;
        break;
      }

      case "crm.createLead": {
        const leadInput = createLeadSchema.parse({
          name: String(payload["name"]),
          email: payload["email"] !== undefined ? String(payload["email"]) : undefined,
          phone: payload["phone"] !== undefined ? String(payload["phone"]) : undefined,
          company: payload["company"] !== undefined ? String(payload["company"]) : undefined,
          notes: payload["notes"] !== undefined ? String(payload["notes"]) : undefined,
        });
        const leadsSvc = this.moduleRef.get(LeadsService, { strict: false });
        const leadResult = await leadsSvc.create(u.orgId, u.userId, leadInput);
        if ("error" in leadResult) throw new BadRequestException(leadResult.error);
        result = { leadId: leadResult.id };
        summary = `Lead created: ${String(payload["name"])}`;
        break;
      }

      case "crm.logActivity": {
        const rawLeadId = Number(payload["leadIdentifier"]);
        if (isNaN(rawLeadId) || rawLeadId <= 0) throw new BadRequestException("leadIdentifier must be a numeric lead ID");
        const activitySvc = this.moduleRef.get(LeadsDetailService, { strict: false });
        const activity = await activitySvc.addActivity(u.orgId, u.userId, rawLeadId, {
          type: String(payload["type"]),
          date: payload["dueDate"] !== undefined ? String(payload["dueDate"]) : new Date().toISOString(),
          notes: payload["notes"] !== undefined ? String(payload["notes"]) : undefined,
        });
        result = { activityId: activity?.id };
        summary = `Activity logged on lead #${rawLeadId}`;
        break;
      }

      case "ticket.assign": {
        const assignSvc = this.moduleRef.get(ProjectsTicketsService, { strict: false });
        await assignSvc.updateTicket(u, Number(payload["ticketId"]), { assigneeId: String(payload["assigneeId"]) });
        result = { ticketId: Number(payload["ticketId"]), assigneeId: String(payload["assigneeId"]) };
        summary = `Ticket #${String(payload["ticketId"])} assigned to ${String(payload["assigneeName"])}`;
        break;
      }

      case "ticket.moveToSprint": {
        const sprintSvc = this.moduleRef.get(ProjectsTicketsService, { strict: false });
        await sprintSvc.updateTicket(u, Number(payload["ticketId"]), { sprintId: Number(payload["sprintId"]) });
        result = { ticketId: Number(payload["ticketId"]), sprintId: Number(payload["sprintId"]) };
        summary = `Ticket #${String(payload["ticketId"])} moved to sprint "${String(payload["sprintName"])}"`;
        break;
      }

      case "calendar.createEvent": {
        const calEventSvc = this.moduleRef.get(CalendarService, { strict: false });
        const { event } = await calEventSvc.createEvent(u.orgId, u.userId, {
          title: String(payload["title"]),
          startDate: String(payload["startDate"]),
          endDate: String(payload["endDate"]),
          timezone: String(payload["timezone"]),
          description: payload["description"] !== undefined ? String(payload["description"]) : undefined,
          category: "general",
        });
        result = { eventId: event?.id };
        summary = `Event created: ${String(payload["title"])}`;
        break;
      }

      case "mail.reply": {
        const replyAccountsSvc = this.moduleRef.get(MailAccountsService, { strict: false });
        const accounts = await replyAccountsSvc.listAccounts(u.orgId, u.userId);
        const accountEmail = payload["accountEmail"] !== undefined ? String(payload["accountEmail"]) : undefined;
        const account = accountEmail
          ? accounts.find((a) => a.accountEmail === accountEmail)
          : (accounts.find((a) => a.isPrimary) ?? accounts[0]);
        if (!account) throw new BadRequestException("No connected mail account found");
        const threadId = String(payload["threadId"]);
        const bodyText = String(payload["body"]);
        const replySvc = this.moduleRef.get(MailComposeService, { strict: false });
        await replySvc.replyMail(u.orgId, u.userId, account.id, threadId, threadId, `<p>${escapeHtml(bodyText)}</p>`);
        result = { sent: true };
        summary = `Reply sent to thread ${threadId}`;
        break;
      }

      case "calendar.scheduleMeeting": {
        const meeting = scheduleMeetingPayloadSchema.parse(payload);
        const meetingSvc = this.moduleRef.get(CalendarService, { strict: false });
        const { event } = await meetingSvc.createEvent(u.orgId, u.userId, {
          title: meeting.title,
          startDate: meeting.startDate,
          endDate: meeting.endDate,
          timezone: meeting.timezone,
          attendeeIds: meeting.attendeeIds,
          location: meeting.location,
          description: meeting.description,
          category: "meeting",
          color: "blue",
        });
        result = { eventId: event?.id, attendees: meeting.attendeeIds.length };
        summary = `Meeting scheduled: ${meeting.title}`;
        break;
      }

      case "chat.sendDirect": {
        const direct = sendDirectMessagePayloadSchema.parse(payload);
        const channelsSvc = this.moduleRef.get(ChatChannelsService, { strict: false });
        const { channel } = await channelsSvc.createChannel(u.orgId, u.userId, {
          type: "DIRECT",
          targetUserId: direct.targetUserId,
        });
        const directSvc = this.moduleRef.get(ChatMessagesService, { strict: false });
        await directSvc.send(channel.id, u.userId, u.orgId, { content: direct.message });
        result = { sent: true, channelId: channel.id };
        summary = `Direct message sent`;
        break;
      }

      default: {
        throw new BadRequestException(`Unknown action type: ${String(action satisfies never)}`);
      }
    }

    await this.confirmation.markExecuted(proposalId, result, u.orgId);
    return { ok: true, result, summary };
  }
}
