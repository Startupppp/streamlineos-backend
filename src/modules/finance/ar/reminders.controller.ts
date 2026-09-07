import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  reminderPolicyListResponseSchema,
  reminderPolicyCreatedResponseSchema,
  reminderPolicyUpdatedResponseSchema,
  reminderPolicyDeleteResponseSchema,
  reminderLogListResponseSchema,
  reminderEffectivenessResponseSchema,
} from "./dto/ar-response.schemas";
import { z } from "zod";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/reminders")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RemindersController {
  constructor(private readonly svc: RemindersService) {}

  @Get("policies")
  @ResponseSchema(reminderPolicyListResponseSchema)
  @RequirePermission("accounting:reminders:read")
  @Validate({ query: listReminderPoliciesSchema })
  listPolicies(
    @Query() query: ListReminderPoliciesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listPolicies(u.orgId, query);
  }

  @Post("policies")
  @ResponseSchema(reminderPolicyCreatedResponseSchema)
  @HttpCode(201)
  @RequirePermission("accounting:reminders:manage")
  @Validate({ body: createReminderPolicySchema })
  createPolicy(
    @Body() body: CreateReminderPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createPolicy(u.orgId, body);
  }

  @Patch("policies/:policyId")
  @ResponseSchema(reminderPolicyUpdatedResponseSchema)
  @RequirePermission("accounting:reminders:manage")
  @Validate({ params: policyIdParams, body: updateReminderPolicySchema })
  updatePolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdateReminderPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updatePolicy(u.orgId, policyId, body);
  }

  @Delete("policies/:policyId")
  @ResponseSchema(reminderPolicyDeleteResponseSchema)
  @RequirePermission("accounting:reminders:manage")
  @Validate({ params: policyIdParams })
  deletePolicy(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.deletePolicy(u.orgId, policyId);
  }

  @Get("log")
  @ResponseSchema(reminderLogListResponseSchema)
  @RequirePermission("accounting:reminders:read")
  @Validate({ query: listReminderLogSchema })
  listLog(
    @Query() query: ListReminderLogQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listLog(u.orgId, query);
  }

  @Get("effectiveness")
  @ResponseSchema(reminderEffectivenessResponseSchema)
  @RequirePermission("accounting:reminders:read")
  effectiveness(@CurrentUser() u: CurrentUserContext) {
    return this.svc.effectiveness(u.orgId);
  }
}
