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
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ProjectsService } from "./projects.service";
import { ProjectsMembersService } from "./projects-members.service";
import {
  addMemberSchema,
  createLabelSchema,
  createProjectSchema,
  createStateSchema,
  fromDealSchema,
  listProjectsSchema,
  removeMemberSchema,
  updateCustomStateSchema,
  updateLabelSchema,
  updateProjectMemberRoleSchema,
  type AddMemberInput,
  type CreateLabelInput,
  type CreateProjectInput,
  type CreateStateInput,
  type FromDealInput,
  type ListProjectsInput,
  type RemoveMemberInput,
  type UpdateCustomStateInput,
  type UpdateLabelInput,
  type UpdateProjectMemberRoleInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectsMembersService,
  ) {}

  @Get()
  @RequirePermission("build:view")
  listProjects(
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.listProjects(u, query);
  }

  @Post()
  @RequirePermission("build:create")
  @HttpCode(201)
  @Idempotent("build.project.create")
  createProject(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.createProject(u.orgId, u.userId, body);
  }

  @Post("from-deal")
  @RequirePermission("build:create")
  @HttpCode(201)
  @Idempotent("build.project.create_from_deal")
  createFromDeal(
    @Body(new ZodValidationPipe(fromDealSchema)) body: FromDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.createFromDeal(u.orgId, u.userId, body);
  }

  @Get("labels")
  @RequirePermission("build:view")
  listLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post("labels")
  @RequirePermission("build:manage")
  @HttpCode(201)
  createLabel(
    @Body(new ZodValidationPipe(createLabelSchema)) body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Patch("labels/:labelId")
  @RequirePermission("build:manage")
  updateLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @Body(new ZodValidationPipe(updateLabelSchema)) body: UpdateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateLabel(u.orgId, labelId, body);
  }

  @Delete("labels/:labelId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  deleteLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteLabel(u.orgId, labelId);
  }

  @Get(":projectId/members")
  @RequirePermission("build:view")
  listMembers(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listMembers(u, projectId);
  }

  @Get(":projectId/roster")
  @RequirePermission("build:view")
  getRoster(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.getProjectRoster(u, projectId);
  }

  @Post(":projectId/members")
  @RequirePermission("build:view")
  @HttpCode(201)
  addMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.addMember(projectId, body, u);
  }

  @Delete(":projectId/members")
  @RequirePermission("build:view")
  @HttpCode(204)
  removeMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(removeMemberSchema)) body: RemoveMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.removeMember(projectId, body.userId, u);
  }

  @Patch(":projectId/members/:memberUserId")
  @RequirePermission("build:view")
  updateMemberRole(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("memberUserId") memberUserId: string,
    @Body(new ZodValidationPipe(updateProjectMemberRoleSchema))
    body: UpdateProjectMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateMemberRole(projectId, memberUserId, body, u);
  }

  @Get(":projectId/custom-states")
  @RequirePermission("build:view")
  listCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listCustomStates(u, projectId);
  }

  @Post(":projectId/custom-states")
  @RequirePermission("build:view")
  @HttpCode(201)
  createCustomState(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createStateSchema)) body: CreateStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createCustomState(u, projectId, body);
  }

  @Patch(":projectId/custom-states/:stateId")
  @RequirePermission("build:view")
  updateCustomState(
    @Param("projectId", ParseIntPipe) _projectId: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @Body(new ZodValidationPipe(updateCustomStateSchema))
    body: UpdateCustomStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateCustomState(u, stateId, body);
  }

  @Delete(":projectId/custom-states/:stateId")
  @RequirePermission("build:view")
  @HttpCode(204)
  deleteCustomState(
    @Param("projectId", ParseIntPipe) _projectId: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteCustomState(u, stateId);
  }

  @Get(":projectId/labels")
  @RequirePermission("build:view")
  listProjectLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post(":projectId/labels")
  @RequirePermission("build:manage")
  @HttpCode(201)
  createProjectLabel(
    @Body(new ZodValidationPipe(createLabelSchema)) body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }
}
