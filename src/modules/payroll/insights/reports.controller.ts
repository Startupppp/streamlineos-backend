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
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { ReportsService } from "./reports.service";
import { buildCsv } from "./lib/csv";

function defaultMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function requireExport(u: CurrentUserContext): void {
  if (!u.permissions.includes("payroll:reports:export")) {
    throw new ForbiddenException("Permission denied: payroll:reports:export required");
  }
}

function setCsvHeaders(res: Response, name: string): void {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
}

@Controller("payroll/reports")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission("payroll:reports:view")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("summary")
  async getSummary(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getSummary(u.orgId, month);
    if (format === "csv") {
      requireExport(u);
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
  async getRegister(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("department") department: string | undefined,
    @Query("costCenter") costCenter: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getRegister(u.orgId, month, { department, costCenter, workerType });
    if (format === "csv") {
      requireExport(u);
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
  async getDepartmentCost(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("department") department: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getDepartmentCost(u.orgId, month, { department, workerType });
    if (format === "csv") {
      requireExport(u);
      const headers = ["department", "employeeCount", "grossTotal", "netTotal", "employerCostTotal"];
      const rows = result.rows.map((r) => [r.department, r.employeeCount, r.grossTotal, r.netTotal, r.employerCostTotal]);
      setCsvHeaders(res, `payroll-department-cost-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("cost-center")
  async getCostCenter(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("costCenter") costCenter: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getCostCenter(u.orgId, month, { costCenter, workerType });
    if (format === "csv") {
      requireExport(u);
      const headers = ["costCenter", "employeeCount", "grossTotal", "netTotal"];
      const rows = result.rows.map((r) => [r.costCenter, r.employeeCount, r.grossTotal, r.netTotal]);
      setCsvHeaders(res, `payroll-cost-center-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("earnings")
  async getEarnings(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("department") department: string | undefined,
    @Query("costCenter") costCenter: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getEarnings(u.orgId, month, { department, costCenter, workerType });
    if (format === "csv") {
      requireExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-earnings-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("deductions")
  async getDeductions(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("department") department: string | undefined,
    @Query("costCenter") costCenter: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getDeductions(u.orgId, month, { department, costCenter, workerType });
    if (format === "csv") {
      requireExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-deductions-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("reimbursements")
  async getReimbursements(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("department") department: string | undefined,
    @Query("costCenter") costCenter: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getReimbursements(u.orgId, month, { department, costCenter, workerType });
    if (format === "csv") {
      requireExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-reimbursements-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("tax")
  async getTax(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @Query("department") department: string | undefined,
    @Query("costCenter") costCenter: string | undefined,
    @Query("workerType") workerType: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getTax(u.orgId, month, { department, costCenter, workerType });
    if (format === "csv") {
      requireExport(u);
      const headers = ["employeeId", "name", "department", "workerType", ...result.columns];
      const rows = result.rows.map((r) => [r.employeeId, r.name, r.department, r.workerType, ...result.columns.map((c) => r.components[c] ?? "0")]);
      setCsvHeaders(res, `payroll-tax-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }

  @Get("bank-payout")
  async getBankPayout(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getBankPayout(u.orgId, month);
    if (format === "csv") {
      requireExport(u);
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
  async getVariance(
    @Query("month") month: string = defaultMonth(),
    @Query("format") format: string = "json",
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getVariance(u.orgId, month);
    if (format === "csv") {
      requireExport(u);
      const headers = ["userId", "name", "prevGross", "currGross", "grossDelta", "prevNet", "currNet", "netDelta"];
      const rows = result.perEmployee.map((r) => [r.userId, r.name, r.prevGross, r.currGross, r.grossDelta, r.prevNet, r.currNet, r.netDelta]);
      setCsvHeaders(res, `payroll-variance-${month}`);
      return buildCsv(headers, rows);
    }
    return result;
  }
}
