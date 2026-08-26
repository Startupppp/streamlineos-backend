import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PackRegistry } from "../packs/pack.registry";
import { AccountsService } from "./accounts.service";
import { BooksService } from "./books.service";
import { FxService } from "./fx.service";
import { LedgerService } from "./ledger.service";
import { PeriodsService } from "./periods.service";
import {
  accountLedgerSchema,
  createAccountSchema,
  enableAccountingSchema,
  enableCurrencySchema,
  fxPreviewSchema,
  listAccountsSchema,
  listFxRatesSchema,
  listPeriodsSchema,
  lockPeriodSchema,
  postJournalSchema,
  reverseJournalSchema,
  setSystemTagSchema,
  trialBalanceSchema,
  unlockPeriodSchema,
  updateAccountSchema,
  upsertFxRateSchema,
  type AccountLedgerQueryDto,
  type CreateAccountInputDto,
  type EnableAccountingInputDto,
  type EnableCurrencyInputDto,
  type FxPreviewInputDto,
  type ListAccountsQueryDto,
  type ListFxRatesQueryDto,
  type ListPeriodsQueryDto,
  type LockPeriodInputDto,
  type PostJournalInputDto,
  type ReverseJournalInputDto,
  type SetSystemTagInputDto,
  type TrialBalanceQueryDto,
  type UnlockPeriodInputDto,
  type UpdateAccountInputDto,
  type UpsertFxRateInputDto,
} from "./dto/kernel.schemas";

/**
 * HTTP surface for the ledger kernel: books, chart of accounts, periods,
 * journals and FX.
 *
 * A `LedgerRejection` is translated to 409 (or 404) by `LedgerRejectionFilter`,
 * registered globally by this module — so handlers here let it propagate rather
 * than each catching it.
 */

