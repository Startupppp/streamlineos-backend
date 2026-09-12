import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { arAllocations, arDocuments, arReceipts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { PackRegistry } from "../packs/pack.registry";
import type { PostedJournal } from "../kernel/ledger.types";
import { PartiesService } from "../parties/parties.service";
import type {
  AllocateCreditNoteInput,
  AllocateFifoInput,
  AllocateReceiptInput,
  CreateReceiptInput,
  ListReceiptsQuery,
  ReverseReceiptInput,
} from "./dto/ar-receipts.schemas";
import type { AllocationSource, ArReceiptPage, ArReceiptView } from "./ar-receipts.types";
import { recordReceipt } from "./lib/ar-receipt-posting";
import {
  OPEN_STATUSES,
  loadReceipt,
  lockDocument,
  lockReceipt,
  receiptColumns,
  statusFor,
} from "./lib/ar-receipt-rows";
import {
  applyAllocations,
  applyFifo,
  settle,
  unwindReceiptAllocations,
} from "./lib/ar-receipt-settlement";

export type { ArReceiptPage, ArReceiptView } from "./ar-receipts.types";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

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
 *
 * The transaction bodies live beside this file: recording a receipt in
 * `lib/ar-receipt-posting.ts`, settling and unwinding in
 * `lib/ar-receipt-settlement.ts`, the row reads in `lib/ar-receipt-rows.ts`.
 * Each runs on the `tx` this service opens.
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
    const header = await loadReceipt(orgId, receiptId, tx);
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
        .select(receiptColumns())
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
      const { receiptId, journal } = await recordReceipt(
        {
          books: this.books,
          ledger: this.ledger,
          sequences: this.sequences,
          packs: this.packs,
          parties: this.parties,
        },
        orgId,
        userId,
        book,
        input,
        tx,
      );

      return { receipt: await this.get(orgId, receiptId, tx), journal };
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
      await applyAllocations(orgId, userId, receiptId, input.allocations, tx);
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
      await applyFifo(orgId, userId, receiptId, input.maxAmountMinor, tx);
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
      const note = await lockDocument(orgId, creditNoteId, tx);
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
      const applied = await settle(orgId, userId, note.bookId, source, input.allocations, tx);

      const settled = note.settledMinor + applied;
      await tx
        .update(arDocuments)
        .set({ settledMinor: settled, status: statusFor(settled, note.grossMinor) })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, note.id)));

      return {
        creditNoteId: note.id,
        allocatedMinor: applied,
        openMinor: note.grossMinor - settled,
      };
    });
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
      const receipt = await lockReceipt(orgId, receiptId, tx);

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

      await unwindReceiptAllocations(orgId, receiptId, tx);

      await tx
        .update(arReceipts)
        .set({ status: "REVERSED", unappliedMinor: 0, reversalJournalId: reversal.id })
        .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)));

      return { receipt: await this.get(orgId, receiptId, tx), reversalJournal: reversal };
    });
  }
}
