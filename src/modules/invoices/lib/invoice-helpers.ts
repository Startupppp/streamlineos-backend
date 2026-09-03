import { eq } from "drizzle-orm";
import { indianStates, organizations } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { decimalFromNumber, roundDecimal } from "../../accounting/core/money.util";

export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

/**
 * Half-up at two decimals — rupees in, rupees out.
 *
 * This used to be `Math.round(n * 100) / 100`, which is not half-up: `n * 100`
 * is a double and for ordinary invoice inputs it lands a hair BELOW the .5
 * boundary, so `Math.round` goes down. Rs 10.75 at 18% stored 1.93 where the
 * rule says 1.94; Rs 0.70 at 5% stored 0.03 where the rule says 0.04. The error
 * only ever went one way, so it was a systematic understatement of output GST
 * that trg_invoice_immutability froze into the invoice at issue.
 *
 * `decimalFromNumber` pins the double to the ledger's scale of 4 — the same
 * scale the `invoices` and `invoice_items` numeric(18,4) columns store, so no
 * precision the system can hold is lost on the way in — and `roundDecimal`
 * then rounds half-up on exact BigInt arithmetic.
 */
export const round2 = (n: number): number =>
  Number(roundDecimal(decimalFromNumber(n), 2));

export function normalizeGstRate(value: string): GstRate {
  const parsed = Number(value);
  return (GST_RATES as ReadonlyArray<number>).includes(parsed)
    ? (parsed as GstRate)
    : 0;
}

export function advanceDate(
  fromIso: string,
  interval: string | null,
): string {
  const d = new Date(`${fromIso}T00:00:00.000Z`);
  switch ((interval ?? "").trim().toLowerCase()) {
    case "weekly":
    case "week":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "biweekly":
    case "fortnightly":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "daily":
    case "day":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "quarterly":
    case "quarter":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case "halfyearly":
    case "half-yearly":
    case "semiannually":
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
    case "yearly":
    case "annually":
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

export async function resolveSupplierStateCode(
  db: Db,
  orgId: string,
): Promise<string> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { address: true },
  });
  const stateName = org?.address?.state;
  if (!stateName) return "";
  const match = await db
    .select({ stateCode: indianStates.stateCode })
    .from(indianStates)
    .where(eq(indianStates.stateName, stateName))
    .limit(1);
  return match[0]?.stateCode ?? "";
}
