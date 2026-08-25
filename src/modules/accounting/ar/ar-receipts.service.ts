import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  arAllocations,
  arDocuments,
  arReceipts,
  glAccounts,
  glFiscalYears,
  glPeriods,
  type DocumentStatus,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { PackRegistry } from "../packs/pack.registry";
import { convert, money } from "../kernel/money";
import type { PostedJournal } from "../kernel/ledger.types";
import { PartiesService } from "../parties/parties.service";
import type {
  AllocateCreditNoteInput,
  AllocateFifoInput,
  AllocateReceiptInput,
  AllocationLineInput,
  CreateReceiptInput,
  ListReceiptsQuery,
  ReverseReceiptInput,
} from "./dto/ar-receipts.schemas";

export interface ArAllocationView {
  id: string;
  documentId: string;
  documentNumber: string | null;
  amountMinor: number;
  createdAt: Date;
}

export interface ArReceiptView {
  id: string;
  bookId: string;
  partyId: string;
  receiptNumber: string | null;
  receiptDate: string;
  depositAccountId: string;
  currency: string;
  fxRate: string;
  amountMinor: number;
  unappliedMinor: number;
  appliedMinor: number;
  status: "POSTED" | "REVERSED";
  paymentMethod: string | null;
  reference: string | null;
  memo: string | null;
  postedJournalId: string | null;
  reversalJournalId: string | null;
  allocations: ArAllocationView[];
}

export interface ArReceiptPage {
  items: Omit<ArReceiptView, "allocations">[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const OPEN_STATUSES: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID"];

/** Where a settlement is coming from. Exactly one of the two, never both. */
type AllocationSource =
  | { kind: "receipt"; id: string; partyId: string; currency: string; availableMinor: number }
  | { kind: "credit_note"; id: string; partyId: string; currency: string; availableMinor: number };

/**
 * Customer receipts and the allocations that settle open items.
 *
 * A receipt moves cash: **Dr deposit account, Cr AR control**. An allocation
 * moves nothing — both legs already hit AR control when the invoice and the
 * receipt posted — so it writes a settlement row and nothing else. That is what
 * keeps "AR control equals the sum of open items" true by construction rather
 * than by a nightly reconciliation.
 *
 * An open item is always `gross - settled`. There is no second definition
 * anywhere in this module.
 */
@Injectable()
export class ArReceiptsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly packs: PackRegistry,
    private readonly parties: PartiesService,
  ) {}

  /* ----------------------------------------------------------------- read */

  async get(orgId: string, receiptId: string, tx: DbOrTx = this.db): Promise<ArReceiptView> {
    const header = await this.loadReceipt(orgId, receiptId, tx);
    const allocations = await tx
      .select({
        id: arAllocations.id,
        documentId: arAllocations.documentId,
        documentNumber: arDocuments.documentNumber,
        amountMinor: arAllocations.amountMinor,
        createdAt: arAllocations.createdAt,
      })
      .from(arAllocations)
      .innerJoin(arDocuments, eq(arAllocations.documentId, arDocuments.id))
      .where(eq(arAllocations.receiptId, receiptId))
      .orderBy(asc(arAllocations.createdAt));

    return {
      ...header,
      appliedMinor: header.amountMinor - header.unappliedMinor,
      allocations,
    };
  }

  async list(orgId: string, query: ListReceiptsQuery = {}): Promise<ArReceiptPage> {
    const book = await this.books.requireDefault(orgId);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filters = [eq(arReceipts.orgId, orgId), eq(arReceipts.bookId, book.id)];
    if (query.partyId) filters.push(eq(arReceipts.partyId, query.partyId));
    if (query.status) filters.push(eq(arReceipts.status, query.status));
    if (query.from) filters.push(gte(arReceipts.receiptDate, query.from));
    if (query.to) filters.push(lte(arReceipts.receiptDate, query.to));
    if (query.unappliedOnly) filters.push(sql`${arReceipts.unappliedMinor} > 0`);
    const where = and(...filters);

    const [rows, [counted]] = await Promise.all([
      this.db
        .select(this.receiptColumns())
        .from(arReceipts)
        .where(where)
        .orderBy(desc(arReceipts.receiptDate), desc(arReceipts.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: sql<string>`count(*)` }).from(arReceipts).where(where),
    ]);

    return {
      items: rows.map((r) => ({ ...r, appliedMinor: r.amountMinor - r.unappliedMinor })),
      page,
      pageSize,
      total: Number(counted?.total ?? 0),
    };
  }

