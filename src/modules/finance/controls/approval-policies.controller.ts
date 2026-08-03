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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ApprovalPoliciesService } from "./approval-policies.service";
import {
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
  type CreateApprovalPolicyInput,
  type UpdateApprovalPolicyInput,
} from "./dto/finance-controls.schemas";
import { z } from "zod";

const listPoliciesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

@RequireModule("accounting")
@Controller("accounting/approval-policies")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalPoliciesController {
  constructor(private readonly svc: ApprovalPoliciesService) {}

  @Get()
  @RequirePermission("accounting:approvals:read")
  list(
    @Query(new ZodValidationPipe(listPoliciesSchema)) query: { page: number; pageSize: number },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query.page, query.pageSize);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:settings:manage")
  async create(
    @Body(new ZodValidationPipe(createApprovalPolicySchema)) body: CreateApprovalPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.svc.assertPolicyMinAmountValid(body);
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":policyId")
  @RequirePermission("accounting:settings:manage")
  update(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(updateApprovalPolicySchema)) body: UpdateApprovalPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, policyId, body);
  }

  @Delete(":policyId")
  @RequirePermission("accounting:settings:manage")
  remove(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.remove(u.orgId, u.userId, policyId);
  }
}
