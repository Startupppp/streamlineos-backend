import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  apAllocations,
  apDocuments,
  apPayments,
  apWithholding,
  glAccounts,
  glParties,
  type DocumentStatus,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { divideRoundHalfUp } from "../kernel/money";
import { PackRegistry } from "../packs/pack.registry";
import { TaxService } from "../tax/tax.service";
import { isUniqueViolation } from "./ap.pg-errors";
import { draft, toJournalLines, type JournalDraftLine } from "./ap.posting";
import { requireVendor, type ApVendor } from "./ap.vendor-lookup";
import { WithholdingEngineRegistry } from "./withholding/withholding.registry";
import type { WithholdingResult } from "./withholding/withholding.types";
import type { ApAllocationDto, ApPaymentDto, ApPaymentPostResult, ApWithholdingDto } from "./ap.types";
import type {
  AllocateDebitNoteInput,
  AllocatePaymentInput,
  AllocationInput,
  ListApPaymentsQuery,
  PostApPaymentInput,
  ReversePaymentInput,
  WithholdingInstruction,
} from "./dto/ap-payments.schemas";

const SETTLEABLE: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID", "PAID"];
const OPEN_STATUSES: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID"];

/**
 * Vendor payments, allocations and withholding.
 *
 * A payment moves three things at once and the schema keeps all three, so a
 * challan can be reconciled later without recomputing anything:
 *
 *   Dr accounts payable   gross      what the vendor was owed
 *   Cr withholding payable  withheld  tax retained on their behalf
 *   Cr bank or cash          net      what actually left the account
 *
 * When nothing is withheld the middle line simply is not emitted and this
 * collapses to Dr AP / Cr bank. The bill is cleared by the **gross** either
 * way — the vendor's debt is discharged by the tax being remitted for them.
 */
