import {
  Body,
  Controller,
  Get,
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
import { Validate } from "../../../common/validation/validate.decorator";
import { PayrollInputsService } from "./payroll-inputs.service";
import {
  createPeriodSchema,
  listPeriodsSchema,
  sectionQuerySchema,
  createAdjustmentSchema,
  rejectAdjustmentSchema,
  type CreatePeriodInput,
  type ListPeriodsInput,
  type SectionQueryInput,
  type CreateAdjustmentInput,
} from "./dto/payroll-inputs.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

@RequireModule("hr")
@Controller("hr/payroll-inputs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollInputsController {
  constructor(private readonly service: PayrollInputsService) {}

  @Get("periods")
  @RequirePermission("hr:payroll:view")
  @Validate({ query: listPeriodsSchema })
  listPeriods(@Query() query: ListPeriodsInput, @CurrentUser() u: CurrentUserContext) {
    return this.service.listPeriods(u.orgId, query);
  }

  @Post("periods")
  @RequirePermission("hr:payroll:generate")
  @Validate({ body: createPeriodSchema })
  createPeriod(@Body() body: CreatePeriodInput, @CurrentUser() u: CurrentUserContext) {
    return this.service.createPeriod(u.orgId, u.userId, body);
  }

  @Get("periods/:periodId")
  @RequirePermission("hr:payroll:view")
  getPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getPeriod(u.orgId, periodId);
  }

  @Post("periods/:periodId/build")
  @RequirePermission("hr:payroll:generate")
  buildPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.buildPeriod(u.orgId, u.userId, periodId);
  }

  @Post("periods/:periodId/lock")
  @RequirePermission("hr:payroll:lock")
  lockPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.lockPeriod(u.orgId, u.userId, periodId);
  }

  @Post("periods/:periodId/unlock")
  @RequirePermission("hr:payroll:reopen")
  unlockPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.unlockPeriod(u.orgId, u.userId, periodId);
  }

  @Get("periods/:periodId/attendance")
  @RequirePermission("hr:payroll:view")
  @Validate({ query: sectionQuerySchema })
  getAttendance(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: SectionQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getSectionSnapshot(u.orgId, periodId, "attendance", query);
  }

  @Get("periods/:periodId/leaves")
  @RequirePermission("hr:payroll:view")
  @Validate({ query: sectionQuerySchema })
  getLeaves(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: SectionQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getSectionSnapshot(u.orgId, periodId, "leave", query);
  }

  @Get("periods/:periodId/overtime")
  @RequirePermission("hr:payroll:view")
  @Validate({ query: sectionQuerySchema })
  getOvertime(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: SectionQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getSectionSnapshot(u.orgId, periodId, "overtime", query);
  }

  @Get("periods/:periodId/reimbursements")
  @RequirePermission("hr:payroll:view")
  @Validate({ query: sectionQuerySchema })
  getReimbursements(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: SectionQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getSectionSnapshot(u.orgId, periodId, "reimbursement", query);
  }

  @Get("periods/:periodId/adjustments")
  @RequirePermission("hr:payroll:view")
  @Validate({ query: sectionQuerySchema })
  getAdjustments(
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: SectionQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listAdjustments(u.orgId, periodId, query);
  }

  @Post("adjustments")
  @Idempotent("payroll.adjustment.create")
  @RequirePermission("hr:payroll:generate")
  @Validate({ body: createAdjustmentSchema })
  createAdjustment(@Body() body: CreateAdjustmentInput, @CurrentUser() u: CurrentUserContext) {
    return this.service.createAdjustment(u.orgId, u.userId, body);
  }

  @Patch("adjustments/:adjustmentId/approve")
  @Idempotent("payroll.adjustment.approve")
  @RequirePermission("hr:payroll:approve")
  approveAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.approveAdjustment(u.orgId, u.userId, adjustmentId);
  }

  @Patch("adjustments/:adjustmentId/reject")
  @Idempotent("payroll.adjustment.reject")
  @RequirePermission("hr:payroll:approve")
  @Validate({ body: rejectAdjustmentSchema })
  rejectAdjustment(
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @Body() body: { reason: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.rejectAdjustment(u.orgId, u.userId, adjustmentId, body.reason);
  }
}
