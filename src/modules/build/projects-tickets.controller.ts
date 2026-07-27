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
  addReactionSchema,
  addRelationSchema,
  removeRelationQuerySchema,
  addWatcherSchema,
  allWorkQuerySchema,
  attachmentSchema,
  bulkUpdateSchema,
  commentSchema,
  addRelatedLinkSchema,
  createTicketSchema,
  importTicketsSchema,
  reorderSchema,
  searchTicketsQuerySchema,
  ticketActivityQuerySchema,
  ticketsListQuerySchema,
  updateCommentSchema,
  updateRelatedLinkSchema,
  updateTicketSchema,
  type AddLabelInput,
  type AddReactionInput,
  type AddRelatedLinkInput,
  type RemoveRelationQuery,
  type AddRelationInput,
  type AddWatcherInput,
  type AllWorkQuery,
  type AttachmentInput,
  type BulkUpdateInput,
  type CommentInput,
  type CreateTicketInput,
  type ImportTicketsInput,
  type ReorderInput,
  type SearchTicketsQuery,
  type TicketActivityQuery,
  type TicketsListQuery,
  type UpdateCommentInput,
  type UpdateRelatedLinkInput,
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

  @Get("my-work")
  @RequirePermission("build:tickets:view")
  getMyWork(@CurrentUser() u: CurrentUserContext) {
    return this.tickets.getMyWork(u.orgId, u.userId);
  }

  @Get(":projectId/tickets/export")
  @RequirePermission("build:tickets:view")
  exportTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.exportTickets(u, projectId);
  }

  @Post(":projectId/tickets/import")
  @RequirePermission("build:tickets:create")
  @HttpCode(200)
  importTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(importTicketsSchema)) body: ImportTicketsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.importTickets(u, projectId, body);
  }

  @Get(":projectId/tickets")
  @RequirePermission("build:tickets:view")
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
  bulkUpdate(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(bulkUpdateSchema)) body: BulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.bulkUpdate(u, projectId, body);
  }

  @Patch(":projectId/tickets/reorder")
  @RequirePermission("build:tickets:update")
  reorder(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(reorderSchema)) body: ReorderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.reorder(u, projectId, body);
  }

  @Get(":projectId/tickets/:ticketId/activity")
  @RequirePermission("build:tickets:view")
  getActivity(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query(new ZodValidationPipe(ticketActivityQuerySchema)) query: TicketActivityQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getActivity(u.orgId, projectId, ticketId, {
      limit: query.limit,
      before: query.before,
    });
  }

  @Post(":projectId/tickets/:ticketId/comments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  addComment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(commentSchema)) body: CommentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addComment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("build:tickets:view")
  getComment(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getComment(u, projectId, ticketId, commentId);
  }

  @Patch(":projectId/tickets/:ticketId/comments/:commentId")
  @RequirePermission("build:tickets:update")
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
  @RequirePermission("build:tickets:update")
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
  @RequirePermission("build:tickets:view")
  getSubtasks(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getSubtasks(u.orgId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/relations")
  @RequirePermission("build:tickets:view")
  listRelations(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.listRelations(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/relations")
  @RequirePermission("build:tickets:update")
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
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  removeRelation(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query(new ZodValidationPipe(removeRelationQuerySchema)) query: RemoveRelationQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeRelation(u, projectId, ticketId, query.relatedId);
  }

  @Get(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:view")
  getWatchers(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getWatchers(u.orgId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  addWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addWatcherSchema)) body: AddWatcherInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addWatcher(u, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/watchers")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  removeWatcher(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeWatcher(u, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/labels")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  addLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addLabelSchema)) body: AddLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addLabel(u.orgId, u.userId, ticketId, body);
  }

  @Delete(":projectId/tickets/:ticketId/labels/:labelId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  removeLabel(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeLabel(u.orgId, u.userId, ticketId, labelId);
  }

  @Post(":projectId/tickets/:ticketId/attachments")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  addAttachment(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(attachmentSchema)) body: AttachmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addAttachment(u, ticketId, body);
  }

  @Get(":projectId/tickets/:ticketId/git-links")
  @RequirePermission("build:tickets:view")
  getGitLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getGitLinks(u.orgId, projectId, ticketId);
  }

  @Get(":projectId/tickets/:ticketId/checklists")
  @RequirePermission("build:tickets:view")
  getChecklists(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.getChecklists(u.orgId, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/checklists")
  @RequirePermission("build:tickets:update")
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
  @RequirePermission("build:tickets:update")
  updateChecklist(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @Body(new ZodValidationPipe(updateChecklistSchema)) body: UpdateChecklistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateChecklist(u.orgId, checklistId, body);
  }

  @Delete(":projectId/tickets/:ticketId/checklists/:checklistId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  deleteChecklist(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteChecklist(u.orgId, checklistId);
  }

  @Post(":projectId/tickets/:ticketId/checklists/:checklistId/items")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  createChecklistItem(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @Body(new ZodValidationPipe(createChecklistItemSchema)) body: CreateChecklistItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.createChecklistItem(u.orgId, checklistId, body);
  }

  @Patch(":projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId")
  @RequirePermission("build:tickets:update")
  updateChecklistItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body(new ZodValidationPipe(updateChecklistItemSchema)) body: UpdateChecklistItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateChecklistItem(u.orgId, itemId, body);
  }

  @Delete(":projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  deleteChecklistItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteChecklistItem(u.orgId, itemId);
  }

  @Get(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:view")
  getTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.getTicket(u, ticketId);
  }

  @Patch(":projectId/tickets/:ticketId")
  @RequirePermission("build:tickets:update")
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
  deleteTicket(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query("force") force: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.tickets.deleteTicket(u.orgId, u.userId, ticketId, force === "true");
  }

  @Post(":projectId/tickets/:ticketId/comments/:commentId/reactions")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  addReaction(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body(new ZodValidationPipe(addReactionSchema)) body: AddReactionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addReaction(commentId, u.userId, u.orgId, body.emoji);
  }

  @Delete(":projectId/tickets/:ticketId/comments/:commentId/reactions/:emoji")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  removeReaction(
    @Param("commentId", ParseIntPipe) commentId: number,
    @Param("emoji") emoji: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.removeReaction(commentId, u.userId, u.orgId, emoji);
  }

  @Get(":projectId/tickets/:ticketId/related-links")
  @RequirePermission("build:tickets:view")
  listRelatedLinks(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.listRelatedLinks(u, projectId, ticketId);
  }

  @Post(":projectId/tickets/:ticketId/related-links")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  addRelatedLink(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(addRelatedLinkSchema)) body: AddRelatedLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.addRelatedLink(u, projectId, ticketId, body);
  }

  @Patch(":projectId/tickets/:ticketId/related-links/:linkId")
  @RequirePermission("build:tickets:update")
  updateRelatedLink(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @Body(new ZodValidationPipe(updateRelatedLinkSchema)) body: UpdateRelatedLinkInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateRelatedLink(u, projectId, ticketId, linkId, body);
  }

  @Delete(":projectId/tickets/:ticketId/related-links/:linkId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  deleteRelatedLink(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Param("linkId", ParseIntPipe) linkId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteRelatedLink(u, projectId, ticketId, linkId);
  }
}
