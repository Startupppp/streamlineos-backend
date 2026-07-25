import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PayrollInputsService } from "./payroll-inputs.service";
import {
  createPeriodSchema,
  listPeriodsSchema,
  sectionQuerySchema,
  createAdjustmentSchema,
  rejectAdjustmentSchema,
} from "./dto/payroll-inputs.schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

type RequestWithUser = { user: CurrentUserContext };

@RequireModule("hr")
@Controller("hr/payroll-inputs")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollInputsController {
  constructor(private readonly service: PayrollInputsService) {}

  @Get("periods")
  @RequirePermission("hr:payroll:view")
  async listPeriods(@Req() req: RequestWithUser, @Query() query: Record<string, string>) {
    const input = listPeriodsSchema.parse(query);
    return this.service.listPeriods(req.user.orgId, input);
  }

  @Post("periods")
  @RequirePermission("hr:payroll:generate")
  async createPeriod(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = createPeriodSchema.parse(body);
    return this.service.createPeriod(req.user.orgId, req.user.userId, input);
  }

  @Get("periods/:periodId")
  @RequirePermission("hr:payroll:view")
  async getPeriod(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
  ) {
    return this.service.getPeriod(req.user.orgId, periodId);
  }

  @Post("periods/:periodId/build")
  @RequirePermission("hr:payroll:generate")
  async buildPeriod(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
  ) {
    return this.service.buildPeriod(req.user.orgId, req.user.userId, periodId);
  }

  @Post("periods/:periodId/lock")
  @RequirePermission("hr:payroll:lock")
  async lockPeriod(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
  ) {
    return this.service.lockPeriod(req.user.orgId, req.user.userId, periodId);
  }

  @Post("periods/:periodId/unlock")
  @RequirePermission("hr:payroll:reopen")
  async unlockPeriod(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
  ) {
    return this.service.unlockPeriod(req.user.orgId, req.user.userId, periodId);
  }

  @Get("periods/:periodId/attendance")
  @RequirePermission("hr:payroll:view")
  async getAttendance(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: Record<string, string>,
  ) {
    const input = sectionQuerySchema.parse(query);
    return this.service.getSectionSnapshot(req.user.orgId, periodId, "attendance", input);
  }

  @Get("periods/:periodId/leaves")
  @RequirePermission("hr:payroll:view")
  async getLeaves(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: Record<string, string>,
  ) {
    const input = sectionQuerySchema.parse(query);
    return this.service.getSectionSnapshot(req.user.orgId, periodId, "leave", input);
  }

  @Get("periods/:periodId/overtime")
  @RequirePermission("hr:payroll:view")
  async getOvertime(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: Record<string, string>,
  ) {
    const input = sectionQuerySchema.parse(query);
    return this.service.getSectionSnapshot(req.user.orgId, periodId, "overtime", input);
  }

  @Get("periods/:periodId/reimbursements")
  @RequirePermission("hr:payroll:view")
  async getReimbursements(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: Record<string, string>,
  ) {
    const input = sectionQuerySchema.parse(query);
    return this.service.getSectionSnapshot(req.user.orgId, periodId, "reimbursement", input);
  }

  @Get("periods/:periodId/adjustments")
  @RequirePermission("hr:payroll:view")
  async getAdjustments(
    @Req() req: RequestWithUser,
    @Param("periodId", ParseIntPipe) periodId: number,
    @Query() query: Record<string, string>,
  ) {
    const input = sectionQuerySchema.parse(query);
    return this.service.listAdjustments(req.user.orgId, periodId, input);
  }

  @Post("adjustments")
  @RequirePermission("hr:payroll:generate")
  async createAdjustment(@Req() req: RequestWithUser, @Body() body: unknown) {
    const input = createAdjustmentSchema.parse(body);
    return this.service.createAdjustment(req.user.orgId, req.user.userId, input);
  }

  @Patch("adjustments/:adjustmentId/approve")
  @RequirePermission("hr:payroll:approve")
  async approveAdjustment(
    @Req() req: RequestWithUser,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
  ) {
    return this.service.approveAdjustment(req.user.orgId, req.user.userId, adjustmentId);
  }

  @Patch("adjustments/:adjustmentId/reject")
  @RequirePermission("hr:payroll:approve")
  async rejectAdjustment(
    @Req() req: RequestWithUser,
    @Param("adjustmentId", ParseIntPipe) adjustmentId: number,
    @Body() body: unknown,
  ) {
    const input = rejectAdjustmentSchema.parse(body);
    return this.service.rejectAdjustment(req.user.orgId, req.user.userId, adjustmentId, input.reason);
  }
}
