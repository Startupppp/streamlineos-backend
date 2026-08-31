import { calcPayroll, surchargeRate } from "../calculation-engine";
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

describe("TDS surcharge (high earners)", () => {
  it("no surcharge at or below ₹50L taxable", () => {
    expect(surchargeRate(5_000_000, "NEW")).toBe(0);
    expect(surchargeRate(4_000_000, "OLD")).toBe(0);
  });

  it("10% between ₹50L and ₹1Cr", () => {
    expect(surchargeRate(7_500_000, "NEW")).toBe(0.1);
    expect(surchargeRate(7_500_000, "OLD")).toBe(0.1);
  });

  it("15% between ₹1Cr and ₹2Cr", () => {
    expect(surchargeRate(15_000_000, "NEW")).toBe(0.15);
    expect(surchargeRate(15_000_000, "OLD")).toBe(0.15);
  });

  it("new regime caps at 25% above ₹2Cr; old regime rises to 37% above ₹5Cr", () => {
    expect(surchargeRate(30_000_000, "NEW")).toBe(0.25);
    expect(surchargeRate(60_000_000, "NEW")).toBe(0.25);
    expect(surchargeRate(30_000_000, "OLD")).toBe(0.25);
    expect(surchargeRate(60_000_000, "OLD")).toBe(0.37);
  });

  it("a high earner above the surcharge threshold pays surcharge-inflated TDS", () => {
    const highConfig = {
      ...baseConfig,
      statutory: { ...baseConfig.statutory, tdsMode: "DECLARATION" as const, tdsFlatPercent: null },
    };
    const snap = calcPayroll({
      ...baseInput,
      annualCtcDecimal: "15000000.00",
      taxRegime: "NEW" as const,
      components: [basicComponent, hraComponent],
      toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, tds: true },
      config: highConfig,
      pulls: { ...baseInput.pulls, taxDeclaration: null },
    });
    const monthlyTds = parseFloat(snap.lines.find((l) => l.code === "TDS")!.amount);
    const annualGross = parseFloat(snap.totals.gross) * 12;
    expect((monthlyTds * 12) / annualGross).toBeGreaterThan(0.28);
  });
});

describe("Contractor TDS — §194J and §206AA (no PAN)", () => {
  const contractorBase = {
    ...baseInput,
    workerType: "CONTRACTOR" as const,
    toggles: { ...DEFAULT_PAYROLL_TOGGLES, pf: false, esi: false, tds: true },
  };

  it("withholds 10% when PAN is on record (§194J)", () => {
    const snap = calcPayroll({ ...contractorBase, pulls: { ...baseInput.pulls, panAvailable: true } });
    const tds = snap.lines.find((l) => l.code === "TDS")!;
    const gross = parseFloat(snap.totals.gross);
    expect(parseFloat(tds.amount)).toBeCloseTo(gross * 0.1, 0);
    expect(tds.explain.steps[0]).toContain("§194J");
  });

  it("withholds 20% when no PAN is on record (§206AA)", () => {
    const withPan = calcPayroll({ ...contractorBase, pulls: { ...baseInput.pulls, panAvailable: true } });
    const noPan = calcPayroll({ ...contractorBase, pulls: { ...baseInput.pulls, panAvailable: false } });
    const tdsWith = parseFloat(withPan.lines.find((l) => l.code === "TDS")!.amount);
    const tdsNo = parseFloat(noPan.lines.find((l) => l.code === "TDS")!.amount);
    expect(tdsNo).toBeCloseTo(tdsWith * 2, 0);
    expect(noPan.lines.find((l) => l.code === "TDS")!.explain.steps[0]).toContain("§206AA");
  });

  it("defaults to 10% when PAN availability is unspecified (back-compat)", () => {
    const snap = calcPayroll({ ...contractorBase, pulls: { ...baseInput.pulls } });
    const tds = snap.lines.find((l) => l.code === "TDS")!;
    const gross = parseFloat(snap.totals.gross);
    expect(parseFloat(tds.amount)).toBeCloseTo(gross * 0.1, 0);
  });
});

describe("Labour Code wage definition — snapshot surfacing", () => {
  const bigAllowance: ResolvedComponent = {
    id: 3, code: "SPECIAL", name: "Special Allowance", type: "EARNING" as const,
    calcMethod: "FIXED" as const,
    amount: "80000.00", percent: null, formula: null,
    taxable: true, showOnPayslip: true, includeInCtc: true,
    isStatutory: false, sortOrder: 3,
  };

  it("flags the snapshot when Basic+DA falls below 50% of gross", () => {
    const snap = calcPayroll({
      ...baseInput,
      components: [basicComponent, hraComponent, bigAllowance],
    });
    const basic = parseFloat(snap.lines.find(l => l.code === "BASIC")!.amount);
    const gross = parseFloat(snap.totals.gross);
    expect(basic / gross).toBeLessThan(0.5);
    expect(snap.wageDefinitionWarning).toContain("Labour Code wage definition");
  });

  it("leaves the snapshot clean for a compliant structure", () => {
    const snap = calcPayroll(baseInput);
    const basic = parseFloat(snap.lines.find(l => l.code === "BASIC")!.amount);
    expect(basic / parseFloat(snap.totals.gross)).toBeGreaterThanOrEqual(0.5);
    expect(snap.wageDefinitionWarning).toBeNull();
  });
});
