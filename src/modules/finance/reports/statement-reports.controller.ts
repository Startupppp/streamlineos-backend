import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { StatementReportsService } from "./statement-reports.service";
import { dateRangeSchema, type DateRangeQuery } from "./dto/finance-reports.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  vendorStatementResponseSchema,
  customerStatementResponseSchema,
  salesByCustomerResponseSchema,
  salesByItemResponseSchema,
  expenseByCategoryResponseSchema,
  taxSummaryResponseSchema,
} from "./dto/finance-reports-response.schemas";

const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();
const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class StatementReportsController {
  constructor(private readonly statementsService: StatementReportsService) {}

  @Get("vendor-statement/:vendorId")
  @ResponseSchema(vendorStatementResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ params: vendorIdParams, query: dateRangeSchema })
  getVendorStatement(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.vendorStatement(u.orgId, vendorId, query.from, query.to);
  }

  @Get("customer-statement/:clientId")
  @ResponseSchema(customerStatementResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ params: clientIdParams, query: dateRangeSchema })
  getCustomerStatement(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.customerStatement(u.orgId, clientId, query.from, query.to);
  }

  @Get("sales-by-customer")
  @ResponseSchema(salesByCustomerResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: dateRangeSchema })
  getSalesByCustomer(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.salesByCustomer(u.orgId, query.from, query.to);
  }

  @Get("sales-by-item")
  @ResponseSchema(salesByItemResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: dateRangeSchema })
  getSalesByItem(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.salesByItem(u.orgId, query.from, query.to);
  }

  @Get("expense-by-category")
  @ResponseSchema(expenseByCategoryResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: dateRangeSchema })
  getExpenseByCategory(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.expenseByCategory(u.orgId, query.from, query.to);
  }

  @Get("tax-summary")
  @ResponseSchema(taxSummaryResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: dateRangeSchema })
  getTaxSummary(
    @Query() query: DateRangeQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.statementsService.taxSummary(u.orgId, query.from, query.to);
  }
}
