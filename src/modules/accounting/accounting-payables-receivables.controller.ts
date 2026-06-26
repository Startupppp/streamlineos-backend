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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccountingPayablesService } from "./accounting-payables.service";
import { AccountingReceivablesService } from "./accounting-receivables.service";
import {
  agedReceivablesQuerySchema,
  createPurchaseBillSchema,
  listCustomerLedgerQuerySchema,
  listCustomersOutstandingQuerySchema,
  listPurchaseBillsQuerySchema,
  recordVendorPaymentSchema,
  updatePurchaseBillStatusSchema,
  type AgedReceivablesQuery,
  type CreatePurchaseBillInput,
  type ListCustomerLedgerQuery,
  type ListCustomersOutstandingQuery,
  type ListPurchaseBillsQuery,
  type RecordVendorPaymentInput,
  type UpdatePurchaseBillStatusInput,
} from "./dto/accounting.schemas";

@Controller("accounting")
@UseGuards(JwtAuthGuard)
export class AccountingPayablesReceivablesController {
  constructor(
    private readonly payables: AccountingPayablesService,
    private readonly receivables: AccountingReceivablesService,
  ) {}

  @Get("purchase-bills")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:journal")
  listPurchaseBills(
    @Query(new ZodValidationPipe(listPurchaseBillsQuerySchema)) query: ListPurchaseBillsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.listPurchaseBills(u.orgId, query);
  }

  @Post("purchase-bills")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "accounting:journal")
  @HttpCode(201)
  createPurchaseBill(
    @Body(new ZodValidationPipe(createPurchaseBillSchema)) body: CreatePurchaseBillInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.createPurchaseBill(u.orgId, u.userId, body);
  }

  @Get("purchase-bills/:billId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:journal")
  getPurchaseBill(
    @Param("billId", ParseIntPipe) billId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.getPurchaseBill(u.orgId, billId);
  }

  @Patch("purchase-bills/:billId")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "accounting:journal")
  updatePurchaseBill(
    @Param("billId", ParseIntPipe) billId: number,
    @Body(new ZodValidationPipe(updatePurchaseBillStatusSchema)) body: UpdatePurchaseBillStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.updatePurchaseBillStatus(u.orgId, u.userId, billId, body);
  }

  @Get("purchase-bills/:billId/payments")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:journal")
  listBillPayments(
    @Param("billId", ParseIntPipe) billId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.listBillPayments(u.orgId, billId);
  }

  @Post("purchase-bills/:billId/payments")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "accounting:journal")
  @HttpCode(201)
  recordBillPayment(
    @Param("billId", ParseIntPipe) billId: number,
    @Body(new ZodValidationPipe(recordVendorPaymentSchema)) body: RecordVendorPaymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.recordBillPayment(u.orgId, u.userId, billId, body);
  }

  @Get("vendors")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  listVendors(
    @Query(new ZodValidationPipe(listCustomersOutstandingQuerySchema)) query: ListCustomersOutstandingQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.listVendors(u.orgId, query);
  }

  @Get("vendors/:vendorId/ledger")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  vendorLedger(
    @Param("vendorId", ParseIntPipe) vendorId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.vendorLedger(u.orgId, vendorId);
  }

  @Get("customers")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  listCustomers(
    @Query(new ZodValidationPipe(listCustomersOutstandingQuerySchema)) query: ListCustomersOutstandingQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receivables.listCustomers(u.orgId, query);
  }

  @Get("customers/:clientId/ledger")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  customerLedger(
    @Param("clientId", ParseIntPipe) clientId: number,
    @Query(new ZodValidationPipe(listCustomerLedgerQuerySchema)) query: ListCustomerLedgerQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receivables.customerLedger(u.orgId, clientId, query);
  }

  @Get("reports/aged-receivables")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  agedReceivables(
    @Query(new ZodValidationPipe(agedReceivablesQuerySchema)) query: AgedReceivablesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.receivables.agedReceivables(u.orgId, query);
  }

  @Get("reports/aged-payables")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  agedPayables(
    @Query(new ZodValidationPipe(agedReceivablesQuerySchema)) query: AgedReceivablesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.payables.agedPayables(u.orgId, query);
  }
}
