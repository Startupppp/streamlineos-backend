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
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { requireAuthorize } from "../../common/access/authorize";
import { hasRoleOrPrivileged } from "../../common/auth/role-access";
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
  payslips(
    @Query(new ZodValidationPipe(payslipsQuerySchema)) query: PayslipsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const canViewAll =
      u.isPlatformAdmin ||
      u.isOrgOwner ||
      (u.permissions ?? []).includes("hr:payroll:view");
    const requestedId = query.userId;

    if (requestedId && requestedId !== u.userId && !canViewAll) {
      throw new ForbiddenException("Forbidden");
    }

    const userId = canViewAll && requestedId ? requestedId : u.userId;
    return this.payrolls.getEmployeePayslips(u.orgId, userId);
  }

  @Get("dashboard/payroll-summary")
  payrollSummary(@CurrentUser() u: CurrentUserContext) {
    requireAuthorize(u, { permission: "hr:payroll:view", requiredModule: "hr" });
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
  @HttpCode(200)
  accountingExport(
    @Body(new ZodValidationPipe(accountingExportSchema)) body: AccountingExportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    requireAuthorize(u, { permission: "hr:payroll:manage", requiredModule: "hr" });
    return this.compensation.accountingExport(u.orgId, body);
  }
}
