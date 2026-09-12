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
import { AuthCtx } from "../../../common/auth/auth-context.decorator";
import type { AuthContext } from "../../../common/auth/auth-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { authorize } from "../../access/authorize";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportDraftsService } from "./support-drafts.service";
import { SupportIntegrationsService } from "./support-integrations.service";
import {
  resolveSupportTicketsManageScope,
  resolveSupportTicketsReplyScope,
  resolveSupportTicketsViewScope,
} from "./support-tickets-scope";
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  supportTicketListSchema,
  createTicketResultSchema,
  ticketStatsSchema,
  supportTicketDetailSchema,
  updateTicketResultSchema,
  supportTicketMessageListSchema,
  supportTicketMessageRowSchema,
  supportTicketActivityListSchema,
  supportTicketLinkListSchema,
  addTicketLinkResultSchema,
  mergeTicketResultSchema,
  snoozeTicketResultSchema,
  supportTicketDraftSchema,
  supportTicketExternalLinkListSchema,
  addExternalLinkResultSchema,
  successSchema,
} from "./dto/support-ticket-response.schemas";

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
  @ResponseSchema(supportTicketListSchema)
  async listTickets(
    @Query() query: ListTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.listTickets(u.orgId, { ...query, read });
  }

  @Post()
  @Idempotent("support:ticket.create")
  @RequirePermission("support:tickets:create")
  @HttpCode(201)
  @Validate({ body: createTicketSchema })
  @ResponseSchema(createTicketResultSchema)
  createTicket(
    @Body() body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u.orgId, u.userId, body, undefined, actingMembershipId(u.principal));
  }

  @Get("stats")
  @RequirePermission("support:tickets:view")
  @ResponseSchema(ticketStatsSchema)
  async stats(@CurrentUser() u: CurrentUserContext) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.stats(read);
  }

  @Get(":supportTicketId")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(supportTicketDetailSchema)
  async getTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.getTicket(u.orgId, supportTicketId, read);
  }

  @Patch(":supportTicketId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: supportTicketIdParams, body: updateTicketSchema })
  @ResponseSchema(updateTicketResultSchema)
  async updateTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.tickets.updateTicket(u.orgId, supportTicketId, u.userId, body, read);
  }

  @Get(":supportTicketId/messages")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(supportTicketMessageListSchema)
  async listMessages(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.listMessages(u.orgId, supportTicketId, read);
  }

  @Post(":supportTicketId/messages")
  @Idempotent("support:ticket.reply")
  @RequirePermission("support:tickets:reply")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: replyMessageSchema })
  @ResponseSchema(supportTicketMessageRowSchema)
  async addMessage(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: ReplyMessageInput,
    @CurrentUser() u: CurrentUserContext,
    @AuthCtx() authCtx: AuthContext,
  ) {
    if (body.isInternal) {
      const result = await authorize(this.access, authCtx, "support:tickets:internal_note");
      if (!result.allow) throw new ForbiddenException("Permission denied");
    }
    const read = await resolveSupportTicketsReplyScope(this.access, u);
    return this.tickets.replyAsAgent(u.orgId, supportTicketId, u.userId, body, read);
  }

  @Get(":supportTicketId/activity")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(supportTicketActivityListSchema)
  async listActivity(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.listActivity(u.orgId, supportTicketId, read);
  }

  @Get(":supportTicketId/links")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(supportTicketLinkListSchema)
  async listTicketLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.tickets.listTicketLinks(u.orgId, supportTicketId, read);
  }

  @Post(":supportTicketId/links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: createTicketLinkSchema })
  @ResponseSchema(addTicketLinkResultSchema)
  async addTicketLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: CreateTicketLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.tickets.addTicketLink(u.orgId, supportTicketId, u.userId, body, read);
  }

  @Post(":supportTicketId/merge")
  @Idempotent("support:ticket.merge")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: supportTicketIdParams, body: mergeTicketSchema })
  @ResponseSchema(mergeTicketResultSchema)
  async mergeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: MergeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.tickets.mergeTicket(u.orgId, supportTicketId, u.userId, body, read);
  }

  @Post(":supportTicketId/snooze")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  @Validate({ params: supportTicketIdParams, body: snoozeTicketSchema })
  @ResponseSchema(snoozeTicketResultSchema)
  async snoozeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: SnoozeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.tickets.snoozeTicket(u.orgId, supportTicketId, u.userId, body, read);
  }

  @Delete(":supportTicketId/snooze")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(successSchema)
  async unsnoozeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.tickets.unsnoozeTicket(u.orgId, supportTicketId, u.userId, read);
  }

  @Post(":supportTicketId/split")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: splitTicketSchema })
  @ResponseSchema(createTicketResultSchema)
  async splitTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: SplitTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.tickets.splitTicket(
      u.orgId,
      supportTicketId,
      u.userId,
      body,
      read,
      actingMembershipId(u.principal),
    );
  }

  @Get(":supportTicketId/draft")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(supportTicketDraftSchema.nullable())
  async getDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.drafts.getDraft(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal), read);
  }

  @Put(":supportTicketId/draft")
  @RequirePermission("support:tickets:reply")
  @Validate({ params: supportTicketIdParams, body: upsertDraftSchema })
  @ResponseSchema(supportTicketDraftSchema)
  async upsertDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: UpsertDraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsReplyScope(this.access, u);
    return this.drafts.upsertDraft(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal), body, read);
  }

  @Delete(":supportTicketId/draft")
  @RequirePermission("support:tickets:reply")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(successSchema)
  async deleteDraft(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsReplyScope(this.access, u);
    return this.drafts.deleteDraft(u.orgId, supportTicketId, u.userId, actingMembershipId(u.principal), read);
  }

  @Get(":supportTicketId/external-links")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(supportTicketExternalLinkListSchema)
  async listExternalLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsViewScope(this.access, u);
    return this.integrations.listLinks(u.orgId, supportTicketId, read);
  }

  @Post(":supportTicketId/external-links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  @Validate({ params: supportTicketIdParams, body: createExternalLinkSchema })
  @ResponseSchema(addExternalLinkResultSchema)
  async addExternalLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body() body: CreateExternalLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.integrations.addLink(u.orgId, supportTicketId, u.userId, body, read);
  }

  @Delete(":supportTicketId/external-links/:linkId")
  @RequirePermission("support:tickets:manage")
  @Validate({ params: supportTicketIdlinkIdParams })
  @ResponseSchema(successSchema)
  async removeExternalLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const read = await resolveSupportTicketsManageScope(this.access, u);
    return this.integrations.removeLink(u.orgId, supportTicketId, linkId, read);
  }
}
