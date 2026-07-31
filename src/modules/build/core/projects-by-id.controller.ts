import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ProjectsService } from "./projects.service";
import {
  linkManagedProductSchema,
  updateProjectSchema,
  type LinkManagedProductInput,
  type UpdateProjectInput,
} from "./dto/projects.schemas";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsByIdController {
  constructor(private readonly projects: ProjectsService) {}

  @Get(":projectId")
  @RequirePermission("build:view")
  getProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.getProject(u, projectId);
  }

  @Patch(":projectId")
  @RequirePermission("build:update")
  updateProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.updateProject(u, projectId, body);
  }

  @Delete(":projectId")
  @RequirePermission("build:delete")
  @HttpCode(204)
  deleteProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.deleteProject(u, projectId);
  }

  @Patch(":projectId/managed-product")
  @RequirePermission("build:managed-products:update")
  linkManagedProduct(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(linkManagedProductSchema))
    body: LinkManagedProductInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.linkProjectToManagedProduct(u, projectId, body);
  }
}
