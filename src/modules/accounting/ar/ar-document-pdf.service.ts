import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  arDocuments,
  glBooks,
  legalEntities,
  organizations,
  type ArDocumentType,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StorageService } from "../../storage/storage.service";
import { PartiesService, type PartyTaxRegistration } from "../parties/parties.service";
import { TaxService } from "../tax/tax.service";
import type { TaxContextRegistration } from "../tax/tax.types";
import { ArDocumentsService, type ArDocumentView } from "./ar-documents.service";
import {
  generateInvoicePdf,
  type InvoicePdfData,
  type InvoicePdfParty,
  type InvoicePdfTaxComponent,
} from "./lib/invoice-pdf";

export interface RenderedDocumentPdf {
  buffer: Buffer;
  fileName: string;
  contentType: "application/pdf";
  /** True when these bytes came back from object storage rather than the renderer. */
  fromStore: boolean;
}

/** The label a registration number prints under, by identifier scheme. */
const REGISTRATION_LABELS: Record<string, string> = {
  GST_IN: "GSTIN",
  VAT_EU: "VAT No.",
  VAT_GB: "VAT No.",
  VAT_GCC: "VAT No.",
  GST_SG: "GST No.",
  GST_AU: "ABN",
  GST_HST_CA: "GST/HST No.",
  SALES_TAX_US: "Tax ID",
  EIN_US: "EIN",
  GENERIC: "Tax reg. no.",
};

/**
 * Identity documents, not tax-invoice registrations. A PAN on an invoice where
 * the GSTIN belongs would be wrong, so they are never picked as the number the
 * document prints.
 */
const NON_INVOICE_REGIMES = new Set(["PAN_IN", "TAN_IN"]);

/**
 * The rendered PDF for a posted sales invoice or credit note.
 *
 * Two rules shape this service:
 *
 * 1. **Only a posted document gets a PDF.** A draft has no document number and
 *    no frozen tax rows, so there is nothing lawful to print — that is a 409,
 *    not an empty invoice.
 * 2. **Render once.** A posted document is immutable, so its PDF is too: the
 *    first request renders and stores it, every later one serves the stored
 *    bytes. When R2 is not configured the bytes are still returned — a missing
 *    bucket must never cost a customer their invoice.
 */
@Injectable()
export class ArDocumentPdfService {
  private readonly logger = new Logger(ArDocumentPdfService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly documents: ArDocumentsService,
    private readonly parties: PartiesService,
    private readonly tax: TaxService,
    private readonly storage: StorageService,
  ) {}

  async render(
    orgId: string,
    documentId: string,
    expectedType: ArDocumentType,
  ): Promise<RenderedDocumentPdf> {
    const view = await this.documents.get(orgId, documentId);
    // An invoice id on the credit-note route is a miss, not a type error — the
    // caller learns nothing about which of the two it actually is.
    if (view.documentType !== expectedType) throw new NotFoundException("Document not found");

    if (view.status === "DRAFT" || !view.documentNumber) {
      throw new ConflictException(
        "This document is still a draft. Post it first: a draft has no document number and no frozen tax, so it cannot be printed as a tax document.",
      );
    }

    const fileName = `${safeFileStem(view.documentNumber)}.pdf`;

    const [cached] = await this.db
      .select({
        pdfStorageKey: arDocuments.pdfStorageKey,
        pdfStorageUrl: arDocuments.pdfStorageUrl,
      })
      .from(arDocuments)
      .where(
        and(
          eq(arDocuments.orgId, orgId),
          eq(arDocuments.id, documentId),
          isNull(arDocuments.deletedAt),
        ),
      )
      .limit(1);

    if (cached?.pdfStorageKey) {
      const stored = await this.readStored(orgId, cached.pdfStorageKey);
      if (stored) return { buffer: stored, fileName, contentType: "application/pdf", fromStore: true };
    }

    const buffer = await generateInvoicePdf(await this.buildData(orgId, view));
    await this.store(orgId, documentId, view, fileName, buffer);

    return { buffer, fileName, contentType: "application/pdf", fromStore: false };
  }

  /* --------------------------------------------------------------- store */

