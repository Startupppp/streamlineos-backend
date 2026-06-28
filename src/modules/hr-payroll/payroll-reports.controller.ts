import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
<<<<<<< HEAD
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
=======
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { requireAuthorize } from "../../common/access/authorize";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccessService } from "../access/access.service";
import { PayrollsService } from "./payrolls.service";
import { CompensationService } from "./compensation.service";
import {
  accountingExportSchema,
  payrollReportsQuerySchema,
  payslipsQuerySchema,
  taxCalcSchema,
  type AccountingExportInput,
  type PayrollReportsQueryInput,
  type PayslipsQueryInput,
  type TaxCalcInput,
} from "./dto/payroll.schemas";

@Controller("hr")
@UseGuards(JwtAuthGuard)
export class PayrollReportsController {
  constructor(
    private readonly payrolls: PayrollsService,
    private readonly compensation: CompensationService,
    private readonly access: AccessService,
  ) {}

  @Get("payroll-reports")
<<<<<<< HEAD
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payrolls:read")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  payrollReports(
    @Query(new ZodValidationPipe(payrollReportsQuerySchema)) query: PayrollReportsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:view", requiredModule: "hr" });
    const year = Number(query.year) || new Date().getFullYear();
    const reportType = query.type || "summary";
    return this.payrolls.getPayrollReports(u.orgId, year, reportType);
  }

  @Get("payslips")
  async payslips(
    @Query(new ZodValidationPipe(payslipsQuerySchema)) query: PayslipsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
<<<<<<< HEAD
    let canViewAll = u.isOrgOwner || u.isPlatformAdmin;
    if (!canViewAll) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      canViewAll = perms.has("hr:payroll:read");
    }
=======
    const canViewAll =
      u.isPlatformAdmin ||
      u.isOrgOwner ||
      (u.permissions ?? []).includes("hr:payroll:view");
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
    const requestedId = query.userId;

    if (requestedId && requestedId !== u.userId && !canViewAll) {
      throw new ForbiddenException("Forbidden");
    }

    const userId = canViewAll && requestedId ? requestedId : u.userId;
    return this.payrolls.getEmployeePayslips(u.orgId, userId);
  }

  @Get("dashboard/payroll-summary")
<<<<<<< HEAD
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  payrollSummary(@CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "hr:payroll:view", requiredModule: "hr" });
    return this.compensation.getPayrollSummary(u.orgId);
  }

  @Get("dashboard/salary-bands")
  async salaryBands(@CurrentUser() u: CurrentUserContext) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("hr:salary:manage")) {
        throw new ForbiddenException("Forbidden");
      }
    }
    return this.compensation.getSalaryBands(u.orgId);
  }

  @Get("analytics/compensation")
<<<<<<< HEAD
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  compensationAnalytics(@CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "hr:payroll:view", requiredModule: "hr" });
    return this.compensation.getCompensationAnalytics(u.orgId);
  }

  @Post("tax-calculator")
  @HttpCode(200)
  taxCalculator(@Body(new ZodValidationPipe(taxCalcSchema)) body: TaxCalcInput) {
    return this.compensation.calculateTax(body);
  }

  @Post("integrations/accounting-export")
<<<<<<< HEAD
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:integrations:manage")
=======
>>>>>>> 8268f32a22460c71f19892e240ad061afc54b8c8
  @HttpCode(200)
  accountingExport(
    @Body(new ZodValidationPipe(accountingExportSchema)) body: AccountingExportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:manage", requiredModule: "hr" });
    return this.compensation.accountingExport(u.orgId, body);
  }
}
