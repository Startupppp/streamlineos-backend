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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { BankAccountsService } from "./bank-accounts.service";
import {
  bankAccountsQuerySchema,
  bankTransactionsQuerySchema,
  createBankAccountSchema,
  updateBankAccountSchema,
  type BankAccountsQuery,
  type BankTransactionsQuery,
  type CreateBankAccountInput,
  type UpdateBankAccountInput,
} from "./dto/bank-accounts.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const bankAccountIdParams = z.object({ bankAccountId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("finance/bank-accounts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BankAccountsController {
  constructor(private readonly service: BankAccountsService) {}

  @Get()
  @RequirePermission("accounting:banking:read")
  list(
    @Query(new ZodValidationPipe(bankAccountsQuerySchema)) query: BankAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("accounting:banking:manage")
  create(
    @Body(new ZodValidationPipe(createBankAccountSchema)) body: CreateBankAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Patch(":bankAccountId")
  @RequirePermission("accounting:banking:manage")
  @Validate({ params: bankAccountIdParams })
  update(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Body(new ZodValidationPipe(updateBankAccountSchema)) body: UpdateBankAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u, bankAccountId, body);
  }

  @Get(":bankAccountId/transactions")
  @RequirePermission("accounting:banking:read")
  @Validate({ params: bankAccountIdParams })
  listTransactions(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Query(new ZodValidationPipe(bankTransactionsQuerySchema)) query: BankTransactionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTransactions(u, bankAccountId, query);
  }
}
