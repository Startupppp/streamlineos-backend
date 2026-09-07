import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsReleasesService } from "./projects-releases.service";
import {
  createReleaseSchema,
  updateReleaseSchema,
  addReleaseTicketSchema,
  type CreateReleaseInput,
  type UpdateReleaseInput,
  type AddReleaseTicketInput,
} from "./dto/releases.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  projectReleaseListItemSchema,
  projectReleaseRowSchema,
} from "./dto/build-core-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdreleaseIdParams = z.object({ projectId: z.string().min(1), releaseId: z.coerce.number().int().positive() }).strict();
const projectIdreleaseIdticketIdParams = z.object({ projectId: z.string().min(1), releaseId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsReleasesController {
  constructor(private readonly releases: ProjectsReleasesService) {}

  @Get(":projectId/releases")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(projectReleaseListItemSchema))
  @Validate({ params: projectIdParams })
  listReleases(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.listReleases(u.orgId, projectId);
  }

  @Post(":projectId/releases")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Idempotent("build.release.create")
  @ResponseSchema(projectReleaseRowSchema)
  @Validate({ params: projectIdParams, body: createReleaseSchema })
  createRelease(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateReleaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.createRelease(u.orgId, projectId, u.userId, body);
  }

  @Patch(":projectId/releases/:releaseId")
  @RequirePermission("build:manage")
  @ResponseSchema(projectReleaseRowSchema)
  @Validate({ params: projectIdreleaseIdParams, body: updateReleaseSchema })
  updateRelease(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Body() body: UpdateReleaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.updateRelease(u.orgId, releaseId, body);
  }

  @Delete(":projectId/releases/:releaseId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdreleaseIdParams })
  deleteRelease(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.deleteRelease(u.orgId, releaseId);
  }

  @Post(":projectId/releases/:releaseId/tickets")
  @RequirePermission("build:tickets:update")
  @HttpCode(200)
  @ResponseSchema(successSchema)
  @Validate({ params: projectIdreleaseIdParams, body: addReleaseTicketSchema })
  addTicket(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Body() body: AddReleaseTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.addTicketToRelease(u.orgId, releaseId, body.ticketId);
  }

  @Delete(":projectId/releases/:releaseId/tickets/:ticketId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdreleaseIdticketIdParams })
  removeTicket(
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.removeTicketFromRelease(u.orgId, releaseId, ticketId);
  }
}
