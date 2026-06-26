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
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccountingLedgerService } from "./accounting-ledger.service";
import {
  createAccountSchema,
  createJournalEntrySchema,
  listAccountsQuerySchema,
  listJournalQuerySchema,
  updateAccountSchema,
  type CreateAccountInput,
  type CreateJournalEntryInput,
  type ListAccountsQuery,
  type ListJournalQuery,
  type UpdateAccountInput,
} from "./dto/accounting.schemas";

@Controller("accounting")
@UseGuards(JwtAuthGuard)
export class AccountingLedgerController {
  constructor(private readonly ledger: AccountingLedgerService) {}

  @Get("accounts")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:accounts")
  listAccounts(
    @Query(new ZodValidationPipe(listAccountsQuerySchema)) query: ListAccountsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.listAccounts(u.orgId, query);
  }

  @Post("accounts")
  @UseGuards(AbilityGuard)
  @CheckAbility("create", "accounting:accounts")
  @HttpCode(201)
  createAccount(
    @Body(new ZodValidationPipe(createAccountSchema)) body: CreateAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.createAccount(u.orgId, body);
  }

  @Patch("accounts/:accountId")
  @UseGuards(AbilityGuard)
  @CheckAbility("update", "accounting:accounts")
  updateAccount(
    @Param("accountId", ParseIntPipe) accountId: number,
    @Body(new ZodValidationPipe(updateAccountSchema)) body: UpdateAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.updateAccount(u.orgId, accountId, body);
  }

  @Get("journal")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:journal")
  listJournal(
    @Query(new ZodValidationPipe(listJournalQuerySchema)) query: ListJournalQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.listJournal(u.orgId, query);
  }

  @Post("journal")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "accounting:journal")
  @HttpCode(201)
  createJournalEntry(
    @Body(new ZodValidationPipe(createJournalEntrySchema)) body: CreateJournalEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.createJournalEntry(u.orgId, u.userId, body);
  }

  @Get("journal/:entryId")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:journal")
  getJournalEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.getJournalEntry(u.orgId, entryId);
  }

  @Post("journal/:entryId/post")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "accounting:journal")
  @HttpCode(200)
  postJournalEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ledger.postJournalEntry(u.orgId, entryId);
  }

  @Post("journal/:entryId/reverse")
  @UseGuards(AbilityGuard)
  @CheckAbility("manage", "accounting:journal")
  async reverseJournalEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, result } = await this.ledger.reverseJournalEntry(u.orgId, u.userId, entryId);
    res.status(created ? 201 : 200);
    return result;
  }
}
