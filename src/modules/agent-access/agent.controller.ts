import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Public } from "../../common/auth/public.decorator";
import { AgentTokenGuard } from "./agent-token.guard";
import { AgentAccessService } from "./agent-access.service";
import { ProjectsService } from "../projects/projects.service";
import { ProjectsTicketsService } from "../projects/projects-tickets.service";
import { ProjectsWorkQueryService } from "../projects/projects-work-query.service";
import { ProjectsTicketSubresourcesService } from "../projects/projects-ticket-subresources.service";
import { listProjectsSchema, type ListProjectsInput } from "../projects/dto/projects.schemas";
import { allWorkQuerySchema, ticketsListQuerySchema, type AllWorkQuery, type TicketsListQuery } from "../projects/dto/projects.schemas";
import { agentCommentSchema, agentUpdateTicketSchema, type AgentCommentInput, type AgentUpdateTicketInput } from "./dto/agent-tokens.schemas";

@Public()
@Controller("agent/v1")
@UseGuards(AgentTokenGuard, PermissionGuard)
export class AgentController {
  constructor(
    private readonly agentSvc: AgentAccessService,
    private readonly projectsSvc: ProjectsService,
    private readonly ticketsSvc: ProjectsTicketsService,
    private readonly workQuerySvc: ProjectsWorkQueryService,
    private readonly subresourcesSvc: ProjectsTicketSubresourcesService,
  ) {}

  @Get("me")
  @RequirePermission("projects:view")
  getMe(@CurrentUser() u: CurrentUserContext) {
    return { userId: u.userId, orgId: u.orgId };
  }

  @Get("projects")
  @RequirePermission("projects:view")
  listProjects(
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsSvc.listProjects(u, query);
  }

  @Get("work")
  @RequirePermission("projects:tickets:view")
  getAllWork(
    @Query(new ZodValidationPipe(allWorkQuerySchema)) query: AllWorkQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workQuerySvc.getAllWork(u, query);
  }

  @Get("projects/:projectId/tickets")
  @RequirePermission("projects:tickets:view")
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(ticketsListQuerySchema)) query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsSvc.listTickets(u, projectId, query);
  }

  @Get("tickets/:ticketId")
  @RequirePermission("projects:tickets:view")
  async getTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.agentSvc.resolveTicketOrgScoped(u.orgId, ticketId);
    return this.agentSvc.getTicketDetail(u.orgId, ticketId);
  }

  @Patch("tickets/:ticketId")
  @RequirePermission("projects:tickets:update")
  async updateTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(agentUpdateTicketSchema)) body: AgentUpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsSvc.updateTicket(u, ticketId, { status: body.status, expectedUpdatedAt: body.expectedUpdatedAt });
  }

  @Post("tickets/:ticketId/comments")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  async addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(agentCommentSchema)) body: AgentCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresourcesSvc.addComment(u, ticketId, { content: body.body });
  }
}
