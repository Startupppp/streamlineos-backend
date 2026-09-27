import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Public } from "../../common/auth/public.decorator";
import { AgentTokenGuard } from "./agent-token.guard";
import { AgentAccessService } from "./agent-access.service";
import { ProjectsQueryService } from "../build/core/projects-query.service";
import { ProjectsProvisionService } from "../build/core/projects-provision.service";
import { ProjectsTicketsService } from "../build/core/tickets/projects-tickets.service";
import { ProjectsTicketsCreateService } from "../build/core/tickets/projects-tickets-create.service";
import { ProjectsTicketsReadService } from "../build/core/tickets/projects-tickets-read.service";
import { ProjectsWorkQueryService } from "../build/core/projects-work-query.service";
import { ProjectsTicketSubresourcesService } from "../build/core/tickets/projects-ticket-subresources.service";
import {
  listProjectsSchema,
  createProjectSchema,
  createTicketSchema,
  allWorkQuerySchema,
  ticketsListQuerySchema,
  type ListProjectsInput,
  type CreateProjectInput,
  type CreateTicketInput,
  type AllWorkQuery,
  type TicketsListQuery,
} from "../build/core/dto/projects.schemas";
import { agentCommentSchema, agentUpdateTicketSchema, type AgentCommentInput, type AgentUpdateTicketInput } from "./dto/agent-tokens.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  agentMeSchema,
  agentTicketDetailSchema,
  allWorkSchema,
  projectRowSchema,
  ticketCommentRowSchema,
  ticketListPageSchema,
  ticketRowSchema,
  updateTicketSchema,
} from "./dto/agent-response.schemas";
import { projectListPageSchema } from "../build/core/dto/build-core-response.schemas";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();

@Public()
@Controller("agent/v1")
@UseGuards(AgentTokenGuard, PermissionGuard)
export class AgentController {
  constructor(
    private readonly agentSvc: AgentAccessService,
    private readonly projectsQuery: ProjectsQueryService,
    private readonly projectsProvision: ProjectsProvisionService,
    private readonly ticketsSvc: ProjectsTicketsService,
    private readonly ticketsCreateSvc: ProjectsTicketsCreateService,
    private readonly ticketsReadSvc: ProjectsTicketsReadService,
    private readonly workQuerySvc: ProjectsWorkQueryService,
    private readonly subresourcesSvc: ProjectsTicketSubresourcesService,
  ) {}

  @Get("me")
  @RequirePermission("build:view")
  @ResponseSchema(agentMeSchema)
  getMe(@CurrentUser() u: CurrentUserContext) {
    return { userId: u.userId, orgId: u.orgId };
  }

  @Get("projects")
  @RequirePermission("build:view")
  @ResponseSchema(projectListPageSchema)
  @Validate({ query: listProjectsSchema })
  listProjects(
    @Query() query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsQuery.listProjects(u, query);
  }

  @Post("projects")
  @RequirePermission("build:create")
  @HttpCode(201)
  @ResponseSchema(projectRowSchema)
  @Validate({ body: createProjectSchema })
  createProject(
    @Body() body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsProvision.createProject(u.orgId, u.userId, body);
  }

  @Post("projects/:projectId/tickets")
  @RequirePermission("build:tickets:create")
  @HttpCode(201)
  @ResponseSchema(ticketRowSchema)
  @Validate({ params: projectIdParams, body: createTicketSchema })
  createTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsCreateSvc.createTicket(u, projectId, body);
  }

  @Get("work")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(allWorkSchema)
  @Validate({ query: allWorkQuerySchema })
  getAllWork(
    @Query() query: AllWorkQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workQuerySvc.getAllWork(u, query);
  }

  @Get("projects/:projectId/tickets")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketListPageSchema)
  @Validate({ params: projectIdParams, query: ticketsListQuerySchema })
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsReadSvc.listTickets(u, projectId, query);
  }

  @Get("tickets/:ticketId")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(agentTicketDetailSchema)
  @Validate({ params: ticketIdParams })
  async getTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.agentSvc.resolveTicketOrgScoped(u.orgId, ticketId);
    return this.agentSvc.getTicketDetail(u.orgId, ticketId);
  }

  @Patch("tickets/:ticketId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(updateTicketSchema)
  @Validate({ params: ticketIdParams, body: agentUpdateTicketSchema })
  async updateTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AgentUpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsSvc.updateTicketFromSystem(u, null, ticketId, {
      status: body.status,
      expectedUpdatedAt: body.expectedUpdatedAt,
    });
  }

  @Post("tickets/:ticketId/comments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(ticketCommentRowSchema)
  @Validate({ params: ticketIdParams, body: agentCommentSchema })
  async addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: AgentCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresourcesSvc.addComment(u, null, ticketId, { content: body.body });
  }
}
