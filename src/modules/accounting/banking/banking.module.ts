import { Module } from "@nestjs/common";
import { AccountingKernelModule } from "../kernel/accounting-kernel.module";
import { BankAccountsService } from "./bank-accounts.service";
import { StatementImportService } from "./statement-import.service";
import { MatchingService } from "./matching.service";
import { ReconciliationService } from "./reconciliation.service";
import { BankAccountsController } from "./bank-accounts.controller";
import { BankStatementsController } from "./bank-statements.controller";
import { BankMatchingController } from "./matching.controller";

/**
 * Banking and reconciliation (PRD 04).
 *
 * The only thing banking needs from the layers below is the kernel's
 * `BooksService`, for the book a bank account belongs to — cash movements are
 * posted by whoever raised the receipt, payment or fee journal, so nothing in
 * this module writes to the ledger at all.
 *
 * `bank_matches` references `ar_receipts` and `ap_payments` by foreign key, but
 * this module never imports AR or AP: a match reads those tables and compares
 * amounts, which is a narrower dependency than their services and keeps the
 * arrows pointing one way.
 *
 * `DrizzleModule` is global, so `DRIZZLE` needs no import. Registration in
 * `app.module.ts` is the orchestrator's job, not this file's.
 */
@Module({
  imports: [AccountingKernelModule],
  controllers: [BankAccountsController, BankStatementsController, BankMatchingController],
  providers: [BankAccountsService, StatementImportService, MatchingService, ReconciliationService],
  exports: [BankAccountsService, StatementImportService, MatchingService, ReconciliationService],
})
export class BankingModule {}
