export function computeRiskScore(overdueAmount: number, totalInvoiced: number, maxDaysOverdue: number): number {
  const ratio = totalInvoiced > 0 ? overdueAmount / totalInvoiced : 0;
  return Math.min(100, Math.round(Math.min(ratio, 1) * 50 + Math.min(maxDaysOverdue, 180) / 180 * 50));
}
