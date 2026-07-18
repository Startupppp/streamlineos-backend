import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DealsStakeholdersService } from "./deals-stakeholders.service";
import {
  createStakeholderSchema,
  updateStakeholderSchema,
  type CreateStakeholderInput,
  type UpdateStakeholderInput,
} from "./dto/deals.schemas";

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
    @Body(new ZodValidationPipe(createStakeholderSchema)) body: CreateStakeholderInput,
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
    @Body(new ZodValidationPipe(updateStakeholderSchema)) body: UpdateStakeholderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.stakeholders.updateStakeholder(u.orgId, dealId, stakeholderId, body);
  }

  @Delete(":stakeholderId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  async deleteStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("stakeholderId") stakeholderId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.stakeholders.deleteStakeholder(u.orgId, dealId, stakeholderId);
  }
}
