import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  arDocumentLines,
  arDocuments,
  glFiscalYears,
  glPeriods,
  glFxRates,
  taxDocumentLines,
  type ArDocumentType,
  type DocumentStatus,
  type GlJournalSource,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { PackRegistry } from "../packs/pack.registry";
import type { DocumentSeriesKind } from "../packs/pack.types";
import { convert, divideRoundHalfUp, money } from "../kernel/money";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import type { PostJournalCommand, PostJournalLineCommand, PostedJournal } from "../kernel/ledger.types";
import { TaxService, type DetermineResult } from "../tax/tax.service";
import type { TaxContext, TaxProblem } from "../tax/tax.types";
import { ComplianceService } from "../compliance/compliance.service";
import { PartiesService, type PartyDetail } from "../parties/parties.service";
import type {
  ArDocumentLineInput,
  CreateCreditNoteInput,
  CreateInvoiceInput,
  CreditNoteFromInvoiceInput,
  ListArDocumentsQuery,
  UpdateDraftInput,
} from "./dto/ar-documents.schemas";

/* -------------------------------------------------------------- line maths */

/**
 * `net = round_half_up(quantity * unit price) - discount`, all in integers.
 *
 * Quantity is thousandths so 2.5 hours is exact, and the multiply happens in
 * `BigInt` before the divide so a 1/3 quantity never rounds twice. Exported
 * because it is pure and worth unit-testing on its own.
 */
export function computeLineNetMinor(
  quantityMilli: number,
  unitPriceMinor: number,
  discountMinor: number,
): number {
  const gross = divideRoundHalfUp(BigInt(quantityMilli) * BigInt(unitPriceMinor), 1000n);
  return Number(gross) - discountMinor;
}

/* -------------------------------------------------------------- view types */

export interface ArDocumentLineView {
  id: string;
  lineNo: number;
  description: string;
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  discountMinor: number;
  taxCategory: string;
  commodityCode: string | null;
  forcedTaxCodeId: string | null;
  forcedTaxReason: string | null;
  incomeAccountId: string | null;
  lineNetMinor: number;
  lineTaxMinor: number;
  lineGrossMinor: number;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
}

export interface ArDocumentView {
  id: string;
  bookId: string;
  partyId: string;
  documentType: ArDocumentType;
  status: DocumentStatus;
  documentNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  fxRate: string;
  supplyNature: TaxContext["supplyNature"];
  taxLocationFromCountry: string | null;
  taxLocationFromRegion: string | null;
  taxLocationToCountry: string | null;
  taxLocationToRegion: string | null;
  placeOfSupplyCode: string | null;
  taxInclusive: boolean;
  exportWithIgst: boolean;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  functionalGrossMinor: number;
  settledMinor: number;
  /** `gross - settled`. The one definition of an open item in this module. */
  openMinor: number;
  originalDocumentId: string | null;
  postedJournalId: string | null;
  gstrPeriod: string | null;
  memo: string | null;
  reference: string | null;
  lines: ArDocumentLineView[];
}

export interface ArDocumentPage {
  items: Omit<ArDocumentView, "lines">[];
  page: number;
  pageSize: number;
  total: number;
}

export interface TaxPreviewComponent {
  component: string;
  jurisdiction: string;
  rateBp: number;
  taxableMinor: number;
  taxMinor: number;
  glRole: string;
  accountId: string | null;
}

export interface TaxPreview {
  currency: string;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  lines: Array<{
    documentLineId: string;
    taxCode: string;
    category: string;
    netMinor: number;
    taxMinor: number;
    grossMinor: number;
    components: TaxPreviewComponent[];
  }>;
  errors: TaxProblem[];
  warnings: TaxProblem[];
}

