import { Controller, Get, Param, ParseIntPipe, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { StatementReportsService } from "./statement-reports.service";
import { buildCsv } from "./finance-reports-csv.util";
import { dateRangeSchema, type DateRangeQuery } from "./dto/finance-reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();
const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class StatementReportsController {
  constructor(private readonly statementsService: StatementReportsService) {}

  @Get("vendor-statement/:vendorId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ params: vendorIdParams })
  getVendorStatement(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.vendorStatement(u.orgId, vendorId, query.from, query.to);
  }

  @Get("vendor-statement/:vendorId/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  @Validate({ params: vendorIdParams })
  async exportVendorStatement(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.statementsService.vendorStatement(u.orgId, vendorId, query.from, query.to);
    const csv = buildCsv(
      ["Date", "Doc Type", "Doc Number", "Debit", "Credit", "Running Balance"],
      data.lines.map((l) => [l.date, l.docType, l.docNumber, l.debit, l.credit, l.runningBalance]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="vendor-statement-${vendorId}.csv"`);
    res.send(csv);
  }

  @Get("customer-statement/:clientId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ params: clientIdParams })
  getCustomerStatement(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.customerStatement(u.orgId, clientId, query.from, query.to);
  }

  @Get("customer-statement/:clientId/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  @Validate({ params: clientIdParams })
  async exportCustomerStatement(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.statementsService.customerStatement(u.orgId, clientId, query.from, query.to);
    const csv = buildCsv(
      ["Date", "Doc Type", "Doc Number", "Debit", "Credit", "Running Balance"],
      data.lines.map((l) => [l.date, l.docType, l.docNumber, l.debit, l.credit, l.runningBalance]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="customer-statement-${clientId}.csv"`);
    res.send(csv);
  }

  @Get("sales-by-customer")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getSalesByCustomer(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.salesByCustomer(u.orgId, query.from, query.to);
  }

  @Get("sales-by-customer/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  async exportSalesByCustomer(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.statementsService.salesByCustomer(u.orgId, query.from, query.to);
    const csv = buildCsv(
      ["Client ID", "Client Name", "Invoice Count", "Total Billed", "Total Paid", "Outstanding"],
      data.map((r) => [r.clientId, r.clientName, r.invoiceCount, r.totalBilled, r.totalPaid, r.outstanding]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sales-by-customer.csv"`);
    res.send(csv);
  }

  @Get("sales-by-item")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getSalesByItem(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.salesByItem(u.orgId, query.from, query.to);
  }

  @Get("sales-by-item/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  async exportSalesByItem(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.statementsService.salesByItem(u.orgId, query.from, query.to);
    const csv = buildCsv(
      ["Description", "Total Quantity", "Total Amount", "Invoice Count"],
      data.map((r) => [r.description, r.totalQuantity, r.totalAmount, r.invoiceCount]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="sales-by-item.csv"`);
    res.send(csv);
  }

  @Get("expense-by-category")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getExpenseByCategory(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.expenseByCategory(u.orgId, query.from, query.to);
  }

  @Get("expense-by-category/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  async exportExpenseByCategory(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.statementsService.expenseByCategory(u.orgId, query.from, query.to);
    const csv = buildCsv(
      ["Category ID", "Category Name", "Total Amount", "Count"],
      data.map((r) => [r.categoryId, r.categoryName, r.totalAmount, r.count]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="expense-by-category.csv"`);
    res.send(csv);
  }

  @Get("tax-summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  getTaxSummary(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.taxSummary(u.orgId, query.from, query.to);
  }

  @Get("tax-summary/export")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:export")
  async exportTaxSummary(
    @Query(new ZodValidationPipe(dateRangeSchema)) query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const data = await this.statementsService.taxSummary(u.orgId, query.from, query.to);
    const csv = buildCsv(
      ["Month", "Output CGST", "Output SGST", "Output IGST", "Input CGST", "Input SGST", "Input IGST", "Net Payable"],
      data.map((r) => [r.month, r.outputCgst, r.outputSgst, r.outputIgst, r.inputCgst, r.inputSgst, r.inputIgst, r.netPayable]),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tax-summary.csv"`);
    res.send(csv);
  }
}
