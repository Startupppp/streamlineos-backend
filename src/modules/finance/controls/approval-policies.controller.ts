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
  listPoliciesSchema,
  type CreateApprovalPolicyInput,
  type UpdateApprovalPolicyInput,
} from "./dto/finance-controls.schemas";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  approvalPolicyListResponseSchema,
  approvalPolicySchema,
  approvalPolicyDeleteResponseSchema,
} from "./dto/controls-response.schemas";

const policyIdParams = z.object({ policyId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/approval-policies")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalPoliciesController {
  constructor(private readonly svc: ApprovalPoliciesService) {}

  @Get()
  @ResponseSchema(approvalPolicyListResponseSchema)
  @RequirePermission("accounting:approvals:read")
  @Validate({ query: listPoliciesSchema })
  list(
    @Query() query: z.infer<typeof listPoliciesSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query.cursor, query.limit);
  }

  @Post()
  @ResponseSchema(approvalPolicySchema)
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
  @ResponseSchema(approvalPolicySchema)
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
  @ResponseSchema(approvalPolicyDeleteResponseSchema)
  @RequirePermission("accounting:settings:manage")
  @Validate({ params: policyIdParams })
  remove(
    @Param("policyId", ParseIntPipe) policyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.remove(u.orgId, u.userId, policyId);
  }
}
