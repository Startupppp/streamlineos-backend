/**
 * The retention cadence declaration — one source of truth for three consumers.
 *
 * `CronRetentionSchedulerService` runs these in process, `alert-retention-dead-man.mjs`
 * alerts on their heartbeats, and `retention-schedule-parity.spec.ts` asserts that the
 * three agree. Before this existed the sweeps were reachable only as `POST /cron/<job>`
 * and no scheduler in either repository ever sent that request, so every drain was
 * correct and dead.
 */

export interface RetentionJobDeclaration {
  /** Lease, heartbeat and route key. `POST /cron/<jobKey>` is the manual trigger. */
  readonly jobKey: string;
  /** `forEachOrg` sweep name, so a per-tenant failure record joins back to the job. */
  readonly sweepName: string | null;
  readonly leaseSeconds: number;
  readonly intervalMs: number;
  /** Heartbeat age past which the sweep is presumed dead. Allows one missed run plus jitter. */
  readonly maxAgeMs: number;
  readonly label: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** One missed daily run plus two hours of scheduling jitter. */
const DAILY_MAX_AGE_MS = 26 * HOUR_MS;

export const RETENTION_JOBS: readonly RetentionJobDeclaration[] = [
  {
    jobKey: "hr-policy-retention-sweep",
    sweepName: "hr-policy-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "HR policy retention (documents, employees, cases, attendance)",
  },
  {
    jobKey: "helpdesk-retention-sweep",
    sweepName: "helpdesk-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Helpdesk ticket retention (resolved tickets older than 2 years)",
  },
  {
    jobKey: "mail-metadata-retention-sweep",
    sweepName: "mail-metadata-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Mail metadata retention (synced metadata older than 1 year)",
  },
  {
    jobKey: "announcements-retention-sweep",
    sweepName: "announcements-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Announcements retention (expired after grace, aged beyond 2 years)",
  },
  {
    jobKey: "ai-usage-retention-sweep",
    sweepName: "ai-usage-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "AI usage log retention (730-day window, explicit non-dry-run)",
  },
  {
    jobKey: "notifications-retention-sweep",
    sweepName: "notification-retention",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Notification body + record purge (email_outbox, notification_deliveries)",
  },
  {
    jobKey: "notification-outbox-retention-sweep",
    sweepName: "notification-outbox-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Notification outbox retention (30-day terminal state purge)",
  },
  {
    jobKey: "outbox-events-retention-sweep",
    sweepName: null,
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Outbox events retention (outbox_events + inbox_records, 30-day terminal purge)",
  },
  {
    jobKey: "kb-chat-history-purge",
    sweepName: "kb-chat-history-purge",
    leaseSeconds: 600,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "KB chat history purge (per-org chat_history_retention_days)",
  },
  {
    jobKey: "kb-chunk-retention-sweep",
    sweepName: "kb-chunk-retention",
    leaseSeconds: 600,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "KB chunk retention (orphaned chunks whose parent is gone)",
  },
  {
    jobKey: "build-retention-prune",
    sweepName: "prune-webhook-deliveries",
    leaseSeconds: 120,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Build webhook delivery retention (completed attempts older than 90 days)",
  },
  {
    jobKey: "notifications-retention-detach",
    sweepName: null,
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Notification partition maintenance (DETACH CONCURRENTLY + DROP)",
  },
];

export const RETENTION_JOB_KEYS: readonly string[] = RETENTION_JOBS.map((j) => j.jobKey);

export function retentionJob(jobKey: string): RetentionJobDeclaration | undefined {
  return RETENTION_JOBS.find((job) => job.jobKey === jobKey);
}

/** Reverse lookup for the durable per-tenant failure record `forEachOrg` writes. */
export function retentionJobForSweep(sweepName: string): RetentionJobDeclaration | undefined {
  return RETENTION_JOBS.find((job) => job.sweepName === sweepName);
}
