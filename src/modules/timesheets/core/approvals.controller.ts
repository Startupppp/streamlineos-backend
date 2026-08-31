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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsBulkService } from "./approvals-bulk.service";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
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
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("timesheets/approvals")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly approvalsBulk: ApprovalsBulkService,
  ) {}

  @Get()
  @RequirePermission("timesheets:approvals:view")
  @Validate({ query: approvalsQuerySchema })
  list(
    @Query() query: ApprovalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.listApprovals(u, query);
  }

  @Post("bulk-approve")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Idempotent("timesheets.approval.bulk_approve")
  @Validate({ body: bulkApproveSchema })
  bulkApprove(
    @Body() body: BulkApproveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvalsBulk.bulkApprove(u, body);
  }

  @Post("bulk-reject")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Idempotent("timesheets.approval.bulk_reject")
  @Validate({ body: bulkRejectSchema })
  bulkReject(
    @Body() body: BulkRejectInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvalsBulk.bulkReject(u, body);
  }

  @Post(":periodId/approve")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Idempotent("timesheets.approval.approve")
  @Validate({ params: periodIdParams })
  approve(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvals.approvePeriod(u, periodId);
  }

  @Post(":periodId/reject")
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Idempotent("timesheets.approval.reject")
  @Validate({ params: periodIdParams, body: rejectPeriodSchema })
  reject(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Body() body: RejectPeriodInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.approvalsBulk.rejectPeriod(u, periodId, body);
  }
}
