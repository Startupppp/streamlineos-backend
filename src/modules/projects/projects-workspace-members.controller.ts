import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UsersService } from "../users/users.service";
import {
  listWorkspaceMembersSchema,
  type ListWorkspaceMembersInput,
} from "./dto/projects-workspace-members.schemas";

@RequireModule("projects")
@Controller("projects/members")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsWorkspaceMembersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermission("projects:members:view")
  list(
    @Query(new ZodValidationPipe(listWorkspaceMembersSchema))
    query: ListWorkspaceMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.usersService.listUsers(u.orgId, {
      page: query.page,
      limit: query.limit,
      search: query.search,
      status: query.status,
      sortBy: "joinedAt",
      sortOrder: "desc",
    });
  }
}
