import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccountingPayablesService } from "./accounting-payables.service";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import { resolveAccountingJournalViewScope } from "./accounting-scope";
import {
  agedReceivablesQuerySchema,
  createPurchaseBillSchema,
  listCustomerLedgerQuerySchema,
  listCustomersOutstandingQuerySchema,
  listPurchaseBillsQuerySchema,
  listVendorsQuerySchema,
  recordVendorPaymentSchema,
  updatePurchaseBillStatusSchema,
  type AgedReceivablesQuery,
  type CreatePurchaseBillInput,
  type ListCustomerLedgerQuery,
  type ListCustomersOutstandingQuery,
  type ListPurchaseBillsQuery,
  type ListVendorsQuery,
  type RecordVendorPaymentInput,
  type UpdatePurchaseBillStatusInput,
} from "./dto/accounting.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { actingMembershipId } from "../../../common/auth/principal";

const billIdParams = z.object({ billId: z.coerce.number().int().positive() }).strict();
const vendorIdParams = z.object({ vendorId: z.coerce.number().int().positive() }).strict();
const clientIdParams = z.object({ clientId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard)
export class AccountingPayablesReceivablesController {
  constructor(
    private readonly payables: AccountingPayablesService,
    private readonly receivables: AccountingReceivablesService,
    private readonly access: AccessService,
  ) {}

  @Get("purchase-bills")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:read")
  @Validate({ query: listPurchaseBillsQuerySchema })
  async listPurchaseBills(
    @Query() query: ListPurchaseBillsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveAccountingJournalViewScope(this.access, u);
    return this.payables.listPurchaseBills(u.orgId, query, scope, actingMembershipId(u.principal));
  }

  @Post("purchase-bills")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:manage")
  @HttpCode(201)
  @Validate({ body: createPurchaseBillSchema })
  createPurchaseBill(
    @Body() body: CreatePurchaseBillInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.createPurchaseBill(u.orgId, u.userId, body);
  }

  @Get("purchase-bills/:billId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:read")
  @Validate({ params: billIdParams })
  getPurchaseBill(
    @Param("billId", ParseIntPipe) billId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.getPurchaseBill(u.orgId, billId);
  }

  @Patch("purchase-bills/:billId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:manage")
  @Validate({ params: billIdParams, body: updatePurchaseBillStatusSchema })
  updatePurchaseBill(
    @Param("billId", ParseIntPipe) billId: number,
    @Body() body: UpdatePurchaseBillStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.updatePurchaseBillStatus(u.orgId, u.userId, billId, body);
  }

  @Get("purchase-bills/:billId/payments")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:read")
  @Validate({ params: billIdParams })
  listBillPayments(
    @Param("billId", ParseIntPipe) billId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.listBillPayments(u.orgId, billId);
  }

  @Post("purchase-bills/:billId/payments")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:manage")
  @HttpCode(201)
  @Validate({ params: billIdParams, body: recordVendorPaymentSchema })
  recordBillPayment(
    @Param("billId", ParseIntPipe) billId: number,
    @Body() body: RecordVendorPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.recordBillPayment(u.orgId, u.userId, billId, body);
  }

  @Get("vendors")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: listVendorsQuerySchema })
  listVendors(
    @Query() query: ListVendorsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.listVendors(u.orgId, query);
  }

  @Get("vendors/:vendorId/ledger")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ params: vendorIdParams })
  vendorLedger(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.vendorLedger(u.orgId, vendorId);
  }

  @Get("customers")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: listCustomersOutstandingQuerySchema })
  listCustomers(
    @Query() query: ListCustomersOutstandingQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receivables.listCustomers(u.orgId, query);
  }

  @Get("customers/:clientId/ledger")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ params: clientIdParams, query: listCustomerLedgerQuerySchema })
  customerLedger(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query() query: ListCustomerLedgerQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receivables.customerLedger(u.orgId, clientId, query);
  }

  @Get("reports/aged-receivables")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: agedReceivablesQuerySchema })
  agedReceivables(
    @Query() query: AgedReceivablesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receivables.agedReceivables(u.orgId, query);
  }

  @Get("reports/aged-payables")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  @Validate({ query: agedReceivablesQuerySchema })
  agedPayables(
    @Query() query: AgedReceivablesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.agedPayables(u.orgId, query);
  }
}
