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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { ManagerInboxService } from "./manager-inbox.service";
import { TeamRewardsService } from "./team-rewards.service";
import { managerRejectSchema, type ManagerReject } from "./dto/insights.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const userIdParams = z.object({ userId: z.string().min(1) }).strict();
const reimbursementIdParams = z.object({ reimbursementId: z.coerce.number().int().positive() }).strict();
const loanIdParams = z.object({ loanId: z.coerce.number().int().positive() }).strict();

@RequireModule("payroll")
@Controller("payroll/manager")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ManagerInboxController {
  constructor(
    private readonly inbox: ManagerInboxService,
    private readonly teamRewards: TeamRewardsService,
  ) {}

  /**
   * Direct-report payroll signals for the current manager.
   */
  @Get("inbox")
  @RequirePermission("self:payroll")
  getInbox(@CurrentUser() u: CurrentUserContext) {
    return this.inbox.getInbox(u.orgId, u.userId);
  }

  /** Illustrative team total-rewards + CTC pay compression for direct reports. */
  @Get("team-rewards")
  @RequirePermission("self:payroll")
  getTeamRewards(@CurrentUser() u: CurrentUserContext) {
    return this.teamRewards.getTeamRewards(u.orgId, u.userId);
  }

  /** Full total-rewards statement for one direct report. */
  @Get("team-rewards/:userId")
  @RequirePermission("self:payroll")
  @Validate({ params: userIdParams })
  getReportRewards(
    @CurrentUser() u: CurrentUserContext,
    @Param("userId") userId: string,
  ) {
    return this.teamRewards.getReportTotalRewards(u.orgId, u.userId, userId);
  }

  @Post("reimbursements/:reimbursementId/approve")
  @BodylessAction()
  @Idempotent("payroll.reimbursement.approve")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  @Validate({ params: reimbursementIdParams })
  approveReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Param("reimbursementId", ParseIntPipe) reimbursementId: number,
  ) {
    return this.inbox.approveReimbursement(u.orgId, u.userId, reimbursementId);
  }

  @Post("reimbursements/:reimbursementId/reject")
  @Idempotent("payroll.reimbursement.reject")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  @Validate({ params: reimbursementIdParams, body: managerRejectSchema })
  rejectReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Param("reimbursementId", ParseIntPipe) reimbursementId: number,
    @Body() body: ManagerReject,
  ) {
    return this.inbox.rejectReimbursement(
      u.orgId,
      u.userId,
      reimbursementId,
      body.reason,
    );
  }

  @Post("loans/:loanId/approve")
  @BodylessAction()
  @Idempotent("payroll.loan.approve")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  @Validate({ params: loanIdParams })
  approveLoan(
    @CurrentUser() u: CurrentUserContext,
    @Param("loanId", ParseIntPipe) loanId: number,
  ) {
    return this.inbox.approveLoan(u.orgId, u.userId, loanId);
  }

  @Post("loans/:loanId/reject")
  @BodylessAction()
  @Idempotent("payroll.loan.reject")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  @Validate({ params: loanIdParams })
  rejectLoan(
    @CurrentUser() u: CurrentUserContext,
    @Param("loanId", ParseIntPipe) loanId: number,
  ) {
    return this.inbox.rejectLoan(u.orgId, u.userId, loanId);
  }
}
