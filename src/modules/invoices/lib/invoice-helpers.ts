import { eq } from "drizzle-orm";
import { indianStates, organizations } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

export const round2 = (n: number): number => Math.round(n * 100) / 100;

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
