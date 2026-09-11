/**
 * Phase 11 — AI payroll guardrails (non-negotiable product rules).
 * Explain/draft only. Never authorize money movement or statutory submission.
 */
import { asRecord } from "../../../common/openapi/zod-operation-contracts";

export const PAYROLL_AI_CAPABILITY = {
  mode: "explain_draft_only" as const,
  autonomousPayrollDecisions: false,
  autonomousStatutoryFiling: false,
  autonomousPayout: false,
  mayRecalculateAmounts: false,
  honestyLabel: "AI narrates pre-computed payroll figures only — never decides pay or filings",
  note: "All monetary amounts and statutory outcomes must come from the payroll engine evidence snapshot. AI must not invent, recompute, approve, pay, or file.",
} as const;

export interface EvidenceCitation {
  /** Stable path into evidenceSnapshot, e.g. "netPay" or "earningsBreakdown[0].amount" */
  path: string;
  label: string;
  value: unknown;
  source: "payroll_engine";
}

/**
 * Build explicit citations so the UI can show which engine fields grounded the narrative.
 */
export function buildPayslipEvidenceCitations(
  evidence: Record<string, unknown>,
): EvidenceCitation[] {
  const citations: EvidenceCitation[] = [];

  const scalar = (path: string, label: string) => {
    if (evidence[path] !== undefined && evidence[path] !== null) {
      citations.push({
        path,
        label,
        value: evidence[path],
        source: "payroll_engine",
      });
    }
  };

  scalar("month", "Pay period");
  scalar("currency", "Currency");
  scalar("grossEarnings", "Gross earnings");
  scalar("totalDeductions", "Total deductions");
  scalar("netPay", "Net pay");
  scalar("scheduledDays", "Scheduled days");
  scalar("paidDays", "Paid days");
  scalar("lopDays", "LOP days");

  const earnings = evidence.earningsBreakdown;
  if (Array.isArray(earnings)) {
    earnings.forEach((row, i) => {
      const r = asRecord(row);
      if (r) {
        citations.push({
          path: `earningsBreakdown[${i}].amount`,
          label: r.name ? `Earning: ${r.name}` : `Earning line ${i + 1}`,
          value: r.amount ?? null,
          source: "payroll_engine",
        });
      }
    });
  }

  const deductions = evidence.deductionsBreakdown;
  if (Array.isArray(deductions)) {
    deductions.forEach((row, i) => {
      const r = asRecord(row);
      if (r) {
        citations.push({
          path: `deductionsBreakdown[${i}].amount`,
          label: r.name ? `Deduction: ${r.name}` : `Deduction line ${i + 1}`,
          value: r.amount ?? null,
          source: "payroll_engine",
        });
      }
    });
  }

  return citations;
}

/** Forbidden AI actions — used by API contracts / FE honesty banners. */
export const FORBIDDEN_PAYROLL_AI_ACTIONS = [
  "approve_run",
  "lock_run",
  "mark_paid",
  "generate_payout_batch",
  "submit_statutory_filing",
  "recalculate_amounts",
  "override_exception",
  "change_salary",
] as const;
