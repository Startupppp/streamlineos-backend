import { addDays } from "date-fns";
import { subscriptions } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";
import { getTrialDays, TRIAL_PLAN } from "./plan-entitlements.constants";

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
