import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { SignSettingsService } from "./sign-settings.service";
import { SignWatermarkService } from "./sign-watermark.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import {
  updateSignSettingsSchema,
  watermarkPolicyInputSchema,
  type UpdateSignSettingsInput,
  type WatermarkPolicyInput,
} from "./dto/e-sign.schemas";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();
const updateWatermarkPolicyBodySchema = watermarkPolicyInputSchema.partial();

@RequireModule("sign")
@Controller("sign/admin")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignAdminController {
  constructor(
    private readonly settings: SignSettingsService,
    private readonly watermark: SignWatermarkService,
    private readonly envelopes: SignEnvelopesService,
  ) {}

  @Get("settings")
  @RequirePermission("sign:admin:manage")
  getSettings(@CurrentUser() u: CurrentUserContext) {
    return this.settings.getOrCreate(u.orgId);
  }

  @Patch("settings")
  @RequirePermission("sign:admin:manage")
  @Validate({ body: updateSignSettingsSchema })
  updateSettings(@Body() body: UpdateSignSettingsInput, @CurrentUser() u: CurrentUserContext) {
    return this.settings.update(u.orgId, body, u.userId);
  }

  @Get("watermark-policies")
  @RequirePermission("sign:admin:manage")
  listWatermarkPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.watermark.list(u.orgId);
  }

  @Get("watermark-policies/:policyId")
  @RequirePermission("sign:admin:manage")
  @Validate({ params: policyIdParams })
  getWatermarkPolicy(@Param("policyId", ParseIntPipe) policyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.watermark.get(u.orgId, policyId);
  }

  @Post("watermark-policies")
  @HttpCode(201)
  @RequirePermission("sign:admin:manage")
  @Validate({ body: watermarkPolicyInputSchema })
  createWatermarkPolicy(@Body() body: WatermarkPolicyInput, @CurrentUser() u: CurrentUserContext) {
    return this.watermark.create(u.orgId, u.userId, body);
  }

  @Patch("watermark-policies/:policyId")
  @RequirePermission("sign:admin:manage")
  @Validate({ params: policyIdParams, body: updateWatermarkPolicyBodySchema })
  updateWatermarkPolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: Partial<WatermarkPolicyInput>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.watermark.update(u.orgId, policyId, u.userId, body);
  }

  @Delete("watermark-policies/:policyId")
  @RequirePermission("sign:admin:manage")
  @Validate({ params: policyIdParams })
  async removeWatermarkPolicy(@Param("policyId", ParseIntPipe) policyId: number, @CurrentUser() u: CurrentUserContext) {
    await this.watermark.remove(u.orgId, policyId, u.userId);
    return { success: true };
  }

  @Post("run-reminder-sweep")
  @BodylessAction()
  @RequirePermission("sign:admin:manage")
  async runReminderSweep(@CurrentUser() u: CurrentUserContext) {
    const remindedCount = await this.envelopes.runReminderSweep(u.orgId);
    return { remindedCount };
  }

  @Post("run-expiration-sweep")
  @BodylessAction()
  @RequirePermission("sign:admin:manage")
  async runExpirationSweep(@CurrentUser() u: CurrentUserContext) {
    const expiredCount = await this.envelopes.runExpirationSweep(u.orgId);
    return { expiredCount };
  }
}
