import { calcPayroll, type ResolvedComponent } from "../calculation-engine";
import { ctcBreakup, type CtcBreakupInput } from "../ctc-breakup";
import { evalFormula } from "../formula-engine";
import { validateFormula } from "../../../setup/lib/template-preview";
import { DEFAULT_PAYROLL_TOGGLES, type FormulaScope } from "../../../payroll.types";

const config = {
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
    tdsMode: "DECLARATION" as const, tdsFlatPercent: null,
  },
  overtime: { multiplier: "1.5", basis: "BASIC" as const },
  varianceThresholdPercent: 20,
};

function component(over: Partial<ResolvedComponent> & Pick<ResolvedComponent, "id" | "code" | "calcMethod">): ResolvedComponent {
  return {
    name: over.code, type: "EARNING", amount: null, percent: null, formula: null,
    taxable: true, showOnPayslip: true, includeInCtc: true, isStatutory: false, sortOrder: over.id,
    ...over,
  };
}

const components: ResolvedComponent[] = [
  component({ id: 1, code: "BASIC", calcMethod: "PERCENT_OF_BASIC", percent: "40" }),
  component({ id: 2, code: "HRA", calcMethod: "FORMULA", formula: "BASIC * 0.5", taxable: false }),
  component({ id: 3, code: "SPECIAL", calcMethod: "FORMULA", formula: "ctc - BASIC - HRA" }),
];

const input: CtcBreakupInput = {
  annualCtc: "2400000.00",
  components,
  toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: true, esi: true, professionalTax: true, tds: true },
  config,
  month: "2026-06",
  regime: null,
  stateCode: "KA",
  workerType: "EMPLOYEE",
  currency: "INR",
  policyVersionId: 7,
};

describe("ctcBreakup", () => {
  it("returns exactly what calcPayroll computes for a full-attendance month with no pulls", () => {
    const breakup = ctcBreakup(input);
    const snapshot = calcPayroll({
      policyVersionId: 7,
      month: "2026-06",
      annualCtcDecimal: "2400000.00",
      workerType: "EMPLOYEE",
      currency: "INR",
      payoutCurrency: null,
      fxRate: null,
      taxRegime: null,
      components,
      toggles: input.toggles,
      config,
      inputs: { scheduledDays: "30", paidDays: "30", lopDays: "0", overtimeHours: "0", billableHours: "0" },
      pulls: { approvedBonuses: [], approvedIncentives: [], approvedReimbursements: [], activeLoans: [], taxDeclaration: null },
      previousSnapshot: null,
      stateCode: "KA",
    });

    expect(breakup.lines.map((l) => [l.code, l.category, l.monthly])).toEqual(
      snapshot.lines.map((l) => [l.code, l.category, l.amount]),
    );
    expect(breakup.monthly).toEqual({
      gross: snapshot.totals.gross,
      deductions: snapshot.totals.deductions,
      employerContributions: snapshot.totals.employerContributions,
      net: snapshot.totals.net,
    });
    expect(breakup.lines.some((l) => l.category === "EMPLOYER_CONTRIBUTION")).toBe(true);
    expect(breakup.lines.some((l) => l.code === "TDS")).toBe(true);
    expect(breakup.regime).toBe("NEW");
    expect(breakup.warnings).toEqual([snapshot.wageDefinitionWarning]);
  });

  it("resolves a percent-of-another-component formula against that component's amount", () => {
    const breakup = ctcBreakup(input);
    const amount = (code: string) => breakup.lines.find((l) => l.code === code)?.monthly;
    expect(amount("BASIC")).toBe("80000.00");
    expect(amount("HRA")).toBe("40000.00");
    expect(amount("SPECIAL")).toBe("80000.00");
    expect(breakup.monthly.gross).toBe("200000.00");
    expect(breakup.annual.gross).toBe("2400000.00");
  });

  it("reports a reference to a component computed later as a warning, not a silent zero", () => {
    const breakup = ctcBreakup({
      ...input,
      components: [component({ id: 1, code: "HRA", calcMethod: "FORMULA", formula: "BASIC * 0.5" }), { ...components[0], sortOrder: 2 }],
    });
    expect(breakup.lines.find((l) => l.code === "HRA")?.monthly).toBe("0.00");
    expect(breakup.warnings[0]).toBe("HRA: Unknown variable: BASIC");
  });
});

describe("evalFormula component references", () => {
  const scope: FormulaScope = {
    basic: 0, gross: 0, ctc: 0, days_in_month: 30, paid_days: 30, lop_days: 0,
    overtime_hours: 0, incentive_amount: 0, reimbursement_amount: 0,
  };

  it("reads a referenced component code and still rejects unknown names", () => {
    expect(evalFormula("BASIC * 0.5", scope, { BASIC: 1000 })).toEqual({ ok: true, value: 500 });
    expect(evalFormula("BASIC * 0.5", scope)).toEqual({ ok: false, error: "Unknown variable: BASIC" });
  });
});

describe("validateFormula component codes", () => {
  it("accepts only the component codes it is given", () => {
    expect(validateFormula("BASIC * 0.5", new Set(["BASIC"]))).toEqual({ valid: true, unknownIdentifiers: [] });
    expect(validateFormula("BASIC * 0.5")).toEqual({ valid: false, unknownIdentifiers: ["BASIC"] });
  });
});
