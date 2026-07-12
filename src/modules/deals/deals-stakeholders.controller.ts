import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DealsStakeholdersService, type CreateStakeholderInput, type UpdateStakeholderInput } from "./deals-stakeholders.service";

@RequireModule("crm")
@Controller("deals/:dealId/stakeholders")
@UseGuards(JwtAuthGuard)
export class DealsStakeholdersController {
  constructor(private readonly stakeholders: DealsStakeholdersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  listStakeholders(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stakeholders.listStakeholders(u.orgId, dealId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @HttpCode(201)
  createStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: CreateStakeholderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stakeholders.createStakeholder(u.orgId, dealId, body);
  }

  @Patch(":stakeholderId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  updateStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("stakeholderId") stakeholderId: string,
    @Body() body: UpdateStakeholderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stakeholders.updateStakeholder(u.orgId, dealId, stakeholderId, body);
  }

  @Delete(":stakeholderId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  deleteStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("stakeholderId") stakeholderId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stakeholders.deleteStakeholder(u.orgId, dealId, stakeholderId);
  }
}
