import type { GlAccountType, GlSystemTag } from "../../../db/schema";

/**
 * A localization pack is **data plus a tax engine binding** — never a fork of
 * the document code. Adding Portugal must not touch AR, AP or the kernel.
 * See `12-prd-localization-packs.md`.
 */

export interface CoaTemplateAccount {
  code: string;
  name: string;
  type: GlAccountType;
  /** Groups only; a header never receives a posting. */
  isHeader?: boolean;
  /** Bank and cash accounts are GL accounts (PRD 04 M1). */
  isCash?: boolean;
  parentCode?: string;
  /** How documents resolve this account without knowing its code. */
  systemTag?: GlSystemTag;
  description?: string;
}

/**
 * `span` prints India's `2026-27`; `calendar` prints `2026`. The fiscal year
 * boundary itself comes from `fiscalYearStart`, so a pack can have an April
 * start with calendar naming if its jurisdiction does that.
 */
export type FiscalYearNaming = "span" | "calendar";

export interface DocumentSeriesPattern {
  /** `{PREFIX}/{FY}/{SEQ}` — tokens are substituted at issue time. */
  pattern: string;
  prefix: string;
  padding: number;
  /** India requires a fresh series each fiscal year (PRD 05 M7). */
  resetEachFiscalYear: boolean;
}

export type DocumentSeriesKind =
  | "salesInvoice"
  | "creditNote"
  | "debitNote"
  | "purchaseBill"
  | "receipt"
  | "payment"
  | "journal";

export interface LocalizationPack {
  /** `IN`, `US`, `GENERIC_VAT`, … */
  code: string;
  title: string;
  /**
   * `enabled` packs can operate a book. `stub` packs register so the country
   * is selectable and the schema is right, but `determine()` returns a
   * structured "pack not configured" error rather than silently zero tax.
   */
  status: "enabled" | "stub";
  /** ISO 3166-1 alpha-2 codes this pack serves. */
  countryCodes: readonly string[];
  defaultCurrency: string;
  defaultTimezone: string;
  /** Display only. Storage is always ISO and integers. */
  locale: string;

  fiscalYearStart: { month: number; day: number };
  fiscalYearNaming: FiscalYearNaming;

  /** Which tax engine this pack binds to (PRD 10 registry key). */
  taxEngine: string;

  /** India (state) and US (state) cannot determine tax without it. */
  regionRequired: boolean;

  documentSeries: Readonly<Record<DocumentSeriesKind, DocumentSeriesPattern>>;

  /** Seeded once per book, idempotently, on enable. */
  chartOfAccounts: readonly CoaTemplateAccount[];
}

export class PackNotFoundError extends Error {
  constructor(code: string) {
    super(`Localization pack ${code} is not registered`);
    this.name = "PackNotFoundError";
  }
}
