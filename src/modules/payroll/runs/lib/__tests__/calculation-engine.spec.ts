import { calcPayroll } from "../calculation-engine";
import type { CalcEngineInput, ResolvedComponent } from "../calculation-engine";
import { DEFAULT_PAYROLL_TOGGLES } from "../../../payroll.types";

const baseConfig = {
  rounding: { mode: "NEAREST" as const, precision: 2 as const },
  components: [],
  approvalChain: [],
  payslipLayout: "CLASSIC" as const,
  calendar: { attendanceCutoffDay: 26, reimbursementCutoffDay: 26, declarationCutoffDay: 20, previewDay: 28, approvalDeadlineDay: 30, publishOffsetDays: 1 },
  statutory: {
    pfEmployeePercent: "12.00", pfEmployerPercent: "13.00",
    pfWageCeiling: "15000.00",
    esiEmployeePercent: "0.75", esiEmployerPercent: "3.25",
    esiWageCeiling: "21000.00",
    professionalTaxMonthly: "200.00",
    tdsMode: "NONE" as const, tdsFlatPercent: null,
  },
  overtime: { multiplier: "1.5", basis: "BASIC" as const },
  varianceThresholdPercent: 20,
};

const basicComponent: ResolvedComponent = {
  id: 1, code: "BASIC", name: "Basic", type: "EARNING" as const,
  calcMethod: "PERCENT_OF_BASIC" as const,
  amount: null, percent: "40", formula: null,
  taxable: true, showOnPayslip: true, includeInCtc: true,
  isStatutory: false, sortOrder: 1,
};

const hraComponent: ResolvedComponent = {
  id: 2, code: "HRA", name: "HRA", type: "EARNING" as const,
  calcMethod: "PERCENT_OF_BASIC" as const,
  amount: null, percent: "20", formula: null,
  taxable: false, showOnPayslip: true, includeInCtc: true,
  isStatutory: false, sortOrder: 2,
};

const baseInput: CalcEngineInput = {
  policyVersionId: 1,
  month: "2025-07",
  annualCtcDecimal: "1200000.00",
  workerType: "EMPLOYEE",
  currency: "INR", payoutCurrency: null, fxRate: null,
  taxRegime: "NEW",
  components: [basicComponent, hraComponent],
  toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: true, esi: false, professionalTax: false },
  config: baseConfig,
  inputs: { scheduledDays: "30", paidDays: "30", lopDays: "0", overtimeHours: "0" },
  pulls: { approvedBonuses: [], approvedIncentives: [], approvedReimbursements: [], activeLoans: [] },
  previousSnapshot: null,
};

describe("calculation engine", () => {
  it("computes basic as 40% of monthly CTC", () => {
    const snap = calcPayroll(baseInput);
    const basicLine = snap.lines.find(l => l.code === "BASIC");
    expect(basicLine).toBeDefined();
    const monthlyCtc = 1200000 / 12;
    const expectedBasic = monthlyCtc * 0.4;
    expect(parseFloat(basicLine!.amount)).toBeCloseTo(expectedBasic, 0);
  });

  it("prorates basic on LOP", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      inputs: { scheduledDays: "30", paidDays: "28", lopDays: "2", overtimeHours: "0" },
    };
    const snap = calcPayroll(input);
    const basicLine = snap.lines.find(l => l.code === "BASIC");
    expect(basicLine).toBeDefined();
    const fullBasic = (1200000 / 12) * 0.4;
    const proratedBasic = fullBasic * (28 / 30);
    expect(parseFloat(basicLine!.amount)).toBeCloseTo(proratedBasic, 0);
  });

  it("applies PF when toggle on", () => {
    const snap = calcPayroll(baseInput);
    const pfLine = snap.lines.find(l => l.code === "PF_EMPLOYEE" || l.code === "EPF_EMPLOYEE");
    expect(pfLine).toBeDefined();
    expect(pfLine!.category).toBe("DEDUCTION");
  });

  it("skips PF for CONTRACTOR", () => {
    const input: CalcEngineInput = { ...baseInput, workerType: "CONTRACTOR" };
    const snap = calcPayroll(input);
    const pfLine = snap.lines.find(l => l.code === "PF_EMPLOYEE" || l.code === "EPF_EMPLOYEE");
    expect(pfLine).toBeUndefined();
  });

  it("zero paid days gives zero net", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      inputs: { scheduledDays: "30", paidDays: "0", lopDays: "30", overtimeHours: "0" },
    };
    const snap = calcPayroll(input);
    expect(parseFloat(snap.totals.net)).toBeCloseTo(0, 0);
  });

  it("recovers loan EMI", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, loans: true, pf: false },
      pulls: {
        ...baseInput.pulls,
        activeLoans: [{
          id: 1, emiAmount: "5000.00", amount: "50000.00",
          paidEmis: 3, totalEmis: 10, adjustment: null,
        }],
      },
    };
    const snap = calcPayroll(input);
    const loanLine = snap.lines.find(l => l.code.includes("LOAN") || l.name.includes("Loan"));
    expect(loanLine).toBeDefined();
    expect(loanLine!.category).toBe("DEDUCTION");
  });

  it("last installment recovers remaining outstanding, not full EMI", () => {
    const input: CalcEngineInput = {
      ...baseInput,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, loans: true, pf: false },
      pulls: {
        ...baseInput.pulls,
        activeLoans: [{
          id: 1,
          emiAmount: "5000.00",
          amount: "12000.00",
          paidEmis: 2,
          totalEmis: 3,
          adjustment: null,
        }],
      },
    };
    const snap = calcPayroll(input);
    const loanLine = snap.lines.find(l => l.code.includes("LOAN") || l.name.includes("Loan"));
    expect(loanLine).toBeDefined();
    expect(parseFloat(loanLine!.amount)).toBeCloseTo(2000, 0);
  });

  it("formula component evaluates correctly", () => {
    const formulaComp: ResolvedComponent = {
      id: 3, code: "SPECIAL_ALLOW", name: "Special Allowance",
      type: "EARNING" as const,
      calcMethod: "FORMULA" as const,
      amount: null, percent: null, formula: "basic * 0.1",
      taxable: true, showOnPayslip: true, includeInCtc: true,
      isStatutory: false, sortOrder: 3,
    };
    const input: CalcEngineInput = {
      ...baseInput,
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false },
      components: [basicComponent, formulaComp],
    };
    const snap = calcPayroll(input);
    const formulaLine = snap.lines.find(l => l.code === "SPECIAL_ALLOW");
    expect(formulaLine).toBeDefined();
    const monthlyCtc = 1200000 / 12;
    const basic = monthlyCtc * 0.4;
    expect(parseFloat(formulaLine!.amount)).toBeCloseTo(basic * 0.1, 0);
  });

  it("net is gross minus deductions", () => {
    const snap = calcPayroll({ ...baseInput, toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false } });
    const gross = parseFloat(snap.totals.gross);
    const deductions = parseFloat(snap.totals.deductions);
    const net = parseFloat(snap.totals.net);
    expect(net).toBeCloseTo(gross - deductions, 1);
  });
});
