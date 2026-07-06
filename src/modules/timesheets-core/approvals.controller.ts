import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ApprovalsService } from "./approvals.service";
import {
  approvalsQuerySchema,
  bulkApproveSchema,
  bulkRejectSchema,
  rejectPeriodSchema,
  type ApprovalsQuery,
  type BulkApproveInput,
  type BulkRejectInput,
  type RejectPeriodInput,
} from "./dto/approvals.schemas";

@Controller("timesheets/approvals")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermission("timesheets:approvals:view")
  list(
    @Query(new ZodValidationPipe(approvalsQuerySchema)) query: ApprovalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u, query);
  }

  @Post("bulk-approve")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  bulkApprove(
    @Body(new ZodValidationPipe(bulkApproveSchema)) body: BulkApproveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.bulkApprove(u, body);
  }

  @Post("bulk-reject")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  bulkReject(
    @Body(new ZodValidationPipe(bulkRejectSchema)) body: BulkRejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.bulkReject(u, body);
  }

  @Post(":periodId/approve")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  approve(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.approvePeriod(u, periodId);
  }

  @Post(":periodId/reject")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  reject(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Body(new ZodValidationPipe(rejectPeriodSchema)) body: RejectPeriodInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.rejectPeriod(u, periodId, body);
  }
}
