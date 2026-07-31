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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ExpensePoliciesService } from "./expense-policies.service";
import {
  createPolicySchema,
  updatePolicySchema,
  type CreatePolicyInput,
  type UpdatePolicyInput,
} from "./dto/finance-expenses.schemas";

@RequireModule("accounting")
@Controller("accounting/expenses/policies")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ExpensePoliciesController {
  constructor(private readonly policies: ExpensePoliciesService) {}

  @Get()
  @RequirePermission("accounting:reimbursements:read")
  async list(@CurrentUser() u: CurrentUserContext) {
    return this.policies.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:reimbursements:manage")
  async create(
    @Body(new ZodValidationPipe(createPolicySchema)) body: CreatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.policies.create(u.orgId, u.userId, body);
  }

  @Patch(":policyId")
  @RequirePermission("accounting:reimbursements:manage")
  async update(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body(new ZodValidationPipe(updatePolicySchema)) body: UpdatePolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.policies.update(u.orgId, u.userId, policyId, body);
  }

  @Delete(":policyId")
  @RequirePermission("accounting:reimbursements:manage")
  async remove(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.policies.remove(u.orgId, u.userId, policyId);
  }
}
