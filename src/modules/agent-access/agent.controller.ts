import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Public } from "../../common/auth/public.decorator";
import { AgentTokenGuard } from "./agent-token.guard";
import { AgentAccessService } from "./agent-access.service";
import { ProjectsService } from "../build/core/projects.service";
import { ProjectsTicketsService } from "../build/core/projects-tickets.service";
import { ProjectsWorkQueryService } from "../build/core/projects-work-query.service";
import { ProjectsTicketSubresourcesService } from "../build/core/projects-ticket-subresources.service";
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
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const ticketIdParams = z.object({ ticketId: z.coerce.number().int().positive() }).strict();

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
  @RequirePermission("build:view")
  getMe(@CurrentUser() u: CurrentUserContext) {
    return { userId: u.userId, orgId: u.orgId };
  }

  @Get("projects")
  @RequirePermission("build:view")
  listProjects(
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsSvc.listProjects(u, query);
  }

  @Post("projects")
  @RequirePermission("build:create")
  @HttpCode(201)
  createProject(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsSvc.createProject(u.orgId, u.userId, body);
  }

  @Post("projects/:projectId/tickets")
  @RequirePermission("build:tickets:create")
  @HttpCode(201)
  @Validate({ params: projectIdParams })
  createTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsSvc.createTicket(u, projectId, body);
  }

  @Get("work")
  @RequirePermission("build:tickets:view")
  getAllWork(
    @Query(new ZodValidationPipe(allWorkQuerySchema)) query: AllWorkQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workQuerySvc.getAllWork(u, query);
  }

  @Get("projects/:projectId/tickets")
  @RequirePermission("build:tickets:view")
  @Validate({ params: projectIdParams })
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(ticketsListQuerySchema)) query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsSvc.listTickets(u, projectId, query);
  }

  @Get("tickets/:ticketId")
  @RequirePermission("build:tickets:view")
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
  @Validate({ params: ticketIdParams })
  async updateTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(agentUpdateTicketSchema)) body: AgentUpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ticketsSvc.updateTicket(u, ticketId, { status: body.status, expectedUpdatedAt: body.expectedUpdatedAt });
  }

  @Post("tickets/:ticketId/comments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @Validate({ params: ticketIdParams })
  async addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(agentCommentSchema)) body: AgentCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresourcesSvc.addComment(u, ticketId, { content: body.body });
  }
}
