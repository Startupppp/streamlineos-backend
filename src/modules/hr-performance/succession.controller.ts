import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { SuccessionService } from "./succession.service";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/succession")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SuccessionController {
  constructor(private readonly successionService: SuccessionService) {}

  @Get()
  @RequirePermission("hr:succession:view")
  list(@CurrentUser() user: CurrentUserContext) {
    return this.successionService.list(user.orgId);
  }

  @Post()
  @RequirePermission("hr:succession:manage")
  create(
    @CurrentUser() user: CurrentUserContext,
    @Body()
    body: {
      roleName: string;
      jobRoleId?: number;
      incumbentId?: string;
      successorId: string;
      readiness: "ready_now" | "1_2_years" | "3_plus";
      note?: string;
    },
  ) {
    return this.successionService.create(user.orgId, user.userId, body);
  }

  @Patch(":id")
  @RequirePermission("hr:succession:manage")
  update(
    @CurrentUser() user: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body()
    body: Partial<{
      roleName: string;
      jobRoleId: number;
      incumbentId: string;
      successorId: string;
      readiness: "ready_now" | "1_2_years" | "3_plus";
      note: string;
    }>,
  ) {
    return this.successionService.update(user.orgId, id, body);
  }

  @Delete(":id")
  @RequirePermission("hr:succession:manage")
  remove(@CurrentUser() user: CurrentUserContext, @Param("id", ParseIntPipe) id: number) {
    return this.successionService.remove(user.orgId, id);
  }
}
