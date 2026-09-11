import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  apDocumentLines,
  apDocuments,
  glAccounts,
  glParties,
  type ApDocumentType,
  type DocumentStatus,
  type GlJournalSource,
  type GlSystemTag,
  type TaxGlRole,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService, type DbOrTx } from "../kernel/sequence.service";
import { assertIsoDate } from "../kernel/fiscal-calendar";
import { convert, money } from "../kernel/money";
import { PackRegistry } from "../packs/pack.registry";
import type { DocumentSeriesKind } from "../packs/pack.types";
import { TaxService, type DetermineResult } from "../tax/tax.service";
import type { TaxComponentResult, TaxContext, TaxContextRegistration } from "../tax/tax.types";
import { computeLineNetMinor, periodKeyOf } from "./ap.math";
import { draft, flip, toJournalLines, type JournalDraftLine, type PostingSide } from "./ap.posting";
import { isUniqueViolation } from "./ap.pg-errors";
import { requireVendor, type ApVendor } from "./ap.vendor-lookup";
import type {
  ApDocumentDetail,
  ApDocumentLineDto,
  ApDocumentSummary,
  ApPostResult,
  ApTaxPreview,
} from "./ap.types";
import type {
  ApDocumentLineInput,
  CreateApDocumentInput,
  ListApDocumentsQuery,
  UpdateApDocumentInput,
} from "./dto/ap-documents.schemas";

/** Tax roles that debit an asset (or, when blocked, an expense). */
const INPUT_ROLES = new Set<TaxGlRole>(["input_recoverable", "reverse_charge_input"]);
/** Tax roles that credit a liability — including the reverse-charge output leg. */
const OUTPUT_ROLES = new Set<TaxGlRole>(["output_payable", "reverse_charge_output"]);

const SEQUENCE_KIND: Record<ApDocumentType, DocumentSeriesKind> = {
  BILL: "purchaseBill",
  DEBIT_NOTE: "debitNote",
};

const JOURNAL_SOURCE: Record<ApDocumentType, GlJournalSource> = {
  BILL: "purchase_bill",
  DEBIT_NOTE: "debit_note",
};

interface ComputedTotals {
  determination: DetermineResult;
  netMinor: number;
  /** What the vendor charged — input tax net of any reverse-charge offset. */
  taxMinor: number;
  /** The reverse-charge leg the buyer accounts for on both sides. */
  selfAssessedTaxMinor: number;
  /** Input tax the engine marked non-recoverable, which is costed not capitalised. */
  blockedTaxMinor: number;
  roundingMinor: number;
  grossMinor: number;
  perLine: Map<string, { netMinor: number; taxMinor: number; grossMinor: number }>;
}

/**
 * Bills and debit notes.
 *
 * One table, discriminated by `document_type`, because a debit note is a signed
 * bill: two tables would mean two open-item calculations that could disagree.
 * A debit note posts the exact mirror of a bill — there is one journal builder
 * here, with the sides flipped, rather than two that drift apart.
 *
 * The service computes, asks `TaxService` what the tax is, and hands
 * `LedgerService` a balanced command. It never writes a journal line, never
 * hardcodes an account code, and never branches on a country.
 */
