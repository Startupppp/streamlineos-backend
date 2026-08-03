export interface BvaAccountPeriodRow {
  accountId: number;
  accountCode: string;
  accountName: string;
  periodKey: string;
  budgeted: string;
  actual: string;
  variance: string;
  variancePct: string;
  exceeded: boolean;
}

export interface BvaResponse {
  budgetId: number;
  from: string | null;
  to: string | null;
  rows: BvaAccountPeriodRow[];
  totals: {
    budgeted: string;
    actual: string;
    variance: string;
    variancePct: string;
  };
}

export interface ForecastWeek {
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  openingCash: string;
  inflows: string;
  outflows: string;
  net: string;
  closingCash: string;
  minimumBalanceWarning: boolean;
}

export interface ForecastResponse {
  scenarioId: number | null;
  generatedAt: string;
  weeks: ForecastWeek[];
  totalInflows: string;
  totalOutflows: string;
}

export interface ScenarioCompareRow {
  weekIndex: number;
  weekStart: string;
  closingCash: Record<number, string>;
}

export interface ScenarioCompareResponse {
  scenarioIds: number[];
  scenarios: Array<{ id: number; name: string; kind: string }>;
  weeks: ScenarioCompareRow[];
}

