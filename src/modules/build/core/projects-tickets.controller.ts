import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsTicketsService } from "./projects-tickets.service";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import {
  allWorkQuerySchema,
  bulkUpdateSchema,
  createTicketSchema,
  importTicketsSchema,
  rankTicketSchema,
  searchTicketsQuerySchema,
  ticketActivityQuerySchema,
  ticketsListQuerySchema,
  updateTicketSchema,
  type AllWorkQuery,
  type BulkUpdateInput,
  type CreateTicketInput,
  type ImportTicketsInput,
  type RankTicketInput,
  type SearchTicketsQuery,
  type TicketActivityQuery,
  type TicketsListQuery,
  type UpdateTicketInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();
const projectIdticketNumberParams = z.object({ projectId: z.coerce.number().int().positive(), ticketNumber: z.coerce.number().int().positive() }).strict();
const projectIdticketIdParams_ = z.object({ projectId: z.string().min(1), ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketsController {
  constructor(
    private readonly tickets: ProjectsTicketsService,
    private readonly subresources: ProjectsTicketSubresourcesService,
  ) {}

  @Get("all-work")
  @RequirePermission("build:tickets:view")
  getAllWork(
    @Query(new ZodValidationPipe(allWorkQuerySchema)) query: AllWorkQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getAllWork(u, query);
  }

  @Get("search/tickets")
  @RequirePermission("build:tickets:view")
  searchTickets(
    @Query(new ZodValidationPipe(searchTicketsQuerySchema)) query: SearchTicketsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.searchOrgTickets(u.orgId, u.userId, query.q, query.limit);
  }

  @Get(":projectId/tickets/export")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdParams })
  exportTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.exportTickets(u, projectId);
  }

  @Post(":projectId/tickets/import")
  @RequirePermission("build:tickets:create")
  @HttpCode(200)
  @Idempotent("build.ticket.import")
  @Validate({ params: projectIdParams })
  importTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(importTicketsSchema)) body: ImportTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.importTickets(u, projectId, body);
  }

  @Get(":projectId/tickets")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdParams })
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(ticketsListQuerySchema)) query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTickets(u, projectId, query);
  }

  @Post(":projectId/tickets")
  @RequirePermission("build:tickets:create")
  @HttpCode(201)
  @Idempotent("build.ticket.create")
  @Validate({ params: projectIdParams })
  createTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u, projectId, body);
  }

  @Post(":projectId/tickets/bulk")
  @RequirePermission("build:tickets:update")
  @HttpCode(200)
  @Idempotent("build.ticket.bulk-update")
  @Validate({ params: projectIdParams })
  bulkUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(bulkUpdateSchema)) body: BulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.bulkUpdate(u, projectId, body);
  }

  @Patch(":projectId/tickets/:ticketId/rank")
  @RequirePermission("build:tickets:update")
  @Validate({ params: projectIdticketIdParams })
  rankTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(rankTicketSchema)) body: RankTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.rankTicket(u, projectId, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/activity")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdticketIdParams })
  getActivity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query(new ZodValidationPipe(ticketActivityQuerySchema)) query: TicketActivityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getActivity(u.orgId, projectId, ticketId, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Get(":projectId/tickets/key/:ticketNumber")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdticketNumberParams })
  getTicketByKey(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketNumber", ParseIntPipe) ticketNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicketByKey(u, projectId, ticketNumber);
  }

  @Get(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdticketIdParams_ })
  getTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u, ticketId);
  }

  @Patch(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:update")
  @Validate({ params: projectIdticketIdParams_ })
  updateTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:delete")
  @HttpCode(204)
  @Validate({ params: projectIdticketIdParams_ })
  deleteTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("force") force: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.deleteTicket(u.orgId, u.userId, ticketId, force === "true");
  }
}
