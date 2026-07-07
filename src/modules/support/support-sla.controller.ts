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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SupportSlaService } from "./support-sla.service";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import type { SettingsAuditEntityType } from "../../db/schema";
import {
  createBusinessHoursSchema,
  createSlaPolicySchema,
  updateBusinessHoursSchema,
  updateSlaPolicySchema,
  type CreateBusinessHoursInput,
  type CreateSlaPolicyInput,
  type UpdateBusinessHoursInput,
  type UpdateSlaPolicyInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";

@RequireModule("support")
@Controller("support")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SupportSlaController {
  constructor(
    private readonly sla: SupportSlaService,
    private readonly audit: SupportSettingsAuditService,
  ) {}

  @Get("business-hours")
  @RequirePermission("support:settings:manage")
  listBusinessHours(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listBusinessHours(u.orgId);
  }

  @Post("business-hours")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  async createBusinessHours(
    @Body(new ZodValidationPipe(createBusinessHoursSchema)) body: CreateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.createBusinessHours(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "business_hours", result.id, "created", body);
    return result;
  }

  @Patch("business-hours/:id")
  @RequirePermission("support:settings:manage")
  async updateBusinessHours(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateBusinessHoursSchema)) body: UpdateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.updateBusinessHours(u.orgId, id, body);
    await this.audit.record(u.orgId, u.userId, "business_hours", id, "updated", body);
    return result;
  }

  @Delete("business-hours/:id")
  @RequirePermission("support:settings:manage")
  async deleteBusinessHours(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.sla.deleteBusinessHours(u.orgId, id);
    await this.audit.record(u.orgId, u.userId, "business_hours", id, "deleted");
    return result;
  }

  @Get("sla-policies")
  @RequirePermission("support:settings:manage")
  listSlaPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listSlaPolicies(u.orgId);
  }

  @Post("sla-policies")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  async createSlaPolicy(
    @Body(new ZodValidationPipe(createSlaPolicySchema)) body: CreateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.createSlaPolicy(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "sla_policy", result.id, "created", body);
    return result;
  }

  @Patch("sla-policies/:id")
  @RequirePermission("support:settings:manage")
  async updateSlaPolicy(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSlaPolicySchema)) body: UpdateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.updateSlaPolicy(u.orgId, id, body);
    await this.audit.record(u.orgId, u.userId, "sla_policy", id, "updated", body);
    return result;
  }

  @Delete("sla-policies/:id")
  @RequirePermission("support:settings:manage")
  async deleteSlaPolicy(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.sla.deleteSlaPolicy(u.orgId, id);
    await this.audit.record(u.orgId, u.userId, "sla_policy", id, "deleted");
    return result;
  }

  @Post("sla/run-escalations")
  @RequirePermission("support:settings:manage")
  @HttpCode(200)
  runEscalations(@CurrentUser() u: CurrentUserContext) {
    return this.sla.runEscalations(u.orgId);
  }

  @Get("settings/audit-log")
  @RequirePermission("support:settings:manage")
  listSettingsAuditLog(
    @Query("entityType") entityType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audit.list(u.orgId, entityType as SettingsAuditEntityType | undefined);
  }

  @Get(":supportTicketId/risk")
  @RequirePermission("support:tickets:view")
  getTicketRisk(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.getTicketRisk(u.orgId, supportTicketId);
  }
}
