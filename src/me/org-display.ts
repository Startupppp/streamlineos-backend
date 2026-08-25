import { eq } from "drizzle-orm";
import { organizations } from "../db/schema";
import type { Db } from "../db/drizzle.types";

/**
 * The currency an organisation's money renders in, for every member of it.
 *
 * Every authenticated member sees money somewhere -- a deal, an expense claim, a
 * payslip -- so this cannot hang off `GET /organization/settings`, which requires
 * `settings:view`. A salesperson holding only `crm:deals:read` would fall back to
 * a hardcoded currency and be shown the wrong symbol on their own pipeline.
 *
 * Nor does it belong on the access snapshot, which is cached against
 * `permissions_version`: changing the currency does not bump that, so the value
 * would stay stale until some unrelated permission happened to change.
 *
 * Hence its own read. Nothing here is anything an unprivileged member should not
 * see, and the settings mutation that writes the column invalidates it.
 */

export interface OrgDisplay {
  readonly currency: string;
  readonly locale: string;
}

/**
 * Currencies whose conventional grouping is not a locale default.
 *
 * INR groups in lakhs and crores, which only `en-IN` produces. Choosing the
 * locale from the currency keeps a rupee figure grouped as `1,23,456` even for a
 * reader whose own language is something else, because the grouping belongs to
 * the money rather than to the person looking at it.
 */
const CURRENCY_LOCALES: Record<string, string> = {
  INR: "en-IN",
  USD: "en-US",
  GBP: "en-GB",
  EUR: "en-IE",
  AED: "en-AE",
  SGD: "en-SG",
  AUD: "en-AU",
  CAD: "en-CA",
  JPY: "ja-JP",
  CHF: "de-CH",
  ZAR: "en-ZA",
};

export const DEFAULT_ORG_DISPLAY: OrgDisplay = { currency: "INR", locale: "en-IN" };

/** ISO 4217 is three letters; anything else makes `Intl.NumberFormat` throw. */
export function normaliseCurrency(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_ORG_DISPLAY.currency;
}

export function localeForCurrency(currency: string): string {
  return CURRENCY_LOCALES[currency] ?? "en-US";
}

export function orgDisplayFor(rawCurrency: string | null | undefined): OrgDisplay {
  const currency = normaliseCurrency(rawCurrency);
  return { currency, locale: localeForCurrency(currency) };
}

export async function readOrgDisplay(db: Db, organizationId: string): Promise<OrgDisplay> {
  if (!organizationId) return DEFAULT_ORG_DISPLAY;

  const [row] = await db
    .select({ currency: organizations.currency })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  return row ? orgDisplayFor(row.currency) : DEFAULT_ORG_DISPLAY;
}
