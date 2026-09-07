import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  TaxReportsService,
  type OutputTaxLine,
  type InputTaxLine,
} from "./tax-reports.service";
import {
  taxDateRangeQuerySchema,
  type TaxDateRangeQuery,
} from "./dto/tax-reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { taxOutputReportResponseSchema, taxInputReportResponseSchema, taxLiabilitySummaryResponseSchema } from "./dto/tax-response.schemas";

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

const CSV_HEADER =
  "Doc Number,Date,Party Name,Taxable Value,GST Rate,CGST,SGST,IGST,Total,Source Type,Source ID\n";

@RequireModule("accounting")
@Controller("accounting/taxes/reports")
@UseGuards(JwtAuthGuard)
export class TaxReportsController {
  constructor(private readonly reports: TaxReportsService) {}

  @Get("output")
  @ResponseSchema(taxOutputReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  @Validate({ query: taxDateRangeQuerySchema })
  async outputReport(
    @Query() query: TaxDateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getOutputReport(u.orgId, query);
    if (query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="output-tax-${query.from}-${query.to}.csv"`,
      );
      const rows = (result.data as OutputTaxLine[]).map(toCsvRow).join("\n");
      return res.send(CSV_HEADER + rows);
    }
    return result;
  }

  @Get("input")
  @ResponseSchema(taxInputReportResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  @Validate({ query: taxDateRangeQuerySchema })
  async inputReport(
    @Query() query: TaxDateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.getInputReport(u.orgId, query);
    if (query.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="input-tax-${query.from}-${query.to}.csv"`,
      );
      const rows = (result.data as InputTaxLine[]).map(toCsvRow).join("\n");
      return res.send(CSV_HEADER + rows);
    }
    return result;
  }

  @Get("liability-summary")
  @ResponseSchema(taxLiabilitySummaryResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:taxes:read")
  @Validate({ query: taxDateRangeQuerySchema })
  liabilitySummary(
    @Query() query: TaxDateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reports.getLiabilitySummary(u.orgId, query);
  }
}
