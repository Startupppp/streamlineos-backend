import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { DealsService } from "./deals.service";
import { resolveDealsReadScope } from "./deals-scope";
import {
  bulkImportDealsSchema,
  dealBulkUpdateSchema,
  dealBulkDeleteSchema,
  createDealSchema,
  listDealsSchema,
  logActivitySchema,
  patchCustomDataSchema,
  updateDealSchema,
  type BulkImportDealsInput,
  type DealBulkUpdateInput,
  type DealBulkDeleteInput,
  type CreateDealInput,
  type ListDealsInput,
  type LogActivityInput,
  type PatchCustomDataInput,
  type UpdateDealInput,
} from "./dto/deals.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const dealIdParams = z.object({ dealId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ query: listDealsSchema })
  async listDeals(
    @Query() query: ListDealsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveDealsReadScope(this.access, u);
    return this.deals.listDeals(u.orgId, u.userId, query, scope);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:create")
  @HttpCode(201)
  @Idempotent("crm.deal.create")
  @Validate({ body: createDealSchema })
  createDeal(
    @Body() body: CreateDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.createDeal(u.orgId, u.userId, body);
  }

  @Patch("bulk")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @Validate({ body: dealBulkUpdateSchema })
  bulkUpdate(
    @Body() body: DealBulkUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.bulkUpdate(u.orgId, u.userId, body);
  }

  @Delete("bulk")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:delete")
  @Validate({ body: dealBulkDeleteSchema })
  bulkDelete(
    @Body() body: DealBulkDeleteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.bulkDelete(u.orgId, u.userId, body);
  }

  @Post("bulk-import")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:create")
  @HttpCode(201)
  @Idempotent("crm.deals.bulkImport")
  @Validate({ body: bulkImportDealsSchema })
  bulkImport(
    @Body() body: BulkImportDealsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.bulkImport(u.orgId, u.userId, body);
  }

  @Get("export")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  async exportCsv(@CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const scope = await resolveDealsReadScope(this.access, u);
    const result = await this.deals.exportCsv(u.orgId, u.userId, scope);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="deals-export.csv"');
    if (result.truncated) res.setHeader("X-Truncated", "true");
    res.setHeader("X-Row-Count", String(result.rowCount));
    res.send(result.csv);
  }

  @Post(":dealId/clone")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:create")
  @HttpCode(200)
  @Validate({ params: dealIdParams })
  cloneDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.cloneDeal(u.orgId, dealId);
  }

  @Get(":dealId/activities")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  @Validate({ params: dealIdParams })
  listActivities(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.listActivities(u.orgId, dealId);
  }

  @Get(":dealId/transitions")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  @Validate({ params: dealIdParams })
  async listStageTransitions(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return { data: await this.deals.listStageTransitions(u.orgId, dealId) };
  }

  @Post(":dealId/activities")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @HttpCode(201)
  @Validate({ params: dealIdParams, body: logActivitySchema })
  addActivity(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: LogActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.addActivity(u.orgId, u.userId, dealId, body);
  }

  @Patch(":dealId/custom-data")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @Validate({ params: dealIdParams, body: patchCustomDataSchema })
  updateCustomData(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: PatchCustomDataInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.deals.updateCustomData(u.orgId, dealId, body);
  }

  @Patch(":dealId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:update")
  @Validate({ params: dealIdParams, body: updateDealSchema })
  async updateDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @Body() body: UpdateDealInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.deals.updateDeal(u.orgId, u.userId, dealId, body);
    if (!result.ok) {
      if (result.reason === "version_conflict") {
        throw new ConflictException("Conflict: deal was updated by another request. Please refresh.");
      }
      throw new NotFoundException("Deal not found");
    }
    if (result.approvalPending) {
      return { approvalPending: true, approvalId: result.approvalId, deal: result.deal };
    }
    return result.deal;
  }

  @Get(":dealId")
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:read")
  @Validate({ params: dealIdParams })
  async getDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const deal = await this.deals.getDeal(u.orgId, dealId);
    if (!deal) throw new NotFoundException("Deal not found");
    return deal;
  }

  @Delete(":dealId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("crm:deals:delete")
  @Validate({ params: dealIdParams })
  async deleteDeal(
    @Param("dealId", ParseIntPipe) dealId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.deals.deleteDeal(u.orgId, u.userId, dealId);
  }
}
