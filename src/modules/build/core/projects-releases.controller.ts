import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsReleasesService } from "./projects-releases.service";
import {
  createReleaseSchema,
  orgListReleasesQuerySchema,
  updateReleaseSchema,
  addReleaseTicketSchema,
  listReleasesQuerySchema,
  type CreateReleaseInput,
  type OrgListReleasesQuery,
  type UpdateReleaseInput,
  type AddReleaseTicketInput,
  type ListReleasesQuery,
} from "./dto/releases.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  projectReleaseListPageSchema,
  projectReleaseRowSchema,
} from "./dto/build-core-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdreleaseIdParams = z.object({ projectId: z.coerce.number().int().positive(), releaseId: z.coerce.number().int().positive() }).strict();
const projectIdreleaseIdticketIdParams = z.object({ projectId: z.coerce.number().int().positive(), releaseId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsReleasesController {
  constructor(private readonly releases: ProjectsReleasesService) {}

  @Get("releases")
  @RequirePermission("build:view")
  @ResponseSchema(projectReleaseListPageSchema)
  @Validate({ query: orgListReleasesQuerySchema })
  listOrgReleases(
    @Query() query: OrgListReleasesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.listOrgReleases(u, query);
  }

  @Get(":projectId/releases")
  @RequirePermission("build:view")
  @ResponseSchema(projectReleaseListPageSchema)
  @Validate({ params: projectIdParams, query: listReleasesQuerySchema })
  listReleases(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListReleasesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.listReleases(u, projectId, query);
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
    return this.releases.createRelease(u, projectId, body);
  }

  @Patch(":projectId/releases/:releaseId")
  @RequirePermission("build:manage")
  @ResponseSchema(projectReleaseRowSchema)
  @Validate({ params: projectIdreleaseIdParams, body: updateReleaseSchema })
  updateRelease(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Body() body: UpdateReleaseInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.updateRelease(u, projectId, releaseId, body);
  }

  @Delete(":projectId/releases/:releaseId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdreleaseIdParams })
  deleteRelease(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.deleteRelease(u, projectId, releaseId);
  }

  @Post(":projectId/releases/:releaseId/tickets")
  @RequirePermission("build:tickets:update")
  @HttpCode(200)
  @ResponseSchema(successSchema)
  @Validate({ params: projectIdreleaseIdParams, body: addReleaseTicketSchema })
  addTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Body() body: AddReleaseTicketInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.addTicketToRelease(u, projectId, releaseId, body.ticketId);
  }

  @Delete(":projectId/releases/:releaseId/tickets/:ticketId")
  @RequirePermission("build:tickets:update")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdreleaseIdticketIdParams })
  removeTicket(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("releaseId", ParseIntPipe) releaseId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.releases.removeTicketFromRelease(u, projectId, releaseId, ticketId);
  }
}
