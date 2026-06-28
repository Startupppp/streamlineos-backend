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
  updateProjectSchema,
  type AddMemberInput,
  type CreateLabelInput,
  type CreateProjectInput,
  type CreateStateInput,
  type FromDealInput,
  type ListProjectsInput,
  type RemoveMemberInput,
  type UpdateProjectInput,
} from "./dto/projects.schemas";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectsMembersService,
  ) {}

  @Get()
  listProjects(
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.listProjects(u, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:create")
  @HttpCode(201)
  createProject(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.createProject(u.orgId, u.userId, body);
  }

  @Post("from-deal")
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:create")
  @HttpCode(201)
  createFromDeal(
    @Body(new ZodValidationPipe(fromDealSchema)) body: FromDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.createFromDeal(u.orgId, u.userId, body);
  }

  @Get("labels")
  listLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post("labels")
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createLabel(
    @Body(new ZodValidationPipe(createLabelSchema)) body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Get(":projectId/members")
  listMembers(@Param("projectId", ParseIntPipe) projectId: number) {
    return this.members.listMembers(projectId);
  }

  @Post(":projectId/members")
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:manage")
  @HttpCode(201)
  addMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
  ) {
    return this.members.addMember(projectId, body);
  }

  @Delete(":projectId/members")
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:manage")
  removeMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(removeMemberSchema)) body: RemoveMemberInput,
  ) {
    return this.members.removeMember(projectId, body.userId);
  }

  @Get(":projectId/custom-states")
  listCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listCustomStates(u.orgId, projectId);
  }

  @Post(":projectId/custom-states")
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createCustomState(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createStateSchema)) body: CreateStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createCustomState(u.orgId, projectId, body);
  }

  @Get(":projectId/labels")
  listProjectLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post(":projectId/labels")
  @UseGuards(PermissionGuard)
  @RequirePermission("projects:manage")
  @HttpCode(201)
  createProjectLabel(
    @Body(new ZodValidationPipe(createLabelSchema)) body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Get(":projectId")
  getProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.getProject(u, projectId);
  }

  @Patch(":projectId")
  updateProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.updateProject(u, projectId, body);
  }

  @Delete(":projectId")
  deleteProject(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projects.deleteProject(u, projectId);
  }
}
