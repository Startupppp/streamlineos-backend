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
import { SupportSlaService } from "./support-sla.service";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import { SETTINGS_AUDIT_ENTITY_TYPES } from "../../../db/schema";
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
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  supportBusinessHoursRowSchema,
  supportBusinessHoursListSchema,
  supportSlaPolicyRowSchema,
  supportSlaPolicyListSchema,
  runEscalationsResultSchema,
  supportSettingsAuditLogListSchema,
  ticketRiskSchema,
  successSchema as slaSuccessSchema,
} from "./dto/support-settings-response.schemas";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

const businessHoursIdParams = z.object({ businessHoursId: z.coerce.number().int().positive() }).strict();
const slaPolicyIdParams = z.object({ slaPolicyId: z.coerce.number().int().positive() }).strict();
const supportTicketIdParams = z.object({ supportTicketId: z.coerce.number().int().positive() }).strict();

/**
 * `Math.min(Number(limit) || 50, 100)` guarded NaN through the `|| 50` fallback
 * but not sign: `Number("-5")` is -5, which is truthy, so `Math.min(-5, 100)` is
 * -5 and Postgres answers `LIMIT must not be negative` (2201W) — a 500 on a
 * malformed query string. `pageSizeField` floors at 1 and clamps at the platform
 * cap, and being declared here it also reaches openapi.json.
 *
 * `entityType` was narrowed with an `includes` guard whose miss silently became
 * `undefined`; declaring the enum turns an unknown entity type into a 400 that
 * names the field instead of quietly listing everything.
 */
const settingsAuditLogQuery = z
  .object({
    entityType: z.enum(SETTINGS_AUDIT_ENTITY_TYPES).optional(),
    limit: pageSizeField(50, 100),
  })
  .strict();
type SettingsAuditLogQuery = z.infer<typeof settingsAuditLogQuery>;

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
  @ResponseSchema(supportBusinessHoursListSchema)
  listBusinessHours(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listBusinessHours(u.orgId);
  }

  @Post("business-hours")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  @Validate({ body: createBusinessHoursSchema })
  @ResponseSchema(supportBusinessHoursRowSchema)
  async createBusinessHours(
    @Body() body: CreateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.createBusinessHours(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "business_hours", result.id, "created", body);
    return result;
  }

  @Patch("business-hours/:businessHoursId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: businessHoursIdParams, body: updateBusinessHoursSchema })
  @ResponseSchema(supportBusinessHoursRowSchema)
  async updateBusinessHours(
    @Param("businessHoursId", ParseIntPipe) businessHoursId: number,
    @Body() body: UpdateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.updateBusinessHours(u.orgId, businessHoursId, body);
    await this.audit.record(u.orgId, u.userId, "business_hours", businessHoursId, "updated", body);
    return result;
  }

  @Delete("business-hours/:businessHoursId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: businessHoursIdParams })
  @ResponseSchema(slaSuccessSchema)
  async deleteBusinessHours(@Param("businessHoursId", ParseIntPipe) businessHoursId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.sla.deleteBusinessHours(u.orgId, businessHoursId);
    await this.audit.record(u.orgId, u.userId, "business_hours", businessHoursId, "deleted");
    return result;
  }

  @Get("sla-policies")
  @RequirePermission("support:settings:manage")
  @ResponseSchema(supportSlaPolicyListSchema)
  listSlaPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listSlaPolicies(u.orgId);
  }

  @Post("sla-policies")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  @Validate({ body: createSlaPolicySchema })
  @ResponseSchema(supportSlaPolicyRowSchema)
  async createSlaPolicy(
    @Body() body: CreateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.createSlaPolicy(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "sla_policy", result.id, "created", body);
    return result;
  }

  @Patch("sla-policies/:slaPolicyId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: slaPolicyIdParams, body: updateSlaPolicySchema })
  @ResponseSchema(supportSlaPolicyRowSchema)
  async updateSlaPolicy(
    @Param("slaPolicyId", ParseIntPipe) slaPolicyId: number,
    @Body() body: UpdateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.sla.updateSlaPolicy(u.orgId, slaPolicyId, body);
    await this.audit.record(u.orgId, u.userId, "sla_policy", slaPolicyId, "updated", body);
    return result;
  }

  @Delete("sla-policies/:slaPolicyId")
  @RequirePermission("support:settings:manage")
  @Validate({ params: slaPolicyIdParams })
  @ResponseSchema(slaSuccessSchema)
  async deleteSlaPolicy(@Param("slaPolicyId", ParseIntPipe) slaPolicyId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.sla.deleteSlaPolicy(u.orgId, slaPolicyId);
    await this.audit.record(u.orgId, u.userId, "sla_policy", slaPolicyId, "deleted");
    return result;
  }

  @Post("sla/run-escalations")
  @BodylessAction()
  @RequirePermission("support:settings:manage")
  @HttpCode(200)
  @ResponseSchema(runEscalationsResultSchema)
  runEscalations(@CurrentUser() u: CurrentUserContext) {
    return this.sla.runEscalations(u.orgId);
  }

  @Get("settings/audit-log")
  @RequirePermission("support:settings:manage")
  @Validate({ query: settingsAuditLogQuery })
  @ResponseSchema(supportSettingsAuditLogListSchema)
  listSettingsAuditLog(
    @Query() query: SettingsAuditLogQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.audit.list(u.orgId, query.entityType, query.limit);
  }

  @Get(":supportTicketId/risk")
  @RequirePermission("support:tickets:view")
  @Validate({ params: supportTicketIdParams })
  @ResponseSchema(ticketRiskSchema)
  getTicketRisk(
    @Param("supportTicketId", ParseIntPipe) supportTicketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.getTicketRisk(u.orgId, supportTicketId);
  }
}
