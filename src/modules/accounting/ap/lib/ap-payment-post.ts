import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { apPayments, apWithholding, glAccounts } from "../../../../db/schema";
import type { BooksService } from "../../kernel/books.service";
import { assertIsoDate } from "../../kernel/fiscal-calendar";
import type { LedgerService } from "../../kernel/ledger.service";
import type { DbOrTx, SequenceService } from "../../kernel/sequence.service";
import type { PackRegistry } from "../../packs/pack.registry";
import type { TaxService } from "../../tax/tax.service";
import { draft, toJournalLines, type JournalDraftLine } from "../ap.posting";
import type { ApPaymentPostResult } from "../ap.types";
import { requireVendor } from "../ap.vendor-lookup";
import type { PostApPaymentInput } from "../dto/ap-payments.schemas";
import type { WithholdingEngineRegistry } from "../withholding/withholding.registry";
import { getPayment } from "./ap-payment-reads";
import { determineWithholding, resolveWithholdingAccount } from "./ap-payment-withholding";
import { applySettlement, loadAllocationTargets, writeAllocation } from "./ap-settlement";

/** The collaborators a payment post needs, handed over by the payments service. */
export interface ApPaymentPostingDeps {
  books: BooksService;
  ledger: LedgerService;
  sequences: SequenceService;
  tax: TaxService;
  packs: PackRegistry;
  withholdingEngines: WithholdingEngineRegistry;
}

/**
 * Post a vendor payment on the caller's transaction: decide the withholding,
 * allocate the number, post Dr AP / Cr withholding / Cr bank, write the
 * payment, settle each bill it pays, and record what was withheld.
 */
