import type { PulledInputs, SectionMap } from "./lib/input-puller";
import type { ResolvedComponent, CalcInputPulls } from "./lib/calculation-engine";
import type { PayrollInputSource, CalculationSnapshot, InputsSnapshot } from "../payroll.types";
import type { DetectedExceptions } from "./lib/exception-engine";

export interface GenerateRunCommand {
  orgId: string;
  runId: number;
  actorId: string;
  isRecalc: boolean;
}

export interface ProfileData {
  id: number;
  userId: string | null;
  workerId: string | null;
  workerType: "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR";
  currency: string;
  payoutCurrency: string | null;
  annualCtc: string;
  taxRegime: "OLD" | "NEW" | null;
}

export interface EmployeeCalcResult {
  profile: ProfileData;
  inputs: InputsSnapshot;
  pulls: CalcInputPulls;
  snapshot: CalculationSnapshot;
  exceptions: DetectedExceptions[];
}

export interface RunBatchData {
  lockedPeriodId: number | null;
  lockedSectionsByUser: Map<string, SectionMap>;
  runInputsByUser: Map<string, {
    source: PayrollInputSource;
    scheduledDays: string;
    paidDays: string;
    lopDays: string;
    halfDays: string;
    overtimeHours: string;
    shiftAllowanceUnits: string;
    holidayWorkDays: string;
    billableHours: string;
    isOverride: boolean;
    overrideReason: string | null;
  }>;
  liveAttendanceByUser: Map<string, PulledInputs | null>;
  componentsByProfileId: Map<number, ResolvedComponent[]>;
  bonusesByUser: Map<string, { id: number; userId: string; amount: string; type: string; taxable: boolean }[]>;
  incentivesByUser: Map<string, { id: number; salesRepId: string; approvedAmount: string | null; calculatedAmount: string }[]>;
  reimbursementsByUser: Map<string, { id: number; userId: string; amount: string; category: string }[]>;
  expensesByUser: Map<string, { id: number; userId: string; amount: string; category: string; expenseDate: string }[]>;
  loansByUser: Map<string, CalcInputPulls["activeLoans"]>;
  taxDeclarationByUser: Map<string, {
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
  }>;
}
