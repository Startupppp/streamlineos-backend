import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RemindersService } from "./reminders.service";
import {
  createReminderPolicySchema,
  updateReminderPolicySchema,
  listReminderPoliciesSchema,
  listReminderLogSchema,
  type CreateReminderPolicyInput,
  type UpdateReminderPolicyInput,
  type ListReminderPoliciesQuery,
  type ListReminderLogQuery,
} from "./dto/finance-ar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/reminders")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RemindersController {
  constructor(private readonly svc: RemindersService) {}

  @Get("policies")
  @RequirePermission("accounting:reminders:read")
  listPolicies(
    @Query(new ZodValidationPipe(listReminderPoliciesSchema)) query: ListReminderPoliciesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPolicies(u.orgId, query);
  }

  @Post("policies")
  @HttpCode(201)
  @RequirePermission("accounting:reminders:manage")
  createPolicy(
    @Body(new ZodValidationPipe(createReminderPolicySchema)) body: CreateReminderPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPolicy(u.orgId, body);
  }

  @Patch("policies/:policyId")
  @RequirePermission("accounting:reminders:manage")
  @Validate({ params: policyIdParams })
  updatePolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(updateReminderPolicySchema)) body: UpdateReminderPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePolicy(u.orgId, policyId, body);
  }

  @Delete("policies/:policyId")
  @RequirePermission("accounting:reminders:manage")
  @Validate({ params: policyIdParams })
  deletePolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deletePolicy(u.orgId, policyId);
  }

  @Get("log")
  @RequirePermission("accounting:reminders:read")
  listLog(
    @Query(new ZodValidationPipe(listReminderLogSchema)) query: ListReminderLogQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listLog(u.orgId, query);
  }
}
