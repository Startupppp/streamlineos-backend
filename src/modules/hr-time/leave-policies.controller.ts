import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { LeavePoliciesService, type CreateLeavePolicyInput, type UpdateLeavePolicyInput } from "./leave-policies.service";

@UseGuards(JwtAuthGuard)
@Controller("hr/leave-policies")
export class LeavePoliciesController {
  constructor(private readonly service: LeavePoliciesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  create(@CurrentUser() u: CurrentUserContext, @Body() body: CreateLeavePolicyInput) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":policyId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdateLeavePolicyInput,
  ) {
    return this.service.update(u.orgId, policyId, body);
  }

  @Delete(":policyId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  remove(@CurrentUser() u: CurrentUserContext, @Param("policyId", ParseIntPipe) policyId: number) {
    return this.service.remove(u.orgId, policyId);
  }
}
