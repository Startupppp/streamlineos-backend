import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isStructuralOrgAdminContext } from "../../common/rbac/is-structural-org-admin";
import { DealsApprovalsService } from "./deals-approvals.service";
import {
  approvalsListSchema,
  createApprovalRuleSchema,
  submitApprovalSchema,
  type ApprovalsListInput,
  type CreateApprovalRuleInput,
  type SubmitApprovalInput,
} from "./dto/deals.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";

@RequireModule("crm")
@Controller("deals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class DealsApprovalsController {
  constructor(private readonly approvals: DealsApprovalsService) {}

  @Get("approval-rules")
  @RequirePermission("crm:deals:read")
  listRules(@CurrentUser() u: CurrentUserContext) {
    return this.approvals.listRules(u.orgId);
  }

  @Post("approval-rules")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  @Validate({ body: createApprovalRuleSchema })
  createRule(
    @Body() body: CreateApprovalRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.createRule(u.orgId, body);
  }

  @Get("approvals")
  @RequirePermission("crm:deals:read")
  @Validate({ query: approvalsListSchema })
  listApprovals(
    @Query() query: ApprovalsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u.orgId, query);
  }

  @Post("approvals")
  @RequirePermission("crm:deals:update")
  @Validate({ body: submitApprovalSchema })
  async submitApproval(
    @Body() body: SubmitApprovalInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    if ("approvalId" in body) {
      if (!isStructuralOrgAdminContext(u)) {
        throw new ForbiddenException("Only admins can resolve approvals");
      }
      const updated = await this.approvals.resolveApproval(u.orgId, u.userId, body);
      res.status(200);
      return updated;
    }

    const outcome = await this.approvals.requestApproval(u.orgId, u.userId, body);
    res.status(outcome.created ? 201 : 200);
    return outcome.body;
  }
}
