import {
  Body,
  Controller,
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
import { SupportTicketsService } from "./support-tickets.service";
import {
  createTicketSchema,
  listTicketsSchema,
  replyMessageSchema,
  updateTicketSchema,
  type CreateTicketInput,
  type ListTicketsInput,
  type ReplyMessageInput,
  type UpdateTicketInput,
} from "./dto/support.schemas";

@Controller("support")
@UseGuards(JwtAuthGuard)
export class SupportTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get()
  listTickets(
    @Query(new ZodValidationPipe(listTicketsSchema)) query: ListTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTickets(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  createTicket(
    @Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u.orgId, u.userId, body);
  }

  @Get("stats")
  stats(@CurrentUser() u: CurrentUserContext) {
    return this.tickets.stats(u.orgId);
  }

  @Get(":supportTicketId")
  getTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u.orgId, supportTicketId);
  }

  @Patch(":supportTicketId")
  @UseGuards(PermissionGuard)
  @RequirePermission("support:tickets:manage")
  updateTicket(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/messages")
  listMessages(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listMessages(u.orgId, supportTicketId);
  }

  @Post(":supportTicketId/messages")
  @HttpCode(201)
  addMessage(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @Body(new ZodValidationPipe(replyMessageSchema)) body: ReplyMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.addMessage(u.orgId, supportTicketId, u.userId, body);
  }

  @Get(":supportTicketId/activity")
  listActivity(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listActivity(u.orgId, supportTicketId);
  }
}
