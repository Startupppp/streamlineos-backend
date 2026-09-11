import type { CompliancePayload } from "./compliance-transport.port";

/**
 * What this product is willing to say to the Indian Invoice Registration
 * Portal — the outgoing half of the wire contract, and no I/O.
 *
 * Pure on purpose. Everything here is a function of the payload, and the things
 * most likely to be wrong (a date in the wrong calendar order, rupees confused
 * with paise, a document type code guessed at) are tedious to reach through an
 * HTTP client and trivial to reach from a test by calling them.
 *
 * **The shape is NIC's own e-invoice envelope**, which the GSPs pass through. A
 * GSP that wraps it in one of its own is a different adapter, not a widening of
 * this one — the port stays the port.
 */

/**
 * NIC's document type codes.
 *
 * A document whose type is not in this map cannot be filed at all: `DocDtls.Typ`
 * is mandatory and there is no value meaning "something else". Guessing one
 * would register a credit note as an invoice.
 */
const IRP_DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  sales_invoice: "INV",
  credit_note: "CRN",
  debit_note: "DBN",
};

/** The e-invoice schema this envelope is written against. */
export const IRP_SCHEMA_VERSION = "1.1";

/** The only currency the IRP states a document's value in. */
const IRP_CURRENCY = "INR";

export interface IrpRequest {
  Version: string;
  TranDtls: { TaxSch: "GST"; SupTyp: "B2B"; RegRev: "N"; IgstOnIntra: "N" };
  DocDtls: { Typ: string; No: string; Dt: string };
  SellerDtls: { Gstin: string };
  BuyerDtls: { Gstin: string };
  ValDtls: { TotInvVal: number };
}

/**
 * Either a request the IRP could act on, or the reason no request can be built.
 *
 * A value rather than a throw, because the caller's answer to "this cannot be
 * filed" is a `TransportResult`, and a thrown error would have to be turned back
 * into one at the only call site that could.
 */
export type IrpRequestBuild = { ok: true; request: IrpRequest } | { ok: false; reason: string };

/**
 * Turn the port's payload into an IRP registration request, or refuse.
 *
 * The refusals are the honest part. `CompliancePayload` is deliberately small —
 * eight fields, shared with every other e-reporting network — and the IRP's
 * mandatory set is larger. Where the gap can be bridged (a date format, a
 * document type code) it is bridged; where bridging would mean **inventing a
 * fact about the tenant's supply**, this refuses, and the document stays unfiled
 * and visibly so:
 *
 *  - **A non-INR document.** `ValDtls.TotInvVal` is a rupee figure and the port
 *    carries no exchange rate, so the only way to fill it would be to make a
 *    number up and send it to a tax authority.
 *  - **A document with no buyer tax id.** `TranDtls.SupTyp` is mandatory and the
 *    port carries no supply nature. A seller GSTIN and a buyer GSTIN together
 *    are a B2B supply and nothing else, so that case is safe; without the
 *    buyer's, the document is an export, an SEZ supply or a supply to an
 *    unregistered person, and this cannot tell which. Registering one of those
 *    as `B2B` would be a wrong statutory filing rather than a missing one.
 *
 * Both gaps are in the port, and closing them is a change to `CompliancePayload`
 * and everything that fills it — not a vendor-shaped bulge in this file.
 */
export function buildIrpRequest(payload: CompliancePayload): IrpRequestBuild {
  const documentType = IRP_DOCUMENT_TYPES[payload.documentType];
  if (!documentType) {
    return {
      ok: false,
      reason:
        `The IRP registers invoices, credit notes and debit notes; it has no document type ` +
        `for "${payload.documentType}", so nothing was sent.`,
    };
  }

  const documentDate = irpDocumentDate(payload.documentDate);
  if (!documentDate) {
    return {
      ok: false,
      reason: `The document's date "${payload.documentDate}" is not a calendar date, so nothing was sent.`,
    };
  }

  if (payload.currency !== IRP_CURRENCY) {
    return {
      ok: false,
      reason:
        `The IRP states a document's value in ${IRP_CURRENCY} and this document is in ` +
        `${payload.currency}. This product holds no exchange rate for it, and will not send a ` +
        `tax authority a figure it made up. Nothing was sent.`,
    };
  }

  if (!payload.buyerTaxId) {
    return {
      ok: false,
      reason:
        "The IRP needs the supply type, and this product can only prove one — a registered " +
        "seller invoicing a registered buyer. This document carries no buyer tax identifier, " +
        "so it is an export, an SEZ supply or a supply to an unregistered person, and filing " +
        "it as B2B would be a wrong filing rather than a missing one. Nothing was sent.",
    };
  }

  return {
    ok: true,
    request: {
      Version: IRP_SCHEMA_VERSION,
      /*
        Fixed, and only safe because the refusals above have already turned away
        every document this cannot prove is a domestic B2B forward-charge
        supply. If the port ever carries the supply nature
        `ComplianceService.decide` already computes, these two stop being
        constants and that refusal stops being needed.
      */
      TranDtls: { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", IgstOnIntra: "N" },
      DocDtls: { Typ: documentType, No: payload.documentNumber, Dt: documentDate },
      SellerDtls: { Gstin: payload.sellerTaxId },
      BuyerDtls: { Gstin: payload.buyerTaxId },
      /*
        The ledger holds minor units (CLAUDE.md §3); the IRP wants rupees with
        two decimal places. Rounded through `toFixed` rather than divided and
        hoped over, so 118000 is 1180 and never 1179.9999999999998.
      */
      ValDtls: { TotInvVal: Number((payload.totalMinor / 100).toFixed(2)) },
    },
  };
}

/** `2026-09-01` as the IRP writes it: `01/09/2026`. */
export function irpDocumentDate(isoDate: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!parts) return null;
  const [, year, month, day] = parts;
  return `${day}/${month}/${year}`;
}
