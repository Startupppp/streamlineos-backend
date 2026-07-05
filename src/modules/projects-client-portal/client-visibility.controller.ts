import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ClientVisibilityService } from "./client-visibility.service";
import { toggleVisibilitySchema, type ToggleVisibilityInput } from "./dto/client-portal.schemas";

@RequireModule("projects")
@Controller("projects/:projectId/client-visibility")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ClientVisibilityController {
  constructor(private readonly svc: ClientVisibilityService) {}

  @Get()
  @RequirePermission("projects:clientvisibility:manage")
  getVisibilitySummary(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getVisibilitySummary(u.orgId, projectId);
  }

  @Patch("tickets/:ticketId")
  @RequirePermission("projects:clientvisibility:manage")
  toggleTicketVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(toggleVisibilitySchema)) body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleTicketVisibility(u.orgId, u.userId, projectId, ticketId, body.clientVisible);
  }

  @Patch("milestones/:milestoneId")
  @RequirePermission("projects:clientvisibility:manage")
  toggleMilestoneVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @Body(new ZodValidationPipe(toggleVisibilitySchema)) body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleMilestoneVisibility(u.orgId, u.userId, projectId, milestoneId, body.clientVisible);
  }

  @Patch("comments/:commentId")
  @RequirePermission("projects:clientvisibility:manage")
  toggleCommentVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body(new ZodValidationPipe(toggleVisibilitySchema)) body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleCommentVisibility(u.orgId, u.userId, projectId, commentId, body.clientVisible);
  }

  @Patch("attachments/:attachmentId")
  @RequirePermission("projects:clientvisibility:manage")
  toggleAttachmentVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @Body(new ZodValidationPipe(toggleVisibilitySchema)) body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleAttachmentVisibility(u.orgId, u.userId, projectId, attachmentId, body.clientVisible);
  }
}
