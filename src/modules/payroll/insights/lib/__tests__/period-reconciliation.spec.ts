import { evaluatePeriodReconciliation } from "../period-reconciliation";

describe("evaluatePeriodReconciliation", () => {
  it("is overall ok when run, balanced journal, and paid match", () => {
    const result = evaluatePeriodReconciliation({
      hasRun: true,
      runStatus: "PAID",
      runNet: "100000",
      hasPayoutBatch: true,
      payoutPaid: "100000",
      payoutPending: "0",
      payoutFailed: "0",
      hasJournal: true,
      journalDebits: "120000",
      journalCredits: "120000",
      journalStatus: "POSTED",
      journalReconStatus: "RECONCILED",
    });
    expect(result.overallOk).toBe(true);
    expect(result.blockerCount).toBe(0);
    expect(result.checks.find((c) => c.key === "run_net_vs_payout_paid")?.ok).toBe(true);
    expect(result.checks.find((c) => c.key === "journal_balanced")?.ok).toBe(true);
  });

  it("blocks when paid total does not match run net after settlement", () => {
    const result = evaluatePeriodReconciliation({
      hasRun: true,
      runStatus: "PAID",
      runNet: "100000",
      hasPayoutBatch: true,
      payoutPaid: "95000",
      payoutPending: "0",
      payoutFailed: "5000",
      hasJournal: true,
      journalDebits: "100000",
      journalCredits: "100000",
      journalStatus: "EXPORTED",
      journalReconStatus: "UNRECONCILED",
    });
    expect(result.overallOk).toBe(false);
    const match = result.checks.find((c) => c.key === "run_net_vs_payout_paid");
    expect(match?.ok).toBe(false);
    expect(match?.severity).toBe("blocker");
  });

  it("warns when payout still in flight", () => {
    const result = evaluatePeriodReconciliation({
      hasRun: true,
      runStatus: "LOCKED",
      runNet: "50000",
      hasPayoutBatch: true,
      payoutPaid: "20000",
      payoutPending: "30000",
      payoutFailed: "0",
      hasJournal: false,
      journalDebits: null,
      journalCredits: null,
      journalStatus: null,
      journalReconStatus: null,
    });
    expect(result.checks.find((c) => c.key === "payout_in_flight")?.ok).toBe(false);
    expect(result.checks.find((c) => c.key === "journal_exists")?.ok).toBe(false);
  });

  it("blocks when journal does not balance", () => {
    const result = evaluatePeriodReconciliation({
      hasRun: true,
      runStatus: "APPROVED",
      runNet: "10",
      hasPayoutBatch: false,
      payoutPaid: "0",
      payoutPending: "0",
      payoutFailed: "0",
      hasJournal: true,
      journalDebits: "100",
      journalCredits: "90",
      journalStatus: "DRAFT",
      journalReconStatus: "UNRECONCILED",
    });
    expect(result.checks.find((c) => c.key === "journal_balanced")?.ok).toBe(false);
    expect(result.blockerCount).toBeGreaterThanOrEqual(1);
  });
});
