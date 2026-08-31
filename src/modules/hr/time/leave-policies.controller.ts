import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { LeavePoliciesService } from "./leave-policies.service";
import { Validate } from "../../../common/validation/validate.decorator";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

const createLeavePolicySchema = z.object({
  leaveTypeId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  accrualType: z.string().optional(),
  accrualRate: z.string().min(1),
  maxBalance: z.string().optional(),
  carryForwardDays: z.string().optional(),
  carryForwardExpiryMonths: z.number().int().positive().optional(),
  encashable: z.boolean().optional(),
  probationRestricted: z.boolean().optional(),
  genderRestriction: z.string().optional(),
  appliesTo: z.string().optional(),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().optional(),
  isActive: z.boolean().optional(),
});

const updateLeavePolicySchema = createLeavePolicySchema.partial();

type CreateLeavePolicyBody = z.infer<typeof createLeavePolicySchema>;
type UpdateLeavePolicyBody = z.infer<typeof updateLeavePolicySchema>;

@UseGuards(JwtAuthGuard)
@Controller("hr/leave-policies")
export class LeavePoliciesController {
  constructor(private readonly service: LeavePoliciesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ body: createLeavePolicySchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateLeavePolicyBody,
  ) {
    return this.service.create(u.orgId, body);
  }

  @Patch(":policyId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: policyIdParams, body: updateLeavePolicySchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdateLeavePolicyBody,
  ) {
    return this.service.update(u.orgId, policyId, body);
  }

  @Delete(":policyId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: policyIdParams })
  remove(@CurrentUser() u: CurrentUserContext, @Param("policyId", ParseIntPipe) policyId: number) {
    return this.service.remove(u.orgId, policyId);
  }
}
