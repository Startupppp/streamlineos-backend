import { addDays } from "date-fns";
import { subscriptions } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { getTrialDays, TRIAL_PLAN } from "./plan-entitlements.constants";

export function addClampedMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}

export async function insertTrialSubscription(tx: TenantTx, orgId: string): Promise<void> {
  const trialDays = getTrialDays();
  await tx.insert(subscriptions).values({
    orgId,
    plan: TRIAL_PLAN,
    status: "TRIAL",
    trialEndsAt: addDays(new Date(), trialDays),
    currentPeriodStart: new Date(),
    currentPeriodEnd: addDays(new Date(), trialDays),
  });
}