@Injectable()
export class ApPaymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly tax: TaxService,
    private readonly packs: PackRegistry,
    private readonly withholdingEngines: WithholdingEngineRegistry,
  ) {}

  /* --------------------------------------------------------------- reads */

  async get(orgId: string, paymentId: string, tx: DbOrTx = this.db): Promise<ApPaymentDto> {
    const [row] = await tx
      .select({ ...PAYMENT_COLUMNS, partyName: glParties.displayName })
      .from(apPayments)
      .innerJoin(glParties, eq(apPayments.partyId, glParties.id))
      .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)))
      .limit(1);
    if (!row) throw new NotFoundException("Payment not found");

    return {
      ...toPaymentDto(row),
      allocations: await this.loadAllocations(tx, orgId, { paymentId }),
      withholding: await this.loadWithholding(tx, orgId, paymentId),
    };
  }

  async list(
    orgId: string,
    query: ListApPaymentsQuery,
  ): Promise<{ items: ApPaymentDto[]; page: number; pageSize: number; total: number }> {
    const book = await this.books.requireDefault(orgId);
    const filters = [eq(apPayments.orgId, orgId), eq(apPayments.bookId, book.id)];
    if (query.partyId) filters.push(eq(apPayments.partyId, query.partyId));
    if (query.status) filters.push(eq(apPayments.status, query.status));
    if (query.from) filters.push(gte(apPayments.paymentDate, assertIsoDate(query.from)));
    if (query.to) filters.push(lte(apPayments.paymentDate, assertIsoDate(query.to)));
    const where = and(...filters);

    const [{ total }] = await this.db.select({ total: count() }).from(apPayments).where(where);
    const rows = await this.db
      .select({ ...PAYMENT_COLUMNS, partyName: glParties.displayName })
      .from(apPayments)
      .innerJoin(glParties, eq(apPayments.partyId, glParties.id))
      .where(where)
      .orderBy(desc(apPayments.paymentDate), desc(apPayments.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const items: ApPaymentDto[] = [];
    for (const row of rows) {
      items.push({
        ...toPaymentDto(row),
        allocations: await this.loadAllocations(this.db, orgId, { paymentId: row.id }),
        withholding: await this.loadWithholding(this.db, orgId, row.id),
      });
    }
    return { items, page: query.page, pageSize: query.pageSize, total: Number(total) };
  }

  /* ------------------------------------------------------------- posting */

  async postPayment(
    orgId: string,
    userId: string | null,
    input: PostApPaymentInput,
  ): Promise<ApPaymentPostResult> {
    return this.db.transaction(async (tx) => {
      const book = input.bookId
        ? await this.books.get(orgId, input.bookId, tx)
        : await this.books.requireDefault(orgId, tx);
      const vendor = await requireVendor(tx, orgId, book.id, input.partyId);
      const paymentDate = assertIsoDate(input.paymentDate);
      const currency = input.currency ?? book.baseCurrency;
      const fxRate = currency === book.baseCurrency ? "1" : (input.fxRate ?? "1");
      if (currency === book.baseCurrency && input.fxRate && Number(input.fxRate) !== 1) {
        throw new BadRequestException(`A ${book.baseCurrency} payment must carry an FX rate of 1`);
      }

      await this.assertPostableAccount(tx, book.id, input.paymentAccountId);

      const targets = await this.loadAllocationTargets(
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

      const withholding = await this.determineWithholding(tx, {
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
      const fiscalYear = await this.books.ensureFiscalYear(orgId, book.id, paymentDate, tx);
      const pack = this.packs.get(book.localizationPack);
      const paymentNumber = await this.sequences.allocate(
        {
          orgId,
          bookId: book.id,
          kind: "payment",
          series: pack.documentSeries.payment,
          fiscalYear: { id: fiscalYear.id, name: fiscalYear.name },
        },
        tx,
      );

      const accounts = await this.books.resolveAccountsByTag(book.id, ["ap_control", "rounding"], tx);
      const withholdingAccountId =
        withholding.withheldMinor > 0
          ? await this.resolveWithholdingAccount(tx, book.id)
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

      const journal = await this.ledger.post(
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
        await this.writeAllocation(tx, {
          orgId,
          bookId: book.id,
          paymentId,
          debitNoteId: null,
          documentId: allocation.documentId,
          amountMinor: allocation.amountMinor,
          userId,
        });
        await this.applySettlement(tx, orgId, allocation.documentId, allocation.amountMinor);
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
        payment: await this.get(orgId, paymentId, tx),
        journalId: journal.id,
        journalNumber: journal.journalNumber,
        replayed: journal.replayed,
      } satisfies ApPaymentPostResult;
    });
  }

  /* --------------------------------------------------------- allocations */

  /** Apply an already-posted payment's unapplied balance to more bills. */
  async allocate(
    orgId: string,
    userId: string | null,
    paymentId: string,
    input: AllocatePaymentInput,
  ): Promise<ApPaymentDto> {
    return this.db.transaction(async (tx) => {
      const payment = await this.loadPaymentForUpdate(tx, orgId, paymentId);
      if (payment.status !== "POSTED") {
        throw new ConflictException("A reversed payment cannot be allocated");
      }

      const total = input.allocations.reduce((a, l) => a + l.amountMinor, 0);
      if (total > payment.unappliedMinor) {
        throw new BadRequestException(
          `This payment has only ${payment.unappliedMinor} unapplied; ${total} was requested`,
        );
      }

      await this.loadAllocationTargets(
        tx,
        orgId,
        payment.bookId,
        payment.partyId,
        payment.currency,
        input.allocations,
      );

      for (const allocation of input.allocations) {
        await this.writeAllocation(tx, {
          orgId,
          bookId: payment.bookId,
          paymentId,
          debitNoteId: null,
          documentId: allocation.documentId,
          amountMinor: allocation.amountMinor,
          userId,
        });
        await this.applySettlement(tx, orgId, allocation.documentId, allocation.amountMinor);
      }

      await tx
        .update(apPayments)
        .set({ unappliedMinor: payment.unappliedMinor - total })
        .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)));

      return this.get(orgId, paymentId, tx);
    });
  }

  /**
   * Apply a posted debit note to bills.
   *
   * No journal: both documents already moved AP control when they posted — the
   * bill credited it, the debit note debited it. Allocating is bookkeeping
   * between two open items, so posting anything here would double-count.
   */
  async allocateDebitNote(
    orgId: string,
    userId: string | null,
    debitNoteId: string,
    input: AllocateDebitNoteInput,
  ): Promise<{ debitNoteId: string; appliedMinor: number; remainingMinor: number }> {
    return this.db.transaction(async (tx) => {
      const note = await this.loadDocumentForUpdate(tx, orgId, debitNoteId);
      if (note.documentType !== "DEBIT_NOTE") {
        throw new BadRequestException("That document is not a debit note");
      }
      if (!OPEN_STATUSES.includes(note.status)) {
        throw new ConflictException(`A ${note.status} debit note cannot be applied`);
      }

      const total = input.allocations.reduce((a, l) => a + l.amountMinor, 0);
      const available = note.grossMinor - note.settledMinor;
      if (total > available) {
        throw new BadRequestException(
          `This debit note has only ${available} left to apply; ${total} was requested`,
        );
      }

      await this.loadAllocationTargets(
        tx,
        orgId,
        note.bookId,
        note.partyId,
        note.currency,
        input.allocations,
      );

      for (const allocation of input.allocations) {
        if (allocation.documentId === debitNoteId) {
          throw new BadRequestException("A debit note cannot be applied to itself");
        }
        await this.writeAllocation(tx, {
          orgId,
          bookId: note.bookId,
          paymentId: null,
          debitNoteId,
          documentId: allocation.documentId,
          amountMinor: allocation.amountMinor,
          userId,
        });
        await this.applySettlement(tx, orgId, allocation.documentId, allocation.amountMinor);
      }

      await this.applySettlement(tx, orgId, debitNoteId, total);

      return {
        debitNoteId,
        appliedMinor: total,
        remainingMinor: available - total,
      };
    });
  }

  /* ----------------------------------------------------------- reversing */

  /**
   * Reverse the journal, unwind every allocation, and drop the withholding.
   *
   * The withholding rows go because a reversed deduction was never made — a TDS
   * return for the period must not pick it up. The payment row itself stays,
   * marked `REVERSED`, carrying both journal ids: history is never rewritten.
   */
  async reversePayment(
    orgId: string,
    userId: string | null,
    paymentId: string,
    input: ReversePaymentInput = {},
  ): Promise<ApPaymentDto> {
    return this.db.transaction(async (tx) => {
      const payment = await this.loadPaymentForUpdate(tx, orgId, paymentId);
      if (payment.status === "REVERSED") return this.get(orgId, paymentId, tx);
      if (!payment.postedJournalId) {
        throw new ConflictException("This payment has no journal to reverse");
      }

      const reversal = await this.ledger.reverse(
        orgId,
        userId,
        {
          bookId: payment.bookId,
          journalId: payment.postedJournalId,
          journalDate: input.reversalDate ? assertIsoDate(input.reversalDate) : payment.paymentDate,
          idempotencyKey: `payment:${paymentId}:reverse`,
          memo: input.reason ?? `Reversal of payment ${payment.paymentNumber ?? paymentId}`,
        },
        tx,
      );

      const allocations = await tx
        .select({
          id: apAllocations.id,
          documentId: apAllocations.documentId,
          amountMinor: apAllocations.amountMinor,
        })
        .from(apAllocations)
        .where(and(eq(apAllocations.orgId, orgId), eq(apAllocations.paymentId, paymentId)));

      for (const allocation of allocations) {
        await this.applySettlement(tx, orgId, allocation.documentId, -allocation.amountMinor);
      }
      // Link rows, so a physical delete is right — there is nothing to retain
      // that the reversed journal and the REVERSED payment do not already say.
      await tx
        .delete(apAllocations)
        .where(and(eq(apAllocations.orgId, orgId), eq(apAllocations.paymentId, paymentId)));
      await tx
        .delete(apWithholding)
        .where(and(eq(apWithholding.orgId, orgId), eq(apWithholding.paymentId, paymentId)));

      await tx
        .update(apPayments)
        .set({ status: "REVERSED", reversalJournalId: reversal.id, unappliedMinor: 0 })
        .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)));

      return this.get(orgId, paymentId, tx);
    });
  }

  /* --------------------------------------------------------- withholding */

  /**
   * How much to keep back.
   *
   * The base defaults to the **tax-exclusive** value of what is being paid,
   * split out of each allocated bill in the proportion the bill itself carries,
   * because most regimes (India TDS included) withhold on the invoice value
   * before GST. An unallocated advance has no such split, so it is taken at
   * face value; a caller who knows better states `baseMinor` outright.
   */
  private async determineWithholding(
    tx: DbOrTx,
    args: {
      orgId: string;
      book: { id: string; localizationPack: string };
      vendor: ApVendor;
      paymentDate: string;
      currency: string;
      grossMinor: number;
      allocatedMinor: number;
      allocations: readonly AllocationInput[];
      targets: Map<string, AllocationTarget>;
      instruction?: WithholdingInstruction;
    },
  ): Promise<WithholdingResult> {
    const instruction = args.instruction ?? { mode: "auto" as const };
    const engine = this.withholdingEngines.forPack(args.book.localizationPack);
    const baseMinor = instruction.baseMinor ?? this.withholdingBase(args);

    if (instruction.mode === "none") {
      return {
        regime: engine.regime,
        applicable: false,
        legacySection: null,
        paymentCode: null,
        rateBp: 0,
        baseMinor,
        withheldMinor: 0,
        reason: instruction.reason ?? "No tax withheld on this payment",
      };
    }

    const code = instruction.code ?? args.vendor.withholdingCode ?? null;

    if (instruction.mode === "manual" && instruction.withheldMinor != null) {
      // A stated amount is the instruction; the rate is derived only so the
      // stored row still explains itself on a certificate.
      const rateBp =
        baseMinor > 0
          ? Number(divideRoundHalfUp(BigInt(instruction.withheldMinor) * 10_000n, BigInt(baseMinor)))
          : 0;
      const named = code ? engine.determine({ ...this.baseContext(args, baseMinor, code), overrideRateBp: 0 }) : null;
      return {
        regime: engine.regime,
        applicable: instruction.withheldMinor > 0,
        legacySection: named?.legacySection ?? null,
        paymentCode: named?.paymentCode ?? null,
        rateBp: Math.min(Math.max(rateBp, 0), 10_000),
        baseMinor,
        withheldMinor: instruction.withheldMinor,
        reason: instruction.reason ?? "Amount stated on the payment",
      };
    }

    const context = {
      ...this.baseContext(args, baseMinor, code),
      taxIdOnFile:
        instruction.taxIdOnFile ??
        ((await this.tax.loadRegistrations("party", args.vendor.id, tx)).length > 0),
      cumulativeBaseMinor:
        instruction.cumulativeBaseMinor ??
        (code ? await this.cumulativeWithheldBase(tx, args, code) : 0),
      overrideRateBp: instruction.mode === "manual" ? (instruction.rateBp ?? null) : null,
      overrideReason: instruction.reason ?? null,
    };

    const result = engine.determine(context);
    if (result.withheldMinor > args.grossMinor) {
      throw new BadRequestException(
        `Withholding of ${result.withheldMinor} exceeds the payment of ${args.grossMinor}`,
      );
    }
    return result;
  }

  private baseContext(
    args: {
      vendor: ApVendor;
      paymentDate: string;
      currency: string;
      instruction?: WithholdingInstruction;
    },
    baseMinor: number,
    code: string | null,
  ) {
    return {
      paymentDate: args.paymentDate,
      currency: args.currency,
      baseMinor,
      withholdingCode: code,
      payeeType: args.instruction?.payeeType ?? undefined,
    };
  }

  private withholdingBase(args: {
    grossMinor: number;
    allocatedMinor: number;
    allocations: readonly AllocationInput[];
    targets: Map<string, AllocationTarget>;
  }): number {
    let base = 0;
    for (const allocation of args.allocations) {
      const target = args.targets.get(allocation.documentId);
      if (!target || target.grossMinor <= 0) {
        base += allocation.amountMinor;
        continue;
      }
      base += Number(
        divideRoundHalfUp(
          BigInt(allocation.amountMinor) * BigInt(target.netMinor),
          BigInt(target.grossMinor),
        ),
      );
    }
    return base + (args.grossMinor - args.allocatedMinor);
  }

  /** Year-to-date base under the same code, for an annual threshold. */
  private async cumulativeWithheldBase(
    tx: DbOrTx,
    args: { orgId: string; book: { id: string }; vendor: ApVendor; paymentDate: string },
    code: string,
  ): Promise<number> {
    const year = await this.books.ensureFiscalYear(
      args.orgId,
      args.book.id,
      args.paymentDate,
      tx,
    );
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${apWithholding.baseMinor}), 0)` })
      .from(apWithholding)
      .innerJoin(apPayments, eq(apWithholding.paymentId, apPayments.id))
      .where(
        and(
          eq(apWithholding.orgId, args.orgId),
          eq(apWithholding.bookId, args.book.id),
          eq(apPayments.partyId, args.vendor.id),
          eq(apPayments.status, "POSTED"),
          gte(apPayments.paymentDate, year.startsOn),
          lte(apPayments.paymentDate, year.endsOn),
          sql`(${apWithholding.legacySection} = ${code} OR ${apWithholding.paymentCode} = ${code})`,
        ),
      );
    return Number(row?.total ?? 0);
  }

  private async resolveWithholdingAccount(tx: DbOrTx, bookId: string): Promise<string> {
    // The tax GL map is the first answer, so a pack that maps withholding
    // somewhere other than the default tag is honoured without a code change.
    const glMap = await this.tax.loadGlMap(bookId, tx);
    return glMap.get("withheld:WHT") ?? (await this.books.resolveAccountByTag(bookId, "wht_payable", tx));
  }

  /* ------------------------------------------------------------ internals */

  private async writeAllocation(
    tx: DbOrTx,
    args: {
      orgId: string;
      bookId: string;
      paymentId: string | null;
      debitNoteId: string | null;
      documentId: string;
      amountMinor: number;
      userId: string | null;
    },
  ): Promise<void> {
    try {
      await tx.insert(apAllocations).values({
        orgId: args.orgId,
        bookId: args.bookId,
        paymentId: args.paymentId,
        debitNoteId: args.debitNoteId,
        documentId: args.documentId,
        amountMinor: args.amountMinor,
        createdBy: args.userId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          "That source is already applied to this bill. Reverse the existing allocation first.",
        );
      }
      throw error;
    }
  }

  /**
   * Move a document's settled total and let the status follow from it.
   *
   * Status is derived here rather than set by a caller, so "paid" can never
   * disagree with the allocations that are supposed to prove it.
   */
  private async applySettlement(
    tx: DbOrTx,
    orgId: string,
    documentId: string,
    deltaMinor: number,
  ): Promise<void> {
    const doc = await this.loadDocumentForUpdate(tx, orgId, documentId);
    if (!SETTLEABLE.includes(doc.status)) {
      throw new ConflictException(`A ${doc.status} document cannot be settled`);
    }

    const settledMinor = doc.settledMinor + deltaMinor;
    if (settledMinor < 0) {
      throw new BadRequestException("Unwinding more than was ever allocated to this document");
    }
    if (settledMinor > doc.grossMinor) {
      throw new BadRequestException(
        `Only ${doc.grossMinor - doc.settledMinor} is open on this document`,
      );
    }

    const status: DocumentStatus =
      settledMinor === 0 ? "POSTED" : settledMinor >= doc.grossMinor ? "PAID" : "PARTIALLY_PAID";

    await tx
      .update(apDocuments)
      .set({ settledMinor, status })
      .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)));
  }

  /**
   * The bills a payment or debit note may be applied to: same book, same
   * vendor, same currency, still open, and open for at least what is asked.
   */
  private async loadAllocationTargets(
    tx: DbOrTx,
    orgId: string,
    bookId: string,
    partyId: string,
    currency: string,
    allocations: readonly AllocationInput[],
  ): Promise<Map<string, AllocationTarget>> {
    if (allocations.length === 0) return new Map();
    const ids = [...new Set(allocations.map((a) => a.documentId))];
    if (ids.length !== allocations.length) {
      throw new BadRequestException("The same bill appears twice in the allocation list");
    }

    const rows = await tx
      .select({
        id: apDocuments.id,
        documentType: apDocuments.documentType,
        status: apDocuments.status,
        currency: apDocuments.currency,
        netMinor: apDocuments.netMinor,
        grossMinor: apDocuments.grossMinor,
        settledMinor: apDocuments.settledMinor,
      })
      .from(apDocuments)
      .where(
        and(
          eq(apDocuments.orgId, orgId),
          eq(apDocuments.bookId, bookId),
          eq(apDocuments.partyId, partyId),
          inArray(apDocuments.id, ids),
          isNull(apDocuments.deletedAt),
        ),
      );

    const byId = new Map(rows.map((r) => [r.id, r]));
    const targets = new Map<string, AllocationTarget>();

    for (const allocation of allocations) {
      const row = byId.get(allocation.documentId);
      if (!row) throw new NotFoundException("One of the bills was not found for this vendor");
      if (row.documentType !== "BILL") {
        throw new BadRequestException("Only a bill can be settled by a payment or debit note");
      }
      if (!OPEN_STATUSES.includes(row.status)) {
        throw new ConflictException(`Bill ${row.id} is ${row.status} and has nothing open`);
      }
      if (row.currency !== currency) {
        throw new BadRequestException(
          `Bill ${row.id} is in ${row.currency}; this settlement is in ${currency}`,
        );
      }
      const open = row.grossMinor - row.settledMinor;
      if (allocation.amountMinor > open) {
        throw new BadRequestException(
          `Bill ${row.id} has only ${open} open; ${allocation.amountMinor} was requested`,
        );
      }
      targets.set(row.id, {
        id: row.id,
        netMinor: row.netMinor,
        grossMinor: row.grossMinor,
        openMinor: open,
      });
    }
    return targets;
  }

  private async assertPostableAccount(
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

  private async loadPaymentForUpdate(tx: DbOrTx, orgId: string, paymentId: string) {
    const [row] = await tx
      .select(PAYMENT_COLUMNS)
      .from(apPayments)
      .where(and(eq(apPayments.orgId, orgId), eq(apPayments.id, paymentId)))
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException("Payment not found");
    return row;
  }

  private async loadDocumentForUpdate(tx: DbOrTx, orgId: string, documentId: string) {
    const [row] = await tx
      .select({
        id: apDocuments.id,
        bookId: apDocuments.bookId,
        partyId: apDocuments.partyId,
        documentType: apDocuments.documentType,
        status: apDocuments.status,
        currency: apDocuments.currency,
        netMinor: apDocuments.netMinor,
        grossMinor: apDocuments.grossMinor,
        settledMinor: apDocuments.settledMinor,
      })
      .from(apDocuments)
      .where(
        and(
          eq(apDocuments.orgId, orgId),
          eq(apDocuments.id, documentId),
          isNull(apDocuments.deletedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException("Document not found");
    return row;
  }

  private async loadAllocations(
    tx: DbOrTx,
    orgId: string,
    by: { paymentId?: string; debitNoteId?: string },
  ): Promise<ApAllocationDto[]> {
    const filters = [eq(apAllocations.orgId, orgId)];
    if (by.paymentId) filters.push(eq(apAllocations.paymentId, by.paymentId));
    if (by.debitNoteId) filters.push(eq(apAllocations.debitNoteId, by.debitNoteId));

    const rows = await tx
      .select({
        id: apAllocations.id,
        documentId: apAllocations.documentId,
        amountMinor: apAllocations.amountMinor,
        createdAt: apAllocations.createdAt,
        documentNumber: apDocuments.documentNumber,
        vendorDocumentNumber: apDocuments.vendorDocumentNumber,
      })
      .from(apAllocations)
      .innerJoin(apDocuments, eq(apAllocations.documentId, apDocuments.id))
      .where(and(...filters))
      .orderBy(desc(apAllocations.createdAt));
    return rows;
  }

  private async loadWithholding(
    tx: DbOrTx,
    orgId: string,
    paymentId: string,
  ): Promise<ApWithholdingDto[]> {
    return tx
      .select({
        id: apWithholding.id,
        regime: apWithholding.regime,
        legacySection: apWithholding.legacySection,
        paymentCode: apWithholding.paymentCode,
        rateBp: apWithholding.rateBp,
        baseMinor: apWithholding.baseMinor,
        withheldMinor: apWithholding.withheldMinor,
        currency: apWithholding.currency,
        glAccountId: apWithholding.glAccountId,
        remittanceReference: apWithholding.remittanceReference,
      })
      .from(apWithholding)
      .where(and(eq(apWithholding.orgId, orgId), eq(apWithholding.paymentId, paymentId)));
  }
}

/* ---------------------------------------------------------------- helpers */

interface AllocationTarget {
  id: string;
  netMinor: number;
  grossMinor: number;
  openMinor: number;
}

const PAYMENT_COLUMNS = {
  id: apPayments.id,
  bookId: apPayments.bookId,
  partyId: apPayments.partyId,
  paymentNumber: apPayments.paymentNumber,
  paymentDate: apPayments.paymentDate,
  paymentAccountId: apPayments.paymentAccountId,
  currency: apPayments.currency,
  fxRate: apPayments.fxRate,
  grossMinor: apPayments.grossMinor,
  withheldMinor: apPayments.withheldMinor,
  netPaidMinor: apPayments.netPaidMinor,
  unappliedMinor: apPayments.unappliedMinor,
  status: apPayments.status,
  paymentMethod: apPayments.paymentMethod,
  reference: apPayments.reference,
  memo: apPayments.memo,
  postedJournalId: apPayments.postedJournalId,
  reversalJournalId: apPayments.reversalJournalId,
};

type PaymentRow = Pick<typeof apPayments.$inferSelect, keyof typeof PAYMENT_COLUMNS>;

function toPaymentDto(row: PaymentRow & { partyName: string }): Omit<
  ApPaymentDto,
  "allocations" | "withholding"
> {
  return {
    id: row.id,
    bookId: row.bookId,
    partyId: row.partyId,
    partyName: row.partyName,
    paymentNumber: row.paymentNumber,
    paymentDate: row.paymentDate,
    paymentAccountId: row.paymentAccountId,
    currency: row.currency,
    fxRate: row.fxRate,
    grossMinor: row.grossMinor,
    withheldMinor: row.withheldMinor,
    netPaidMinor: row.netPaidMinor,
    unappliedMinor: row.unappliedMinor,
    status: row.status,
    paymentMethod: row.paymentMethod,
    reference: row.reference,
    memo: row.memo,
    postedJournalId: row.postedJournalId,
    reversalJournalId: row.reversalJournalId,
  };
}
