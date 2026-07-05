import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProjectsReleasesService } from "./projects-releases.service";
import {
  createReleaseSchema,
  updateReleaseSchema,
  addReleaseTicketSchema,
  type CreateReleaseInput,
  type UpdateReleaseInput,
  type AddReleaseTicketInput,
} from "./dto/releases.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsReleasesController {
  constructor(private readonly releases: ProjectsReleasesService) {}

  @Get(":projectId/releases")
  @RequirePermission("projects:view")
  listReleases(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.listReleases(u.orgId, projectId);
  }

  @Post(":projectId/releases")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createRelease(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createReleaseSchema)) body: CreateReleaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.createRelease(u.orgId, projectId, u.userId, body);
  }

  @Patch(":projectId/releases/:releaseId")
  @RequirePermission("projects:manage")
  updateRelease(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Body(new ZodValidationPipe(updateReleaseSchema)) body: UpdateReleaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.updateRelease(u.orgId, releaseId, body);
  }

  @Delete(":projectId/releases/:releaseId")
  @RequirePermission("projects:manage")
  @HttpCode(204)
  deleteRelease(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.deleteRelease(u.orgId, releaseId);
  }

  @Post(":projectId/releases/:releaseId/tickets")
  @RequirePermission("projects:tickets:update")
  @HttpCode(200)
  addTicket(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Body(new ZodValidationPipe(addReleaseTicketSchema)) body: AddReleaseTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.addTicketToRelease(u.orgId, releaseId, body.ticketId);
  }

  @Delete(":projectId/releases/:releaseId/tickets/:ticketId")
  @RequirePermission("projects:tickets:update")
  @HttpCode(204)
  removeTicket(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.removeTicketFromRelease(u.orgId, releaseId, ticketId);
  }
}
