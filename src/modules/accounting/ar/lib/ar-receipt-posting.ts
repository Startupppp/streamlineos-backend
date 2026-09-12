/**
 * Recording a receipt: number it, insert it, post **Dr deposit account, Cr AR
 * control**, then apply it. The body of `ArReceiptsService.postReceipt`'s
 * transaction — every statement runs on the `tx` it is handed.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { arReceipts, glAccounts, glFiscalYears, glPeriods } from "../../../../db/schema";
import type { BookSummary, BooksService } from "../../kernel/books.service";
import type { LedgerService } from "../../kernel/ledger.service";
import type { PostedJournal } from "../../kernel/ledger.types";
import { convert, money } from "../../kernel/money";
import type { DbOrTx, SequenceService } from "../../kernel/sequence.service";
import type { PackRegistry } from "../../packs/pack.registry";
import type { PartiesService } from "../../parties/parties.service";
import type { CreateReceiptInput } from "../dto/ar-receipts.schemas";
import { applyAllocations, applyFifo } from "./ar-receipt-settlement";

/** The receipts service's own collaborators, handed over rather than exposed. */
export interface ReceiptPostingDeps {
  books: BooksService;
  ledger: LedgerService;
  sequences: SequenceService;
  packs: PackRegistry;
  parties: PartiesService;
}

/**
 * Receipts have no draft state — cash either arrived or it did not — so
 * recording one posts it. Idempotency is `receipt:{id}:post`. The caller reads
 * the receipt back on the same transaction.
 */
export async function recordReceipt(
  deps: ReceiptPostingDeps,
  orgId: string,
  userId: string | null,
  book: BookSummary,
  input: CreateReceiptInput,
  tx: DbOrTx,
): Promise<{ receiptId: string; journal: PostedJournal }> {
  const party = await deps.parties.requireForBook(orgId, book.id, input.partyId, tx);
  const currency = (input.currency ?? party.defaultCurrency).toUpperCase();
  const fxRate = assertFxRate(currency, book.baseCurrency, input.fxRate);

  const depositAccountId = input.depositAccountId
    ? await assertAccountInBook(book.id, input.depositAccountId, tx)
    : await deps.books.resolveAccountByTag(book.id, input.depositAccountTag!, tx);

  const fiscalYear = await resolveFiscalYear(book.id, input.receiptDate, tx);
  const pack = deps.packs.get(book.localizationPack);
  const receiptNumber = await deps.sequences.allocate(
    {
      orgId,
      bookId: book.id,
      kind: "receipt",
      series: pack.documentSeries.receipt,
      fiscalYear,
    },
    tx,
  );

  const [created] = await tx
    .insert(arReceipts)
    .values({
      orgId,
      bookId: book.id,
      partyId: party.id,
      receiptNumber,
      receiptDate: input.receiptDate,
      depositAccountId,
      currency,
      fxRate,
      amountMinor: input.amountMinor,
      unappliedMinor: input.amountMinor,
      status: "POSTED",
      paymentMethod: input.paymentMethod ?? null,
      reference: input.reference ?? null,
      memo: input.memo ?? null,
      providerPaymentId: input.providerPaymentId ?? null,
      createdBy: userId,
    })
    .returning({ id: arReceipts.id });

  if (!created) throw new ConflictException("Could not record the receipt");

  const arAccountId = await deps.books.resolveAccountByTag(book.id, "ar_control", tx);
  const functional = toFunctional(
    input.amountMinor,
    currency,
    book.baseCurrency,
    fxRate,
  );

  const journal = await deps.ledger.post(
    orgId,
    userId,
    {
      bookId: book.id,
      idempotencyKey: `receipt:${created.id}:post`,
      journalDate: input.receiptDate,
      memo: `${receiptNumber} — ${party.displayName}`,
      sourceType: "receipt",
      sourceId: created.id,
      lines: [
        {
          accountId: depositAccountId,
          debitMinor: functional,
          txnCurrency: currency,
          txnAmountMinor: input.amountMinor,
          fxRate,
          partyId: party.id,
          description: `${receiptNumber} — ${party.displayName}`,
        },
        {
          accountId: arAccountId,
          creditMinor: functional,
          txnCurrency: currency,
          txnAmountMinor: input.amountMinor,
          fxRate,
          partyId: party.id,
          description: `${receiptNumber} — ${party.displayName}`,
        },
      ],
    },
    tx,
  );

  await tx
    .update(arReceipts)
    .set({ postedJournalId: journal.id })
    .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, created.id)));

  if (input.allocations?.length) {
    await applyAllocations(orgId, userId, created.id, input.allocations, tx);
  } else if (input.autoAllocateFifo) {
    await applyFifo(orgId, userId, created.id, undefined, tx);
  }

  return { receiptId: created.id, journal };
}

function toFunctional(
  txnMinor: number,
  currency: string,
  baseCurrency: string,
  fxRate: string,
): number {
  if (currency === baseCurrency) return txnMinor;
  return convert(money(txnMinor, currency), baseCurrency, fxRate).minor;
}

function assertFxRate(currency: string, baseCurrency: string, provided?: string): string {
  if (currency === baseCurrency) {
    if (provided && Number(provided) !== 1) {
      throw new BadRequestException(`A ${currency} receipt on ${baseCurrency} books needs rate 1`);
    }
    return "1";
  }
  if (!provided) {
    throw new BadRequestException(
      `A ${currency} receipt on ${baseCurrency} books needs an explicit FX rate`,
    );
  }
  if (!(Number(provided) > 0)) throw new BadRequestException("The FX rate must be positive");
  return provided;
}

async function assertAccountInBook(
  bookId: string,
  accountId: string,
  tx: DbOrTx,
): Promise<string> {
  const [row] = await tx
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.bookId, bookId),
        eq(glAccounts.id, accountId),
        eq(glAccounts.isActive, true),
        isNull(glAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Deposit account not found");
  return row.id;
}

async function resolveFiscalYear(
  bookId: string,
  onDate: string,
  tx: DbOrTx,
): Promise<{ id: string; name: string }> {
  const [row] = await tx
    .select({ id: glFiscalYears.id, name: glFiscalYears.name })
    .from(glPeriods)
    .innerJoin(glFiscalYears, eq(glPeriods.fiscalYearId, glFiscalYears.id))
    .where(
      and(
        eq(glPeriods.bookId, bookId),
        lte(glPeriods.startsOn, onDate),
        gte(glPeriods.endsOn, onDate),
      ),
    )
    .limit(1);
  if (!row) {
    throw new BadRequestException(
      `No accounting period covers ${onDate}. Open the fiscal year first.`,
    );
  }
  return row;
}
