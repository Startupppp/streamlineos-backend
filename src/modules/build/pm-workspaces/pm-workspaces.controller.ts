import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
import { PmWorkspacesService } from "./pm-workspaces.service";
import { PmWorkspaceMembershipsService } from "./pm-workspace-memberships.service";
import {
  addWorkspaceMemberSchema,
  createWorkspaceSchema,
  listMembersQuerySchema,
  listWorkspacesQuerySchema,
  updateWorkspaceSchema,
  type AddWorkspaceMemberInput,
  type CreateWorkspaceInput,
  type ListMembersQuery,
  type ListWorkspacesQuery,
  type UpdateWorkspaceInput,
} from "./dto/pm-workspaces.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const pmWorkspaceIdParams = z.object({ pmWorkspaceId: z.string().min(1) }).strict();
const pmWorkspaceIdpmWorkspaceMembershipIdParams = z.object({ pmWorkspaceId: z.string().min(1), pmWorkspaceMembershipId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("product-management/workspaces")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PmWorkspacesController {
  constructor(
    private readonly svc: PmWorkspacesService,
    private readonly memberships: PmWorkspaceMembershipsService,
  ) {}

  @Get()
  @RequirePermission("build:workspaces:view")
  @Validate({ query: listWorkspacesQuerySchema })
  listWorkspaces(
    @Query() query: ListWorkspacesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listWorkspaces(u.orgId, query);
  }

  @Get(":pmWorkspaceId")
  @RequirePermission("build:workspaces:view")
  @Validate({ params: pmWorkspaceIdParams })
  getWorkspace(
    @Param("pmWorkspaceId") pmWorkspaceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.getWorkspace(u.orgId, pmWorkspaceId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:workspaces:create")
  @Validate({ body: createWorkspaceSchema })
  createWorkspace(
    @Body() body: CreateWorkspaceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createWorkspace(u.orgId, u.userId, body);
  }

  @Patch(":pmWorkspaceId")
  @RequirePermission("build:workspaces:update")
  @Validate({ params: pmWorkspaceIdParams, body: updateWorkspaceSchema })
  updateWorkspace(
    @Param("pmWorkspaceId") pmWorkspaceId: string,
    @Body() body: UpdateWorkspaceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateWorkspace(u.orgId, u.userId, pmWorkspaceId, body);
  }

  @Delete(":pmWorkspaceId")
  @HttpCode(204)
  @RequirePermission("build:workspaces:delete")
  @Validate({ params: pmWorkspaceIdParams })
  deleteWorkspace(
    @Param("pmWorkspaceId") pmWorkspaceId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deleteWorkspace(u.orgId, u.userId, pmWorkspaceId);
  }

  @Get(":pmWorkspaceId/members")
  @RequirePermission("build:workspaces:members:view")
  @Validate({ params: pmWorkspaceIdParams, query: listMembersQuerySchema })
  listMembers(
    @Param("pmWorkspaceId") pmWorkspaceId: string,
    @Query() query: ListMembersQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.memberships.listMembers(u.orgId, pmWorkspaceId, query);
  }

  @Post(":pmWorkspaceId/members")
  @HttpCode(201)
  @RequirePermission("build:workspaces:members:manage")
  @Validate({ params: pmWorkspaceIdParams, body: addWorkspaceMemberSchema })
  addMember(
    @Param("pmWorkspaceId") pmWorkspaceId: string,
    @Body() body: AddWorkspaceMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.memberships.addMember(u.orgId, u.userId, pmWorkspaceId, body);
  }

  @Delete(":pmWorkspaceId/members/:pmWorkspaceMembershipId")
  @HttpCode(200)
  @RequirePermission("build:workspaces:members:manage")
  @Validate({ params: pmWorkspaceIdpmWorkspaceMembershipIdParams })
  removeMember(
    @Param("pmWorkspaceId") pmWorkspaceId: string,
    @Param("pmWorkspaceMembershipId") pmWorkspaceMembershipId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.memberships.removeMember(u.orgId, u.userId, pmWorkspaceId, pmWorkspaceMembershipId);
  }
}