  private async readStored(orgId: string, key: string): Promise<Buffer | null> {
    if (!this.storage.isConfigured()) return null;
    try {
      const stream = await this.storage.getFileStream(orgId, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const buffer = Buffer.concat(chunks);
      return buffer.length > 0 ? buffer : null;
    } catch (error) {
      // The object is gone or the bucket moved. Re-render rather than 500 —
      // the document is the source of truth, the PDF is a derivative.
      this.logger.warn(
        `Stored invoice PDF ${key} could not be read; re-rendering: ${describe(error)}`,
      );
      return null;
    }
  }

  /**
   * Upload and remember the key.
   *
   * Guarded the way `payroll/payout/publishing.service.ts` guards its payslips:
   * an unconfigured or failing bucket is logged and the caller still gets the
   * bytes. Nothing about this request depends on R2 succeeding.
   */
  private async store(
    orgId: string,
    documentId: string,
    view: ArDocumentView,
    fileName: string,
    buffer: Buffer,
  ): Promise<void> {
    if (!this.storage.isConfigured()) return;
    try {
      const folder = `accounting/${view.bookId}/${view.documentType === "CREDIT_NOTE" ? "credit-notes" : "invoices"}`;
      const uploaded = await this.storage.uploadFile(orgId, buffer, folder, fileName, "application/pdf");
      await this.db
        .update(arDocuments)
        .set({ pdfStorageKey: uploaded.key, pdfStorageUrl: uploaded.url })
        .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));
    } catch (error) {
      this.logger.warn(
        `Invoice PDF for ${view.documentNumber ?? documentId} was rendered but not stored: ${describe(error)}`,
      );
    }
  }

  /* ---------------------------------------------------------------- data */

  /** Everything the pure renderer needs, as plain values — never an ORM row. */
  private async buildData(orgId: string, view: ArDocumentView): Promise<InvoicePdfData> {
    const [book] = await this.db
      .select({
        name: glBooks.name,
        countryCode: glBooks.countryCode,
        legalEntityId: glBooks.legalEntityId,
      })
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, view.bookId)))
      .limit(1);

    const [entity, [org], sellerRegistrations, party, taxLines, original] = await Promise.all([
      this.loadLegalEntity(orgId, book?.legalEntityId ?? null),
      this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
      this.tax.loadRegistrations("book", view.bookId),
      this.parties.get(orgId, view.partyId),
      this.documents.frozenTaxLines(orgId, view.id),
      this.loadOriginal(orgId, view.originalDocumentId),
    ]);

    const sellerRegistration = pickRegistration(sellerRegistrations);
    const seller: InvoicePdfParty = {
      name: entity?.name ?? org?.name ?? book?.name ?? "Supplier",
      legalName: entity?.legalName ?? org?.name ?? null,
      taxRegistrationNumber: sellerRegistration?.number ?? entity?.gstin ?? null,
      taxRegistrationLabel: registrationLabel(sellerRegistration?.regime, entity?.gstin),
      addressLines: addressLinesOf(entity?.registeredAddress ?? null),
      stateCode:
        sellerRegistration?.region ?? entity?.stateCode ?? view.taxLocationFromRegion ?? null,
      countryCode: entity?.countryCode ?? view.taxLocationFromCountry ?? book?.countryCode ?? null,
    };

    const buyerRegistration = pickRegistration(party.taxRegistrations);
    const buyer: InvoicePdfParty = {
      name: party.displayName,
      legalName: party.legalName,
      taxRegistrationNumber: buyerRegistration?.number ?? null,
      taxRegistrationLabel: registrationLabel(buyerRegistration?.regime, null),
      addressLines: [
        party.billingLine1,
        party.billingLine2,
        [party.billingCity, party.billingRegion, party.billingPostalCode]
          .filter(Boolean)
          .join(", "),
        party.billingCountryCode ?? party.countryCode,
      ].filter((line): line is string => Boolean(line && line.trim())),
      stateCode: buyerRegistration?.region ?? party.billingRegion ?? null,
      countryCode: party.billingCountryCode ?? party.countryCode,
      email: party.email,
      phone: party.phone,
    };

    const componentsByLine = new Map<string, InvoicePdfTaxComponent[]>();
    for (const row of taxLines) {
      if (!row.documentLineId) continue;
      const bucket = componentsByLine.get(row.documentLineId) ?? [];
      bucket.push({
        component: row.component,
        jurisdiction: row.jurisdiction,
        rateBp: row.rateBp,
        taxableMinor: row.taxableMinor,
        taxMinor: row.taxMinor,
      });
      componentsByLine.set(row.documentLineId, bucket);
    }
    for (const bucket of componentsByLine.values()) bucket.sort(byComponentThenRate);

    return {
      documentType: view.documentType,
      documentNumber: view.documentNumber ?? "",
      documentDate: view.issueDate,
      dueDate: view.dueDate,
      currency: view.currency,
      seller,
      buyer,
      placeOfSupply: view.placeOfSupplyCode ?? view.taxLocationToRegion ?? null,
      // AR has no `reverse_charge` column: on a sale the charge shifts through
      // the supply nature or a line's tax category, which is what the engine
      // determined against.
      reverseCharge:
        view.supplyNature === "reverse_charge" ||
        view.lines.some((line) => line.taxCategory === "reverse_charge"),
      supplyNature: view.supplyNature,
      originalDocumentNumber: original?.documentNumber ?? null,
      originalDocumentDate: original?.issueDate ?? null,
      lines: view.lines.map((line) => ({
        lineNo: line.lineNo,
        description: line.description,
        commodityCode: line.commodityCode,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
        unitPriceMinor: line.unitPriceMinor,
        discountMinor: line.discountMinor,
        taxableMinor: line.lineNetMinor,
        taxMinor: line.lineTaxMinor,
        grossMinor: line.lineGrossMinor,
        taxComponents: componentsByLine.get(line.id) ?? [],
      })),
      taxSummary: rollUp(taxLines),
      netMinor: view.netMinor,
      taxMinor: view.taxMinor,
      roundingMinor: view.roundingMinor,
      grossMinor: view.grossMinor,
      memo: view.memo,
      reference: view.reference,
    };
  }

  private async loadLegalEntity(orgId: string, legalEntityId: string | null) {
    if (!legalEntityId) return null;
    const [row] = await this.db
      .select({
        name: legalEntities.name,
        legalName: legalEntities.legalName,
        gstin: legalEntities.gstin,
        countryCode: legalEntities.countryCode,
        stateCode: legalEntities.stateCode,
        registeredAddress: legalEntities.registeredAddress,
      })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.orgId, orgId),
          eq(legalEntities.id, legalEntityId),
          isNull(legalEntities.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** A credit note prints the invoice it corrects, which GSTR-1 needs. */
  private async loadOriginal(orgId: string, originalDocumentId: string | null) {
    if (!originalDocumentId) return null;
    const [row] = await this.db
      .select({
        documentNumber: arDocuments.documentNumber,
        issueDate: arDocuments.issueDate,
      })
      .from(arDocuments)
      .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, originalDocumentId)))
      .limit(1);
    return row ?? null;
  }
}

