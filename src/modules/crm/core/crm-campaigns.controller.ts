import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { CrmCampaignsService } from "./crm-campaigns.service";
import { CrmAttributionReportService } from "./crm-attribution-report.service";
import { AttributionReportService } from "../../attribution/attribution-report.service";
import {
  attributionReportQuerySchema,
  type AttributionReportQuery,
} from "../../attribution/dto/attribution-report.schemas";
import {
  campaignListSchema,
  campaignCreateSchema,
  campaignUpdateSchema,
  type CampaignListQuery,
  type CampaignCreateInput,
  type CampaignUpdateInput,
} from "./dto/campaigns.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  campaignsListSchema,
  campaignSchema,
  campaignRoiSchema,
  campaignLeadsSchema,
  campaignAttributionSchema,
  campaignAttributionByModelSchema,
} from "./dto/crm-campaigns-response.schemas";

const campaignIdParams = z.object({ campaignId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("crm/campaigns")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmCampaignsController {
  constructor(
    private readonly campaigns: CrmCampaignsService,
    private readonly attribution: CrmAttributionReportService,
    private readonly multiTouch: AttributionReportService,
  ) {}

  @Get()
  @RequirePermission("crm:campaigns:view")
  @ResponseSchema(campaignsListSchema)
  @Validate({ query: campaignListSchema })
  list(
    @Query() query: CampaignListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("crm:campaigns:manage")
  @HttpCode(201)
  @ResponseSchema(campaignSchema)
  @Idempotent("crm.campaign.create")
  @Validate({ body: campaignCreateSchema })
  create(
    @Body() body: CampaignCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.create(u.orgId, body);
  }

  @Get("attribution/first-touch")
  @RequirePermission("crm:reports:view")
  @ResponseSchema(z.array(campaignAttributionSchema))
  firstTouch(@CurrentUser() u: CurrentUserContext) {
    return this.attribution.getFirstTouchAttribution(u.orgId);
  }

  @Get("attribution/last-touch")
  @RequirePermission("crm:reports:view")
  @ResponseSchema(z.array(campaignAttributionSchema))
  lastTouch(@CurrentUser() u: CurrentUserContext) {
    return this.attribution.getLastTouchAttribution(u.orgId);
  }

  /**
   * The same question as the two above, asked under any of the five models.
   *
   * It sits beside them on the same permission rather than behind a new key:
   * multi-touch is a different arithmetic over the touches `crm:reports:view`
   * already discloses, not a wider disclosure. Declared before `:campaignId`
   * so the literal segment is matched first.
   */
  @Get("attribution/by-model")
  @RequirePermission("crm:reports:view")
  @ResponseSchema(campaignAttributionByModelSchema)
  byModel(
    @Query(new ZodValidationPipe(attributionReportQuerySchema))
    query: AttributionReportQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.multiTouch.getReport(u.orgId, query.model, query.halfLifeDays);
  }

  @Get(":campaignId/roi")
  @RequirePermission("crm:campaigns:view")
  @ResponseSchema(campaignRoiSchema)
  @Validate({ params: campaignIdParams })
  roi(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.getCampaignRoi(u.orgId, campaignId);
  }

  @Get(":campaignId/leads")
  @RequirePermission("crm:campaigns:view")
  @ResponseSchema(campaignLeadsSchema)
  @Validate({ params: campaignIdParams })
  campaignLeads(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.getCampaignLeads(u.orgId, campaignId, cursor);
  }

  @Patch(":campaignId")
  @RequirePermission("crm:campaigns:manage")
  @ResponseSchema(campaignSchema)
  @Validate({ params: campaignIdParams, body: campaignUpdateSchema })
  update(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @Body() body: CampaignUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.campaigns.update(u.orgId, campaignId, body);
  }

  @Delete(":campaignId")
  @HttpCode(204)
  @RequirePermission("crm:campaigns:manage")
  @NoContentResponse()
  @Validate({ params: campaignIdParams })
  async remove(
    @Param("campaignId", ParseIntPipe) campaignId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.campaigns.remove(u.orgId, campaignId);
  }
}
