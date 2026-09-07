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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { checklistRowSchema, checklistItemSchema } from "./dto/build-tickets-response.schemas";

const projectIdticketIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdchecklistIdParams = z.object({ projectId: z.string().min(1), ticketId: z.string().min(1), checklistId: z.coerce.number().int().positive() }).strict();
const projectIdticketIdchecklistIditemIdParams = z.object({ projectId: z.string().min(1), ticketId: z.string().min(1), checklistId: z.string().min(1), itemId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsTicketChecklistsController {
  constructor(private readonly subresources: ProjectsTicketSubresourcesService) {}

  @Get(":projectId/tickets/:ticketId/checklists")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(z.array(checklistRowSchema))
  @Validate({ params: projectIdticketIdParams })
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
  @ResponseSchema(checklistRowSchema)
  @Validate({ params: projectIdticketIdParams, body: createChecklistSchema })
  createChecklist(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: CreateChecklistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.createChecklist(u.orgId, projectId, ticketId, body);
  }

  @Patch(":projectId/tickets/:ticketId/checklists/:checklistId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(checklistRowSchema)
  @Validate({ params: projectIdticketIdchecklistIdParams, body: updateChecklistSchema })
  updateChecklist(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @Body() body: UpdateChecklistInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateChecklist(u.orgId, checklistId, body);
  }

  @Delete(":projectId/tickets/:ticketId/checklists/:checklistId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdchecklistIdParams })
  deleteChecklist(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteChecklist(u.orgId, checklistId);
  }

  @Post(":projectId/tickets/:ticketId/checklists/:checklistId/items")
  @RequirePermission("build:tickets:update")
  @HttpCode(201)
  @ResponseSchema(checklistItemSchema)
  @Validate({ params: projectIdticketIdchecklistIdParams, body: createChecklistItemSchema })
  createChecklistItem(
    @Param("checklistId", ParseIntPipe) checklistId: number,
    @Body() body: CreateChecklistItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.createChecklistItem(u.orgId, checklistId, body);
  }

  @Patch(":projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId")
  @RequirePermission("build:tickets:update")
  @ResponseSchema(checklistItemSchema)
  @Validate({ params: projectIdticketIdchecklistIditemIdParams, body: updateChecklistItemSchema })
  updateChecklistItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: UpdateChecklistItemInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.updateChecklistItem(u.orgId, itemId, body);
  }

  @Delete(":projectId/tickets/:ticketId/checklists/:checklistId/items/:itemId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdticketIdchecklistIditemIdParams })
  deleteChecklistItem(
    @Param("itemId", ParseIntPipe) itemId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.subresources.deleteChecklistItem(u.orgId, itemId);
  }
}
