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
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ProjectsQueryService } from "./projects-query.service";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsMembersService } from "./projects-members.service";
import {
  addMemberSchema,
  bulkReorderStatesSchema,
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
  type BulkReorderStatesInput,
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const labelIdParams = z.object({ labelId: z.coerce.number().int().positive() }).strict();
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdmemberUserIdParams = z.object({ projectId: z.coerce.number().int().positive(), memberUserId: z.string().min(1) }).strict();
const projectIdstateIdParams = z.object({ projectId: z.coerce.number().int().positive(), stateId: z.coerce.number().int().positive() }).strict();
const projectIdParams_ = z.object({ projectId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsController {
  constructor(
    private readonly projectsQuery: ProjectsQueryService,
    private readonly projectsProvision: ProjectsProvisionService,
    private readonly members: ProjectsMembersService,
  ) {}

  @Get()
  @RequirePermission("build:view")
  @Validate({ query: listProjectsSchema })
  listProjects(
    @Query() query: ListProjectsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsQuery.listProjects(u, query);
  }

  @Post()
  @RequirePermission("build:create")
  @HttpCode(201)
  @Idempotent("build.project.create")
  @Validate({ body: createProjectSchema })
  createProject(
    @Body() body: CreateProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsProvision.createProject(u.orgId, u.userId, body);
  }

  @Post("from-deal")
  @RequirePermission("build:create")
  @HttpCode(201)
  @Idempotent("build.project.create_from_deal")
  @Validate({ body: fromDealSchema })
  createFromDeal(
    @Body() body: FromDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.projectsProvision.createFromDeal(u.orgId, u.userId, body);
  }

  @Get("labels")
  @RequirePermission("build:view")
  listLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post("labels")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Validate({ body: createLabelSchema })
  createLabel(
    @Body() body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }

  @Patch("labels/:labelId")
  @RequirePermission("build:manage")
  @Validate({ params: labelIdParams, body: updateLabelSchema })
  updateLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @Body() body: UpdateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateLabel(u.orgId, labelId, body);
  }

  @Delete("labels/:labelId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: labelIdParams })
  deleteLabel(
    @Param("labelId", ParseIntPipe) labelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteLabel(u.orgId, labelId);
  }

  @Get(":projectId/members")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  listMembers(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listMembers(u, projectId);
  }

  @Get(":projectId/roster")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  getRoster(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.getProjectRoster(u, projectId);
  }

  @Post(":projectId/members")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Validate({ params: projectIdParams, body: addMemberSchema })
  addMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.addMember(projectId, body, u);
  }

  @Delete(":projectId/members")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: projectIdParams, body: removeMemberSchema })
  removeMember(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: RemoveMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.removeMember(projectId, body.userId, u);
  }

  @Patch(":projectId/members/:memberUserId")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdmemberUserIdParams, body: updateProjectMemberRoleSchema })
  updateMemberRole(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("memberUserId") memberUserId: string,
    @Body() body: UpdateProjectMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateMemberRole(projectId, memberUserId, body, u);
  }

  @Put(":projectId/custom-states")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdParams, body: bulkReorderStatesSchema })
  bulkReorderCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: BulkReorderStatesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.bulkReorderCustomStates(u, projectId, body);
  }

  @Get(":projectId/custom-states")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  listCustomStates(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listCustomStates(u, projectId);
  }

  @Post(":projectId/custom-states")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Validate({ params: projectIdParams, body: createStateSchema })
  createCustomState(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createCustomState(u, projectId, body);
  }

  @Patch(":projectId/custom-states/:stateId")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdstateIdParams, body: updateCustomStateSchema })
  updateCustomState(
    @Param("projectId", ParseIntPipe) _: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @Body() body: UpdateCustomStateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateCustomState(u, stateId, body);
  }

  @Delete(":projectId/custom-states/:stateId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: projectIdstateIdParams })
  deleteCustomState(
    @Param("projectId", ParseIntPipe) _: number,
    @Param("stateId", ParseIntPipe) stateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.deleteCustomState(u, stateId);
  }

  @Get(":projectId/labels")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams_ })
  listProjectLabels(@CurrentUser() u: CurrentUserContext) {
    return this.members.listLabels(u.orgId);
  }

  @Post(":projectId/labels")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Validate({ params: projectIdParams_, body: createLabelSchema })
  createProjectLabel(
    @Body() body: CreateLabelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.createLabel(u.orgId, body);
  }
}
