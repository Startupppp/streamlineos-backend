import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DealsService } from "./deals.service";
import { resolveDealsReadScope } from "./deals-scope";
import {
  createDealSchema,
  listDealsSchema,
  logActivitySchema,
  patchCustomDataSchema,
  updateDealSchema,
  type CreateDealInput,
  type ListDealsInput,
  type LogActivityInput,
  type PatchCustomDataInput,
  type UpdateDealInput,
} from "./dto/deals.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard)
export class DealsController {
  constructor(
    private readonly deals: DealsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  async listDeals(
    @Query(new ZodValidationPipe(listDealsSchema)) query: ListDealsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveDealsReadScope(this.access, u);
    return this.deals.listDeals(u.orgId, u.userId, query, scope);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:create")
  @HttpCode(201)
  createDeal(
    @Body(new ZodValidationPipe(createDealSchema)) body: CreateDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.createDeal(u.orgId, u.userId, body);
  }

  @Post(":dealId/clone")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:create")
  @HttpCode(200)
  cloneDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.cloneDeal(u.orgId, dealId);
  }

  @Get(":dealId/activities")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  listActivities(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.listActivities(u.orgId, dealId);
  }

  @Post(":dealId/activities")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @HttpCode(201)
  addActivity(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body(new ZodValidationPipe(logActivitySchema)) body: LogActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.addActivity(u.orgId, u.userId, dealId, body);
  }

  @Patch(":dealId/custom-data")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  updateCustomData(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body(new ZodValidationPipe(patchCustomDataSchema)) body: PatchCustomDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.updateCustomData(u.orgId, dealId, body);
  }

  @Patch(":dealId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  async updateDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body(new ZodValidationPipe(updateDealSchema)) body: UpdateDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.deals.updateDeal(u.orgId, u.userId, dealId, body);
    if (!result.ok) {
      if (result.reason === "version_conflict") {
        throw new ConflictException("Conflict: deal was updated by another request. Please refresh.");
      }
      throw new NotFoundException("Deal not found");
    }
    return result.deal;
  }

  @Get(":dealId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  async getDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const deal = await this.deals.getDeal(u.orgId, dealId);
    if (!deal) throw new NotFoundException("Deal not found");
    return deal;
  }

  @Delete(":dealId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:delete")
  deleteDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.deleteDeal(u.orgId, u.userId, dealId);
  }
}
