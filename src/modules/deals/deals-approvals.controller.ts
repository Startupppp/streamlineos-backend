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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
  createRule(
    @Body(new ZodValidationPipe(createApprovalRuleSchema)) body: CreateApprovalRuleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.createRule(u.orgId, body);
  }

  @Get("approvals")
  @RequirePermission("crm:deals:read")
  listApprovals(
    @Query(new ZodValidationPipe(approvalsListSchema)) query: ApprovalsListInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u.orgId, query);
  }

  @Post("approvals")
  @RequirePermission("crm:deals:update")
  async submitApproval(
    @Body(new ZodValidationPipe(submitApprovalSchema)) body: SubmitApprovalInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    if ("approvalId" in body) {
      if (!(u.isOrgOwner || u.isPlatformAdmin)) {
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
