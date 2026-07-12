import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignSettingsService } from "./sign-settings.service";
import { SignWatermarkService } from "./sign-watermark.service";
import { SignEnvelopesService } from "./sign-envelopes.service";
import {
  updateSignSettingsSchema,
  watermarkPolicyInputSchema,
  type UpdateSignSettingsInput,
  type WatermarkPolicyInput,
} from "./dto/signos.schemas";

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

  @Get("watermark-policies/:id")
  @RequirePermission("sign:admin:manage")
  getWatermarkPolicy(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.watermark.get(u.orgId, id);
  }

  @Post("watermark-policies")
  @RequirePermission("sign:admin:manage")
  createWatermarkPolicy(@Body(new ZodValidationPipe(watermarkPolicyInputSchema)) body: WatermarkPolicyInput, @CurrentUser() u: CurrentUserContext) {
    return this.watermark.create(u.orgId, u.userId, body);
  }

  @Patch("watermark-policies/:id")
  @RequirePermission("sign:admin:manage")
  updateWatermarkPolicy(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(watermarkPolicyInputSchema.partial())) body: Partial<WatermarkPolicyInput>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.watermark.update(u.orgId, id, u.userId, body);
  }

  @Delete("watermark-policies/:id")
  @RequirePermission("sign:admin:manage")
  async removeWatermarkPolicy(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    await this.watermark.remove(u.orgId, id, u.userId);
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
