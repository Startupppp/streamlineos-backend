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
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { ManagerInboxService } from "./manager-inbox.service";
import { TeamRewardsService } from "./team-rewards.service";
import { managerRejectSchema, type ManagerReject } from "./dto/insights.schemas";

@Controller("payroll/manager")
@UseGuards(JwtAuthGuard, PermissionGuard)
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
  getReportRewards(
    @CurrentUser() u: CurrentUserContext,
    @Param("userId") userId: string,
  ) {
    return this.teamRewards.getReportTotalRewards(u.orgId, u.userId, userId);
  }

  @Post("reimbursements/:id/approve")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  approveReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.inbox.approveReimbursement(u.orgId, u.userId, id);
  }

  @Post("reimbursements/:id/reject")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  rejectReimbursement(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(managerRejectSchema)) body: ManagerReject,
  ) {
    return this.inbox.rejectReimbursement(u.orgId, u.userId, id, body.reason);
  }

  @Post("loans/:id/approve")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  approveLoan(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.inbox.approveLoan(u.orgId, u.userId, id);
  }

  @Post("loans/:id/reject")
  @HttpCode(200)
  @RequirePermission("self:payroll")
  rejectLoan(
    @CurrentUser() u: CurrentUserContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.inbox.rejectLoan(u.orgId, u.userId, id);
  }
}