export async function postVendorPayment(
  deps: ApPaymentPostingDeps,
  tx: DbOrTx,
  orgId: string,
  userId: string | null,
  input: PostApPaymentInput,
): Promise<ApPaymentPostResult> {
  const { books, ledger, sequences, packs } = deps;
  const book = input.bookId
    ? await books.get(orgId, input.bookId, tx)
    : await books.requireDefault(orgId, tx);
  const vendor = await requireVendor(tx, orgId, book.id, input.partyId);
  const paymentDate = assertIsoDate(input.paymentDate);
  const currency = input.currency ?? book.baseCurrency;
  const fxRate = currency === book.baseCurrency ? "1" : (input.fxRate ?? "1");
  if (currency === book.baseCurrency && input.fxRate && Number(input.fxRate) !== 1) {
    throw new BadRequestException(`A ${book.baseCurrency} payment must carry an FX rate of 1`);
  }

  await assertPostableAccount(tx, book.id, input.paymentAccountId);

  const targets = await loadAllocationTargets(
    tx,
    orgId,
    book.id,
    vendor.id,
    currency,
    input.allocations,
  );
  const allocatedMinor = input.allocations.reduce((a, l) => a + l.amountMinor, 0);
  const grossMinor = input.grossMinor ?? allocatedMinor;
  if (grossMinor <= 0) {
    throw new BadRequestException("A payment must be for a positive amount");
  }
  if (allocatedMinor > grossMinor) {
    throw new BadRequestException(
      `Allocations total ${allocatedMinor} but the payment is only ${grossMinor}`,
    );
  }

  const withholding = await determineWithholding(deps, tx, {
    orgId,
    book,
    vendor,
    paymentDate,
    currency,
    grossMinor,
    allocatedMinor,
    allocations: input.allocations,
    targets,
    instruction: input.withholding,
  });

  const netPaidMinor = grossMinor - withholding.withheldMinor;
  if (netPaidMinor < 0) {
    throw new BadRequestException("Withholding cannot exceed the payment");
  }

  const paymentId = randomUUID();
  const fiscalYear = await books.ensureFiscalYear(orgId, book.id, paymentDate, tx);
  const pack = packs.get(book.localizationPack);
  const paymentNumber = await sequences.allocate(
    {
      orgId,
      bookId: book.id,
      kind: "payment",
      series: pack.documentSeries.payment,
      fiscalYear: { id: fiscalYear.id, name: fiscalYear.name },
    },
    tx,
  );

  const accounts = await books.resolveAccountsByTag(book.id, ["ap_control", "rounding"], tx);
  const withholdingAccountId =
    withholding.withheldMinor > 0
      ? await resolveWithholdingAccount(deps, tx, book.id)
      : null;

  const drafts: JournalDraftLine[] = [
    draft(accounts.get("ap_control")!, "debit", grossMinor, {
      description: vendor.displayName,
      partyId: vendor.id,
    }),
  ];
  if (withholdingAccountId && withholding.withheldMinor > 0) {
    drafts.push(
      draft(withholdingAccountId, "credit", withholding.withheldMinor, {
        description: `${withholding.legacySection ?? withholding.regime} withheld from ${vendor.displayName}`,
        partyId: vendor.id,
        taxComponent: "WHT",
      }),
    );
  }
  drafts.push(
    draft(input.paymentAccountId, "credit", netPaidMinor, {
      description: input.reference ?? `Payment ${paymentNumber}`,
      partyId: vendor.id,
    }),
  );

  const journal = await ledger.post(
    orgId,
    userId,
    {
      bookId: book.id,
      idempotencyKey: `payment:${paymentId}:post`,
      journalDate: paymentDate,
      memo: input.memo ?? `Payment ${paymentNumber} — ${vendor.displayName}`,
      sourceType: "payment",
      sourceId: paymentId,
      lines: toJournalLines({
        drafts,
        currency,
        functionalCurrency: book.baseCurrency,
        fxRate,
        roundingAccountId: accounts.get("rounding")!,
      }),
    },
    tx,
  );

  await tx.insert(apPayments).values({
    id: paymentId,
    orgId,
    bookId: book.id,
    partyId: vendor.id,
    paymentNumber,
    paymentDate,
    paymentAccountId: input.paymentAccountId,
    currency,
    fxRate,
    grossMinor,
    withheldMinor: withholding.withheldMinor,
    netPaidMinor,
    unappliedMinor: grossMinor - allocatedMinor,
    status: "POSTED",
    paymentMethod: input.paymentMethod ?? null,
    reference: input.reference ?? null,
    memo: input.memo ?? null,
    postedJournalId: journal.id,
    createdBy: userId,
  });

  for (const allocation of input.allocations) {
    await writeAllocation(tx, {
      orgId,
      bookId: book.id,
      paymentId,
      debitNoteId: null,
      documentId: allocation.documentId,
      amountMinor: allocation.amountMinor,
      userId,
    });
    await applySettlement(tx, orgId, allocation.documentId, allocation.amountMinor);
  }

  // A row even at zero, when the engine actually looked: "considered and
  // below the threshold" and "nobody thought about it" are different facts.
  if ((withholding.legacySection || withholding.paymentCode) && withholding.baseMinor > 0) {
    await tx.insert(apWithholding).values({
      orgId,
      bookId: book.id,
      paymentId,
      documentId: input.allocations[0]?.documentId ?? null,
      regime: withholding.regime,
      legacySection: withholding.legacySection,
      paymentCode: withholding.paymentCode,
      rateBp: withholding.rateBp,
      baseMinor: withholding.baseMinor,
      withheldMinor: withholding.withheldMinor,
      currency,
      glAccountId: withholdingAccountId,
    });
  }

  return {
    payment: await getPayment(tx, orgId, paymentId),
    journalId: journal.id,
    journalNumber: journal.journalNumber,
    replayed: journal.replayed,
  } satisfies ApPaymentPostResult;
}

async function assertPostableAccount(
  tx: DbOrTx,
  bookId: string,
  accountId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(
      and(
        eq(glAccounts.bookId, bookId),
        eq(glAccounts.id, accountId),
        eq(glAccounts.isActive, true),
        eq(glAccounts.isHeader, false),
        isNull(glAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("The payment account does not exist in this book");
}
