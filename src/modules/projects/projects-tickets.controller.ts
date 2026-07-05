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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
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
  searchTicketsQuerySchema,
  ticketsListQuerySchema,
  updateCommentSchema,
  updateTicketSchema,
  type AddLabelInput,
  type AddRelationInput,
  type AddWatcherInput,
  type AttachmentInput,
  type BulkUpdateInput,
  type CommentInput,
  type CreateTicketInput,
  type ReorderInput,
  type SearchTicketsQuery,
  type TicketsListQuery,
  type UpdateCommentInput,
  type UpdateTicketInput,
} from "./dto/projects.schemas";
import {
  createChecklistSchema,
  updateChecklistSchema,
  createChecklistItemSchema,
  updateChecklistItemSchema,
  type CreateChecklistInput,
  type UpdateChecklistInput,
  type CreateChecklistItemInput,
  type UpdateChecklistItemInput,
} from "./dto/checklist.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketsController {
  constructor(
    private readonly tickets: ProjectsTicketsService,
    private readonly subresources: ProjectsTicketSubresourcesService,
  ) {}

  @Get("search/tickets")
  @RequirePermission("projects:tickets:view")
  searchTickets(
    @Query(new ZodValidationPipe(searchTicketsQuerySchema)) query: SearchTicketsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.searchOrgTickets(u.orgId, u.userId, query.q, query.limit);
  }

  @Get("my-work")
  @RequirePermission("projects:tickets:view")
  getMyWork(@CurrentUser() u: CurrentUserContext) {
    return this.tickets.getMyWork(u.orgId, u.userId);
  }

  @Get(":projectId/tickets")
  @RequirePermission("projects:tickets:view")
  listTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query(new ZodValidationPipe(ticketsListQuerySchema)) query: TicketsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.listTickets(u, projectId, query);
  }

  @Post(":projectId/tickets")
  @RequirePermission("projects:tickets:create")
  @HttpCode(201)
  createTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createTicketSchema)) body: CreateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.createTicket(u, projectId, body);
  }

  @Post(":projectId/tickets/bulk")
  @RequirePermission("projects:tickets:update")
  @HttpCode(200)
  bulkUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(bulkUpdateSchema)) body: BulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.bulkUpdate(u, projectId, body);
  }

  @Patch(":projectId/tickets/reorder")
  @RequirePermission("projects:tickets:update")
  reorder(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(reorderSchema)) body: ReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.reorder(u.orgId, projectId, body);
  }

  @Get(":projectId/tickets/:ticketId/activity")
  @RequirePermission("projects:tickets:view")
  getActivity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getActivity(u.orgId, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/comments")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(commentSchema)) body: CommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addComment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("projects:tickets:view")
  getComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getComment(u, projectId, ticketId, commentId);
  }

  @Patch(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("projects:tickets:update")
  editComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body(new ZodValidationPipe(updateCommentSchema)) body: UpdateCommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.editComment(u, projectId, ticketId, commentId, body.content);
  }

  @Delete(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("projects:tickets:update")
  @HttpCode(204)
  deleteComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteComment(u, projectId, ticketId, commentId);
  }

  @Get(":projectId/tickets/:ticketId/subtasks")
  @RequirePermission("projects:tickets:view")
  getSubtasks(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getSubtasks(u.orgId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/relations")
  @RequirePermission("projects:tickets:view")
  listRelations(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.listRelations(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/relations")
  @RequirePermission("projects:tickets:update")
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
  @RequirePermission("projects:tickets:update")
  removeRelation(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("relatedId") relatedId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeRelation(u, projectId, ticketId, Number(relatedId));
  }

  @Get(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("projects:tickets:view")
  getWatchers(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getWatchers(u.orgId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  addWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addWatcherSchema)) body: AddWatcherInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addWatcher(u, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("projects:tickets:update")
  removeWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeWatcher(u, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/labels")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  addLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addLabelSchema)) body: AddLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addLabel(u.orgId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/labels/:labelId")
  @RequirePermission("projects:tickets:update")
  removeLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeLabel(u.orgId, ticketId, labelId);
  }

  @Post(":projectId/tickets/:ticketId/attachments")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  addAttachment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(attachmentSchema)) body: AttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addAttachment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/git-links")
  @RequirePermission("projects:tickets:view")
  getGitLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getGitLinks(u.orgId, projectId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/checklists")
  @RequirePermission("projects:tickets:view")
  getChecklists(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getChecklists(u.orgId, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/checklists")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  createChecklist(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(createChecklistSchema)) body: CreateChecklistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.createChecklist(u.orgId, projectId, ticketId, body);
  }

  @Patch(":projectId/tickets/:ticketId/checklists/:checklistId")
  @RequirePermission("projects:tickets:update")
  updateChecklist(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @Body(new ZodValidationPipe(updateChecklistSchema)) body: UpdateChecklistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateChecklist(u.orgId, checklistId, body);
  }

  @Delete(":projectId/tickets/:ticketId/checklists/:checklistId")
  @RequirePermission("projects:tickets:update")
  @HttpCode(204)
  deleteChecklist(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteChecklist(u.orgId, checklistId);
  }

  @Post(":projectId/tickets/:ticketId/checklists/:checklistId/items")
  @RequirePermission("projects:tickets:update")
  @HttpCode(201)
  createChecklistItem(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @Body(new ZodValidationPipe(createChecklistItemSchema)) body: CreateChecklistItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.createChecklistItem(u.orgId, checklistId, body);
  }

  @Patch(":projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId")
  @RequirePermission("projects:tickets:update")
  updateChecklistItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(updateChecklistItemSchema)) body: UpdateChecklistItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateChecklistItem(u.orgId, itemId, body);
  }

  @Delete(":projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId")
  @RequirePermission("projects:tickets:update")
  @HttpCode(204)
  deleteChecklistItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteChecklistItem(u.orgId, itemId);
  }

  @Get(":projectId/tickets/:ticketId")
  @RequirePermission("projects:tickets:view")
  getTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u, ticketId);
  }

  @Patch(":projectId/tickets/:ticketId")
  @RequirePermission("projects:tickets:update")
  updateTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(updateTicketSchema)) body: UpdateTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.updateTicket(u.orgId, u.userId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId")
  @RequirePermission("projects:tickets:delete")
  deleteTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("force") force: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.deleteTicket(u.orgId, u.userId, ticketId, force === "true");
  }

  @Post(":projectId/tickets/:ticketId/comments/:commentId/reactions")
  @RequirePermission("projects:tickets:update")
  @HttpCode(200)
  addReaction(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: { emoji: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addReaction(commentId, u.userId, u.orgId, body.emoji);
  }

  @Delete(":projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji")
  @RequirePermission("projects:tickets:update")
  @HttpCode(204)
  removeReaction(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Param("emoji") emoji: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeReaction(commentId, u.userId, emoji);
  }
}
