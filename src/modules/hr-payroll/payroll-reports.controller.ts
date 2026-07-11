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
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PayrollReportsController {
  constructor(
    private readonly payrolls: PayrollsService,
    private readonly compensation: CompensationService,
    private readonly access: AccessService,
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
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:view")
  async payslips(
    @Query(new ZodValidationPipe(payslipsQuerySchema)) query: PayslipsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    let canViewAll = u.isOrgOwner || u.isPlatformAdmin;
    if (!canViewAll) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      canViewAll = perms.has("hr:payroll:read") || perms.has("hr:payroll:view") || perms.has("hr:payroll:approve");
    }
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
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:manage")
  salaryBands(@CurrentUser() u: CurrentUserContext) {
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
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:view")
  taxCalculator(
    @Body(new ZodValidationPipe(taxCalcSchema)) body: TaxCalcInput,
    @CurrentUser() _u: CurrentUserContext,
  ) {
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
