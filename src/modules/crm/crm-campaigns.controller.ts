import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmCampaignsService } from "./crm-campaigns.service";
import { CrmAttributionReportService } from "./crm-attribution-report.service";
import {
  campaignListSchema,
  campaignCreateSchema,
  campaignUpdateSchema,
  type CampaignListQuery,
  type CampaignCreateInput,
  type CampaignUpdateInput,
} from "./dto/campaigns.schemas";

@RequireModule("crm")
@Controller("crm/campaigns")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmCampaignsController {
  constructor(
    private readonly campaigns: CrmCampaignsService,
    private readonly attribution: CrmAttributionReportService,
  ) {}

  @Get()
  @RequirePermission("crm:campaigns:view")
  list(
    @Query(new ZodValidationPipe(campaignListSchema)) query: CampaignListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("crm:campaigns:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(campaignCreateSchema)) body: CampaignCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.create(u.orgId, body);
  }

  @Get("attribution/first-touch")
  @RequirePermission("crm:reports:view")
  firstTouch(@CurrentUser() u: CurrentUserContext) {
    return this.attribution.getFirstTouchAttribution(u.orgId);
  }

  @Get("attribution/last-touch")
  @RequirePermission("crm:reports:view")
  lastTouch(@CurrentUser() u: CurrentUserContext) {
    return this.attribution.getLastTouchAttribution(u.orgId);
  }

  @Get(":campaignId/roi")
  @RequirePermission("crm:campaigns:view")
  roi(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.getCampaignRoi(u.orgId, campaignId);
  }

  @Get(":campaignId/leads")
  @RequirePermission("crm:campaigns:view")
  campaignLeads(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @Query("page") page: string | undefined,
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.getCampaignLeads(
      u.orgId,
      campaignId,
      Math.max(1, parseInt(page ?? "1", 10) || 1),
      Math.min(50, parseInt(limit ?? "20", 10) || 20),
    );
  }

  @Patch(":campaignId")
  @RequirePermission("crm:campaigns:manage")
  update(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @Body(new ZodValidationPipe(campaignUpdateSchema)) body: CampaignUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.update(u.orgId, campaignId, body);
  }

  @Delete(":campaignId")
  @HttpCode(204)
  @RequirePermission("crm:campaigns:manage")
  async remove(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.campaigns.remove(u.orgId, campaignId);
  }
}
