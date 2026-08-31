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
import { ApprovalPoliciesService } from "./approval-policies.service";
import {
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
  type CreateApprovalPolicyInput,
  type UpdateApprovalPolicyInput,
} from "./dto/finance-controls.schemas";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import { Validate } from "../../../common/validation/validate.decorator";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

const listPoliciesSchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});

@RequireModule("accounting")
@Controller("accounting/approval-policies")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalPoliciesController {
  constructor(private readonly svc: ApprovalPoliciesService) {}

  @Get()
  @RequirePermission("accounting:approvals:read")
  @Validate({ query: listPoliciesSchema })
  list(
    @Query() query: { page: number; pageSize: number },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query.page, query.pageSize);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:settings:manage")
  @Validate({ body: createApprovalPolicySchema })
  async create(
    @Body() body: CreateApprovalPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.svc.assertPolicyMinAmountValid(body);
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":policyId")
  @RequirePermission("accounting:settings:manage")
  @Validate({ params: policyIdParams, body: updateApprovalPolicySchema })
  update(
    @Param("policyId", ParseIntPipe) policyId: number,
    @Body() body: UpdateApprovalPolicyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, policyId, body);
  }

  @Delete(":policyId")
  @RequirePermission("accounting:settings:manage")
  @Validate({ params: policyIdParams })
  remove(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.remove(u.orgId, u.userId, policyId);
  }
}
