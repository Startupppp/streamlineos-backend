/**
 * Pure payroll period reconciliation checks (Phase 6).
 * Compares run net, payout paid totals, and journal batch balance without claiming
 * bank-statement or provider settlement (those remain export/manual).
 */

export interface PeriodReconMoneyInputs {
  runNet: number | null;
  payoutPaid: number;
  payoutPending: number;
  payoutFailed: number;
  journalDebits: number | null;
  journalCredits: number | null;
  journalStatus: string | null;
  journalReconStatus: string | null;
  runStatus: string | null;
  hasRun: boolean;
  hasJournal: boolean;
  hasPayoutBatch: boolean;
}

export interface PeriodReconCheck {
  key: string;
  label: string;
  ok: boolean;
  severity: "blocker" | "warning" | "info";
  detail: string;
  expected?: string;
  actual?: string;
  delta?: string;
}

export interface PeriodReconEvaluation {
  checks: PeriodReconCheck[];
  overallOk: boolean;
  blockerCount: number;
  warningCount: number;
}

const EPS = 0.009; // half-cent tolerance on rupee money

function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

/**
 * Evaluate recon checks from numeric inputs (unit-testable, no DB).
 */
export function evaluatePeriodReconciliation(input: PeriodReconMoneyInputs): PeriodReconEvaluation {
  const checks: PeriodReconCheck[] = [];

  checks.push({
    key: "run_exists",
    label: "Payroll run exists for period",
    ok: input.hasRun,
    severity: "blocker",
    detail: input.hasRun
      ? `Run status ${input.runStatus ?? "unknown"}`
      : "No REGULAR payroll run for this month",
  });

  if (input.hasJournal && input.journalDebits != null && input.journalCredits != null) {
    const balanced = nearlyEqual(input.journalDebits, input.journalCredits);
    checks.push({
      key: "journal_balanced",
      label: "Journal batch balances",
      ok: balanced,
      severity: "blocker",
      detail: balanced
        ? `Debits ${money(input.journalDebits)} = credits ${money(input.journalCredits)}`
        : `Debits ${money(input.journalDebits)} ≠ credits ${money(input.journalCredits)}`,
      expected: money(input.journalDebits),
      actual: money(input.journalCredits),
      delta: money(input.journalDebits - input.journalCredits),
    });
  } else {
    checks.push({
      key: "journal_exists",
      label: "Journal outbox batch exists",
      ok: false,
      severity: "warning",
      detail: "No active journal batch for this period — snapshot from Journal batches when ready",
    });
  }

  if (input.hasJournal) {
    const posted =
      input.journalStatus === "POSTED" || input.journalStatus === "EXPORTED";
    checks.push({
      key: "journal_posted",
      label: "Journal posted or exported",
      ok: posted,
      severity: "warning",
      detail: posted
        ? `Status ${input.journalStatus}`
        : `Journal is ${input.journalStatus ?? "missing"} — post before external GL import`,
    });

    const reconDone = input.journalReconStatus === "RECONCILED";
    checks.push({
      key: "journal_reconciled",
      label: "Journal marked reconciled",
      ok: reconDone,
      severity: "info",
      detail: reconDone
        ? "Reconciliation status RECONCILED"
        : `Reconciliation status ${input.journalReconStatus ?? "UNRECONCILED"} (manual mark after GL match)`,
    });
  }

  checks.push({
    key: "payout_batch_exists",
    label: "Payout batch generated",
    ok: input.hasPayoutBatch,
    severity: "warning",
    detail: input.hasPayoutBatch
      ? `Paid ${money(input.payoutPaid)} · pending ${money(input.payoutPending)} · failed ${money(input.payoutFailed)}`
      : "No bank payout batch for this run yet",
  });

  if (input.hasRun && input.runNet != null && input.hasPayoutBatch) {
    // When all items paid (no pending), paid should match run net (excluding failed)
    const allSettled = input.payoutPending <= EPS;
    if (allSettled) {
      const match = nearlyEqual(input.runNet, input.payoutPaid);
      checks.push({
        key: "run_net_vs_payout_paid",
        label: "Run net matches payout paid total",
        ok: match,
        severity: "blocker",
        detail: match
          ? `Run net ${money(input.runNet)} = paid ${money(input.payoutPaid)}`
          : `Run net ${money(input.runNet)} vs paid ${money(input.payoutPaid)} — investigate failed/held items or partial pays`,
        expected: money(input.runNet),
        actual: money(input.payoutPaid),
        delta: money(input.runNet - input.payoutPaid),
      });
    } else {
      checks.push({
        key: "payout_in_flight",
        label: "Payout fully settled",
        ok: false,
        severity: "warning",
        detail: `${money(input.payoutPending)} still pending payment; ${money(input.payoutPaid)} paid, ${money(input.payoutFailed)} failed`,
        expected: money(input.runNet),
        actual: money(input.payoutPaid),
      });
    }
  }

  if (
    input.hasRun &&
    input.runNet != null &&
    input.hasJournal &&
    input.journalCredits != null
  ) {
    // Balanced journal total credits ≈ full double-entry side; net payable is often
    // half when expense/payable pair — only assert balance already checked above.
    // Soft check: journal credits >= run net (payable + other liabilities).
    const covers = input.journalCredits + EPS >= input.runNet;
    checks.push({
      key: "journal_covers_run_net",
      label: "Journal credits cover run net",
      ok: covers,
      severity: "warning",
      detail: covers
        ? `Credits ${money(input.journalCredits)} ≥ run net ${money(input.runNet)}`
        : `Credits ${money(input.journalCredits)} < run net ${money(input.runNet)} — mappings may omit net pay`,
      expected: money(input.runNet),
      actual: money(input.journalCredits),
    });
  }

  const blockerCount = checks.filter((c) => !c.ok && c.severity === "blocker").length;
  const warningCount = checks.filter((c) => !c.ok && c.severity === "warning").length;
  const overallOk = blockerCount === 0;

  return { checks, overallOk, blockerCount, warningCount };
}
