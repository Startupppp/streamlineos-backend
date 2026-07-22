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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProjectsService } from "./projects.service";
import {
  updateProjectSchema,
  type UpdateProjectInput,
} from "./dto/projects.schemas";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsByIdController {
  constructor(private readonly projects: ProjectsService) {}

  @Get(":projectId")
  @RequirePermission("projects:view")
  getProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.getProject(u, projectId);
  }

  @Patch(":projectId")
  @RequirePermission("projects:view")
  updateProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.updateProject(u, projectId, body);
  }

  @Delete(":projectId")
  @RequirePermission("projects:delete")
  @HttpCode(204)
  deleteProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.deleteProject(u, projectId);
  }
}
