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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignSettingsService } from "./sign-settings.service";
import { SignWatermarkService } from "./sign-watermark.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import {
  updateSignSettingsSchema,
  watermarkPolicyInputSchema,
  type UpdateSignSettingsInput,
  type WatermarkPolicyInput,
} from "./dto/e-sign.schemas";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

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
  updateSettings(@Body(new ZodValidationPipe(updateSignSettingsSchema)) body: UpdateSignSettingsInput, @CurrentUser() u: CurrentUserContext) {
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
  createWatermarkPolicy(@Body(new ZodValidationPipe(watermarkPolicyInputSchema)) body: WatermarkPolicyInput, @CurrentUser() u: CurrentUserContext) {
    return this.watermark.create(u.orgId, u.userId, body);
  }

  @Patch("watermark-policies/:policyId")
  @RequirePermission("sign:admin:manage")
  @Validate({ params: policyIdParams })
  updateWatermarkPolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(watermarkPolicyInputSchema.partial())) body: Partial<WatermarkPolicyInput>,
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
  @RequirePermission("sign:admin:manage")
  async runReminderSweep() {
    const remindedCount = await this.envelopes.runReminderSweep();
    return { remindedCount };
  }

  @Post("run-expiration-sweep")
  @RequirePermission("sign:admin:manage")
  async runExpirationSweep() {
    const expiredCount = await this.envelopes.runExpirationSweep();
    return { expiredCount };
  }
}
