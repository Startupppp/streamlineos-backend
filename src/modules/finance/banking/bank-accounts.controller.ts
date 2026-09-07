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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  bankAccountListResponseSchema,
  bankAccountSchema,
  bankTransactionListResponseSchema,
} from "./dto/banking-response.schemas";

const bankAccountIdParams = z.object({ bankAccountId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("finance/bank-accounts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BankAccountsController {
  constructor(private readonly service: BankAccountsService) {}

  @Get()
  @ResponseSchema(bankAccountListResponseSchema)
  @RequirePermission("accounting:banking:read")
  @Validate({ query: bankAccountsQuerySchema })
  list(
    @Query() query: BankAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u, query);
  }

  @Post()
  @ResponseSchema(bankAccountSchema)
  @HttpCode(201)
  @RequirePermission("accounting:banking:manage")
  @Validate({ body: createBankAccountSchema })
  create(
    @Body() body: CreateBankAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u, body);
  }

  @Patch(":bankAccountId")
  @ResponseSchema(bankAccountSchema)
  @RequirePermission("accounting:banking:manage")
  @Validate({ params: bankAccountIdParams, body: updateBankAccountSchema })
  update(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Body() body: UpdateBankAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u, bankAccountId, body);
  }

  @Get(":bankAccountId")
  @ResponseSchema(bankAccountSchema)
  @RequirePermission("accounting:banking:read")
  @Validate({ params: bankAccountIdParams })
  findOne(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.findOne(u.orgId, bankAccountId);
  }

  @Get(":bankAccountId/transactions")
  @ResponseSchema(bankTransactionListResponseSchema)
  @RequirePermission("accounting:banking:read")
  @Validate({ params: bankAccountIdParams, query: bankTransactionsQuerySchema })
  listTransactions(
    @Param("bankAccountId", ParseIntPipe) bankAccountId: number,
    @Query() query: BankTransactionsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTransactions(u, bankAccountId, query);
  }
}
