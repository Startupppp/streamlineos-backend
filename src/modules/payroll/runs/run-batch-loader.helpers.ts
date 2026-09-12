export type BonusRow = { id: number; userId: string; amount: string; type: string; taxable: boolean };
export type IncentiveRow = { id: number; salesRepId: string; approvedAmount: string | null; calculatedAmount: string };
export type ReimbursementRow = { id: number; userId: string; amount: string; category: string };
export type TaxDeclarationRow = {
  userId: string;
  section80c: string;
  section80d: string;
  hra: string;
  lta: string;
  homeLoanInterest: string;
  section80g: string;
  previousEmploymentIncome: string;
  previousEmployerTds: string;
  status: string;
};

export function getFyString(month: string): string {
  const [yearStr, monStr] = month.split("-");
  const year = parseInt(yearStr ?? "2025", 10);
  const mon = parseInt(monStr ?? "4", 10);
  if (mon >= 4) return `${year}-${String(year + 1).slice(-2)}`;
  return `${year - 1}-${String(year).slice(-2)}`;
}

export function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  return map;
}
