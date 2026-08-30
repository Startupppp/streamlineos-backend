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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TeamsService } from "./teams.service";
import {
  addTeamMemberSchema,
  createTeamSchema,
  listTeamMembersQuerySchema,
  listTeamsQuerySchema,
  updateTeamMemberRoleSchema,
  updateTeamSchema,
  addTeamProjectSchema,
  type AddTeamMemberInput,
  type AddTeamProjectInput,
  type CreateTeamInput,
  type ListTeamMembersQuery,
  type ListTeamsQuery,
  type UpdateTeamInput,
  type UpdateTeamMemberRoleInput,
} from "./dto/teams.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const teamIdParams = z.object({ teamId: z.coerce.number().int().positive() }).strict();
const teamIdmemberUserIdParams = z.object({ teamId: z.coerce.number().int().positive(), memberUserId: z.string().min(1) }).strict();
const teamIdmemberIdParams = z.object({ teamId: z.coerce.number().int().positive(), memberId: z.string().min(1) }).strict();
const teamIdprojectIdParams = z.object({ teamId: z.coerce.number().int().positive(), projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/teams")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TeamsController {
  constructor(private readonly svc: TeamsService) {}

  @Get()
  @RequirePermission("build:teams:view")
  @Validate({ query: listTeamsQuerySchema })
  listTeams(
    @Query() query: ListTeamsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listTeams(u.orgId, query);
  }

  @Get(":teamId")
  @RequirePermission("build:teams:view")
  @Validate({ params: teamIdParams })
  getTeam(
    @Param("teamId", ParseIntPipe) teamId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getTeam(u.orgId, teamId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:teams:create")
  @Validate({ body: createTeamSchema })
  createTeam(
    @Body() body: CreateTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createTeam(u.orgId, u.userId, body);
  }

  @Patch(":teamId")
  @RequirePermission("build:teams:update")
  @Validate({ params: teamIdParams, body: updateTeamSchema })
  updateTeam(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Body() body: UpdateTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateTeam(u.orgId, u.userId, teamId, body);
  }

  @Delete(":teamId")
  @HttpCode(204)
  @RequirePermission("build:teams:delete")
  @Validate({ params: teamIdParams })
  deleteTeam(
    @Param("teamId", ParseIntPipe) teamId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteTeam(u.orgId, u.userId, teamId);
  }

  @Get(":teamId/members")
  @RequirePermission("build:teams:view")
  @Validate({ params: teamIdParams, query: listTeamMembersQuerySchema })
  listTeamMembers(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Query() query: ListTeamMembersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listTeamMembers(u.orgId, teamId, query);
  }

  @Post(":teamId/members")
  @HttpCode(201)
  @RequirePermission("build:teams:manage")
  @Validate({ params: teamIdParams, body: addTeamMemberSchema })
  addMember(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Body() body: AddTeamMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addMember(u.orgId, u.userId, teamId, body);
  }

  @Patch(":teamId/members/:memberUserId")
  @RequirePermission("build:teams:manage")
  @Validate({ params: teamIdmemberUserIdParams, body: updateTeamMemberRoleSchema })
  updateMemberRole(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Param("memberUserId") memberUserId: string,
    @Body() body: UpdateTeamMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateMemberRole(
      u.orgId,
      u.userId,
      teamId,
      memberUserId,
      body,
    );
  }

  @Delete(":teamId/members/:memberId")
  @HttpCode(204)
  @RequirePermission("build:teams:manage")
  @Validate({ params: teamIdmemberIdParams })
  removeMember(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Param("memberId") memberId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.removeMember(u.orgId, u.userId, teamId, memberId);
  }

  @Get(":teamId/projects")
  @RequirePermission("build:teams:view")
  @Validate({ params: teamIdParams })
  listTeamProjects(
    @Param("teamId", ParseIntPipe) teamId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listTeamProjects(u.orgId, teamId);
  }

  @Post(":teamId/projects")
  @HttpCode(201)
  @RequirePermission("build:teams:manage")
  @Validate({ params: teamIdParams, body: addTeamProjectSchema })
  addProject(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Body() body: AddTeamProjectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.addProject(u.orgId, u.userId, teamId, body.projectId);
  }

  @Delete(":teamId/projects/:projectId")
  @HttpCode(204)
  @RequirePermission("build:teams:manage")
  @Validate({ params: teamIdprojectIdParams })
  removeProject(
    @Param("teamId", ParseIntPipe) teamId: number,
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.removeProject(u.orgId, u.userId, teamId, projectId);
  }
}
