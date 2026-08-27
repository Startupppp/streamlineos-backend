import type { RevenueEventType } from "./revenue-events";

export interface RevenueMovement {
  type: RevenueEventType;
  mrr: number;
  count: number;
  recentMrr: number;
}

export interface RevenueMetrics {
  mrr: number;
  arr: number;
  arpu: number;
  churnRate: number;
  activeSubscriptions: number;
  trialSubscriptions: number;
  ltv: number;
  cac: number;
  expansionRevenue: number;
  trialConversionRate: number;
  refundRate: number;
}

// Level from subscription state, movement from the event stream; pure so the two reconcile in a test.
export function summariseMovements(input: {
  mrr: number;
  totalActive: number;
  totalTrial: number;
  movements: RevenueMovement[];
}): RevenueMetrics {
  const { mrr, totalActive, totalTrial, movements } = input;
  const by = (type: RevenueEventType) => movements.find((movement) => movement.type === type);

  const totalChurn = by("churn")?.count ?? 0;
  const totalRefunds = by("refund")?.count ?? 0;
  const totalNewSubs = by("new_subscription")?.count ?? 0;
  const expansionRevenue = by("upgrade")?.recentMrr ?? 0;

  const arpu = totalActive > 0 ? Math.round(mrr / totalActive) : 0;
  const churnRate = totalActive > 0 ? Math.round((totalChurn / totalActive) * 100) : 0;
  const totalEver = totalActive + totalTrial + totalChurn;

  return {
    mrr,
    arr: mrr * 12,
    arpu,
    churnRate,
    activeSubscriptions: totalActive,
    trialSubscriptions: totalTrial,
    ltv: churnRate > 0 ? Math.round(arpu / (churnRate / 100)) : arpu * 24,
    cac: 0,
    expansionRevenue,
    trialConversionRate: totalEver > 0 ? Math.round((totalActive / totalEver) * 1000) / 10 : 0,
    refundRate: totalNewSubs > 0 ? Math.round((totalRefunds / totalNewSubs) * 1000) / 10 : 0,
  };
}
