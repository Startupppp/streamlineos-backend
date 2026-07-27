import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ApprovalsService } from "./approvals.service";
import {
  approvalActionSchema,
  rejectActionSchema,
  type ApprovalActionInput,
  type RejectActionInput,
} from "./dto/payout.schemas";

@RequireModule("payroll")
@Controller("payroll/runs/:runId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post("submit-approval")
  @HttpCode(200)
  @RequirePermission("payroll:runs:update")
  submitApproval(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.submitApproval(u.orgId, u.userId, runId);
  }

  @Get("approvals")
  @RequirePermission("payroll:runs:view")
  listApprovals(
    @Param("runId", ParseIntPipe) runId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u.orgId, runId, u.userId);
  }

  @Post("approvals/:approvalId/approve")
  @HttpCode(200)
  @RequirePermission("payroll:runs:approve")
  approveStage(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body(new ZodValidationPipe(approvalActionSchema)) body: ApprovalActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.approveStage(u.orgId, u.userId, runId, approvalId, body.comment);
  }

  @Post("approvals/:approvalId/reject")
  @HttpCode(200)
  @RequirePermission("payroll:runs:approve")
  rejectStage(
    @Param("runId", ParseIntPipe) runId: number,
    @Param("approvalId", ParseIntPipe) approvalId: number,
    @Body(new ZodValidationPipe(rejectActionSchema)) body: RejectActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.rejectStage(u.orgId, u.userId, runId, approvalId, body.comment);
  }
}