@RequireModule("accounting")
@Controller("accounting")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class AccountingKernelController {
  constructor(
    private readonly books: BooksService,
    private readonly accounts: AccountsService,
    private readonly periods: PeriodsService,
    private readonly ledger: LedgerService,
    private readonly fx: FxService,
    private readonly packs: PackRegistry,
  ) {}

  /* ----------------------------------------------------------- books */

  @Get("packs")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:read")
  listPacks() {
    return this.packs.list().map((p) => ({
      code: p.code,
      title: p.title,
      status: p.status,
      countryCodes: p.countryCodes,
      defaultCurrency: p.defaultCurrency,
      fiscalYearStart: p.fiscalYearStart,
      taxEngine: p.taxEngine,
    }));
  }

  @Post("enable")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:manage")
  enable(
    @Body(new ZodValidationPipe(enableAccountingSchema)) body: EnableAccountingInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.books.enable(u.orgId, u.userId, body);
  }

  @Get("book")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  getBook(@CurrentUser() u: CurrentUserContext) {
    return this.books.requireDefault(u.orgId);
  }

  @Get("books")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  listBooks(@CurrentUser() u: CurrentUserContext) {
    return this.books.list(u.orgId);
  }

  /* ------------------------------------------------ chart of accounts */

  @Get("accounts")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:read")
  async listAccounts(
    @Query(new ZodValidationPipe(listAccountsSchema)) query: ListAccountsQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.list(u.orgId, book.id, query);
  }

  @Get("accounts/postable")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:read")
  async listPostable(@CurrentUser() u: CurrentUserContext) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.listPostable(u.orgId, book.id);
  }

  @Get("accounts/:accountId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:read")
  async getAccount(
    @Param("accountId") accountId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.get(u.orgId, book.id, accountId);
  }

  @Post("accounts")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:create")
  async createAccount(
    @Body(new ZodValidationPipe(createAccountSchema)) body: CreateAccountInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.create(u.orgId, u.userId, book.id, body);
  }

  @Patch("accounts/:accountId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:update")
  async updateAccount(
    @Param("accountId") accountId: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) body: UpdateAccountInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.update(u.orgId, u.userId, book.id, accountId, body);
  }

  @Patch("accounts/:accountId/system-tag")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:manage")
  async setSystemTag(
    @Param("accountId") accountId: string,
    @Body(new ZodValidationPipe(setSystemTagSchema)) body: SetSystemTagInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.setSystemTag(u.orgId, u.userId, book.id, accountId, body.systemTag);
  }

  @Delete("accounts/:accountId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:accounts:manage")
  async archiveAccount(
    @Param("accountId") accountId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.accounts.archive(u.orgId, u.userId, book.id, accountId);
  }

  /* --------------------------------------------------------- periods */

  @Get("fiscal-years")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:read")
  async listFiscalYears(@CurrentUser() u: CurrentUserContext) {
    const book = await this.books.requireDefault(u.orgId);
    return this.periods.listFiscalYears(u.orgId, book.id);
  }

  @Post("fiscal-years/open-next")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  async openNextFiscalYear(@CurrentUser() u: CurrentUserContext) {
    const book = await this.books.requireDefault(u.orgId);
    return this.periods.openNextFiscalYear(u.orgId, u.userId, book.id);
  }

  @Get("periods")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:read")
  async listPeriods(
    @Query(new ZodValidationPipe(listPeriodsSchema)) query: ListPeriodsQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.periods.listPeriods(u.orgId, book.id, query.fiscalYearId);
  }

  @Post("periods/:periodId/lock")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:manage")
  async lockPeriod(
    @Param("periodId") periodId: string,
    @Body(new ZodValidationPipe(lockPeriodSchema)) body: LockPeriodInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.periods.lock(u.orgId, u.userId, book.id, periodId, body.reason);
  }

  /** Reopening is its own permission — it is the privileged half of the pair. */
  @Post("periods/:periodId/unlock")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:periods:reopen")
  async unlockPeriod(
    @Param("periodId") periodId: string,
    @Body(new ZodValidationPipe(unlockPeriodSchema)) body: UnlockPeriodInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.periods.unlock(u.orgId, u.userId, book.id, periodId, body.reason);
  }

  /* -------------------------------------------------------- journals */

  @Post("journals/post")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:post")
  async postJournal(
    @Body(new ZodValidationPipe(postJournalSchema)) body: PostJournalInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.ledger.post(u.orgId, u.userId, { bookId: book.id, ...body });
  }

  @Post("journals/:journalId/reverse")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:post")
  async reverseJournal(
    @Param("journalId") journalId: string,
    @Body(new ZodValidationPipe(reverseJournalSchema)) body: ReverseJournalInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.ledger.reverse(u.orgId, u.userId, { bookId: book.id, journalId, ...body });
  }

  @Get("journals/:journalId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:journal:read")
  async getJournal(
    @Param("journalId") journalId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const journal = await this.ledger.loadJournal(u.orgId, journalId);
    // A journal in another tenant is indistinguishable from one that does not
    // exist — a 403 here would confirm it exists.
    if (!journal) throw new NotFoundException("Journal not found");
    return journal;
  }

  @Get("trial-balance")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reports:read")
  async trialBalance(
    @Query(new ZodValidationPipe(trialBalanceSchema)) query: TrialBalanceQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    const rows = await this.ledger.trialBalance(u.orgId, book.id, query.asOf);
    const totalDebitMinor = rows.reduce((a, r) => a + r.debitMinor, 0);
    const totalCreditMinor = rows.reduce((a, r) => a + r.creditMinor, 0);
    return {
      asOf: query.asOf,
      currency: book.baseCurrency,
      rows,
      totalDebitMinor,
      totalCreditMinor,
      balanced: totalDebitMinor === totalCreditMinor,
    };
  }

  @Get("accounts/:accountId/ledger")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:general-ledger:read")
  async accountLedger(
    @Param("accountId") accountId: string,
    @Query(new ZodValidationPipe(accountLedgerSchema)) query: AccountLedgerQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    const page = await this.accounts.ledger(u.orgId, book.id, accountId, query);
    return { ...page, currency: book.baseCurrency };
  }

  /* -------------------------------------------------------------- FX */

  @Get("currencies")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  listCurrencies() {
    return this.fx.listCurrencies();
  }

  @Get("book-currencies")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  async listBookCurrencies(@CurrentUser() u: CurrentUserContext) {
    const book = await this.books.requireDefault(u.orgId);
    return this.fx.listBookCurrencies(u.orgId, book.id);
  }

  @Post("book-currencies")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:manage")
  async enableCurrency(
    @Body(new ZodValidationPipe(enableCurrencySchema)) body: EnableCurrencyInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.fx.enableCurrency(u.orgId, u.userId, book.id, body.currencyCode);
  }

  @Get("fx-rates")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  async listFxRates(
    @Query(new ZodValidationPipe(listFxRatesSchema)) query: ListFxRatesQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.fx.listRates(u.orgId, book.id, query);
  }

  @Post("fx-rates")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:settings:manage")
  async upsertFxRate(
    @Body(new ZodValidationPipe(upsertFxRateSchema)) body: UpsertFxRateInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.fx.upsertRate(u.orgId, u.userId, book.id, body);
  }

  @Post("fx/preview")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:read")
  async previewFx(
    @Body(new ZodValidationPipe(fxPreviewSchema)) body: FxPreviewInputDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const book = await this.books.requireDefault(u.orgId);
    return this.fx.preview(u.orgId, book.id, body);
  }
}