/* ------------------------------------------------------------- helpers */

function byComponentThenRate(a: InvoicePdfTaxComponent, b: InvoicePdfTaxComponent): number {
  return a.component === b.component
    ? a.rateBp - b.rateBp
    : a.component.localeCompare(b.component);
}

/** One row per component and rate, so 18% and 5% goods never merge. */
function rollUp(
  rows: ReadonlyArray<{
    component: string;
    jurisdiction: string;
    rateBp: number;
    taxableMinor: number;
    taxMinor: number;
  }>,
): InvoicePdfTaxComponent[] {
  const grouped = new Map<string, InvoicePdfTaxComponent>();
  for (const row of rows) {
    const key = `${row.component}|${row.rateBp}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, {
        ...existing,
        taxableMinor: existing.taxableMinor + row.taxableMinor,
        taxMinor: existing.taxMinor + row.taxMinor,
      });
    } else {
      grouped.set(key, {
        component: row.component,
        jurisdiction: row.jurisdiction,
        rateBp: row.rateBp,
        taxableMinor: row.taxableMinor,
        taxMinor: row.taxMinor,
      });
    }
  }
  return [...grouped.values()].sort(byComponentThenRate);
}

function pickRegistration<T extends TaxContextRegistration | PartyTaxRegistration>(
  registrations: readonly T[],
): T | null {
  const usable = registrations.filter((r) => !NON_INVOICE_REGIMES.has(r.regime));
  const primary = usable.find((r) => "isPrimary" in r && r.isPrimary);
  return primary ?? usable[0] ?? null;
}

function registrationLabel(regime: string | undefined, gstinFallback: string | null | undefined) {
  if (regime) return REGISTRATION_LABELS[regime] ?? "Tax reg. no.";
  return gstinFallback ? "GSTIN" : "Tax reg. no.";
}

function addressLinesOf(
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
  } | null,
): string[] {
  if (!address) return [];
  return [
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(", "),
    address.country,
  ].filter((line): line is string => Boolean(line && line.trim()));
}

/**
 * A document number is `INV/2026-27/0001` — slashes and all. Anything that
 * could be read as a path separator or break a `Content-Disposition` header is
 * folded to a hyphen before the string leaves the service.
 */
function safeFileStem(documentNumber: string): string {
  const cleaned = documentNumber.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 120) || "document";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
