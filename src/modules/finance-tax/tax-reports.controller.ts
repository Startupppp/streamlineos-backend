import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TaxReportsService, type OutputTaxLine, type InputTaxLine } from "./tax-reports.service";
import { taxDateRangeQuerySchema, type TaxDateRangeQuery } from "./dto/tax-reports.schemas";

function toCsvRow(line: OutputTaxLine | InputTaxLine): string {
  return [
    line.docNumber,
    line.date,
    `"${line.partyName.replace(/"/g, '""')}"`,
    line.taxableValue,
    line.gstRate,
    line.cgst,
    line.sgst,
    line.igst,
    line.total,
    line.sourceType,
    String(line.sourceId),
  ].join(",");
}

const CSV_HEADER = "Doc Number,Date,Party Name,Taxable Value,GST Rate,CGST,SGST,IGST,Total,Source Type,Source ID\n";

@RequireModule("accounting")
@Controller("accounting/taxes/reports")
@UseGuards(JwtAuthGuard)
export class TaxReportsController {
  constructor(private readonly reports: TaxReportsService) {}

  @Get("output")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  async outputReport(
    @Query(new ZodValidationPipe(taxDateRangeQuerySchema)) query: TaxDateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getOutputReport(u.orgId, query);
    if (query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="output-tax-${query.from}-${query.to}.csv"`);
      const rows = (result.items as OutputTaxLine[]).map(toCsvRow).join("\n");
      return res.send(CSV_HEADER + rows);
    }
    return result;
  }

  @Get("input")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  async inputReport(
    @Query(new ZodValidationPipe(taxDateRangeQuerySchema)) query: TaxDateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getInputReport(u.orgId, query);
    if (query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="input-tax-${query.from}-${query.to}.csv"`);
      const rows = (result.items as InputTaxLine[]).map(toCsvRow).join("\n");
      return res.send(CSV_HEADER + rows);
    }
    return result;
  }

  @Get("liability-summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  liabilitySummary(
    @Query(new ZodValidationPipe(taxDateRangeQuerySchema)) query: TaxDateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getLiabilitySummary(u.orgId, query);
  }
}
