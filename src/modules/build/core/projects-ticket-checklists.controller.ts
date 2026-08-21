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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsTicketSubresourcesService } from "./projects-ticket-subresources.service";
import {
  createChecklistItemSchema,
  createChecklistSchema,
  updateChecklistItemSchema,
  updateChecklistSchema,
  type CreateChecklistItemInput,
  type CreateChecklistInput,
  type UpdateChecklistItemInput,
  type UpdateChecklistInput,
} from "./dto/checklist.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketChecklistsController {
  constructor(private readonly subresources: ProjectsTicketSubresourcesService) {}

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
}
