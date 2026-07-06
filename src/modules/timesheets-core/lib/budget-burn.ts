export interface BurnBudget {
  budgetType: string;
  budgetHours: number | null;
  budgetAmount: number | null;
  alertThresholds: number[];
}

export interface BurnResult {
  budget: number;
  consumed: number;
  percentUsed: number;
  remaining: number;
  alertLevel: number;
  over: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeBurn(
  b: BurnBudget,
  consumedHours: number,
  consumedAmount: number,
): BurnResult {
  const isHours = b.budgetType === "HOURS";
  const budget = (isHours ? b.budgetHours : b.budgetAmount) ?? 0;
  const consumed = round2(isHours ? consumedHours : consumedAmount);
  const percentUsed = budget > 0 ? Math.round((consumed / budget) * 1000) / 10 : 0;
  const remaining = round2(budget - consumed);

  let alertLevel = 0;
  for (const t of [...b.alertThresholds].sort((a, c) => a - c)) {
    if (percentUsed >= t) alertLevel = t;
  }

  return {
    budget: round2(budget),
    consumed,
    percentUsed,
    remaining,
    alertLevel,
    over: budget > 0 && consumed > budget,
  };
}
