import {
  Controller,
  Get,
  Query,
  Res,
  ForbiddenException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { authorize } from "../../access/authorize";
import { ApiOkResponse } from "@nestjs/swagger";
import { Validate } from "../../../common/validation/validate.decorator";
import { ReportsService } from "./reports.service";
import { buildCsv } from "./lib/csv";
import { reportsQuerySchema, reportsSummaryQuerySchema, type ReportsQuery, type ReportsSummaryQuery } from "./dto/insights.schemas";
import {
  summaryReportSchema,
  employeeRegisterReportSchema,
  departmentCostReportSchema,
  costCenterReportSchema,
  bankPayoutReportSchema,
  varianceReportSchema,
} from "./dto/reports-response-schemas";

function defaultMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function setCsvHeaders(res: Response, name: string): void {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
}

function pagination(q: ReportsQuery): { limit: number; cursor?: string } {
  return { limit: q.limit ?? 100, cursor: q.cursor };
}

@RequireModule("payroll")
@Controller("payroll/reports")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequirePermission("payroll:reports:view")
export class PayrollInsightsReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly access: AccessService,
  ) {}

  private async assertExport(u: CurrentUserContext): Promise<void> {
    const check = await authorize(this.access, u, "payroll:reports:export");
    if (!check.allow) throw new ForbiddenException("Permission denied: payroll:reports:export required");
  }

  @Get("summary")
  @Validate({ query: reportsSummaryQuerySchema })
  @ApiOkResponse({ schema: summaryReportSchema })
  async getSummary(
    @Query() q: ReportsSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getSummary(u.orgId, month);
    if (q.format === "csv") {
      await this.assertExport(u);
      const run = result.run;
      const headers = ["month", "status", "employeeCount", "grossTotal", "deductionTotal", "netTotal", "employerCostTotal", "exceptionCount"];
      const rows = run
        ? [[run.month, run.status, run.employeeCount, run.grossTotal, run.deductionTotal, run.netTotal, run.employerCostTotal, run.exceptionCount]]
        : [];
      setCsvHeaders(res, `payroll-summary-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("register")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: employeeRegisterReportSchema })
  async getRegister(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getRegister(u.orgId, month, { department: q.department, costCenter: q.costCenter, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["employeeId", "name", "department", "workerType", "paidDays", "gross", "totalDeductions", "net", ...result.columns];
      const rows = result.rows.map((r) => [
        r.employeeId, r.name, r.department, r.workerType, r.paidDays, r.gross, r.totalDeductions, r.net,
        ...result.columns.map((c) => r.components[c] ?? "0"),
      ]);
      setCsvHeaders(res, `payroll-register-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("department-cost")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: departmentCostReportSchema })
  async getDepartmentCost(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getDepartmentCost(u.orgId, month, { department: q.department, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["department", "employeeCount", "grossTotal", "netTotal", "employerCostTotal"];
      const rows = result.rows.map((r) => [r.department, r.employeeCount, r.grossTotal, r.netTotal, r.employerCostTotal]);
      setCsvHeaders(res, `payroll-department-cost-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("cost-center")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: costCenterReportSchema })
  async getCostCenter(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getCostCenter(u.orgId, month, { costCenter: q.costCenter, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["costCenter", "employeeCount", "grossTotal", "netTotal"];
      const rows = result.rows.map((r) => [r.costCenter, r.employeeCount, r.grossTotal, r.netTotal]);
      setCsvHeaders(res, `payroll-cost-center-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("earnings")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: employeeRegisterReportSchema })
  async getEarnings(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getEarnings(u.orgId, month, { department: q.department, costCenter: q.costCenter, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-earnings-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("deductions")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: employeeRegisterReportSchema })
  async getDeductions(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getDeductions(u.orgId, month, { department: q.department, costCenter: q.costCenter, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-deductions-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("reimbursements")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: employeeRegisterReportSchema })
  async getReimbursements(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getReimbursements(u.orgId, month, { department: q.department, costCenter: q.costCenter, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-reimbursements-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("tax")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: employeeRegisterReportSchema })
  async getTax(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getTax(u.orgId, month, { department: q.department, costCenter: q.costCenter, workerType: q.workerType }, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-tax-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("bank-payout")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: bankPayoutReportSchema })
  async getBankPayout(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getBankPayout(u.orgId, month, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["batchNumber", "format", "totalAmount", "itemCount", "status", "generatedAt", "userName", "accountMasked", "ifsc", "amount", "itemStatus"];
      const rows = result.batches.flatMap((b) =>
        b.items.length > 0
          ? b.items.map((item) => [b.batchNumber, b.format, b.totalAmount, b.itemCount, b.status, b.generatedAt.toISOString(), item.userName, item.accountMasked, item.ifsc, item.amount, item.status])
          : [[b.batchNumber, b.format, b.totalAmount, b.itemCount, b.status, b.generatedAt.toISOString(), null, null, null, null, null]],
      );
      setCsvHeaders(res, `payroll-bank-payout-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("variance")
  @Validate({ query: reportsQuerySchema })
  @ApiOkResponse({ schema: varianceReportSchema })
  async getVariance(
    @Query() q: ReportsQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const month = q.month ?? defaultMonth();
    const result = await this.reports.getVariance(u.orgId, month, pagination(q));
    if (q.format === "csv") {
      await this.assertExport(u);
      const headers = ["userId", "name", "prevGross", "currGross", "grossDelta", "prevNet", "currNet", "netDelta"];
      const rows = result.perEmployee.map((r) => [r.userId, r.name, r.prevGross, r.currGross, r.grossDelta, r.prevNet, r.currNet, r.netDelta]);
      setCsvHeaders(res, `payroll-variance-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }
}
