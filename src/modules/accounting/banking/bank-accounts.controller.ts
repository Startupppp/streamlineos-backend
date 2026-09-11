import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { BankAccountsService } from "./bank-accounts.service";
import {
  balanceQuerySchema,
  createBankAccountSchema,
  listBankAccountsQuerySchema,
  saveCsvMappingSchema,
  updateBankAccountSchema,
  type BalanceQuery,
  type CreateBankAccountBody,
  type ListBankAccountsQuery,
  type SaveCsvMappingBody,
  type UpdateBankAccountBody,
} from "./dto/banking.schemas";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  bankAccountBalanceResponseSchema,
  createBankAccountResponseSchema,
  getBankAccountResponseSchema,
  listBankAccountsResponseSchema,
  saveCsvMappingResponseSchema,
  updateBankAccountResponseSchema,
} from "./dto/banking-response.schemas";

/**
 * Bank accounts. There is no create-a-GL-account here on purpose — a bank
 * account is metadata attached to a cash account that the chart already has.
 */
@RequireModule("accounting")
@Controller("accounting/banking/accounts")
@UseGuards(JwtAuthGuard)
export class BankAccountsController {
  constructor(private readonly bankAccounts: BankAccountsService) {}

  @Post()
  @ResponseSchema(createBankAccountResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:manage")
  create(
    @Body(new ZodValidationPipe(createBankAccountSchema)) body: CreateBankAccountBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bankAccounts.create(u.orgId, u.userId, body);
  }

  @Get()
  @ResponseSchema(listBankAccountsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  list(
    @Query(new ZodValidationPipe(listBankAccountsQuerySchema)) query: ListBankAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bankAccounts.list(u.orgId, query);
  }

  @Get(":bankAccountId")
  @ResponseSchema(getBankAccountResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  get(@Param("bankAccountId") bankAccountId: string, @CurrentUser() u: CurrentUserContext) {
    return this.bankAccounts.get(u.orgId, bankAccountId);
  }

  /** The balance is derived from `gl_journal_lines`; nothing is stored. */
  @Get(":bankAccountId/balance")
  @ResponseSchema(bankAccountBalanceResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:read")
  balance(
    @Param("bankAccountId") bankAccountId: string,
    @Query(new ZodValidationPipe(balanceQuerySchema)) query: BalanceQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bankAccounts.balance(u.orgId, bankAccountId, query.asOf);
  }

  @Patch(":bankAccountId")
  @ResponseSchema(updateBankAccountResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:manage")
  update(
    @Param("bankAccountId") bankAccountId: string,
    @Body(new ZodValidationPipe(updateBankAccountSchema)) body: UpdateBankAccountBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bankAccounts.update(u.orgId, u.userId, bankAccountId, body);
  }

  @Put(":bankAccountId/csv-mapping")
  @ResponseSchema(saveCsvMappingResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:banking:manage")
  saveCsvMapping(
    @Param("bankAccountId") bankAccountId: string,
    @Body(new ZodValidationPipe(saveCsvMappingSchema)) body: SaveCsvMappingBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.bankAccounts.saveCsvMapping(u.orgId, bankAccountId, body);
  }
}
