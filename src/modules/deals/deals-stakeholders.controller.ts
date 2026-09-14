import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DealsStakeholdersService } from "./deals-stakeholders.service";
import {
  createStakeholderSchema,
  updateStakeholderSchema,
  type CreateStakeholderInput,
  type UpdateStakeholderInput,
} from "./dto/deals.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../common/openapi/zod-operation-contracts";
import { dealStakeholderSchema } from "./dto/deals-response.schemas";

const dealIdParams = z.object({ dealId: z.coerce.number().int().positive() }).strict();
const dealAndStakeholderIdParams = z.object({ dealId: z.coerce.number().int().positive(), stakeholderId: z.string().min(1) }).strict();

@RequireModule("crm")
@Controller("deals/:dealId/stakeholders")
@UseGuards(JwtAuthGuard)
export class DealsStakeholdersController {
  constructor(private readonly stakeholders: DealsStakeholdersService) {}

  private async loadStakeholderWithContact(orgId: string, dealId: number, stakeholderId: string) {
    return this.stakeholders.getOne(orgId, dealId, stakeholderId);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  @ResponseSchema(z.array(dealStakeholderSchema))
  @Validate({ params: dealIdParams })
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
  @ResponseSchema(dealStakeholderSchema)
  @Validate({ params: dealIdParams, body: createStakeholderSchema })
  async createStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: CreateStakeholderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const row = await this.stakeholders.createStakeholder(u.orgId, dealId, body);
    if (!row) throw new NotFoundException("Stakeholder could not be created");
    const detail = await this.loadStakeholderWithContact(u.orgId, dealId, row.id);
    if (!detail) throw new NotFoundException("Stakeholder not found");
    return detail;
  }

  @Patch(":stakeholderId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @ResponseSchema(dealStakeholderSchema)
  @Validate({ params: dealAndStakeholderIdParams, body: updateStakeholderSchema })
  async updateStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("stakeholderId") stakeholderId: string,
    @Body() body: UpdateStakeholderInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.stakeholders.updateStakeholder(u.orgId, dealId, stakeholderId, body);
    const detail = await this.loadStakeholderWithContact(u.orgId, dealId, stakeholderId);
    if (!detail) throw new NotFoundException("Stakeholder not found");
    return detail;
  }

  @Delete(":stakeholderId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @NoContentResponse()
  @Validate({ params: dealAndStakeholderIdParams })
  async deleteStakeholder(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Param("stakeholderId") stakeholderId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.stakeholders.deleteStakeholder(u.orgId, dealId, stakeholderId);
  }
}