@Injectable()
export class ApDocumentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
    private readonly ledger: LedgerService,
    private readonly sequences: SequenceService,
    private readonly tax: TaxService,
    private readonly packs: PackRegistry,
  ) {}

  /* --------------------------------------------------------------- reads */

  async get(orgId: string, documentId: string, tx: DbOrTx = this.db): Promise<ApDocumentDetail> {
    const [row] = await tx
      .select({ ...DOCUMENT_COLUMNS, partyName: glParties.displayName })
      .from(apDocuments)
      .innerJoin(glParties, eq(apDocuments.partyId, glParties.id))
      .where(
        and(
          eq(apDocuments.orgId, orgId),
          eq(apDocuments.id, documentId),
          isNull(apDocuments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Document not found");

    const lines = await this.loadLines(tx, documentId);
    return toDetail(row, lines);
  }

  async list(
    orgId: string,
    query: ListApDocumentsQuery,
  ): Promise<{ items: ApDocumentSummary[]; page: number; pageSize: number; total: number }> {
    const book = await this.books.requireDefault(orgId);
    const filters = [
      eq(apDocuments.orgId, orgId),
      eq(apDocuments.bookId, book.id),
      isNull(apDocuments.deletedAt),
    ];
    if (query.documentType) filters.push(eq(apDocuments.documentType, query.documentType));
    if (query.status) filters.push(eq(apDocuments.status, query.status));
    if (query.partyId) filters.push(eq(apDocuments.partyId, query.partyId));
    if (query.from) filters.push(gte(apDocuments.issueDate, assertIsoDate(query.from)));
    if (query.to) filters.push(lte(apDocuments.issueDate, assertIsoDate(query.to)));
    if (query.openOnly) {
      filters.push(inArray(apDocuments.status, ["POSTED", "PARTIALLY_PAID"]));
      filters.push(sql`${apDocuments.grossMinor} > ${apDocuments.settledMinor}`);
    }

    const where = and(...filters);
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(apDocuments)
      .where(where);

    const rows = await this.db
      .select({ ...DOCUMENT_COLUMNS, partyName: glParties.displayName })
      .from(apDocuments)
      .innerJoin(glParties, eq(apDocuments.partyId, glParties.id))
      .where(where)
      .orderBy(desc(apDocuments.issueDate), desc(apDocuments.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: rows.map((r) => toSummary(r)),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(total),
    };
  }

  /* -------------------------------------------------------------- drafts */

  async create(
    orgId: string,
    userId: string | null,
    input: CreateApDocumentInput,
  ): Promise<ApDocumentDetail> {
    return this.db.transaction(async (tx) => {
      const book = input.bookId
        ? await this.books.get(orgId, input.bookId, tx)
        : await this.books.requireDefault(orgId, tx);
      const vendor = await requireVendor(tx, orgId, book.id, input.partyId);
      const currency = input.currency ?? book.baseCurrency;
      const fxRate = input.fxRate ?? "1";
      this.assertFxIsCoherent(currency, book.baseCurrency, fxRate);

      const issueDate = assertIsoDate(input.issueDate);
      await this.assertAccountsBelongToBook(tx, book.id, input.lines);
      if (input.originalDocumentId) {
        await this.assertOriginalExists(tx, orgId, book.id, input.originalDocumentId);
      }

      const supplyNature =
        input.supplyNature ?? (input.reverseCharge ? "reverse_charge" : "domestic_b2b");
      const reverseCharge = input.reverseCharge ?? supplyNature === "reverse_charge";

      const values = {
        orgId,
        bookId: book.id,
        partyId: vendor.id,
        documentType: input.documentType,
        status: "DRAFT" as const,
        vendorDocumentNumber: input.vendorDocumentNumber ?? null,
        vendorDocumentDate: input.vendorDocumentDate ?? null,
        issueDate,
        dueDate: input.dueDate ?? null,
        currency,
        fxRate,
        supplyNature,
        reverseCharge,
        blockedInputTax: input.blockedInputTax,
        taxInclusive: input.taxInclusive,
        placeOfSupplyCode: input.placeOfSupplyCode ?? null,
        taxLocationFromCountry: input.taxLocationFromCountry ?? null,
        taxLocationFromRegion: input.taxLocationFromRegion ?? null,
        taxLocationToCountry: input.taxLocationToCountry ?? null,
        taxLocationToRegion: input.taxLocationToRegion ?? null,
        originalDocumentId: input.originalDocumentId ?? null,
        memo: input.memo ?? null,
        reference: input.reference ?? null,
        dimensionProjectId: input.dimensionProjectId ?? null,
        createdBy: userId,
      };

      const [created] = await this.guardDuplicateVendorNumber(
        vendor.displayName,
        input.vendorDocumentNumber ?? null,
        () => tx.insert(apDocuments).values(values).returning({ id: apDocuments.id }),
      );
      if (!created) throw new ConflictException("Could not create the document");

      await this.writeLines(tx, orgId, created.id, input.lines);
      return this.get(orgId, created.id, tx);
    });
  }

  /**
   * Edit a draft. A posted document is immutable — the correction is a debit
   * note or a reversal, never an edit, so this is a 409 and not a 400.
   */
  async update(
    orgId: string,
    documentId: string,
    input: UpdateApDocumentInput,
  ): Promise<ApDocumentDetail> {
    return this.db.transaction(async (tx) => {
      const existing = await this.loadForUpdate(tx, orgId, documentId);
      this.assertDraft(existing);

      const book = await this.books.get(orgId, existing.bookId, tx);
      const partyId = input.partyId ?? existing.partyId;
      const vendor = await requireVendor(tx, orgId, book.id, partyId);

      const currency = input.currency ?? existing.currency;
      const fxRate = input.fxRate ?? existing.fxRate;
      this.assertFxIsCoherent(currency, book.baseCurrency, fxRate);
      if (input.lines) await this.assertAccountsBelongToBook(tx, book.id, input.lines);
      if (input.originalDocumentId) {
        await this.assertOriginalExists(tx, orgId, book.id, input.originalDocumentId);
      }

      const supplyNature =
        input.supplyNature ??
        (input.reverseCharge === undefined
          ? existing.supplyNature
          : input.reverseCharge
            ? "reverse_charge"
            : "domestic_b2b");

      const vendorDocumentNumber =
        input.vendorDocumentNumber === undefined
          ? existing.vendorDocumentNumber
          : (input.vendorDocumentNumber ?? null);

      await this.guardDuplicateVendorNumber(vendor.displayName, vendorDocumentNumber, () =>
        tx
          .update(apDocuments)
          .set({
            partyId: vendor.id,
            vendorDocumentNumber,
            vendorDocumentDate:
              input.vendorDocumentDate === undefined
                ? existing.vendorDocumentDate
                : (input.vendorDocumentDate ?? null),
            issueDate: input.issueDate ? assertIsoDate(input.issueDate) : existing.issueDate,
            dueDate: input.dueDate === undefined ? existing.dueDate : (input.dueDate ?? null),
            currency,
            fxRate,
            supplyNature,
            reverseCharge: input.reverseCharge ?? supplyNature === "reverse_charge",
            blockedInputTax: input.blockedInputTax ?? existing.blockedInputTax,
            taxInclusive: input.taxInclusive ?? existing.taxInclusive,
            placeOfSupplyCode:
              input.placeOfSupplyCode === undefined
                ? existing.placeOfSupplyCode
                : (input.placeOfSupplyCode ?? null),
            taxLocationFromCountry:
              input.taxLocationFromCountry === undefined
                ? existing.taxLocationFromCountry
                : (input.taxLocationFromCountry ?? null),
            taxLocationFromRegion:
              input.taxLocationFromRegion === undefined
                ? existing.taxLocationFromRegion
                : (input.taxLocationFromRegion ?? null),
            taxLocationToCountry:
              input.taxLocationToCountry === undefined
                ? existing.taxLocationToCountry
                : (input.taxLocationToCountry ?? null),
            taxLocationToRegion:
              input.taxLocationToRegion === undefined
                ? existing.taxLocationToRegion
                : (input.taxLocationToRegion ?? null),
            originalDocumentId:
              input.originalDocumentId === undefined
                ? existing.originalDocumentId
                : (input.originalDocumentId ?? null),
            memo: input.memo === undefined ? existing.memo : (input.memo ?? null),
            reference: input.reference === undefined ? existing.reference : (input.reference ?? null),
            dimensionProjectId:
              input.dimensionProjectId === undefined
                ? existing.dimensionProjectId
                : (input.dimensionProjectId ?? null),
          })
          .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)))
          .returning({ id: apDocuments.id }),
      );

      if (input.lines) {
        await tx.delete(apDocumentLines).where(eq(apDocumentLines.documentId, documentId));
        await this.writeLines(tx, orgId, documentId, input.lines);
      }

      return this.get(orgId, documentId, tx);
    });
  }

  /** Soft delete, and only while it is a draft. Posted history never vanishes. */
  async remove(orgId: string, documentId: string): Promise<{ id: string; deleted: true }> {
    return this.db.transaction(async (tx) => {
      const existing = await this.loadForUpdate(tx, orgId, documentId);
      this.assertDraft(existing);
      await tx
        .update(apDocuments)
        .set({ deletedAt: new Date() })
        .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)));
      return { id: documentId, deleted: true as const };
    });
  }

  /* ---------------------------------------------------------- tax preview */

  /**
   * What the engine would say, with nothing written.
   *
   * Purchases run determination with `direction: 'purchase'`, which is what
   * makes the same 18% resolve to *input* CGST/SGST here and *output*
   * CGST/SGST on a sales invoice — the difference is one field, not a fork.
   */
  async previewTax(orgId: string, documentId: string): Promise<ApTaxPreview> {
    const doc = await this.loadDocumentRow(this.db, orgId, documentId);
    const lines = await this.loadLineRows(this.db, documentId);
    const book = await this.books.get(orgId, doc.bookId);
    const vendor = await requireVendor(this.db, orgId, doc.bookId, doc.partyId);

    const totals = await this.computeTotals(this.db, doc, lines, vendor, book.countryCode);

    return {
      documentId,
      currency: doc.currency,
      netMinor: totals.netMinor,
      taxMinor: totals.taxMinor,
      selfAssessedTaxMinor: totals.selfAssessedTaxMinor,
      blockedTaxMinor: totals.blockedTaxMinor,
      roundingMinor: totals.roundingMinor,
      grossMinor: totals.grossMinor,
      lines: totals.determination.lines.map((line) => ({
        documentLineId: line.documentLineId,
        taxCode: line.taxCode,
        taxCodeId: line.taxCodeId,
        category: line.category,
        taxableMinor: line.taxableMinor,
        totalTaxMinor: line.totalTaxMinor,
        components: line.components.map((component) => ({
          component: component.code,
          jurisdiction: component.jurisdiction,
          rateBp: component.rateBp,
          taxableMinor: component.taxableMinor,
          taxMinor: component.taxMinor,
          recoverable: component.recoverable,
          glRole: component.glRole,
          glAccountId:
            totals.determination.accountByRoleAndComponent.get(
              `${component.glRole}:${component.code}`,
            ) ?? null,
        })),
      })),
      errors: totals.determination.errors,
      warnings: totals.determination.warnings,
    };
  }

  /* -------------------------------------------------------------- posting */

  /**
   * Freeze the document and post its journal, in one transaction.
   *
   * A bill debits expense or asset per line, debits the recoverable tax per
   * component, and credits AP with the gross. A debit note is the exact mirror.
   * Every account comes from the book's tag map or the tax GL map keyed
   * `glRole:component`; nothing here knows an account code.
   *
   * Reverse charge posts **both** legs the engine returns, so the GST nets to
   * zero on the supply and accounts payable carries only what the vendor is
   * actually owed. There is no `if (country === 'IN')` — AP simply obeys the
   * `glRole` on each component.
   */
  async post(orgId: string, userId: string | null, documentId: string): Promise<ApPostResult> {
    return this.db.transaction(async (tx) => {
      const doc = await this.loadForUpdate(tx, orgId, documentId);

      // Posting twice is a no-op, not a second journal (PRD 03 acceptance 7).
      if (doc.status !== "DRAFT") {
        if (!doc.postedJournalId) {
          throw new ConflictException(`A ${doc.status} document cannot be posted`);
        }
        const journal = await this.ledger.loadJournal(orgId, doc.postedJournalId, tx);
        return {
          document: await this.get(orgId, documentId, tx),
          journalId: doc.postedJournalId,
          journalNumber: journal?.journalNumber ?? "",
          replayed: true,
          selfAssessedTaxMinor: 0,
        } satisfies ApPostResult;
      }

      const book = await this.books.get(orgId, doc.bookId, tx);
      const vendor = await requireVendor(tx, orgId, doc.bookId, doc.partyId);
      const lines = await this.loadLineRows(tx, documentId);
      if (lines.length === 0) throw new BadRequestException("A document needs at least one line");

      const totals = await this.computeTotals(tx, doc, lines, vendor, book.countryCode, tx);
      if (totals.determination.errors.length > 0) {
        throw new BadRequestException({
          message: "Tax could not be determined for this document",
          errors: totals.determination.errors,
        });
      }
      if (totals.netMinor < 0 || totals.grossMinor <= 0) {
        throw new BadRequestException(
          "A document must post a positive amount; check the line quantities and discounts",
        );
      }

      const fiscalYear = await this.books.ensureFiscalYear(orgId, doc.bookId, doc.issueDate, tx);
      const pack = this.packs.get(book.localizationPack);
      const documentNumber = await this.sequences.allocate(
        {
          orgId,
          bookId: doc.bookId,
          kind: SEQUENCE_KIND[doc.documentType],
          series: pack.documentSeries[SEQUENCE_KIND[doc.documentType]],
          fiscalYear: { id: fiscalYear.id, name: fiscalYear.name },
        },
        tx,
      );

      const drafts = await this.buildJournalDrafts(tx, doc, lines, vendor, totals);
      const roundingAccountId = await this.books.resolveAccountByTag(doc.bookId, "rounding", tx);
      const sourceType = JOURNAL_SOURCE[doc.documentType];

      const journal = await this.ledger.post(
        orgId,
        userId,
        {
          bookId: doc.bookId,
          idempotencyKey: `${sourceType}:${doc.id}:post`,
          journalDate: doc.issueDate,
          memo:
            doc.memo ??
            `${doc.documentType === "BILL" ? "Bill" : "Debit note"} ${documentNumber} — ${vendor.displayName}`,
          sourceType,
          sourceId: doc.id,
          lines: toJournalLines({
            drafts,
            currency: doc.currency,
            functionalCurrency: book.baseCurrency,
            fxRate: doc.fxRate,
            roundingAccountId,
            roundingMinor:
              doc.documentType === "BILL" ? totals.roundingMinor : -totals.roundingMinor,
            roundingDescription: "Tax rounding adjustment",
          }),
        },
        tx,
      );

      await this.tax.freezeDocumentTaxLines(
        orgId,
        doc.bookId,
        sourceType,
        doc.id,
        doc.currency,
        this.withResolvedTaxAccounts(totals.determination, await this.blockedAccountId(doc.bookId, tx)),
        tx,
      );

      const functionalGrossMinor =
        doc.currency === book.baseCurrency
          ? totals.grossMinor
          : convert(money(totals.grossMinor, doc.currency), book.baseCurrency, doc.fxRate).minor;

      await tx
        .update(apDocuments)
        .set({
          status: "POSTED",
          documentNumber,
          netMinor: totals.netMinor,
          taxMinor: totals.taxMinor,
          grossMinor: totals.grossMinor,
          roundingMinor: totals.roundingMinor,
          functionalGrossMinor,
          gstrPeriod: periodKeyOf(doc.issueDate),
          postedJournalId: journal.id,
          postedBy: userId,
          postedAt: new Date(),
        })
        .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, doc.id)));

      for (const line of lines) {
        const computed = totals.perLine.get(line.id);
        if (!computed) continue;
        await tx
          .update(apDocumentLines)
          .set({
            lineNetMinor: computed.netMinor,
            lineTaxMinor: computed.taxMinor,
            lineGrossMinor: computed.grossMinor,
          })
          .where(eq(apDocumentLines.id, line.id));
      }

      return {
        document: await this.get(orgId, doc.id, tx),
        journalId: journal.id,
        journalNumber: journal.journalNumber,
        replayed: journal.replayed,
        selfAssessedTaxMinor: totals.selfAssessedTaxMinor,
      } satisfies ApPostResult;
    });
  }

  /* ------------------------------------------------------------ internals */

  /**
   * Run determination and roll the answer up into document totals.
   *
   * The interesting arithmetic is what accounts payable should carry. A vendor
   * charges input tax and is owed it; under reverse charge the engine also
   * returns an output leg, and the two cancel — so `taxMinor` is input less
   * output, which is exactly the tax on the vendor's own document. The
   * self-assessed leg moves GST without moving money and is reported apart.
   */
  private async computeTotals(
    reader: DbOrTx,
    doc: DocumentRow,
    lines: LineRow[],
    vendor: ApVendor,
    bookCountryCode: string,
    tx: DbOrTx = reader,
  ): Promise<ComputedTotals> {
    const context = await this.buildTaxContext(reader, doc, lines, vendor, bookCountryCode);
    const determination = await this.tax.determine(doc.bookId, context, tx);

    const byLine = new Map(determination.lines.map((l) => [l.documentLineId, l]));
    const perLine = new Map<string, { netMinor: number; taxMinor: number; grossMinor: number }>();

    let netMinor = 0;
    let taxMinor = 0;
    let selfAssessedTaxMinor = 0;
    let blockedTaxMinor = 0;

    for (const line of lines) {
      const resolved = byLine.get(line.id);
      // No verdict for a line means determination failed on it; the caller
      // surfaces `errors` rather than posting a document with a hole in it.
      const lineNet = resolved?.taxableMinor ?? computeLineNet(line);
      let lineTax = 0;

      for (const component of resolved?.components ?? []) {
        if (INPUT_ROLES.has(component.glRole)) {
          lineTax += component.taxMinor;
          if (!component.recoverable) blockedTaxMinor += component.taxMinor;
        } else if (OUTPUT_ROLES.has(component.glRole)) {
          lineTax -= component.taxMinor;
          selfAssessedTaxMinor += component.taxMinor;
        }
      }

      netMinor += lineNet;
      taxMinor += lineTax;
      perLine.set(line.id, {
        netMinor: lineNet,
        taxMinor: lineTax,
        grossMinor: lineNet + lineTax,
      });
    }

    const roundingMinor = determination.roundingAdjustmentMinor;
    return {
      determination,
      netMinor,
      taxMinor,
      selfAssessedTaxMinor,
      blockedTaxMinor,
      roundingMinor,
      grossMinor: netMinor + taxMinor + roundingMinor,
      perLine,
    };
  }

  /**
   * The purchase context.
   *
   * On a purchase the **vendor** is the supplier, so its registrations are the
   * "seller" ones the engine reasons from and the book's are the buyer's — the
   * exact inverse of a sales invoice. A vendor with nothing on file still has a
   * place of supply, so the document's from-location stands in under the book's
   * own regime; a supplier genuinely outside the tax net is modelled by the
   * document's `supplyNature`, which the engine already understands.
   */
  private async buildTaxContext(
    reader: DbOrTx,
    doc: DocumentRow,
    lines: LineRow[],
    vendor: ApVendor,
    bookCountryCode: string,
  ): Promise<TaxContext> {
    const bookRegistrations = await this.tax.loadRegistrations("book", doc.bookId, reader);
    const vendorRegistrations = await this.tax.loadRegistrations("party", vendor.id, reader);

    const fromCountry =
      doc.taxLocationFromCountry ?? vendor.billingCountryCode ?? vendor.countryCode;
    const fromRegion = doc.taxLocationFromRegion ?? vendor.billingRegion ?? null;
    const toCountry = doc.taxLocationToCountry ?? bookCountryCode;
    const toRegion =
      doc.taxLocationToRegion ??
      doc.placeOfSupplyCode ??
      bookRegistrations.find((r) => r.region)?.region ??
      null;

    const sellerRegistrations: TaxContextRegistration[] =
      vendorRegistrations.length > 0
        ? vendorRegistrations
        : bookRegistrations.map((r) => ({
            regime: r.regime,
            number: "",
            region: fromRegion,
            countryCode: fromCountry,
          }));

    return {
      bookId: doc.bookId,
      direction: "purchase",
      documentDate: doc.issueDate,
      currency: doc.currency,
      supplyNature: doc.supplyNature,
      from: { countryCode: fromCountry, region: fromRegion },
      to: { countryCode: toCountry, region: toRegion },
      sellerRegistrations,
      buyerRegistrations: bookRegistrations,
      taxInclusive: doc.taxInclusive,
      flags: { blockedInput: doc.blockedInputTax },
      lines: lines.map((line) => ({
        id: line.id,
        taxableMinor: computeLineNet(line),
        taxCategory: line.taxCategory,
        commodityCode: line.commodityCode,
        forceTaxCodeId: line.forcedTaxCodeId,
        quantity: line.quantityMilli / 1000,
        uom: line.unit,
      })),
    };
  }

  /**
   * Dr expense or asset per line, Dr recoverable tax per component, Cr AP with
   * the gross — with every side flipped when the document is a debit note.
   */
  private async buildJournalDrafts(
    tx: DbOrTx,
    doc: DocumentRow,
    lines: LineRow[],
    vendor: ApVendor,
    totals: ComputedTotals,
  ): Promise<JournalDraftLine[]> {
    const isBill = doc.documentType === "BILL";
    const orient = (side: PostingSide): PostingSide => (isBill ? side : flip(side));

    const fallbackTags: GlSystemTag[] = ["opex", "fixed_asset", "ap_control"];
    const tagged = await this.books.resolveAccountsByTag(doc.bookId, fallbackTags, tx);
    const blockedFallbackId = tagged.get("opex")!;

    const drafts: JournalDraftLine[] = [];

    for (const line of lines) {
      const computed = totals.perLine.get(line.id);
      if (!computed || computed.netMinor === 0) continue;
      const accountId =
        line.expenseAccountId ??
        vendor.defaultExpenseAccountId ??
        (line.capitalize ? tagged.get("fixed_asset")! : tagged.get("opex")!);

      drafts.push(
        draft(accountId, orient("debit"), computed.netMinor, {
          description: line.description,
          partyId: doc.partyId,
          dimensionProjectId: line.dimensionProjectId ?? doc.dimensionProjectId ?? undefined,
          dimensionCostCenterId: line.dimensionCostCenterId ?? undefined,
        }),
      );
    }

    // One journal line per (role, component, code), not per document line, so a
    // twenty-line bill still produces a readable CGST/SGST pair.
    const buckets = new Map<
      string,
      { accountId: string; side: PostingSide; amount: number; component: string; taxCodeId: string | null }
    >();

    for (const taxLine of totals.determination.lines) {
      for (const component of taxLine.components) {
        if (component.taxMinor === 0) continue;
        const placement = this.placeComponent(
          component,
          totals.determination.accountByRoleAndComponent,
          blockedFallbackId,
        );
        const key = `${component.glRole}:${component.code}:${component.recoverable}:${taxLine.taxCodeId ?? ""}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.amount += component.taxMinor;
        else
          buckets.set(key, {
            accountId: placement.accountId,
            side: placement.side,
            amount: component.taxMinor,
            component: component.code,
            taxCodeId: taxLine.taxCodeId,
          });
      }
    }

    for (const bucket of buckets.values()) {
      drafts.push(
        draft(bucket.accountId, orient(bucket.side), bucket.amount, {
          description: `${bucket.component} on ${vendor.displayName}`,
          partyId: doc.partyId,
          taxCodeId: bucket.taxCodeId ?? undefined,
          taxComponent: bucket.component,
        }),
      );
    }

    // Accounts payable carries the **gross** the vendor is owed, rounding
    // included — the rounding account absorbs the difference so the journal
    // still balances at zero tolerance rather than AP carrying a stray paisa.
    drafts.push(
      draft(tagged.get("ap_control")!, orient("credit"), totals.grossMinor, {
        description: vendor.displayName,
        partyId: doc.partyId,
      }),
    );

    return drafts;
  }

  /**
   * Where a component lands, decided purely from the role the engine returned.
   *
   * Blocked input tax (India s17(5), entertainment elsewhere) arrives as an
   * input role with `recoverable: false`. It is a cost, not a receivable from
   * the state, so it goes to the `blocked_input` account rather than to a tax
   * asset — PRD 03 M8, and the reason `tax_gl_map` has that role at all.
   */
  private placeComponent(
    component: TaxComponentResult,
    glMap: Map<string, string>,
    blockedFallbackId: string,
  ): { accountId: string; side: PostingSide } {
    if (INPUT_ROLES.has(component.glRole)) {
      if (!component.recoverable) {
        return {
          accountId: glMap.get(`blocked_input:${component.code}`) ?? blockedFallbackId,
          side: "debit",
        };
      }
      return { accountId: this.requireMapped(glMap, component), side: "debit" };
    }
    if (OUTPUT_ROLES.has(component.glRole)) {
      return { accountId: this.requireMapped(glMap, component), side: "credit" };
    }
    if (component.glRole === "blocked_input") {
      return {
        accountId: glMap.get(`blocked_input:${component.code}`) ?? blockedFallbackId,
        side: "debit",
      };
    }
    throw new BadRequestException(
      `Tax role ${component.glRole} does not belong on a purchase document`,
    );
  }

  private requireMapped(glMap: Map<string, string>, component: TaxComponentResult): string {
    const accountId = glMap.get(`${component.glRole}:${component.code}`);
    if (!accountId) {
      throw new NotFoundException(
        `No GL account is mapped for ${component.code} (${component.glRole}) in this book. ` +
          "Re-run the tax pack setup in accounting settings.",
      );
    }
    return accountId;
  }

  /**
   * The frozen tax lines must name the account the journal actually used, or a
   * blocked-input reconciliation would point at an asset nobody debited.
   * `TaxService` resolves the map by role alone, so re-point the blocked ones.
   */
  private withResolvedTaxAccounts(
    determination: DetermineResult,
    blockedFallbackId: string,
  ): DetermineResult {
    const resolved = new Map(determination.accountByRoleAndComponent);
    for (const line of determination.lines) {
      for (const component of line.components) {
        if (INPUT_ROLES.has(component.glRole) && !component.recoverable) {
          resolved.set(
            `${component.glRole}:${component.code}`,
            determination.accountByRoleAndComponent.get(`blocked_input:${component.code}`) ??
              blockedFallbackId,
          );
        }
      }
    }
    return { ...determination, accountByRoleAndComponent: resolved };
  }

  private async blockedAccountId(bookId: string, tx: DbOrTx): Promise<string> {
    return this.books.resolveAccountByTag(bookId, "opex", tx);
  }

  private assertDraft(doc: { status: DocumentStatus }): void {
    if (doc.status !== "DRAFT") {
      throw new ConflictException(
        "A posted document is immutable. Raise a debit note or reverse it instead of editing it.",
      );
    }
  }

  private assertFxIsCoherent(currency: string, baseCurrency: string, fxRate: string): void {
    if (currency === baseCurrency && Number(fxRate) !== 1) {
      throw new BadRequestException(`A ${baseCurrency} document must carry an FX rate of 1`);
    }
    if (!(Number(fxRate) > 0)) {
      throw new BadRequestException("The FX rate must be greater than zero");
    }
  }

  /**
   * The vendor's own number is unique per vendor per book, enforced by
   * `uniq_ap_documents_vendor_number`. Postgres raises 23505; letting that
   * escape would be a 500 for what is a perfectly ordinary user mistake, so it
   * becomes a 409 that names the number (PRD 03 M3).
   */
  private async guardDuplicateVendorNumber<T>(
    vendorName: string,
    vendorDocumentNumber: string | null,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      // A machine-readable `code` alongside the sentence, so a client can
      // branch on the cause instead of pattern-matching the message text —
      // which is what the frontend was otherwise forced to do.
      if (isUniqueViolation(error, "uniq_ap_documents_vendor_number")) {
        throw new ConflictException({
          code: "DUPLICATE_VENDOR_DOCUMENT_NUMBER",
          message:
            `${vendorName} has already been entered with document number ` +
            `${vendorDocumentNumber ?? ""}. Open the existing bill instead of entering it twice.`,
          vendorDocumentNumber,
        });
      }
      if (isUniqueViolation(error, "uniq_ap_documents_book_number")) {
        throw new ConflictException({
          code: "DUPLICATE_DOCUMENT_NUMBER",
          message: "That document number is already in use in this book",
        });
      }
      throw error;
    }
  }

  private async assertAccountsBelongToBook(
    tx: DbOrTx,
    bookId: string,
    lines: readonly ApDocumentLineInput[],
  ): Promise<void> {
    const wanted = [
      ...new Set(lines.map((l) => l.expenseAccountId).filter((id): id is string => Boolean(id))),
    ];
    if (wanted.length === 0) return;
    const rows = await tx
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.bookId, bookId),
          inArray(glAccounts.id, wanted),
          eq(glAccounts.isActive, true),
          eq(glAccounts.isHeader, false),
          isNull(glAccounts.deletedAt),
        ),
      );
    if (rows.length !== wanted.length) {
      throw new NotFoundException("One of the expense accounts does not exist in this book");
    }
  }

  private async assertOriginalExists(
    tx: DbOrTx,
    orgId: string,
    bookId: string,
    originalDocumentId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: apDocuments.id })
      .from(apDocuments)
      .where(
        and(
          eq(apDocuments.orgId, orgId),
          eq(apDocuments.bookId, bookId),
          eq(apDocuments.id, originalDocumentId),
          ne(apDocuments.documentType, "DEBIT_NOTE"),
          isNull(apDocuments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("The original bill was not found");
  }

  private async writeLines(
    tx: DbOrTx,
    orgId: string,
    documentId: string,
    lines: readonly ApDocumentLineInput[],
  ): Promise<void> {
    await tx.insert(apDocumentLines).values(
      lines.map((line, index) => ({
        orgId,
        documentId,
        lineNo: index + 1,
        description: line.description,
        quantityMilli: line.quantityMilli,
        unit: line.unit ?? null,
        unitPriceMinor: line.unitPriceMinor,
        discountMinor: line.discountMinor,
        taxCategory: line.taxCategory,
        commodityCode: line.commodityCode ?? null,
        forcedTaxCodeId: line.forcedTaxCodeId ?? null,
        forcedTaxReason: line.forcedTaxReason ?? null,
        expenseAccountId: line.expenseAccountId ?? null,
        capitalize: line.capitalize,
        lineNetMinor: computeLineNetMinor(
          line.quantityMilli,
          line.unitPriceMinor,
          line.discountMinor,
        ),
        dimensionProjectId: line.dimensionProjectId ?? null,
        dimensionCostCenterId: line.dimensionCostCenterId ?? null,
      })),
    );
  }

  private async loadDocumentRow(
    tx: DbOrTx,
    orgId: string,
    documentId: string,
  ): Promise<DocumentRow> {
    const [row] = await tx
      .select(DOCUMENT_COLUMNS)
      .from(apDocuments)
      .where(
        and(
          eq(apDocuments.orgId, orgId),
          eq(apDocuments.id, documentId),
          isNull(apDocuments.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Document not found");
    return row;
  }

  /**
   * Row lock while posting, so two concurrent posts of the same bill serialise
   * and the second sees `POSTED` rather than racing to allocate a second
   * number. The ledger's idempotency key is the backstop; this is the fence.
   */
  private async loadForUpdate(
    tx: DbOrTx,
    orgId: string,
    documentId: string,
  ): Promise<DocumentRow> {
    const [row] = await tx
      .select(DOCUMENT_COLUMNS)
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

  private async loadLineRows(tx: DbOrTx, documentId: string): Promise<LineRow[]> {
    return tx
      .select(LINE_COLUMNS)
      .from(apDocumentLines)
      .where(eq(apDocumentLines.documentId, documentId))
      .orderBy(asc(apDocumentLines.lineNo));
  }

  private async loadLines(tx: DbOrTx, documentId: string): Promise<ApDocumentLineDto[]> {
    const rows = await tx
      .select({
        ...LINE_COLUMNS,
        lineTaxMinor: apDocumentLines.lineTaxMinor,
        lineGrossMinor: apDocumentLines.lineGrossMinor,
      })
      .from(apDocumentLines)
      .where(eq(apDocumentLines.documentId, documentId))
      .orderBy(asc(apDocumentLines.lineNo));
    return rows.map((r) => ({
      id: r.id,
      lineNo: r.lineNo,
      description: r.description,
      quantityMilli: r.quantityMilli,
      unit: r.unit,
      unitPriceMinor: r.unitPriceMinor,
      discountMinor: r.discountMinor,
      taxCategory: r.taxCategory,
      commodityCode: r.commodityCode,
      expenseAccountId: r.expenseAccountId,
      capitalize: r.capitalize,
      lineNetMinor: r.lineNetMinor,
      lineTaxMinor: r.lineTaxMinor,
      lineGrossMinor: r.lineGrossMinor,
      dimensionProjectId: r.dimensionProjectId,
      dimensionCostCenterId: r.dimensionCostCenterId,
    }));
  }
}

/* ---------------------------------------------------------------- helpers */

function computeLineNet(line: LineRow): number {
  return computeLineNetMinor(line.quantityMilli, line.unitPriceMinor, line.discountMinor);
}

const DOCUMENT_COLUMNS = {
  id: apDocuments.id,
  bookId: apDocuments.bookId,
  partyId: apDocuments.partyId,
  documentType: apDocuments.documentType,
  status: apDocuments.status,
  documentNumber: apDocuments.documentNumber,
  vendorDocumentNumber: apDocuments.vendorDocumentNumber,
  vendorDocumentDate: apDocuments.vendorDocumentDate,
  issueDate: apDocuments.issueDate,
  dueDate: apDocuments.dueDate,
  currency: apDocuments.currency,
  fxRate: apDocuments.fxRate,
  supplyNature: apDocuments.supplyNature,
  reverseCharge: apDocuments.reverseCharge,
  blockedInputTax: apDocuments.blockedInputTax,
  taxInclusive: apDocuments.taxInclusive,
  placeOfSupplyCode: apDocuments.placeOfSupplyCode,
  taxLocationFromCountry: apDocuments.taxLocationFromCountry,
  taxLocationFromRegion: apDocuments.taxLocationFromRegion,
  taxLocationToCountry: apDocuments.taxLocationToCountry,
  taxLocationToRegion: apDocuments.taxLocationToRegion,
  netMinor: apDocuments.netMinor,
  taxMinor: apDocuments.taxMinor,
  grossMinor: apDocuments.grossMinor,
  roundingMinor: apDocuments.roundingMinor,
  settledMinor: apDocuments.settledMinor,
  functionalGrossMinor: apDocuments.functionalGrossMinor,
  originalDocumentId: apDocuments.originalDocumentId,
  gstrPeriod: apDocuments.gstrPeriod,
  postedJournalId: apDocuments.postedJournalId,
  postedAt: apDocuments.postedAt,
  memo: apDocuments.memo,
  reference: apDocuments.reference,
  dimensionProjectId: apDocuments.dimensionProjectId,
};

const LINE_COLUMNS = {
  id: apDocumentLines.id,
  lineNo: apDocumentLines.lineNo,
  description: apDocumentLines.description,
  quantityMilli: apDocumentLines.quantityMilli,
  unit: apDocumentLines.unit,
  unitPriceMinor: apDocumentLines.unitPriceMinor,
  discountMinor: apDocumentLines.discountMinor,
  taxCategory: apDocumentLines.taxCategory,
  commodityCode: apDocumentLines.commodityCode,
  forcedTaxCodeId: apDocumentLines.forcedTaxCodeId,
  expenseAccountId: apDocumentLines.expenseAccountId,
  capitalize: apDocumentLines.capitalize,
  lineNetMinor: apDocumentLines.lineNetMinor,
  dimensionProjectId: apDocumentLines.dimensionProjectId,
  dimensionCostCenterId: apDocumentLines.dimensionCostCenterId,
};

/** Exactly the projection above — never the whole row (backend/CLAUDE.md §1). */
type DocumentRow = Pick<typeof apDocuments.$inferSelect, keyof typeof DOCUMENT_COLUMNS>;
type LineRow = Pick<typeof apDocumentLines.$inferSelect, keyof typeof LINE_COLUMNS>;

function toSummary(row: DocumentRow & { partyName: string }): ApDocumentSummary {
  return {
    id: row.id,
    bookId: row.bookId,
    partyId: row.partyId,
    partyName: row.partyName,
    documentType: row.documentType,
    status: row.status,
    documentNumber: row.documentNumber,
    vendorDocumentNumber: row.vendorDocumentNumber,
    vendorDocumentDate: row.vendorDocumentDate,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    fxRate: row.fxRate,
    supplyNature: row.supplyNature,
    reverseCharge: row.reverseCharge,
    blockedInputTax: row.blockedInputTax,
    taxInclusive: row.taxInclusive,
    netMinor: row.netMinor,
    taxMinor: row.taxMinor,
    grossMinor: row.grossMinor,
    roundingMinor: row.roundingMinor,
    settledMinor: row.settledMinor,
    openMinor: row.grossMinor - row.settledMinor,
    functionalGrossMinor: row.functionalGrossMinor,
    gstrPeriod: row.gstrPeriod,
    postedJournalId: row.postedJournalId,
    postedAt: row.postedAt,
    memo: row.memo,
    reference: row.reference,
  };
}

function toDetail(
  row: DocumentRow & { partyName: string },
  lines: ApDocumentLineDto[],
): ApDocumentDetail {
  return {
    ...toSummary(row),
    originalDocumentId: row.originalDocumentId,
    placeOfSupplyCode: row.placeOfSupplyCode,
    taxLocationFromCountry: row.taxLocationFromCountry,
    taxLocationFromRegion: row.taxLocationFromRegion,
    taxLocationToCountry: row.taxLocationToCountry,
    taxLocationToRegion: row.taxLocationToRegion,
    dimensionProjectId: row.dimensionProjectId,
    lines,
  };
}
