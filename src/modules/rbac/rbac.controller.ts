import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RbacService } from "./rbac.service";
import {
  assignRolePermissionSchema,
  rolePermissionsQuerySchema,
  type AssignRolePermissionInput,
  type RolePermissionsQuery,
} from "./dto/rbac.schemas";

@Controller("rbac")
@UseGuards(JwtAuthGuard)
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get("permissions")
  getPermissions() {
    return this.rbac.getAllPermissions();
  }

  @Get("role-permissions")
  getRolePermissions(
    @Query(new ZodValidationPipe(rolePermissionsQuerySchema)) query: RolePermissionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.getRolePermissions(query.role, u.orgId);
  }

  @Post("role-permissions")
  @HttpCode(200)
  assignRolePermission(
    @Body(new ZodValidationPipe(assignRolePermissionSchema)) body: AssignRolePermissionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.rbac.assignRolePermission(u, body);
  }

  @Get("user-permissions")
  getUserPermissions(@CurrentUser() u: CurrentUserContext) {
    return this.rbac.getUserPermissions(u.userId, u.orgId);
  }
}
