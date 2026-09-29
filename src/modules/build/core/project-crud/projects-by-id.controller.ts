import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ParseResourceIdPipe } from "../../../../common/pipes/parse-resource-id.pipe";
import { Validate } from "../../../../common/validation/validate.decorator";
import { ProjectsQueryService } from "./projects-query.service";
import { ProjectsWriteService } from "./projects-write.service";
import { ProjectsRestoreService } from "./projects-restore.service";
import {
  linkManagedProductSchema,
  updateProjectSchema,
  type LinkManagedProductInput,
  type UpdateProjectInput,
} from "../dto/projects.schemas";
import { projectIdParams } from "../dto/build-params.schemas";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { buildRestoreResultSchema, linkManagedProductResultSchema } from "../dto/build-core-response.schemas";
import { projectDetailSchema } from "../dto/build-project-detail-response.schemas";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsByIdController {
  constructor(
    private readonly projectsQuery: ProjectsQueryService,
    private readonly projectsWrite: ProjectsWriteService,
    private readonly projectsRestore: ProjectsRestoreService,
  ) {}

  @Get(":projectId")
  @RequirePermission("build:view")
  @ResponseSchema(projectDetailSchema)
  @Validate({ params: projectIdParams })
  getProject(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsQuery.getProject(u, projectId);
  }

  @Patch(":projectId")
  @RequirePermission("build:update")
  @ResponseSchema(projectDetailSchema)
  @Validate({ params: projectIdParams, body: updateProjectSchema })
  updateProject(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @Body() body: UpdateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsWrite.updateProject(u, projectId, body);
  }

  @Delete(":projectId")
  @RequirePermission("build:delete")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdParams })
  deleteProject(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsWrite.deleteProject(u, projectId);
  }

  @Post(":projectId/restore")
  @BodylessAction()
  @RequirePermission("build:restore")
  @HttpCode(200)
  @ResponseSchema(buildRestoreResultSchema)
  @Validate({ params: projectIdParams })
  restoreProject(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsRestore.restoreProject(u, projectId);
  }

  @Patch(":projectId/managed-product")
  @RequirePermission("build:managed-products:update")
  @ResponseSchema(linkManagedProductResultSchema)
  @Validate({ params: projectIdParams, body: linkManagedProductSchema })
  linkManagedProduct(
    @Param("projectId", ParseResourceIdPipe) projectId: number,
    @Body() body: LinkManagedProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsWrite.linkProjectToManagedProduct(u, projectId, body);
  }
}
