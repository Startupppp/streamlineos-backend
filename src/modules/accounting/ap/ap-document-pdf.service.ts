import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  apDocuments,
  glBooks,
  legalEntities,
  organizations,
  type ApDocumentType,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StorageService } from "../../storage/storage.service";
import { PartiesService } from "../parties/parties.service";
import { TaxService } from "../tax/tax.service";
import { ApDocumentsService } from "./ap-documents.service";
import {
  generateInvoicePdf,
  type InvoicePdfData,
  type InvoicePdfParty,
  type InvoicePdfTaxComponent,
} from "../ar/lib/invoice-pdf";

export interface RenderedDocumentPdf {
  buffer: Buffer;
  fileName: string;
  contentType: "application/pdf";
  fromStore: boolean;
}

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

const NON_INVOICE_REGIMES = new Set(["PAN_IN", "TAN_IN"]);

@Injectable()
export class ApDocumentPdfService {
  private readonly logger = new Logger(ApDocumentPdfService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly documents: ApDocumentsService,
    private readonly parties: PartiesService,
    private readonly tax: TaxService,
    private readonly storage: StorageService,
  ) {}

  async render(
    orgId: string,
    documentId: string,
  ): Promise<RenderedDocumentPdf> {
    const view = await this.documents.get(orgId, documentId);

    if (view.status === "DRAFT" || !view.documentNumber) {
      throw new ConflictException("This document is still a draft. Post it first.");
    }

    const fileName = `${safeFileStem(view.documentNumber)}.pdf`;

    const buffer = await generateInvoicePdf(await this.buildData(orgId, view));

    return { buffer, fileName, contentType: "application/pdf", fromStore: false };
  }

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
      this.logger.warn(`Stored AP document PDF ${key} could not be read; re-rendering: ${describe(error)}`);
      return null;
    }
  }

  private async store(
    orgId: string,
    documentId: string,
    view: any,
    fileName: string,
    buffer: Buffer,
  ): Promise<void> {
    // if (!this.storage.isConfigured()) return;
    // try {
    //   const folder = `accounting/${view.bookId}/ap/${view.documentType === "DEBIT_NOTE" ? "debit-notes" : "bills"}`;
    //   const uploaded = await this.storage.uploadFile(orgId, buffer, folder, fileName, "application/pdf");
    //   await this.db
    //     .update(apDocuments)
    //     .set({ pdfStorageKey: uploaded.key, pdfStorageUrl: uploaded.url })
    //     .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)));
    // } catch (error) {
    //   this.logger.warn(`AP document PDF for ${view.documentNumber ?? documentId} was rendered but not stored: ${describe(error)}`);
    // }
  }

  private async buildData(orgId: string, view: any): Promise<InvoicePdfData> {
    const [book] = await this.db
      .select({
        name: glBooks.name,
        countryCode: glBooks.countryCode,
        legalEntityId: glBooks.legalEntityId,
      })
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, view.bookId)))
      .limit(1);

    const [entity, [org], party, taxLines] = await Promise.all([
      this.loadLegalEntity(orgId, book?.legalEntityId ?? null),
      this.db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
      this.parties.get(orgId, view.partyId),
      this.documents.frozenTaxLines(orgId, view.id),
    ]);

    const sellerRegistration = pickRegistration(party.taxRegistrations);

    const buyerRegistrations = await this.tax.loadRegistrations("book", view.bookId ?? "");
    const buyerRegistration = pickRegistration(buyerRegistrations);

    const seller: InvoicePdfParty = {
        name: party.displayName,
        legalName: party.legalName,
        taxRegistrationNumber: sellerRegistration?.number ?? null,
        taxRegistrationLabel: registrationLabel(sellerRegistration?.regime, null),
        addressLines: addressLinesOf({
          line1: party.billingLine1 ?? undefined,
          line2: party.billingLine2 ?? undefined,
          city: party.billingCity ?? undefined,
          state: party.billingRegion ?? undefined,
          country: party.billingCountryCode ?? undefined,
          postalCode: party.billingPostalCode ?? undefined,
        }),
        stateCode: sellerRegistration?.region ?? party.billingRegion ?? null,
        countryCode: party.billingCountryCode ?? party.countryCode,
        email: party.email,
        phone: party.phone,
    };

    const buyer: InvoicePdfParty = {
        name: entity?.name ?? org?.name ?? book?.name ?? "Company",
        legalName: entity?.legalName ?? org?.name ?? null,
        taxRegistrationNumber: buyerRegistration?.number ?? entity?.gstin ?? null,
        taxRegistrationLabel: registrationLabel(buyerRegistration?.regime, entity?.gstin),
        addressLines: addressLinesOf(entity?.registeredAddress ?? null),
        stateCode: buyerRegistration?.region ?? entity?.stateCode ?? null,
        countryCode: entity?.countryCode ?? book?.countryCode ?? null,
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
    componentsByLine.forEach((bucket) => bucket.sort(byComponentThenRate));

    return {
      documentType: view.documentType === "DEBIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
      documentNumber: view.documentNumber ?? "",
      documentDate: view.issueDate,
      dueDate: view.dueDate,
      currency: view.currency,
      seller,
      buyer,
      placeOfSupply: view.placeOfSupplyCode ?? view.taxLocationToRegion ?? null,
      reverseCharge: view.reverseCharge,
      supplyNature: view.supplyNature,
      lines: view.lines.map((line: any) => ({
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
}

function byComponentThenRate(a: any, b: any): number {
  return a.component === b.component
    ? a.rateBp - b.rateBp
    : a.component.localeCompare(b.component);
}

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

function registrationLabel(regime: string | undefined, gstinFallback: string | null | undefined) {
    if (regime) return REGISTRATION_LABELS[regime] ?? "Tax reg. no.";
    return gstinFallback ? "GSTIN" : "Tax reg. no.";
}

function pickRegistration(registrations: readonly any[]): any | null {
    const usable = registrations.filter((r) => !NON_INVOICE_REGIMES.has(r.regime));
    const primary = usable.find((r) => "isPrimary" in r && r.isPrimary);
    return primary ?? usable[0] ?? null;
}

function safeFileStem(documentNumber: string): string {
    const cleaned = documentNumber.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned.slice(0, 120) || "document";
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
