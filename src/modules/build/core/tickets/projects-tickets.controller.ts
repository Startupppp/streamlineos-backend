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
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import { ProjectsTicketsCreateService } from "./projects-tickets-create.service";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { ProjectsTicketsDetailService } from "./projects-tickets-detail.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsTicketsDeleteService } from "./projects-tickets-delete.service";
import { ProjectsTicketsRestoreService } from "./projects-tickets-restore.service";
import { ProjectsSearchService } from "../project-crud/projects-search.service";
import { ProjectsWorkQueryService } from "../work-query/projects-work-query.service";
import {
  allWorkQuerySchema,
  bulkUpdateSchema,
  createTicketSchema,
  exportTicketsQuerySchema,
  importTicketsSchema,
  rankTicketSchema,
  searchTicketsQuerySchema,
  ticketActivityQuerySchema,
  ticketsListQuerySchema,
  updateTicketSchema,
  type AllWorkQuery,
  type BulkUpdateInput,
  type CreateTicketInput,
  type ExportTicketsQuery,
  type ImportTicketsInput,
  type RankTicketInput,
  type SearchTicketsQuery,
  type TicketActivityQuery,
  type TicketsListQuery,
  type UpdateTicketInput,
} from "../dto/projects.schemas";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { buildRestoreResultSchema } from "../dto/build-core-response.schemas";
import {
  ticketRowSchema,
  ticketDetailSchema,
  ticketListPageSchema,
  ticketActivityPageSchema,
  allWorkPageSchema,
  columnCountsSchema,
  exportTicketsResultSchema,
  importTicketsResultSchema,
  bulkUpdateResultSchema,
  rankTicketResultSchema,
  ticketUpdateResultSchema,
  ticketSearchResultListSchema,
} from "../dto/build-tickets-response.schemas";
import { projectAndTicketIdParams } from "../dto/build-params.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdticketNumberParams = z.object({ projectId: z.coerce.number().int().positive(), ticketNumber: z.coerce.number().int().positive() }).strict();
const ticketInProjectParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketsController {
  constructor(
    private readonly read: ProjectsTicketsReadService,
    private readonly create: ProjectsTicketsCreateService,
    private readonly update: ProjectsTicketsUpdateService,
    private readonly detail: ProjectsTicketsDetailService,
    private readonly query: ProjectsTicketsQueryService,
    private readonly transfer: ProjectsTicketsTransferService,
    private readonly del: ProjectsTicketsDeleteService,
    private readonly restore: ProjectsTicketsRestoreService,
    private readonly search: ProjectsSearchService,
    private readonly workQuery: ProjectsWorkQueryService,
  ) {}

  @Get("all-work")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(allWorkPageSchema)
  @Validate({ query: allWorkQuerySchema })
  getAllWork(
    @Query() query: AllWorkQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workQuery.getAllWork(u, query);
  }

  @Get("search/tickets")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketSearchResultListSchema)
  @Validate({ query: searchTicketsQuerySchema })
  searchTickets(
    @Query() query: SearchTicketsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.search.searchOrgTickets(u.orgId, u.userId, query.q, query.limit);
  }

  @Get(":projectId/tickets/column-counts")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(columnCountsSchema)
  @Validate({ params: projectIdParams, query: ticketsListQuerySchema })
  getColumnCounts(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.read.getColumnCounts(u, projectId, query);
  }

  @Get(":projectId/tickets/export")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(exportTicketsResultSchema)
  @Validate({ params: projectIdParams, query: exportTicketsQuerySchema })
  exportTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ExportTicketsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfer.exportTickets(u, projectId, query.ticketIds);
  }

  @Post(":projectId/tickets/import")
  @RequirePermission("build:tickets:create")
  @HttpCode(200)
  @ResponseSchema(importTicketsResultSchema)
  @Idempotent("build.ticket.import")
  @Validate({ params: projectIdParams, body: importTicketsSchema })
  importTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: ImportTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.transfer.importTickets(u, projectId, body);
  }

  @Get(":projectId/tickets")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketListPageSchema)
  @Validate({ params: projectIdParams, query: ticketsListQuerySchema })
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.read.listTickets(u, projectId, query);
  }

  @Post(":projectId/tickets")
  @RequirePermission("build:tickets:create")
  @HttpCode(201)
  @ResponseSchema(ticketRowSchema)
  @Idempotent("build.ticket.create")
  @Validate({ params: projectIdParams, body: createTicketSchema })
  createTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.create.createTicket(u, projectId, body);
  }

  @Post(":projectId/tickets/bulk")
  @RequirePermission("build:tickets:update")
  @HttpCode(200)
  @ResponseSchema(bulkUpdateResultSchema)
  @Idempotent("build.ticket.bulk-update")
  @Validate({ params: projectIdParams, body: bulkUpdateSchema })
  bulkUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: BulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.query.bulkUpdate(u, projectId, body);
  }

  @Patch(":projectId/tickets/:ticketId/rank")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(rankTicketResultSchema)
  @Validate({ params: projectAndTicketIdParams, body: rankTicketSchema })
  rankTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: RankTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.query.rankTicket(u, projectId, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/activity")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketActivityPageSchema)
  @Validate({ params: projectAndTicketIdParams, query: ticketActivityQuerySchema })
  getActivity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query() query: TicketActivityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.query.getTicketActivity(u, projectId, ticketId, {
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Get(":projectId/tickets/key/:ticketNumber")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketDetailSchema)
  @Validate({ params: projectIdticketNumberParams })
  getTicketByKey(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketNumber", ParseIntPipe) ticketNumber: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.detail.getTicketByKey(u, projectId, ticketNumber);
  }

  @Get(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketDetailSchema)
  @Validate({ params: ticketInProjectParams })
  getTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.detail.getTicket(u, projectId, ticketId);
  }

  @Patch(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(ticketUpdateResultSchema)
  @Validate({ params: ticketInProjectParams, body: updateTicketSchema })
  updateTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.update.updateTicket(u, projectId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:delete")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: ticketInProjectParams })
  deleteTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("force") force: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.del.deleteTicket(u, projectId, ticketId, force === "true");
  }

  @Post(":projectId/tickets/:ticketId/restore")
  @BodylessAction()
  @RequirePermission("build:tickets:restore")
  @HttpCode(200)
  @ResponseSchema(buildRestoreResultSchema)
  @Validate({ params: ticketInProjectParams })
  restoreTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.restore.restoreTicket(u, projectId, ticketId);
  }
}
