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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { SupportSlaService } from "./support-sla.service";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import { SETTINGS_AUDIT_ENTITY_TYPES, type SettingsAuditEntityType } from "../../../db/schema";
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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";

const businessHoursIdParams = z.object({ businessHoursId: z.coerce.number().int().positive() }).strict();
const slaPolicyIdParams = z.object({ slaPolicyId: z.coerce.number().int().positive() }).strict();
const supportTicketIdParams = z.object({ supportTicketId: z.coerce.number().int().positive() }).strict();

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

  @Patch("business-hours/:businessHoursId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: businessHoursIdParams })
  async updateBusinessHours(
    @Param("businessHoursId", ParseIntPipe) businessHoursId: number,
    @Body(new ZodValidationPipe(updateBusinessHoursSchema)) body: UpdateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.updateBusinessHours(u.orgId, businessHoursId, body);
    await this.audit.record(u.orgId, u.userId, "business_hours", businessHoursId, "updated", body);
    return result;
  }

  @Delete("business-hours/:businessHoursId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: businessHoursIdParams })
  async deleteBusinessHours(@Param("businessHoursId", ParseIntPipe) businessHoursId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.sla.deleteBusinessHours(u.orgId, businessHoursId);
    await this.audit.record(u.orgId, u.userId, "business_hours", businessHoursId, "deleted");
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

  @Patch("sla-policies/:slaPolicyId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: slaPolicyIdParams })
  async updateSlaPolicy(
    @Param("slaPolicyId", ParseIntPipe) slaPolicyId: number,
    @Body(new ZodValidationPipe(updateSlaPolicySchema)) body: UpdateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.updateSlaPolicy(u.orgId, slaPolicyId, body);
    await this.audit.record(u.orgId, u.userId, "sla_policy", slaPolicyId, "updated", body);
    return result;
  }

  @Delete("sla-policies/:slaPolicyId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: slaPolicyIdParams })
  async deleteSlaPolicy(@Param("slaPolicyId", ParseIntPipe) slaPolicyId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.sla.deleteSlaPolicy(u.orgId, slaPolicyId);
    await this.audit.record(u.orgId, u.userId, "sla_policy", slaPolicyId, "deleted");
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
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsedLimit = Math.min(Number(limit) || 50, 100);
    const typedEntityType = SETTINGS_AUDIT_ENTITY_TYPES.includes(entityType as SettingsAuditEntityType)
      ? (entityType as SettingsAuditEntityType)
      : undefined;
    return this.audit.list(u.orgId, typedEntityType, parsedLimit);
  }

  @Get(":supportTicketId/risk")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  getTicketRisk(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.getTicketRisk(u.orgId, supportTicketId);
  }
}
