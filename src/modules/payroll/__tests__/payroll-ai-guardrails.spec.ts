import {
  PAYROLL_AI_CAPABILITY,
  FORBIDDEN_PAYROLL_AI_ACTIONS,
  buildPayslipEvidenceCitations,
} from "../insights/payroll-ai-guardrails";

describe("Phase 11 payroll AI guardrails", () => {
  it("forbids autonomous payroll decisions", () => {
    expect(PAYROLL_AI_CAPABILITY.mode).toBe("explain_draft_only");
    expect(PAYROLL_AI_CAPABILITY.autonomousPayrollDecisions).toBe(false);
    expect(PAYROLL_AI_CAPABILITY.autonomousStatutoryFiling).toBe(false);
    expect(PAYROLL_AI_CAPABILITY.autonomousPayout).toBe(false);
    expect(PAYROLL_AI_CAPABILITY.mayRecalculateAmounts).toBe(false);
  });

  it("lists high-risk forbidden actions", () => {
    expect(FORBIDDEN_PAYROLL_AI_ACTIONS).toEqual(
      expect.arrayContaining([
        "approve_run",
        "mark_paid",
        "submit_statutory_filing",
        "recalculate_amounts",
      ]),
    );
  });

  it("builds engine citations from payslip evidence", () => {
    const citations = buildPayslipEvidenceCitations({
      month: "2026-06",
      currency: "INR",
      grossEarnings: "100000.00",
      totalDeductions: "15000.00",
      netPay: "85000.00",
      scheduledDays: "30",
      paidDays: "30",
      lopDays: "0",
      earningsBreakdown: [{ name: "Basic", amount: "50000.00" }],
      deductionsBreakdown: [{ name: "PF", amount: "1800.00" }],
    });

    expect(citations.some((c) => c.path === "netPay" && c.value === "85000.00")).toBe(true);
    expect(citations.some((c) => c.path === "earningsBreakdown[0].amount")).toBe(true);
    expect(citations.every((c) => c.source === "payroll_engine")).toBe(true);
  });
});