  /* -------------------------------------------------------------- posting */

  /**
   * Record the money and post its journal in one transaction, then apply it.
   *
   * Receipts have no draft state — cash either arrived or it did not — so
   * creating one posts it. Idempotency is `receipt:{id}:post`.
   */
  async postReceipt(
    orgId: string,
    userId: string | null,
    input: CreateReceiptInput,
  ): Promise<{ receipt: ArReceiptView; journal: PostedJournal }> {
    const book = await this.books.requireDefault(orgId);

    return this.db.transaction(async (tx) => {
      const party = await this.parties.requireForBook(orgId, book.id, input.partyId, tx);
      const currency = (input.currency ?? party.defaultCurrency).toUpperCase();
      const fxRate = this.assertFxRate(currency, book.baseCurrency, input.fxRate);

      const depositAccountId = input.depositAccountId
        ? await this.assertAccountInBook(book.id, input.depositAccountId, tx)
        : await this.books.resolveAccountByTag(book.id, input.depositAccountTag!, tx);

      const fiscalYear = await this.resolveFiscalYear(book.id, input.receiptDate, tx);
      const pack = this.packs.get(book.localizationPack);
      const receiptNumber = await this.sequences.allocate(
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

      const arAccountId = await this.books.resolveAccountByTag(book.id, "ar_control", tx);
      const functional = this.toFunctional(
        input.amountMinor,
        currency,
        book.baseCurrency,
        fxRate,
      );

      const journal = await this.ledger.post(
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
        await this.applyAllocations(orgId, userId, created.id, input.allocations, tx);
      } else if (input.autoAllocateFifo) {
        await this.applyFifo(orgId, userId, created.id, undefined, tx);
      }

      return { receipt: await this.get(orgId, created.id, tx), journal };
    });
  }

  /* ---------------------------------------------------------- allocations */

  async allocate(
    orgId: string,
    userId: string | null,
    receiptId: string,
    input: AllocateReceiptInput,
  ): Promise<ArReceiptView> {
    return this.db.transaction(async (tx) => {
      await this.applyAllocations(orgId, userId, receiptId, input.allocations, tx);
      return this.get(orgId, receiptId, tx);
    });
  }

  /** Oldest open item first — the default a founder means by "apply it". */
  async allocateFifo(
    orgId: string,
    userId: string | null,
    receiptId: string,
    input: AllocateFifoInput = {},
  ): Promise<ArReceiptView> {
    return this.db.transaction(async (tx) => {
      await this.applyFifo(orgId, userId, receiptId, input.maxAmountMinor, tx);
      return this.get(orgId, receiptId, tx);
    });
  }

  /**
   * Apply a posted credit note against open invoices.
   *
   * No journal: the credit note already credited AR control when it posted, and
   * the invoice already debited it. This records which one it offsets.
   */
  async allocateCreditNote(
    orgId: string,
    userId: string | null,
    creditNoteId: string,
    input: AllocateCreditNoteInput,
  ): Promise<{ creditNoteId: string; allocatedMinor: number; openMinor: number }> {
    return this.db.transaction(async (tx) => {
      const note = await this.lockDocument(orgId, creditNoteId, tx);
      if (note.documentType !== "CREDIT_NOTE") {
        throw new BadRequestException("That document is not a credit note");
      }
      if (!OPEN_STATUSES.includes(note.status)) {
        throw new ConflictException(
          `Credit note ${note.documentNumber ?? note.id} is ${note.status} and has nothing left to apply`,
        );
      }

      const source: AllocationSource = {
        kind: "credit_note",
        id: note.id,
        partyId: note.partyId,
        currency: note.currency,
        availableMinor: note.grossMinor - note.settledMinor,
      };
      const applied = await this.settle(orgId, userId, note.bookId, source, input.allocations, tx);

      const settled = note.settledMinor + applied;
      await tx
        .update(arDocuments)
        .set({ settledMinor: settled, status: this.statusFor(settled, note.grossMinor) })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, note.id)));

      return {
        creditNoteId: note.id,
        allocatedMinor: applied,
        openMinor: note.grossMinor - settled,
      };
    });
  }

  private async applyAllocations(
    orgId: string,
    userId: string | null,
    receiptId: string,
    allocations: readonly AllocationLineInput[],
    tx: DbOrTx,
  ): Promise<number> {
    const receipt = await this.lockReceipt(orgId, receiptId, tx);
    if (receipt.status !== "POSTED") {
      throw new ConflictException("A reversed receipt cannot be allocated");
    }

    const source: AllocationSource = {
      kind: "receipt",
      id: receipt.id,
      partyId: receipt.partyId,
      currency: receipt.currency,
      availableMinor: receipt.unappliedMinor,
    };
    const applied = await this.settle(orgId, userId, receipt.bookId, source, allocations, tx);

    await tx
      .update(arReceipts)
      .set({ unappliedMinor: receipt.unappliedMinor - applied })
      .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)));

    return applied;
  }

  private async applyFifo(
    orgId: string,
    userId: string | null,
    receiptId: string,
    maxAmountMinor: number | undefined,
    tx: DbOrTx,
  ): Promise<number> {
    const receipt = await this.loadReceipt(orgId, receiptId, tx);
    let remaining = Math.min(receipt.unappliedMinor, maxAmountMinor ?? receipt.unappliedMinor);
    if (remaining <= 0) return 0;

    const open = await tx
      .select({
        id: arDocuments.id,
        grossMinor: arDocuments.grossMinor,
        settledMinor: arDocuments.settledMinor,
      })
      .from(arDocuments)
      .where(
        and(
          eq(arDocuments.orgId, orgId),
          eq(arDocuments.bookId, receipt.bookId),
          eq(arDocuments.partyId, receipt.partyId),
          eq(arDocuments.documentType, "INVOICE"),
          eq(arDocuments.currency, receipt.currency),
          inArray(arDocuments.status, OPEN_STATUSES),
          isNull(arDocuments.deletedAt),
          sql`${arDocuments.grossMinor} > ${arDocuments.settledMinor}`,
        ),
      )
      // Oldest due date first; an invoice with no due date ages from its issue.
      .orderBy(
        asc(sql`coalesce(${arDocuments.dueDate}, ${arDocuments.issueDate})`),
        asc(arDocuments.issueDate),
        asc(arDocuments.id),
      );

    const allocations: AllocationLineInput[] = [];
    for (const doc of open) {
      if (remaining <= 0) break;
      const amountMinor = Math.min(remaining, doc.grossMinor - doc.settledMinor);
      if (amountMinor <= 0) continue;
      allocations.push({ documentId: doc.id, amountMinor });
      remaining -= amountMinor;
    }

    if (allocations.length === 0) return 0;
    return this.applyAllocations(orgId, userId, receiptId, allocations, tx);
  }

  /**
   * The shared settlement path for both sources.
   *
   * Targets are locked in id order so two receipts landing on the same pair of
   * invoices cannot deadlock, and every amount is checked against both the
   * invoice's open balance and the source's remaining balance before anything
   * is written.
   */
  private async settle(
    orgId: string,
    userId: string | null,
    bookId: string,
    source: AllocationSource,
    allocations: readonly AllocationLineInput[],
    tx: DbOrTx,
  ): Promise<number> {
    if (allocations.length === 0) return 0;

    const merged = new Map<string, number>();
    for (const allocation of allocations) {
      merged.set(
        allocation.documentId,
        (merged.get(allocation.documentId) ?? 0) + allocation.amountMinor,
      );
    }

    const total = [...merged.values()].reduce((a, b) => a + b, 0);
    if (total > source.availableMinor) {
      throw new BadRequestException(
        `Cannot allocate ${total} against an unapplied balance of ${source.availableMinor}`,
      );
    }

    for (const documentId of [...merged.keys()].sort()) {
      const amountMinor = merged.get(documentId)!;
      const target = await this.lockDocument(orgId, documentId, tx);

      if (target.bookId !== bookId) throw new NotFoundException("Document not found");
      if (target.documentType !== "INVOICE") {
        throw new BadRequestException("Only an invoice can be settled");
      }
      if (target.id === source.id) {
        throw new BadRequestException("A document cannot settle itself");
      }
      if (target.partyId !== source.partyId) {
        throw new BadRequestException(
          "A receipt can only be applied to the same customer's invoices",
        );
      }
      if (target.currency !== source.currency) {
        throw new BadRequestException(
          `Currency mismatch: ${source.currency} cannot settle a ${target.currency} invoice`,
        );
      }
      if (!OPEN_STATUSES.includes(target.status)) {
        throw new ConflictException(
          `Invoice ${target.documentNumber ?? target.id} is ${target.status} and is not open`,
        );
      }

      const openMinor = target.grossMinor - target.settledMinor;
      if (amountMinor > openMinor) {
        throw new BadRequestException(
          `Cannot allocate ${amountMinor} to ${target.documentNumber ?? target.id}; ` +
            `only ${openMinor} is open`,
        );
      }

      await tx
        .insert(arAllocations)
        .values({
          orgId,
          bookId,
          receiptId: source.kind === "receipt" ? source.id : null,
          creditNoteId: source.kind === "credit_note" ? source.id : null,
          documentId,
          amountMinor,
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target:
            source.kind === "receipt"
              ? [arAllocations.receiptId, arAllocations.documentId]
              : [arAllocations.creditNoteId, arAllocations.documentId],
          targetWhere:
            source.kind === "receipt"
              ? sql`${arAllocations.receiptId} IS NOT NULL`
              : sql`${arAllocations.creditNoteId} IS NOT NULL`,
          set: { amountMinor: sql`${arAllocations.amountMinor} + ${amountMinor}` },
        });

      const settled = target.settledMinor + amountMinor;
      await tx
        .update(arDocuments)
        .set({ settledMinor: settled, status: this.statusFor(settled, target.grossMinor) })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));
    }

    return total;
  }

  /* -------------------------------------------------------------- reversal */

  /**
   * Reverse the journal, unwind every allocation, mark the receipt reversed.
   *
   * The original journal is never rewritten — the kernel posts its mirror and
   * links the two. Invoices this receipt had settled go back to open, which is
   * the only way the aging report and the AR control account can stay in step.
   */
  async reverseReceipt(
    orgId: string,
    userId: string | null,
    receiptId: string,
    input: ReverseReceiptInput = {},
  ): Promise<{ receipt: ArReceiptView; reversalJournal: PostedJournal | null }> {
    return this.db.transaction(async (tx) => {
      const receipt = await this.lockReceipt(orgId, receiptId, tx);

      if (receipt.status === "REVERSED") {
        const existing = receipt.reversalJournalId
          ? await this.ledger.loadJournal(orgId, receipt.reversalJournalId, tx)
          : null;
        return { receipt: await this.get(orgId, receiptId, tx), reversalJournal: existing };
      }
      if (!receipt.postedJournalId) {
        throw new ConflictException("This receipt has no journal to reverse");
      }

      const reversal = await this.ledger.reverse(
        orgId,
        userId,
        {
          bookId: receipt.bookId,
          journalId: receipt.postedJournalId,
          journalDate: input.reversalDate ?? receipt.receiptDate,
          idempotencyKey: `receipt:${receiptId}:reverse`,
          memo: input.reason ?? `Reversal of receipt ${receipt.receiptNumber ?? receiptId}`,
        },
        tx,
      );

      const existing = await tx
        .select({
          documentId: arAllocations.documentId,
          amountMinor: arAllocations.amountMinor,
        })
        .from(arAllocations)
        .where(eq(arAllocations.receiptId, receiptId));

      for (const allocation of [...existing].sort((a, b) =>
        a.documentId.localeCompare(b.documentId),
      )) {
        const target = await this.lockDocument(orgId, allocation.documentId, tx);
        const settled = Math.max(0, target.settledMinor - allocation.amountMinor);
        await tx
          .update(arDocuments)
          .set({ settledMinor: settled, status: this.statusFor(settled, target.grossMinor) })
          .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, allocation.documentId)));
      }

      await tx.delete(arAllocations).where(eq(arAllocations.receiptId, receiptId));

      await tx
        .update(arReceipts)
        .set({ status: "REVERSED", unappliedMinor: 0, reversalJournalId: reversal.id })
        .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)));

      return { receipt: await this.get(orgId, receiptId, tx), reversalJournal: reversal };
    });
  }

  /* -------------------------------------------------------------- helpers */

  /**
   * Settlement drives status, never the other way round: nothing settled is
   * `POSTED`, everything settled is `PAID`, in between is `PARTIALLY_PAID`.
   */
  private statusFor(settledMinor: number, grossMinor: number): DocumentStatus {
    if (settledMinor <= 0) return "POSTED";
    if (settledMinor >= grossMinor) return "PAID";
    return "PARTIALLY_PAID";
  }

  private toFunctional(
    txnMinor: number,
    currency: string,
    baseCurrency: string,
    fxRate: string,
  ): number {
    if (currency === baseCurrency) return txnMinor;
    return convert(money(txnMinor, currency), baseCurrency, fxRate).minor;
  }

  private assertFxRate(currency: string, baseCurrency: string, provided?: string): string {
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

  private async assertAccountInBook(
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

  private async resolveFiscalYear(
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

  private receiptColumns() {
    return {
      id: arReceipts.id,
      bookId: arReceipts.bookId,
      partyId: arReceipts.partyId,
      receiptNumber: arReceipts.receiptNumber,
      receiptDate: arReceipts.receiptDate,
      depositAccountId: arReceipts.depositAccountId,
      currency: arReceipts.currency,
      fxRate: arReceipts.fxRate,
      amountMinor: arReceipts.amountMinor,
      unappliedMinor: arReceipts.unappliedMinor,
      status: arReceipts.status,
      paymentMethod: arReceipts.paymentMethod,
      reference: arReceipts.reference,
      memo: arReceipts.memo,
      postedJournalId: arReceipts.postedJournalId,
      reversalJournalId: arReceipts.reversalJournalId,
    } as const;
  }

  private async loadReceipt(orgId: string, receiptId: string, tx: DbOrTx) {
    const [row] = await tx
      .select(this.receiptColumns())
      .from(arReceipts)
      .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)))
      .limit(1);
    if (!row) throw new NotFoundException("Receipt not found");
    return row;
  }

  private async lockReceipt(orgId: string, receiptId: string, tx: DbOrTx) {
    const [row] = await tx
      .select(this.receiptColumns())
      .from(arReceipts)
      .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)))
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException("Receipt not found");
    return row;
  }

  private async lockDocument(orgId: string, documentId: string, tx: DbOrTx) {
    const [row] = await tx
      .select({
        id: arDocuments.id,
        bookId: arDocuments.bookId,
        partyId: arDocuments.partyId,
        documentType: arDocuments.documentType,
        documentNumber: arDocuments.documentNumber,
        status: arDocuments.status,
        currency: arDocuments.currency,
        grossMinor: arDocuments.grossMinor,
        settledMinor: arDocuments.settledMinor,
      })
      .from(arDocuments)
      .where(
        and(
          eq(arDocuments.orgId, orgId),
          eq(arDocuments.id, documentId),
          isNull(arDocuments.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException("Document not found");
    return row;
  }
}
