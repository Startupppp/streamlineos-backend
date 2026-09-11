import { eq } from "drizzle-orm";
import { organizations } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { allocate, money } from "../../accounting/kernel/money";
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

/**
 * GST state codes, keyed by the state name an organisation stores on its
 * address.
 *
 * This replaces the `indian_states` lookup table, which was dropped with the
 * pre-rewrite accounting schema in 0466. The new tax engine works in opaque
 * region codes supplied by the document (`place_of_supply_code`) and carries no
 * name-to-code catalogue, so the mapping lives here as data rather than as a
 * table nothing else reads. Codes are the GSTIN prefixes published by the GST
 * Council; `97` is Other Territory.
 */
export const INDIAN_STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  "jammu and kashmir": "01",
  "himachal pradesh": "02",
  punjab: "03",
  chandigarh: "04",
  uttarakhand: "05",
  haryana: "06",
  delhi: "07",
  "rajasthan": "08",
  "uttar pradesh": "09",
  bihar: "10",
  sikkim: "11",
  "arunachal pradesh": "12",
  nagaland: "13",
  manipur: "14",
  mizoram: "15",
  tripura: "16",
  meghalaya: "17",
  assam: "18",
  "west bengal": "19",
  jharkhand: "20",
  odisha: "21",
  orissa: "21",
  chhattisgarh: "22",
  "madhya pradesh": "23",
  gujarat: "24",
  "dadra and nagar haveli and daman and diu": "26",
  maharashtra: "27",
  karnataka: "29",
  goa: "30",
  lakshadweep: "31",
  kerala: "32",
  "tamil nadu": "33",
  puducherry: "34",
  pondicherry: "34",
  "andaman and nicobar islands": "35",
  telangana: "36",
  "andhra pradesh": "37",
  ladakh: "38",
  "other territory": "97",
});

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
  return INDIAN_STATE_CODES[stateName.trim().toLowerCase()] ?? "";
}

/**
 * Split a GST pool into CGST/SGST or IGST.
 *
 * Intra-state supply halves the pool; inter-state puts all of it on IGST. The
 * half is split through the kernel's largest-remainder `allocate`, so an odd
 * number of paise lands on CGST rather than vanishing — the two halves always
 * sum back to the pool.
 *
 * An unknown supplier state and an unknown place of supply compare equal, which
 * keeps the pre-rewrite behaviour: a domestic seller with no state on file
 * still produces CGST/SGST rather than being silently treated as inter-state.
 */
export function gstSplit(
  taxPool: number,
  supplierStateCode: string,
  placeOfSupplyStateCode: string,
): { cgst: number; sgst: number; igst: number } {
  const poolMinor = Math.round(round2(taxPool) * 100);
  if (poolMinor <= 0) return { cgst: 0, sgst: 0, igst: 0 };

  if (supplierStateCode !== placeOfSupplyStateCode) {
    return { cgst: 0, sgst: 0, igst: poolMinor / 100 };
  }

  const [cgst, sgst] = allocate(money(poolMinor, "INR"), [1, 1]);
  return { cgst: cgst.minor / 100, sgst: sgst.minor / 100, igst: 0 };
}
