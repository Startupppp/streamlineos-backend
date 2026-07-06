import {
  Body,
  Controller,
  ForbiddenException,
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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { authorize } from "../access/authorize";
import { SupportTicketsService } from "./support-tickets.service";
import { resolveSupportTicketsViewScope } from "./support-tickets-scope";
import {
  createTicketLinkSchema,
  createTicketSchema,
  listTicketsSchema,
  mergeTicketSchema,
  replyMessageSchema,
  updateTicketSchema,
  type CreateTicketInput,
  type CreateTicketLinkInput,
  type ListTicketsInput,
  type MergeTicketInput,
  type ReplyMessageInput,
  type UpdateTicketInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportTicketsController {
  constructor(
    private readonly tickets: SupportTicketsService,
    private readonly access: AccessService,
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
  getTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u.orgId, supportTicketId);
  }

  @Patch(":supportTicketId")
  @RequirePermission("support:tickets:manage")
  updateTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/messages")
  @RequirePermission("support:tickets:view")
  listMessages(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listMessages(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/messages")
  @RequirePermission("support:tickets:reply")
  @HttpCode(201)
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
  listActivity(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listActivity(u.orgId, supportTicketId);
  }

  @Get(":supportTicketId/links")
  @RequirePermission("support:tickets:view")
  listTicketLinks(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTicketLinks(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/links")
  @RequirePermission("support:tickets:manage")
  @HttpCode(201)
  addTicketLink(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(createTicketLinkSchema)) body: CreateTicketLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.addTicketLink(u.orgId, supportTicketId, u.userId, body);
  }

  @Post(":supportTicketId/merge")
  @RequirePermission("support:tickets:manage")
  @HttpCode(200)
  mergeTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(mergeTicketSchema)) body: MergeTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.mergeTicket(u.orgId, supportTicketId, u.userId, body);
  }
}
