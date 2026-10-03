import type {
  PayrollPolicyConfig,
  PayrollToggles,
  PayrollWorkerType,
  MoneyString,
  TaxRegimeType,
} from "../../payroll.types";
import type { SalaryComponentType, SalaryComponentCalcMethod } from "../../payroll.types";
import type { CalculationSnapshot } from "../../payroll.types";

export interface ResolvedComponent {
  id: number;
  code: string;
  name: string;
  type: SalaryComponentType;
  calcMethod: SalaryComponentCalcMethod;
  amount: MoneyString | null;
  percent: string | null;
  formula: string | null;
  taxable: boolean;
  showOnPayslip: boolean;
  includeInCtc: boolean;
  isStatutory: boolean;
  sortOrder: number;
}

export interface CalcInputPulls {
  approvedBonuses: { amount: MoneyString; type: string; taxable: boolean }[];
  approvedIncentives: { amount: MoneyString }[];
  approvedReimbursements: { amount: MoneyString; category: string }[];
  consumedReimbursementIds?: number[];
  consumedIncentiveIds?: number[];
  consumedBonusIds?: number[];
  activeLoans: {
    id: number;
    emiAmount: MoneyString | null;
    amount: MoneyString;
    paidEmis: number;
    totalEmis: number | null;
    adjustment: { type: string; amount: MoneyString | null } | null;
  }[];
  taxDeclaration?: {
    section80c: string;
    section80d: string;
    hra: string;
    lta: string;
    homeLoanInterest: string;
    section80g: string;
    previousEmploymentIncome: string;
    previousEmployerTds: string;
  } | null;
  panAvailable?: boolean;
}

export interface CalcEngineInput {
  policyVersionId: number | null;
  month: string;
  annualCtcDecimal: MoneyString;
  workerType: PayrollWorkerType;
  currency: string;
  payoutCurrency: string | null;
  fxRate: string | null;
  taxRegime: TaxRegimeType | null;
  components: ResolvedComponent[];
  toggles: PayrollToggles;
  config: PayrollPolicyConfig;
  inputs: {
    scheduledDays: string;
    paidDays: string;
    lopDays: string;
    overtimeHours: string;
    billableHours?: string;
  };
  pulls: CalcInputPulls;
  previousSnapshot: CalculationSnapshot | null;
  stateCode?: string | null;
}

export const SORT_BASE_TAX = 950;
