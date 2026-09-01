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
import { actingMembershipId } from "../../../common/auth/principal";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const supportTicketIdParams = z.object({ supportTicketId: z.coerce.number().int().positive() }).strict();
const supportTicketIdlinkIdParams = z.object({ supportTicketId: z.coerce.number().int().positive(), linkId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listTicketsSchema })
  async listTickets(
    @Query() query: ListTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.listTickets(u.orgId, { ...query, scope, userId: u.userId });
  }

  @Post()
  @Idempotent("support:ticket.create")
  @RequirePermission("support:tickets:create")
  @HttpCode(201)
  @Validate({ body: createTicketSchema })
  createTicket(
    @Body() body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u.orgId, u.userId, body, undefined, actingMembershipId(u.principal));
  }

  @Get("stats")
  @RequirePermission("support:tickets:view")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.tickets.stats(u.orgId);
  }

  @Get(":supportTicketId")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  async getTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.getTicket(u.orgId, supportTicketId, { userId: u.userId, scope });
  }

  @Patch(":supportTicketId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: supportTicketIdParams, body: updateTicketSchema })
  updateTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/messages")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
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
  @Validate({ params: supportTicketIdParams, body: replyMessageSchema })
  async addMessage(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: ReplyMessageInput,
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
  @Validate({ params: supportTicketIdParams })
  listActivity(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listActivity(u.orgId, supportTicketId);
  }

  @Get(":supportTicketId/links")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  listTicketLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTicketLinks(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: createTicketLinkSchema })
  addTicketLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: CreateTicketLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.addTicketLink(u.orgId, supportTicketId, u.userId, body);
  }

  @Post(":supportTicketId/merge")
  @Idempotent("support:ticket.merge")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: supportTicketIdParams, body: mergeTicketSchema })
  mergeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: MergeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.mergeTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Post(":supportTicketId/snooze")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: supportTicketIdParams, body: snoozeTicketSchema })
  snoozeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: SnoozeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.snoozeTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Delete(":supportTicketId/snooze")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: supportTicketIdParams })
  unsnoozeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.unsnoozeTicket(u.orgId, supportTicketId, u.userId);
  }

  @Post(":supportTicketId/split")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: splitTicketSchema })
  splitTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: SplitTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.splitTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/draft")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  getDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.drafts.getDraft(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal));
  }

  @Put(":supportTicketId/draft")
  @RequirePermission("support:tickets:reply")
  @Validate({ params: supportTicketIdParams, body: upsertDraftSchema })
  upsertDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: UpsertDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.drafts.upsertDraft(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal), body);
  }

  @Delete(":supportTicketId/draft")
  @RequirePermission("support:tickets:reply")
  @Validate({ params: supportTicketIdParams })
  deleteDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.drafts.deleteDraft(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal));
  }

  @Get(":supportTicketId/external-links")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  listExternalLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.listLinks(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/external-links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: createExternalLinkSchema })
  addExternalLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: CreateExternalLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.addLink(u.orgId, supportTicketId, u.userId, body);
  }

  @Delete(":supportTicketId/external-links/:linkId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: supportTicketIdlinkIdParams })
  removeExternalLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.integrations.removeLink(u.orgId, supportTicketId, linkId);
  }
}
