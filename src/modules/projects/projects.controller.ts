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
  updateProjectSchema,
  type AddMemberInput,
  type CreateLabelInput,
  type CreateProjectInput,
  type CreateStateInput,
  type FromDealInput,
  type ListProjectsInput,
  type RemoveMemberInput,
  type UpdateCustomStateInput,
  type UpdateLabelInput,
  type UpdateProjectInput,
} from "./dto/projects.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectsMembersService,
  ) {}

  @Get()
  @RequirePermission("projects:view")
  listProjects(
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.listProjects(u, query);
  }

  @Post()
  @RequirePermission("projects:create")
  @HttpCode(201)
  createProject(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.createProject(u.orgId, u.userId, body);
  }

  @Post("from-deal")
  @RequirePermission("projects:create")
  @HttpCode(201)
  createFromDeal(
    @Body(new ZodValidationPipe(fromDealSchema)) body: FromDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.createFromDeal(u.orgId, u.userId, body);
  }

  @Get("labels")
  @RequirePermission("projects:view")
  listLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post("labels")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createLabel(
    @Body(new ZodValidationPipe(createLabelSchema)) body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Patch("labels/:labelId")
  @RequirePermission("projects:manage")
  updateLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @Body(new ZodValidationPipe(updateLabelSchema)) body: UpdateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateLabel(u.orgId, labelId, body);
  }

  @Delete("labels/:labelId")
  @RequirePermission("projects:manage")
  @HttpCode(204)
  deleteLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteLabel(u.orgId, labelId);
  }

  @Get(":projectId/members")
  @RequirePermission("projects:view")
  listMembers(@Param("projectId", ParseIntPipe) projectId: number) {
    return this.members.listMembers(projectId);
  }

  @Post(":projectId/members")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  addMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.addMember(projectId, body, u.orgId, u.userId);
  }

  @Delete(":projectId/members")
  @RequirePermission("projects:manage")
  removeMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(removeMemberSchema)) body: RemoveMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.removeMember(projectId, body.userId, u.orgId, u.userId);
  }

  @Get(":projectId/custom-states")
  @RequirePermission("projects:view")
  listCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listCustomStates(u.orgId, projectId);
  }

  @Post(":projectId/custom-states")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createCustomState(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createStateSchema)) body: CreateStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createCustomState(u.orgId, projectId, body);
  }

  @Patch(":projectId/custom-states/:stateId")
  @RequirePermission("projects:manage")
  updateCustomState(
    @Param("projectId", ParseIntPipe) _projectId: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @Body(new ZodValidationPipe(updateCustomStateSchema))
    body: UpdateCustomStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateCustomState(u.orgId, stateId, body);
  }

  @Delete(":projectId/custom-states/:stateId")
  @RequirePermission("projects:manage")
  @HttpCode(204)
  deleteCustomState(
    @Param("projectId", ParseIntPipe) _projectId: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteCustomState(u.orgId, stateId);
  }

  @Get(":projectId/labels")
  @RequirePermission("projects:view")
  listProjectLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post(":projectId/labels")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createProjectLabel(
    @Body(new ZodValidationPipe(createLabelSchema)) body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Get(":projectId")
  @RequirePermission("projects:view")
  getProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.getProject(u, projectId);
  }

  @Patch(":projectId")
  @RequirePermission("projects:update")
  updateProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.updateProject(u, projectId, body);
  }

  @Delete(":projectId")
  @RequirePermission("projects:delete")
  deleteProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.deleteProject(u, projectId);
  }
}
