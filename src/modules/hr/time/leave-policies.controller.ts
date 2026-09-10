import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { LeavePoliciesService } from "./leave-policies.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { leavePolicyRowSchema } from "./dto/time-leave-response.schemas";
import {
  createLeavePolicySchema,
  updateLeavePolicySchema,
  type CreateLeavePolicyBody,
  type UpdateLeavePolicyBody,
} from "./dto/leaves.schemas";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/leave-policies")
export class LeavePoliciesController {
  constructor(private readonly service: LeavePoliciesService) {}

  @Get()
  @ResponseSchema(z.array(leavePolicyRowSchema))
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.service.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @ResponseSchema(leavePolicyRowSchema)
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
  @ResponseSchema(leavePolicyRowSchema)
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
  @NoContentResponse()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:leaves:manage")
  @Validate({ params: policyIdParams })
  remove(@CurrentUser() u: CurrentUserContext, @Param("policyId", ParseIntPipe) policyId: number) {
    return this.service.remove(u.orgId, policyId);
  }
}
