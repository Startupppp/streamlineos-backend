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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

const SALARY_BAND_ROLES = ["CEO", "ADMIN", "HR", "BRANCH_HR"];

@Controller("hr")
@UseGuards(JwtAuthGuard)
export class PayrollReportsController {
  constructor(
    private readonly payrolls: PayrollsService,
    private readonly compensation: CompensationService,
  ) {}

  @Get("payroll-reports")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payrolls:read")
  payrollReports(
    @Query(new ZodValidationPipe(payrollReportsQuerySchema)) query: PayrollReportsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const year = Number(query.year) || new Date().getFullYear();
    const reportType = query.type || "summary";
    return this.payrolls.getPayrollReports(u.orgId, year, reportType);
  }

  @Get("payslips")
  payslips(
    @Query(new ZodValidationPipe(payslipsQuerySchema)) query: PayslipsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const ability = defineAbilityFor({
      isPlatformAdmin: u.isPlatformAdmin,
      isOrgOwner: u.isOrgOwner,
      permissions: u.permissions,
      enabledModules: u.enabledModules,
    });
    const canViewAll = ability.can("read", "hr:payroll");
    const requestedId = query.userId;

    if (requestedId && requestedId !== u.userId && !canViewAll) {
      throw new ForbiddenException("Forbidden");
    }

    const userId = canViewAll && requestedId ? requestedId : u.userId;
    return this.payrolls.getEmployeePayslips(u.orgId, userId);
  }

  @Get("dashboard/payroll-summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  payrollSummary(@CurrentUser() u: CurrentUserContext) {
    return this.compensation.getPayrollSummary(u.orgId);
  }

  @Get("dashboard/salary-bands")
  salaryBands(@CurrentUser() u: CurrentUserContext) {
    if (!hasRoleOrPrivileged(u, SALARY_BAND_ROLES)) {
      throw new ForbiddenException("Forbidden");
    }
    return this.compensation.getSalaryBands(u.orgId);
  }

  @Get("analytics/compensation")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  compensationAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.compensation.getCompensationAnalytics(u.orgId);
  }

  @Post("tax-calculator")
  @HttpCode(200)
  taxCalculator(@Body(new ZodValidationPipe(taxCalcSchema)) body: TaxCalcInput) {
    return this.compensation.calculateTax(body);
  }

  @Post("integrations/accounting-export")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:integrations:manage")
  @HttpCode(200)
  accountingExport(
    @Body(new ZodValidationPipe(accountingExportSchema)) body: AccountingExportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.compensation.accountingExport(u.orgId, body);
  }
}
