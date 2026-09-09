export interface SystemJobDefinition {
  readonly reason: string;
  readonly ceiling: readonly string[];
}

export const SYSTEM_JOBS = {
  "build.daily-snapshots": {
    reason: "Captures tenant-scoped project aggregates for the authenticated daily scheduler.",
    ceiling: ["build:manage"],
  },
  "payroll.run.finalize-posting": {
    reason:
      "Posts the salary-accrual journal when a payroll run locks. Writes accounting and reads nothing else.",
    ceiling: ["accounting:journal:create", "accounting:journal:post"],
  },
  "payroll.run.payout-posting": {
    reason:
      "Posts the bank-disbursement journal when a payroll run is marked paid.",
    ceiling: ["accounting:journal:create", "accounting:journal:post"],
  },
  "integrations.git.webhook": {
    reason:
      "Moves a ticket when a signature-verified commit or pull request references it. Holds no project membership.",
    ceiling: ["build:tickets:view", "build:tickets:update"],
  },
  "accounting.payables.fx-posting": {
    reason:
      "Posts the realised FX gain or loss when a supplier bill settles at a different rate.",
    ceiling: ["accounting:journal:create", "accounting:journal:post"],
  },
  "finance.payment-run.fx-posting": {
    reason:
      "Posts the realised FX gain or loss for each capture in a supplier payment run.",
    ceiling: ["accounting:journal:create", "accounting:journal:post"],
  },
  "finance.depreciation-run.execute": {
    reason:
      "Runs the scheduled depreciation for a period and posts its journal.",
    ceiling: [
      "accounting:assets:read",
      "accounting:assets:update",
      "accounting:journal:create",
      "accounting:journal:post",
    ],
  },
  "finance.controls.provider-bridge": {
    reason:
      "Records a payment provider's webhook against the ledger, net of its fee.",
    ceiling: ["accounting:journal:create", "accounting:journal:post"],
  },
  "invoices.void-reversal": {
    reason:
      "Reverses the revenue journal when a sent invoice is voided.",
    ceiling: ["accounting:journal:create", "accounting:journal:manage"],
  },
  "invoices.payment.fx-posting": {
    reason:
      "Posts the realised FX gain or loss when a customer invoice settles at a different rate.",
    ceiling: ["accounting:journal:create", "accounting:journal:post"],
  },
} as const satisfies Record<string, SystemJobDefinition>;

export type SystemJobId = keyof typeof SYSTEM_JOBS;

export const SYSTEM_JOB_IDS = Object.keys(SYSTEM_JOBS) as SystemJobId[];

export function systemJobCeiling(jobId: SystemJobId): readonly string[] {
  return SYSTEM_JOBS[jobId].ceiling;
}
