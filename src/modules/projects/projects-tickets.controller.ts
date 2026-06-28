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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProjectsTicketsService } from "./projects-tickets.service";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import {
  addLabelSchema,
  addRelationSchema,
  addWatcherSchema,
  attachmentSchema,
  bulkUpdateSchema,
  commentSchema,
  createTicketSchema,
  reorderSchema,
  ticketsListQuerySchema,
  updateTicketSchema,
  type AddLabelInput,
  type AddRelationInput,
  type AddWatcherInput,
  type AttachmentInput,
  type BulkUpdateInput,
  type CommentInput,
  type CreateTicketInput,
  type ReorderInput,
  type TicketsListQuery,
  type UpdateTicketInput,
} from "./dto/projects.schemas";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsTicketsController {
  constructor(
    private readonly tickets: ProjectsTicketsService,
    private readonly subresources: ProjectsTicketSubresourcesService,
  ) {}

  @Get(":projectId/tickets")
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(ticketsListQuerySchema)) query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTickets(u, projectId, query);
  }

  @Post(":projectId/tickets")
  @HttpCode(201)
  createTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u, projectId, body);
  }

  @Post(":projectId/tickets/bulk")
  @HttpCode(200)
  bulkUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(bulkUpdateSchema)) body: BulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.bulkUpdate(u, projectId, body);
  }

  @Patch(":projectId/tickets/reorder")
  reorder(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(reorderSchema)) body: ReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.reorder(u.orgId, projectId, body);
  }

  @Get(":projectId/tickets/:ticketId/activity")
  getActivity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getActivity(u.orgId, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/comments")
  @HttpCode(201)
  addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(commentSchema)) body: CommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addComment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/subtasks")
  getSubtasks(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getSubtasks(u.orgId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/relations")
  listRelations(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.listRelations(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/relations")
  @HttpCode(201)
  addRelation(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addRelationSchema)) body: AddRelationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addRelation(u, projectId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/relations")
  removeRelation(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("relatedId") relatedId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeRelation(u, projectId, ticketId, Number(relatedId));
  }

  @Get(":projectId/tickets/:ticketId/watchers")
  getWatchers(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getWatchers(u.orgId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/watchers")
  @HttpCode(201)
  addWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addWatcherSchema)) body: AddWatcherInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addWatcher(u, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/watchers")
  removeWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeWatcher(u, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/labels")
  @HttpCode(201)
  addLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addLabelSchema)) body: AddLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addLabel(u.orgId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/labels/:labelId")
  removeLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeLabel(u.orgId, ticketId, labelId);
  }

  @Post(":projectId/tickets/:ticketId/attachments")
  @HttpCode(201)
  addAttachment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(attachmentSchema)) body: AttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addAttachment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/git-links")
  getGitLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getGitLinks(u.orgId, projectId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId")
  getTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u, ticketId);
  }

  @Patch(":projectId/tickets/:ticketId")
  updateTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u.orgId, u.userId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId")
  deleteTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("force") force: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.deleteTicket(u.orgId, u.userId, ticketId, force === "true");
  }
}
