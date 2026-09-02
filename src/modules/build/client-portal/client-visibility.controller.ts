import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ClientVisibilityService } from "./client-visibility.service";
import { toggleVisibilitySchema, type ToggleVisibilityInput } from "./dto/client-portal.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectAndTicketIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();
const projectAndMilestoneIdParams = z.object({ projectId: z.coerce.number().int().positive(), milestoneId: z.coerce.number().int().positive() }).strict();
const projectAndCommentIdParams = z.object({ projectId: z.coerce.number().int().positive(), commentId: z.coerce.number().int().positive() }).strict();
const projectAndAttachmentIdParams = z.object({ projectId: z.coerce.number().int().positive(), attachmentId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/client-visibility")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ClientVisibilityController {
  constructor(private readonly svc: ClientVisibilityService) {}

  @Get()
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectIdParams })
  getVisibilitySummary(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getVisibilitySummary(u, projectId);
  }

  @Patch("tickets/:ticketId")
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectAndTicketIdParams, body: toggleVisibilitySchema })
  toggleTicketVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleTicketVisibility(u.orgId, u.userId, projectId, ticketId, body.clientVisible);
  }

  @Patch("milestones/:milestoneId")
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectAndMilestoneIdParams, body: toggleVisibilitySchema })
  toggleMilestoneVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("milestoneId", ParseIntPipe) milestoneId: number,
    @Body() body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleMilestoneVisibility(u.orgId, u.userId, projectId, milestoneId, body.clientVisible);
  }

  @Patch("comments/:commentId")
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectAndCommentIdParams, body: toggleVisibilitySchema })
  toggleCommentVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("commentId", ParseIntPipe) commentId: number,
    @Body() body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleCommentVisibility(u.orgId, u.userId, projectId, commentId, body.clientVisible);
  }

  @Patch("attachments/:attachmentId")
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectAndAttachmentIdParams, body: toggleVisibilitySchema })
  toggleAttachmentVisibility(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("attachmentId", ParseIntPipe) attachmentId: number,
    @Body() body: ToggleVisibilityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.toggleAttachmentVisibility(u.orgId, u.userId, projectId, attachmentId, body.clientVisible);
  }
}
