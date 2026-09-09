import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
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
import { SignEnvelopeSweepsService } from "./sign-envelope-sweeps.service";
import {
  updateSignSettingsSchema,
  watermarkPolicyInputSchema,
  type UpdateSignSettingsInput,
  type WatermarkPolicyInput,
} from "./dto/e-sign.schemas";

@RequireModule("sign")
@Controller("sign/admin")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignAdminController {
  constructor(
    private readonly settings: SignSettingsService,
    private readonly watermark: SignWatermarkService,
    private readonly envelopes: SignEnvelopesService,
    private readonly sweeps: SignEnvelopeSweepsService,
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
  updateWatermarkPolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(watermarkPolicyInputSchema.partial())) body: Partial<WatermarkPolicyInput>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.watermark.update(u.orgId, policyId, u.userId, body);
  }

  @Delete("watermark-policies/:policyId")
  @RequirePermission("sign:admin:manage")
  async removeWatermarkPolicy(@Param("policyId", ParseIntPipe) policyId: number, @CurrentUser() u: CurrentUserContext) {
    await this.watermark.remove(u.orgId, policyId, u.userId);
    return { success: true };
  }

  /**
   * When each sweep last ran for this organisation, and whether it worked.
   *
   * Reported for both sweeps whether or not a row exists: an absent row means
   * "never run", and that is the answer worth showing. Returning only the
   * sweeps that have run lets a screen render an empty list and look healthy —
   * which is indistinguishable from the state SignOS was actually in, with the
   * sweeps wired to nothing at all.
   */
  @Get("sweep-status")
  @RequirePermission("sign:admin:manage")
  async sweepStatus(@CurrentUser() u: CurrentUserContext) {
    return { sweeps: await this.sweeps.lastRuns(u.orgId) };
  }

  /**
   * What the next sweep would do to this organisation, without doing it.
   *
   * Runs the same selection the sweep runs, so an operator asking "what happens
   * if I turn this on" gets the sweep's own answer rather than a second
   * implementation's. Nothing is written and no mail is queued, which also
   * means calling this does not reset the staleness clock `sweep-status` reads.
   */
  @Get("sweep-preview")
  @RequirePermission("sign:admin:manage")
  async sweepPreview(@Query("sweep") sweep?: string) {
    const which = sweep === "expiration" ? "expiration" : "reminder";
    return this.sweeps.previewSweep(which);
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
