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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SupportSlaService } from "./support-sla.service";
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
  constructor(private readonly sla: SupportSlaService) {}

  @Get("business-hours")
  @RequirePermission("support:settings:manage")
  listBusinessHours(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listBusinessHours(u.orgId);
  }

  @Post("business-hours")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  createBusinessHours(
    @Body(new ZodValidationPipe(createBusinessHoursSchema)) body: CreateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.createBusinessHours(u.orgId, body);
  }

  @Patch("business-hours/:id")
  @RequirePermission("support:settings:manage")
  updateBusinessHours(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateBusinessHoursSchema)) body: UpdateBusinessHoursInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.updateBusinessHours(u.orgId, id, body);
  }

  @Delete("business-hours/:id")
  @RequirePermission("support:settings:manage")
  deleteBusinessHours(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.sla.deleteBusinessHours(u.orgId, id);
  }

  @Get("sla-policies")
  @RequirePermission("support:settings:manage")
  listSlaPolicies(@CurrentUser() u: CurrentUserContext) {
    return this.sla.listSlaPolicies(u.orgId);
  }

  @Post("sla-policies")
  @RequirePermission("support:settings:manage")
  @HttpCode(201)
  createSlaPolicy(
    @Body(new ZodValidationPipe(createSlaPolicySchema)) body: CreateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.createSlaPolicy(u.orgId, body);
  }

  @Patch("sla-policies/:id")
  @RequirePermission("support:settings:manage")
  updateSlaPolicy(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSlaPolicySchema)) body: UpdateSlaPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.sla.updateSlaPolicy(u.orgId, id, body);
  }

  @Delete("sla-policies/:id")
  @RequirePermission("support:settings:manage")
  deleteSlaPolicy(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.sla.deleteSlaPolicy(u.orgId, id);
  }

  @Post("sla/run-escalations")
  @RequirePermission("support:settings:manage")
  @HttpCode(200)
  runEscalations(@CurrentUser() u: CurrentUserContext) {
    return this.sla.runEscalations(u.orgId);
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