interface ComputedLine {
  id: string;
  lineNo: number;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  incomeAccountId: string | null;
  taxCategory: ArDocumentLineView["taxCategory"];
  commodityCode: string | null;
  forcedTaxCodeId: string | null;
  dimensionProjectId: number | null;
  dimensionCostCenterId: string | null;
  description: string;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const OPEN_STATUSES: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID"];

/** `document_type` as the ledger and the frozen tax rows spell it. */
const SOURCE_TYPE: Record<ArDocumentType, GlJournalSource> = {
  INVOICE: "sales_invoice",
  CREDIT_NOTE: "credit_note",
};

const SERIES_KIND: Record<ArDocumentType, DocumentSeriesKind> = {
  INVOICE: "salesInvoice",
  CREDIT_NOTE: "creditNote",
};

/**
 * Sales invoices and credit notes.
 *
 * A credit note is a signed invoice, so it is the same table, the same maths and
 * the same posting routine with the debits and credits swapped. Two code paths
 * would be two open-item calculations that could disagree.
 *
 * The service computes and emits a `PostJournalCommand`; it never writes a
 * journal line. Posting a document and posting its journal happen in **one**
 * transaction, so a document is never posted without its ledger entry.
 */
@Injectable()
export class ArDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly packs: PackRegistry,
    private readonly tax: TaxService,
    private readonly parties: PartiesService,
    private readonly compliance: ComplianceService,
  ) {}

  /* ----------------------------------------------------------------- read */

  async get(orgId: string, documentId: string, tx: DbOrTx = this.db): Promise<ArDocumentView> {
    const header = await this.loadHeader(orgId, documentId, tx);
    const lines = await tx
      .select({
        id: arDocumentLines.id,
        lineNo: arDocumentLines.lineNo,
        description: arDocumentLines.description,
        quantityMilli: arDocumentLines.quantityMilli,
        unit: arDocumentLines.unit,
        unitPriceMinor: arDocumentLines.unitPriceMinor,
        discountMinor: arDocumentLines.discountMinor,
        taxCategory: arDocumentLines.taxCategory,
        commodityCode: arDocumentLines.commodityCode,
        forcedTaxCodeId: arDocumentLines.forcedTaxCodeId,
        forcedTaxReason: arDocumentLines.forcedTaxReason,
        incomeAccountId: arDocumentLines.incomeAccountId,
        lineNetMinor: arDocumentLines.lineNetMinor,
        lineTaxMinor: arDocumentLines.lineTaxMinor,
        lineGrossMinor: arDocumentLines.lineGrossMinor,
        dimensionProjectId: arDocumentLines.dimensionProjectId,
        dimensionCostCenterId: arDocumentLines.dimensionCostCenterId,
      })
      .from(arDocumentLines)
      .where(eq(arDocumentLines.documentId, documentId))
      .orderBy(asc(arDocumentLines.lineNo));

    return { ...this.toHeaderView(header), lines };
  }

  async list(
    orgId: string,
    documentType: ArDocumentType,
    query: ListArDocumentsQuery = {},
  ): Promise<ArDocumentPage> {
    const book = await this.books.requireDefault(orgId);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filters = [
      eq(arDocuments.orgId, orgId),
      eq(arDocuments.bookId, book.id),
      eq(arDocuments.documentType, documentType),
      isNull(arDocuments.deletedAt),
    ];
    if (query.partyId) filters.push(eq(arDocuments.partyId, query.partyId));
    if (query.status) filters.push(eq(arDocuments.status, query.status));
    if (query.from) filters.push(gte(arDocuments.issueDate, query.from));
    if (query.to) filters.push(lte(arDocuments.issueDate, query.to));
    if (query.openOnly) {
      filters.push(inArray(arDocuments.status, OPEN_STATUSES));
      filters.push(sql`${arDocuments.grossMinor} > ${arDocuments.settledMinor}`);
    }
    if (query.search) {
      const needle = `%${query.search}%`;
      filters.push(
        or(
          sql`${arDocuments.documentNumber} ILIKE ${needle}`,
          sql`${arDocuments.reference} ILIKE ${needle}`,
        )!,
      );
    }
    const where = and(...filters);

    const [items, [counted]] = await Promise.all([
      this.db
        .select(this.headerColumns())
        .from(arDocuments)
        .where(where)
        .orderBy(desc(arDocuments.issueDate), desc(arDocuments.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: sql<string>`count(*)` }).from(arDocuments).where(where),
    ]);

    return {
      items: items.map((row) => this.toHeaderView(row)),
      page,
      pageSize,
      total: Number(counted?.total ?? 0),
    };
  }

  /** The frozen engine verdict on a posted document — never re-determined. */
  async frozenTaxLines(orgId: string, documentId: string) {
    const header = await this.loadHeader(orgId, documentId);
    return this.db
      .select({
        component: taxDocumentLines.component,
        jurisdiction: taxDocumentLines.jurisdiction,
        rateBp: taxDocumentLines.rateBp,
        taxableMinor: taxDocumentLines.taxableMinor,
        taxMinor: taxDocumentLines.taxMinor,
        currency: taxDocumentLines.currency,
        glRole: taxDocumentLines.glRole,
        glAccountId: taxDocumentLines.glAccountId,
        documentLineId: taxDocumentLines.documentLineId,
      })
      .from(taxDocumentLines)
      .where(
        and(
          eq(taxDocumentLines.orgId, orgId),
          eq(taxDocumentLines.bookId, header.bookId),
          eq(taxDocumentLines.documentId, documentId),
        ),
      );
  }

  /* ---------------------------------------------------------- draft write */

  async createInvoice(
    orgId: string,
    userId: string | null,
    input: CreateInvoiceInput,
  ): Promise<ArDocumentView> {
    return this.createDraft(orgId, userId, "INVOICE", input);
  }

  async createCreditNote(
    orgId: string,
    userId: string | null,
    input: CreateCreditNoteInput,
  ): Promise<ArDocumentView> {
    return this.createDraft(orgId, userId, "CREDIT_NOTE", input);
  }

  private async createDraft(
    orgId: string,
    userId: string | null,
    documentType: ArDocumentType,
    input: CreateInvoiceInput & { originalDocumentId?: string | null },
  ): Promise<ArDocumentView> {
    const book = await this.books.requireDefault(orgId);
    assertIsoDate(input.issueDate);

    return this.db.transaction(async (tx) => {
      const party = await this.parties.requireForBook(orgId, book.id, input.partyId, tx);
      const currency = (input.currency ?? party.defaultCurrency).toUpperCase();
      const fxRate = await this.resolveFxRate(
        book.id,
        book.baseCurrency,
        currency,
        input.issueDate,
        input.fxRate,
        tx,
      );

      if (documentType === "CREDIT_NOTE" && input.originalDocumentId) {
        const original = await this.loadHeader(orgId, input.originalDocumentId, tx);
        if (original.documentType !== "INVOICE") {
          throw new BadRequestException("A credit note can only reference an invoice");
        }
      }

      const [created] = await tx
        .insert(arDocuments)
        .values({
          orgId,
          bookId: book.id,
          partyId: party.id,
          documentType,
          status: "DRAFT",
          issueDate: input.issueDate,
          dueDate: input.dueDate ?? this.defaultDueDate(input.issueDate, party.paymentTermsDays),
          currency,
          fxRate,
          supplyNature: input.supplyNature ?? "domestic_b2b",
          taxLocationFromCountry: input.taxLocationFromCountry ?? book.countryCode,
          taxLocationFromRegion: input.taxLocationFromRegion ?? null,
          taxLocationToCountry:
            input.taxLocationToCountry ?? party.billingCountryCode ?? party.countryCode,
          taxLocationToRegion: input.taxLocationToRegion ?? party.billingRegion ?? null,
          placeOfSupplyCode: input.placeOfSupplyCode ?? party.billingRegion ?? null,
          taxInclusive: input.taxInclusive ?? false,
          exportWithIgst: input.exportWithIgst ?? false,
          originalDocumentId: input.originalDocumentId ?? null,
          memo: input.memo ?? null,
          reference: input.reference ?? null,
          crmDealId: input.crmDealId ?? null,
          dimensionProjectId: input.dimensionProjectId ?? null,
          ecommerceGstin: input.ecommerceGstin ?? null,
          createdBy: userId,
        })
        .returning({ id: arDocuments.id });

      if (!created) throw new ConflictException("Could not create the document");

      await this.replaceLines(orgId, created.id, input.lines, tx);
      await this.refreshDraftTotals(created.id, tx);
      return this.get(orgId, created.id, tx);
    });
  }

  /**
   * Copy a posted invoice into a draft credit note.
   *
   * The correction path for a posted document is a new document, never an edit —
   * which is exactly why this exists as a first-class operation.
   */
  async creditNoteFromInvoice(
    orgId: string,
    userId: string | null,
    invoiceId: string,
    input: CreditNoteFromInvoiceInput = {},
  ): Promise<ArDocumentView> {
    const invoice = await this.get(orgId, invoiceId);
    if (invoice.documentType !== "INVOICE") {
      throw new BadRequestException("Only an invoice can be credited");
    }
    if (invoice.status === "DRAFT") {
      throw new ConflictException("Delete the draft instead of crediting it");
    }

    const lines: ArDocumentLineInput[] =
      input.lines ??
      invoice.lines.map((line) => ({
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceMinor: line.unitPriceMinor,
        discountMinor: line.discountMinor,
        taxCategory: line.taxCategory as ArDocumentLineInput["taxCategory"],
        commodityCode: line.commodityCode,
        forcedTaxCodeId: line.forcedTaxCodeId,
        forcedTaxReason: line.forcedTaxReason,
        incomeAccountId: line.incomeAccountId,
        dimensionProjectId: line.dimensionProjectId,
        dimensionCostCenterId: line.dimensionCostCenterId,
      }));

    return this.createDraft(orgId, userId, "CREDIT_NOTE", {
      partyId: invoice.partyId,
      issueDate: input.issueDate ?? invoice.issueDate,
      dueDate: null,
      currency: invoice.currency,
      fxRate: invoice.fxRate,
      supplyNature: invoice.supplyNature,
      taxLocationFromCountry: invoice.taxLocationFromCountry,
      taxLocationFromRegion: invoice.taxLocationFromRegion,
      taxLocationToCountry: invoice.taxLocationToCountry,
      taxLocationToRegion: invoice.taxLocationToRegion,
      placeOfSupplyCode: invoice.placeOfSupplyCode,
      taxInclusive: invoice.taxInclusive,
      exportWithIgst: invoice.exportWithIgst,
      originalDocumentId: invoice.id,
      memo: input.memo ?? `Credit note against ${invoice.documentNumber ?? invoice.id}`,
      reference: input.reference ?? invoice.documentNumber,
      lines,
    });
  }

  /** Drafts are mutable; a posted document is not. Editing one is a 409. */
  async updateDraft(
    orgId: string,
    documentId: string,
    patch: UpdateDraftInput,
  ): Promise<ArDocumentView> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockDocument(orgId, documentId, tx);
      this.assertDraft(current);

      const book = await this.books.get(orgId, current.bookId, tx);
      const partyId = patch.partyId ?? current.partyId;
      const party = await this.parties.requireForBook(orgId, current.bookId, partyId, tx);
      const issueDate = patch.issueDate ?? current.issueDate;
      const currency = (patch.currency ?? current.currency).toUpperCase();
      // Only re-snapshot the rate when the caller changed something that bears on
      // it — silently re-resolving on an unrelated edit would move a rate the
      // caller had pinned by hand.
      const fxRate =
        patch.fxRate !== undefined || currency !== current.currency
          ? await this.resolveFxRate(
              current.bookId,
              book.baseCurrency,
              currency,
              issueDate,
              patch.fxRate,
              tx,
            )
          : current.fxRate;

      await tx
        .update(arDocuments)
        .set({
          partyId,
          issueDate,
          dueDate:
            patch.dueDate === undefined
              ? current.dueDate
              : (patch.dueDate ?? this.defaultDueDate(issueDate, party.paymentTermsDays)),
          currency,
          fxRate,
          supplyNature: patch.supplyNature ?? current.supplyNature,
          taxLocationFromCountry:
            patch.taxLocationFromCountry ?? current.taxLocationFromCountry ?? book.countryCode,
          taxLocationFromRegion:
            patch.taxLocationFromRegion === undefined
              ? current.taxLocationFromRegion
              : patch.taxLocationFromRegion,
          taxLocationToCountry:
            patch.taxLocationToCountry ??
            current.taxLocationToCountry ??
            party.billingCountryCode ??
            party.countryCode,
          taxLocationToRegion:
            patch.taxLocationToRegion === undefined
              ? current.taxLocationToRegion
              : patch.taxLocationToRegion,
          placeOfSupplyCode:
            patch.placeOfSupplyCode === undefined
              ? current.placeOfSupplyCode
              : patch.placeOfSupplyCode,
          taxInclusive: patch.taxInclusive ?? current.taxInclusive,
          exportWithIgst: patch.exportWithIgst ?? current.exportWithIgst,
          originalDocumentId:
            patch.originalDocumentId === undefined
              ? current.originalDocumentId
              : patch.originalDocumentId,
          memo: patch.memo === undefined ? current.memo : patch.memo,
          reference: patch.reference === undefined ? current.reference : patch.reference,
          crmDealId: patch.crmDealId === undefined ? current.crmDealId : patch.crmDealId,
          dimensionProjectId:
            patch.dimensionProjectId === undefined
              ? current.dimensionProjectId
              : patch.dimensionProjectId,
          ecommerceGstin:
            patch.ecommerceGstin === undefined ? current.ecommerceGstin : patch.ecommerceGstin,
        })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));

      if (patch.lines) await this.replaceLines(orgId, documentId, patch.lines, tx);
      await this.refreshDraftTotals(documentId, tx);
      return this.get(orgId, documentId, tx);
    });
  }

  async deleteDraft(orgId: string, documentId: string): Promise<{ id: string; deleted: true }> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockDocument(orgId, documentId, tx);
      this.assertDraft(current);
      await tx
        .update(arDocuments)
        .set({ deletedAt: new Date() })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));
      return { id: documentId, deleted: true as const };
    });
  }

  /* --------------------------------------------------------------- preview */

  /**
   * Run determination and show the answer without writing anything — no journal,
   * no frozen tax rows, no sequence consumed. This is what the invoice screen
   * calls on every keystroke.
   */
  async previewTax(orgId: string, documentId: string): Promise<TaxPreview> {
    const header = await this.loadHeader(orgId, documentId);
    const party = await this.parties.requireForBook(orgId, header.bookId, header.partyId);
    const lines = await this.loadComputedLines(documentId);
    if (lines.length === 0) throw new BadRequestException("A document needs at least one line");

    const determined = await this.tax.determine(
      header.bookId,
      await this.buildTaxContext(header, party, lines, this.db),
      this.db,
    );

    return this.toPreview(header.currency, determined);
  }

  private toPreview(currency: string, determined: DetermineResult): TaxPreview {
    const lines = determined.lines.map((line) => ({
      documentLineId: line.documentLineId,
      taxCode: line.taxCode,
      category: line.category as string,
      netMinor: line.taxableMinor,
      taxMinor: line.totalTaxMinor,
      grossMinor: line.taxableMinor + line.totalTaxMinor,
      components: line.components.map((c) => ({
        component: c.code,
        jurisdiction: c.jurisdiction,
        rateBp: c.rateBp,
        taxableMinor: c.taxableMinor,
        taxMinor: c.taxMinor,
        glRole: c.glRole as string,
        accountId: determined.accountByRoleAndComponent.get(`${c.glRole}:${c.code}`) ?? null,
      })),
    }));

    const netMinor = lines.reduce((a, l) => a + l.netMinor, 0);
    const taxMinor = lines.reduce((a, l) => a + l.taxMinor, 0);
    const roundingMinor = determined.roundingAdjustmentMinor;

    return {
      currency,
      netMinor,
      taxMinor,
      roundingMinor,
      grossMinor: netMinor + taxMinor + roundingMinor,
      lines,
      errors: determined.errors,
      warnings: determined.warnings,
    };
  }

  /* ------------------------------------------------------------- posting */

  /**
   * Compute, determine, number, freeze and post — all inside one transaction.
   *
   * Posting twice is safe from two directions at once: the row lock plus the
   * status check catch the sequential double-click, and the ledger's
   * `(book, idempotency_key)` unique catches the genuinely concurrent one. Both
   * callers get the same journal; there is never a second one.
   */
  async post(
    orgId: string,
    userId: string | null,
    documentId: string,
  ): Promise<{ document: ArDocumentView; journal: PostedJournal }> {
    return this.db.transaction(async (tx) => {
      const header = await this.lockDocument(orgId, documentId, tx);

      if (header.status !== "DRAFT") {
        if (!header.postedJournalId) {
          throw new ConflictException(`Document ${documentId} is ${header.status} but has no journal`);
        }
        const existing = await this.ledger.loadJournal(orgId, header.postedJournalId, tx);
        if (!existing) throw new ConflictException("The document's journal is missing");
        return { document: await this.get(orgId, documentId, tx), journal: { ...existing, replayed: true } };
      }

      const book = await this.books.get(orgId, header.bookId, tx);
      const party = await this.parties.requireForBook(orgId, header.bookId, header.partyId, tx);
      const computed = await this.loadComputedLines(documentId, tx);
      if (computed.length === 0) throw new BadRequestException("A document needs at least one line");

      // Hoisted rather than inlined: the compliance record below needs to know
      // whether each side is tax-registered, and that is settled here.
      const taxContext = await this.buildTaxContext(header, party, computed, tx);
      const determined = await this.tax.determine(header.bookId, taxContext, tx);
      if (determined.errors.length > 0) {
        throw new BadRequestException({
          message: "Tax determination failed",
          errors: determined.errors,
        });
      }

      // The engine owns the net once inclusive tax has been backed out, so its
      // answer replaces what the line arithmetic produced.
      const byLine = new Map(determined.lines.map((l) => [l.documentLineId, l]));
      for (const line of computed) {
        const resolved = byLine.get(line.id);
        if (!resolved) {
          throw new BadRequestException(`The tax engine returned no result for line ${line.lineNo}`);
        }
        line.netMinor = resolved.taxableMinor;
        line.taxMinor = resolved.totalTaxMinor;
        line.grossMinor = resolved.taxableMinor + resolved.totalTaxMinor;
      }

      const netMinor = computed.reduce((a, l) => a + l.netMinor, 0);
      const taxMinor = computed.reduce((a, l) => a + l.taxMinor, 0);
      const roundingMinor = determined.roundingAdjustmentMinor;
      const grossMinor = netMinor + taxMinor + roundingMinor;
      if (grossMinor <= 0) {
        throw new BadRequestException("A document must total more than zero to be posted");
      }

      const fiscalYear = await this.resolveFiscalYear(header.bookId, header.issueDate, tx);
      const pack = this.packs.get(book.localizationPack);
      const documentNumber = await this.sequences.allocate(
        {
          orgId,
          bookId: header.bookId,
          kind: SERIES_KIND[header.documentType],
          series: pack.documentSeries[SERIES_KIND[header.documentType]],
          fiscalYear,
        },
        tx,
      );

      await this.tax.freezeDocumentTaxLines(
        orgId,
        header.bookId,
        SOURCE_TYPE[header.documentType],
        documentId,
        header.currency,
        determined,
        tx,
      );

      const command = await this.buildJournalCommand({
        orgId,
        header,
        party,
        book,
        computed,
        determined,
        netMinor,
        taxMinor,
        grossMinor,
        documentNumber,
        tx,
      });

      const journal = await this.ledger.post(orgId, userId, command, tx);

      const functionalGrossMinor = this.toFunctional(
        grossMinor,
        header.currency,
        book.baseCurrency,
        header.fxRate,
      );

      await tx
        .update(arDocuments)
        .set({
          status: "POSTED",
          documentNumber,
          postedJournalId: journal.id,
          postedBy: userId,
          postedAt: new Date(),
          netMinor,
          taxMinor,
          grossMinor,
          roundingMinor,
          functionalGrossMinor,
          // `YYYY-MM` from the issue date — the return period this supply lands in.
          gstrPeriod: header.issueDate.slice(0, 7),
        })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));

      for (const line of computed) {
        await tx
          .update(arDocumentLines)
          .set({
            lineNetMinor: line.netMinor,
            lineTaxMinor: line.taxMinor,
            lineGrossMinor: line.grossMinor,
          })
          .where(eq(arDocumentLines.id, line.id));
      }

      /**
       * Record whether this document would need reporting to a tax authority
       * (PRD 13). v1 writes the transport and a `pending` status and calls
       * nothing — enforcement is `off`, so a document posts whether or not the
       * authority is reachable. A founder losing the ability to invoice because
       * a government endpoint is down is not a trade worth making.
       */
      await this.compliance.recordForDocument(
        orgId,
        book.id,
        header.documentType === "CREDIT_NOTE" ? "credit_note" : "sales_invoice",
        documentId,
        {
          supplyNature: header.supplyNature,
          sellerHasTaxId: taxContext.sellerRegistrations.length > 0,
          buyerHasTaxId: taxContext.buyerRegistrations.length > 0,
        },
        tx,
      );

      return { document: await this.get(orgId, documentId, tx), journal };
    });
  }

  /**
   * Dr AR control (gross) · Cr revenue per line (net) · Cr tax per component.
   * A credit note is the exact mirror — same lines, sides swapped.
   */
  private async buildJournalCommand(args: {
    orgId: string;
    header: ArDocumentHeader;
    party: PartyDetail;
    book: { id: string; baseCurrency: string; countryCode: string; localizationPack: string };
    computed: ComputedLine[];
    determined: DetermineResult;
    netMinor: number;
    taxMinor: number;
    grossMinor: number;
    documentNumber: string;
    tx: DbOrTx;
  }): Promise<PostJournalCommand> {
    const { header, party, book, computed, determined, grossMinor, documentNumber, tx } = args;
    const isInvoice = header.documentType === "INVOICE";
    const base = book.baseCurrency;
    const currency = header.currency;
    const sameCurrency = currency === base;
    const fxRate = sameCurrency ? "1" : header.fxRate;

    const arAccountId = await this.books.resolveAccountByTag(header.bookId, "ar_control", tx);
    const fallbackIncomeId =
      party.defaultIncomeAccountId ??
      (await this.books.resolveAccountByTag(header.bookId, "sales", tx));

    const lines: PostJournalLineCommand[] = [];

    const push = (
      accountId: string,
      side: "debit" | "credit",
      txnAmountMinor: number,
      extra: Partial<PostJournalLineCommand> = {},
      lineCurrency = currency,
      lineRate = fxRate,
    ) => {
      if (txnAmountMinor <= 0) return;
      const functional = this.toFunctional(txnAmountMinor, lineCurrency, base, lineRate);
      if (functional <= 0) return;
      lines.push({
        accountId,
        ...(side === "debit" ? { debitMinor: functional } : { creditMinor: functional }),
        txnCurrency: lineCurrency,
        txnAmountMinor,
        fxRate: lineCurrency === base ? "1" : lineRate,
        ...extra,
      });
    };

    const arSide = isInvoice ? "debit" : "credit";
    const otherSide = isInvoice ? "credit" : "debit";

    push(arAccountId, arSide, grossMinor, {
      partyId: header.partyId,
      description: `${documentNumber} — ${party.displayName}`,
    });

    for (const line of computed) {
      push(line.incomeAccountId ?? fallbackIncomeId, otherSide, line.netMinor, {
        partyId: header.partyId,
        dimensionProjectId: line.dimensionProjectId ?? header.dimensionProjectId ?? undefined,
        dimensionCostCenterId: line.dimensionCostCenterId ?? undefined,
        description: line.description,
      });
    }

    // One credit per (role, component, code) rather than per line — the GL wants
    // "Output CGST 900", not eleven rows that add up to it.
    for (const bucket of this.aggregateTax(determined)) {
      const accountId = determined.accountByRoleAndComponent.get(bucket.key);
      if (!accountId) {
        throw new BadRequestException(
          `No GL account is mapped for ${bucket.key}. Re-run the tax pack setup for this book.`,
        );
      }
      push(accountId, otherSide, bucket.taxMinor, {
        partyId: header.partyId,
        taxCodeId: bucket.taxCodeId ?? undefined,
        taxComponent: bucket.component,
        description: `${bucket.component} on ${documentNumber}`,
      });
    }

    // The kernel balances at zero tolerance, so any residue — a pack's document
    // rounding, or the paise lost converting each line separately — is posted
    // explicitly rather than papered over.
    const debit = lines.reduce((a, l) => a + (l.debitMinor ?? 0), 0);
    const credit = lines.reduce((a, l) => a + (l.creditMinor ?? 0), 0);
    const difference = debit - credit;
    if (difference !== 0) {
      const roundingAccountId = await this.books.resolveAccountByTag(header.bookId, "rounding", tx);
      push(
        roundingAccountId,
        difference > 0 ? "credit" : "debit",
        Math.abs(difference),
        { description: `Rounding on ${documentNumber}` },
        base,
        "1",
      );
    }

    return {
      bookId: header.bookId,
      idempotencyKey: `${SOURCE_TYPE[header.documentType]}:${header.id}:post`,
      journalDate: header.issueDate,
      memo: `${documentNumber} — ${party.displayName}`,
      sourceType: SOURCE_TYPE[header.documentType],
      sourceId: header.id,
      lines,
    };
  }

  private aggregateTax(determined: DetermineResult) {
    const buckets = new Map<
      string,
      { key: string; component: string; taxCodeId: string | null; taxMinor: number }
    >();
    for (const line of determined.lines) {
      for (const component of line.components) {
        const key = `${component.glRole}:${component.code}`;
        const bucketKey = `${key}|${line.taxCodeId ?? ""}`;
        const existing = buckets.get(bucketKey);
        if (existing) existing.taxMinor += component.taxMinor;
        else {
          buckets.set(bucketKey, {
            key,
            component: component.code,
            taxCodeId: line.taxCodeId,
            taxMinor: component.taxMinor,
          });
        }
      }
    }
    return [...buckets.values()].filter((b) => b.taxMinor > 0);
  }

  /* ------------------------------------------------------------- helpers */

  /** `functional = txn * rate`, the one FX direction this module knows (PRD 11). */
  private toFunctional(
    txnMinor: number,
    currency: string,
    baseCurrency: string,
    fxRate: string,
  ): number {
    if (currency === baseCurrency) return txnMinor;
    return convert(money(txnMinor, currency), baseCurrency, fxRate).minor;
  }

  private async buildTaxContext(
    header: ArDocumentHeader,
    party: PartyDetail,
    lines: ComputedLine[],
    tx: DbOrTx,
  ): Promise<TaxContext> {
    const [sellerRegistrations, buyerRegistrations] = await Promise.all([
      this.tax.loadRegistrations("book", header.bookId, tx),
      this.tax.loadRegistrations("party", header.partyId, tx),
    ]);

    return {
      bookId: header.bookId,
      direction: "sale",
      documentDate: header.issueDate,
      currency: header.currency,
      supplyNature: header.supplyNature,
      from: {
        countryCode: header.taxLocationFromCountry ?? "",
        region: header.taxLocationFromRegion,
      },
      to: {
        countryCode:
          header.taxLocationToCountry ?? party.billingCountryCode ?? party.countryCode,
        region: header.placeOfSupplyCode ?? header.taxLocationToRegion ?? party.billingRegion,
      },
      sellerRegistrations,
      buyerRegistrations,
      lines: lines.map((line) => ({
        id: line.id,
        taxableMinor: line.netMinor,
        taxCategory: line.taxCategory as TaxContext["lines"][number]["taxCategory"],
        commodityCode: line.commodityCode,
        forceTaxCodeId: line.forcedTaxCodeId,
      })),
      taxInclusive: header.taxInclusive,
      flags: { exportWithIgst: header.exportWithIgst },
    };
  }

  private async loadComputedLines(documentId: string, tx: DbOrTx = this.db): Promise<ComputedLine[]> {
    const rows = await tx
      .select({
        id: arDocumentLines.id,
        lineNo: arDocumentLines.lineNo,
        description: arDocumentLines.description,
        quantityMilli: arDocumentLines.quantityMilli,
        unitPriceMinor: arDocumentLines.unitPriceMinor,
        discountMinor: arDocumentLines.discountMinor,
        taxCategory: arDocumentLines.taxCategory,
        commodityCode: arDocumentLines.commodityCode,
        forcedTaxCodeId: arDocumentLines.forcedTaxCodeId,
        incomeAccountId: arDocumentLines.incomeAccountId,
        dimensionProjectId: arDocumentLines.dimensionProjectId,
        dimensionCostCenterId: arDocumentLines.dimensionCostCenterId,
      })
      .from(arDocumentLines)
      .where(eq(arDocumentLines.documentId, documentId))
      .orderBy(asc(arDocumentLines.lineNo));

    return rows.map((row) => {
      const netMinor = computeLineNetMinor(
        row.quantityMilli,
        row.unitPriceMinor,
        row.discountMinor,
      );
      if (netMinor < 0) {
        throw new BadRequestException(
          `Line ${row.lineNo}: the discount exceeds the line amount`,
        );
      }
      return {
        id: row.id,
        lineNo: row.lineNo,
        description: row.description,
        netMinor,
        taxMinor: 0,
        grossMinor: netMinor,
        incomeAccountId: row.incomeAccountId,
        taxCategory: row.taxCategory,
        commodityCode: row.commodityCode,
        forcedTaxCodeId: row.forcedTaxCodeId,
        dimensionProjectId: row.dimensionProjectId,
        dimensionCostCenterId: row.dimensionCostCenterId,
      };
    });
  }

  private async replaceLines(
    orgId: string,
    documentId: string,
    lines: readonly ArDocumentLineInput[],
    tx: DbOrTx,
  ): Promise<void> {
    await tx.delete(arDocumentLines).where(eq(arDocumentLines.documentId, documentId));
    await tx.insert(arDocumentLines).values(
      lines.map((line, index) => ({
        orgId,
        documentId,
        lineNo: index + 1,
        description: line.description,
        quantityMilli: line.quantityMilli ?? 1000,
        unit: line.unit ?? null,
        unitPriceMinor: line.unitPriceMinor,
        discountMinor: line.discountMinor ?? 0,
        taxCategory: line.taxCategory ?? "standard",
        commodityCode: line.commodityCode ?? null,
        forcedTaxCodeId: line.forcedTaxCodeId ?? null,
        forcedTaxReason: line.forcedTaxReason ?? null,
        incomeAccountId: line.incomeAccountId ?? null,
        lineNetMinor: computeLineNetMinor(
          line.quantityMilli ?? 1000,
          line.unitPriceMinor,
          line.discountMinor ?? 0,
        ),
        lineGrossMinor: computeLineNetMinor(
          line.quantityMilli ?? 1000,
          line.unitPriceMinor,
          line.discountMinor ?? 0,
        ),
        dimensionProjectId: line.dimensionProjectId ?? null,
        dimensionCostCenterId: line.dimensionCostCenterId ?? null,
      })),
    );
  }

  /**
   * Keep a draft's header totals in step with its lines. Tax stays zero until
   * the document posts — a draft has no frozen verdict, only a preview.
   */
  private async refreshDraftTotals(documentId: string, tx: DbOrTx): Promise<void> {
    const lines = await this.loadComputedLines(documentId, tx);
    const netMinor = lines.reduce((a, l) => a + l.netMinor, 0);
    await tx
      .update(arDocuments)
      .set({ netMinor, taxMinor: 0, grossMinor: netMinor })
      .where(eq(arDocuments.id, documentId));
  }

  private assertDraft(header: ArDocumentHeader): void {
    if (header.status !== "DRAFT") {
      throw new ConflictException(
        `${header.documentNumber ?? header.id} is ${header.status} and cannot be edited. ` +
          "Issue a credit note instead.",
      );
    }
  }

  private defaultDueDate(issueDate: string, paymentTermsDays: number): string {
    const [y, m, d] = issueDate.split("-").map(Number);
    const due = new Date(Date.UTC(y, m - 1, d + paymentTermsDays));
    return due.toISOString().slice(0, 10);
  }

  /**
   * The rate is snapshotted onto the document at draft time and never re-read,
   * so a rate published tomorrow cannot restate a posted invoice.
   */
  private async resolveFxRate(
    bookId: string,
    baseCurrency: string,
    currency: string,
    onDate: string,
    provided: string | undefined,
    tx: DbOrTx,
  ): Promise<string> {
    if (currency === baseCurrency) {
      if (provided && Number(provided) !== 1) {
        throw new BadRequestException(`A ${currency} document on ${baseCurrency} books needs rate 1`);
      }
      return "1";
    }
    if (provided) {
      if (!(Number(provided) > 0)) throw new BadRequestException("The FX rate must be positive");
      return provided;
    }

    const [row] = await tx
      .select({ rate: glFxRates.rate })
      .from(glFxRates)
      .where(
        and(
          eq(glFxRates.bookId, bookId),
          eq(glFxRates.fromCode, currency),
          eq(glFxRates.toCode, baseCurrency),
          lte(glFxRates.rateDate, onDate),
        ),
      )
      .orderBy(desc(glFxRates.rateDate))
      .limit(1);

    if (!row) {
      throw new BadRequestException(
        `No ${currency}/${baseCurrency} rate is on file for ${onDate}. Supply one with the document.`,
      );
    }
    return row.rate;
  }

  /**
   * The fiscal year covering the document date. Missing is a setup error, not
   * an invitation to invent a period — the kernel would reject the post anyway,
   * and this says so before a number is burned.
   */
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

  private headerColumns() {
    return {
      id: arDocuments.id,
      bookId: arDocuments.bookId,
      partyId: arDocuments.partyId,
      documentType: arDocuments.documentType,
      status: arDocuments.status,
      documentNumber: arDocuments.documentNumber,
      issueDate: arDocuments.issueDate,
      dueDate: arDocuments.dueDate,
      currency: arDocuments.currency,
      fxRate: arDocuments.fxRate,
      supplyNature: arDocuments.supplyNature,
      taxLocationFromCountry: arDocuments.taxLocationFromCountry,
      taxLocationFromRegion: arDocuments.taxLocationFromRegion,
      taxLocationToCountry: arDocuments.taxLocationToCountry,
      taxLocationToRegion: arDocuments.taxLocationToRegion,
      placeOfSupplyCode: arDocuments.placeOfSupplyCode,
      taxInclusive: arDocuments.taxInclusive,
      exportWithIgst: arDocuments.exportWithIgst,
      netMinor: arDocuments.netMinor,
      taxMinor: arDocuments.taxMinor,
      grossMinor: arDocuments.grossMinor,
      roundingMinor: arDocuments.roundingMinor,
      functionalGrossMinor: arDocuments.functionalGrossMinor,
      settledMinor: arDocuments.settledMinor,
      originalDocumentId: arDocuments.originalDocumentId,
      postedJournalId: arDocuments.postedJournalId,
      gstrPeriod: arDocuments.gstrPeriod,
      memo: arDocuments.memo,
      reference: arDocuments.reference,
      crmDealId: arDocuments.crmDealId,
      dimensionProjectId: arDocuments.dimensionProjectId,
      ecommerceGstin: arDocuments.ecommerceGstin,
    } as const;
  }

  private toHeaderView(row: ArDocumentHeader): Omit<ArDocumentView, "lines"> {
    return {
      id: row.id,
      bookId: row.bookId,
      partyId: row.partyId,
      documentType: row.documentType,
      status: row.status,
      documentNumber: row.documentNumber,
      issueDate: row.issueDate,
      dueDate: row.dueDate,
      currency: row.currency,
      fxRate: row.fxRate,
      supplyNature: row.supplyNature,
      taxLocationFromCountry: row.taxLocationFromCountry,
      taxLocationFromRegion: row.taxLocationFromRegion,
      taxLocationToCountry: row.taxLocationToCountry,
      taxLocationToRegion: row.taxLocationToRegion,
      placeOfSupplyCode: row.placeOfSupplyCode,
      taxInclusive: row.taxInclusive,
      exportWithIgst: row.exportWithIgst,
      netMinor: row.netMinor,
      taxMinor: row.taxMinor,
      grossMinor: row.grossMinor,
      roundingMinor: row.roundingMinor,
      functionalGrossMinor: row.functionalGrossMinor,
      settledMinor: row.settledMinor,
      openMinor: row.grossMinor - row.settledMinor,
      originalDocumentId: row.originalDocumentId,
      postedJournalId: row.postedJournalId,
      gstrPeriod: row.gstrPeriod,
      memo: row.memo,
      reference: row.reference,
    };
  }

  private async loadHeader(
    orgId: string,
    documentId: string,
    tx: DbOrTx = this.db,
  ): Promise<ArDocumentHeader> {
    const [row] = await tx
      .select(this.headerColumns())
      .from(arDocuments)
      .where(
        and(
          eq(arDocuments.orgId, orgId),
          eq(arDocuments.id, documentId),
          isNull(arDocuments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Document not found");
    return row;
  }

  /** `SELECT … FOR UPDATE`, so two posts of the same document serialise. */
  private async lockDocument(
    orgId: string,
    documentId: string,
    tx: DbOrTx,
  ): Promise<ArDocumentHeader> {
    const [row] = await tx
      .select(this.headerColumns())
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

type ArDocumentHeader = {
  id: string;
  bookId: string;
  partyId: string;
  documentType: ArDocumentType;
  status: DocumentStatus;
  documentNumber: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  fxRate: string;
  supplyNature: TaxContext["supplyNature"];
  taxLocationFromCountry: string | null;
  taxLocationFromRegion: string | null;
  taxLocationToCountry: string | null;
  taxLocationToRegion: string | null;
  placeOfSupplyCode: string | null;
  taxInclusive: boolean;
  exportWithIgst: boolean;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  roundingMinor: number;
  functionalGrossMinor: number;
  settledMinor: number;
  originalDocumentId: string | null;
  postedJournalId: string | null;
  gstrPeriod: string | null;
  memo: string | null;
  reference: string | null;
  crmDealId: string | null;
  dimensionProjectId: number | null;
  ecommerceGstin: string | null;
};

/** Statuses that still carry an open balance. Exported for the aging report. */
export { OPEN_STATUSES };
