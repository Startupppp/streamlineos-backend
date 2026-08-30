import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AccessService } from "../../access/access.service";
import { authorize } from "../../access/authorize";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportDraftsService } from "./support-drafts.service";
import { SupportIntegrationsService } from "./support-integrations.service";
import { resolveSupportTicketsViewScope } from "./support-tickets-scope";
import {
  createExternalLinkSchema,
  createTicketLinkSchema,
  createTicketSchema,
  listTicketsSchema,
  mergeTicketSchema,
  replyMessageSchema,
  snoozeTicketSchema,
  splitTicketSchema,
  updateTicketSchema,
  upsertDraftSchema,
  type CreateExternalLinkInput,
  type CreateTicketInput,
  type CreateTicketLinkInput,
  type ListTicketsInput,
  type MergeTicketInput,
  type ReplyMessageInput,
  type SnoozeTicketInput,
  type SplitTicketInput,
  type UpdateTicketInput,
  type UpsertDraftInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";

const ticketIdParams = z.object({ supportTicketId: z.coerce.number().int().positive() }).strict();
const ticketAndLinkIdParams = z.object({ supportTicketId: z.coerce.number().int().positive(), linkId: z.coerce.number().int().positive() }).strict();

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportTicketsController {
  constructor(
    private readonly tickets: SupportTicketsService,
    private readonly access: AccessService,
    private readonly drafts: SupportDraftsService,
    private readonly integrations: SupportIntegrationsService,
  ) {}

  @Get()
  @RequirePermission("support:tickets:view")
  async listTickets(
    @Query(new ZodValidationPipe(listTicketsSchema)) query: ListTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.listTickets(u.orgId, { ...query, scope, userId: u.userId });
  }

  @Post()
  @Idempotent("support:ticket.create")
  @RequirePermission("support:tickets:create")
  @HttpCode(201)
  createTicket(
    @Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u.orgId, u.userId, body);
  }

  @Get("stats")
  @RequirePermission("support:tickets:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.tickets.stats(u.orgId);
  }

  @Get(":supportTicketId")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  getTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u.orgId, supportTicketId);
  }

  @Patch(":supportTicketId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: ticketIdParams })
  updateTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/messages")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  listMessages(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listMessages(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/messages")
  @Idempotent("support:ticket.reply")
  @RequirePermission("support:tickets:reply")
  @HttpCode(201)
  @Validate({ params: ticketIdParams })
  async addMessage(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(replyMessageSchema)) body: ReplyMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.isInternal) {
      const result = await authorize(this.access, u, "support:tickets:internal_note");
      if (!result.allow) throw new ForbiddenException("Permission denied");
    }
    return this.tickets.addMessage(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/activity")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  listActivity(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listActivity(u.orgId, supportTicketId);
  }

  @Get(":supportTicketId/links")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  listTicketLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTicketLinks(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: ticketIdParams })
  addTicketLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(createTicketLinkSchema)) body: CreateTicketLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.addTicketLink(u.orgId, supportTicketId, u.userId, body);
  }

  @Post(":supportTicketId/merge")
  @Idempotent("support:ticket.merge")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  mergeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(mergeTicketSchema)) body: MergeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.mergeTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Post(":supportTicketId/snooze")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: ticketIdParams })
  snoozeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(snoozeTicketSchema)) body: SnoozeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.snoozeTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Delete(":supportTicketId/snooze")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: ticketIdParams })
  unsnoozeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.unsnoozeTicket(u.orgId, supportTicketId, u.userId);
  }

  @Post(":supportTicketId/split")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: ticketIdParams })
  splitTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(splitTicketSchema)) body: SplitTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.splitTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/draft")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  getDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.drafts.getDraft(u.orgId, supportTicketId, u.userId);
  }

  @Put(":supportTicketId/draft")
  @RequirePermission("support:tickets:reply")
  @Validate({ params: ticketIdParams })
  upsertDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(upsertDraftSchema)) body: UpsertDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.drafts.upsertDraft(u.orgId, supportTicketId, u.userId, body);
  }

  @Delete(":supportTicketId/draft")
  @RequirePermission("support:tickets:reply")
  @Validate({ params: ticketIdParams })
  deleteDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.drafts.deleteDraft(u.orgId, supportTicketId, u.userId);
  }

  @Get(":supportTicketId/external-links")
  @RequirePermission("support:tickets:view")
  @Validate({ params: ticketIdParams })
  listExternalLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.listLinks(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/external-links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: ticketIdParams })
  addExternalLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(createExternalLinkSchema)) body: CreateExternalLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.addLink(u.orgId, supportTicketId, u.userId, body);
  }

  @Delete(":supportTicketId/external-links/:linkId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: ticketAndLinkIdParams })
  removeExternalLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.removeLink(u.orgId, supportTicketId, linkId);
  }
}
