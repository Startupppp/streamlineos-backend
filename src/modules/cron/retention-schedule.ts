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
const DAILY_MAX_AGE_MS = 26 * HOUR_MS;

export const RETENTION_JOBS: readonly RetentionJobDeclaration[] = [
  {
    jobKey: "feedbucket-media-retention-sweep",
    sweepName: "feedbucket-media-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Feedbucket media retention (stored screenshots and attachments purged 30 days after soft delete)",
  },
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
    jobKey: "kb-telemetry-retention-sweep",
    sweepName: "kb-telemetry-retention",
    leaseSeconds: 600,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "KB telemetry retention (kb_events past 365 days, orphaned ingestion checkpoints past 30)",
  },
  {
    jobKey: "kb-trash-purge",
    sweepName: "kb-trash-purge",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "KB trash purge (soft-deleted pages past the org's trash_retention_days; HR-document entries 30 days after their document was removed)",
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
    jobKey: "build-project-retention-purge",
    sweepName: "build-project-retention",
    leaseSeconds: 1800,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Build project retention (closed tickets and attachments purged after each project's configured window past soft delete)",
  },
  {
    jobKey: "gdpr-export-artifact-retention",
    sweepName: "gdpr-export-retention",
    leaseSeconds: 900,
    intervalMs: HOUR_MS,
    maxAgeMs: 3 * HOUR_MS,
    label: "GDPR subject-export artifact retention (72h expiry, object purge, stale-job reclaim)",
  },
  {
    jobKey: "monthly-plan-grants",
    sweepName: "billing-monthly-grants",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Monthly plan credit grants (one PLAN_GRANT per organisation per calendar month)",
  },
  {
    jobKey: "trial-expiry",
    sweepName: "billing-trial-expiry",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Trial expiry and expiry reminders (TRIAL -> EXPIRED, 7/3/1-day notices)",
  },
  {
    jobKey: "period-expiry",
    sweepName: "billing-period-expiry",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Paid subscription period expiry (ACTIVE -> EXPIRED when current_period_end has passed)",
  },
  {
    jobKey: "ai-reservations-sweep",
    sweepName: "sweep:expired-ai-reservations",
    leaseSeconds: 120,
    intervalMs: 15 * 60_000,
    maxAgeMs: HOUR_MS,
    label: "AI credit reservation compensator (expired reservations refunded to the wallet)",
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

export const UNSCHEDULED_BILLING_JOBS: readonly { jobKey: string; reason: string }[] = [
  {
    jobKey: "auto-topup-flush",
    reason:
      "the payment leg does not exist: purchaseCreditsDirectly(orgId, null, packId, true) credits " +
      "the wallet and writes a PURCHASE transaction, and nothing in ai-credits.service.ts calls a " +
      "payment provider — so putting this on a timer issues credit packs for free to every org " +
      "under its auto-top-up threshold. Its double-run protection is actually sound " +
      "(reference `auto-<packId>-<UTC date>` under uq_ai_credit_txns_purchase_ref), so this is not " +
      "an idempotency gap; it is a missing charge. Needs a product decision, not a cadence.",
  },
  {
    jobKey: "ai-jobs-flush",
    reason:
      "it cannot run at all as the application role. AiJobsService.claimBatch is a cross-tenant " +
      "UPDATE ai_jobs with no org_id predicate, issued outside any tenant transaction, and ai_jobs " +
      "carries RLS `org_id = app.current_org_id()`. Running that exact statement as streamline_app " +
      "against a schema-head database raises 42501 'no tenant context' on the first statement, so " +
      "scheduling it would register a job that fails silently forever. releaseStaleLocks has the " +
      "same shape. Move the claim inside forEachOrg / runInNewTenantTransaction first. A second " +
      "defect would then bite on the first successful tick: `crm.stale-pipeline` is enqueued but no " +
      "handler registers that type, and the no-handler branch writes status='DEAD' with " +
      "attempts=maxAttempts while enqueue returns the existing row whatever its status — so the " +
      "first run permanently poisons that idempotency key for every organisation.",
  },
  {
    jobKey: "provider-webhook-redrive",
    reason:
      "it double-counts revenue on an overlapping run. BillingWebhookEffects.apply pushes the " +
      "addon_purchase revenue entry after externalEffectLedger.execute without reading its outcome, " +
      "so an ALREADY_SUCCEEDED grant still emits a second revenue event, and the payment.status === " +
      "'refunded' branch pushes a refund entry with no ledger guard at all. revenue_events has no " +
      "natural key and RevenueAnalyticsService mints a fresh randomUUID per emit, so neither the " +
      "outbox dedupe nor the database can catch it. The credit grant itself is safe " +
      "(uq_ai_credit_txns_purchase_ref plus the effect ledger's token-fenced CAS); only the revenue " +
      "emit is unguarded. Skip the revenue push on ALREADY_SUCCEEDED, or give revenue_events a " +
      "(org_id, payment_id, type) natural key, and then a 5-minute cadence matches REDRIVE_MIN_AGE_MS.",
  },
];

export const UNSCHEDULED_PURGE_JOBS: readonly { jobKey: string; reason: string }[] = [
  {
    jobKey: "org-purge-worker",
    reason:
      "irreversible organisation deletion; enabling it on a timer is an operator decision, not a retention cadence",
  },
  {
    jobKey: "retention-delete-sweep",
    reason:
      "fulfils HR data-subject delete requests; belongs to the GDPR erasure path, not to hr_retention_policies",
  },
  {
    jobKey: "session-revocation-prune",
    reason: "session revocation tombstones; no entry in RETENTION-POLICY.md's per-table inventory",
  },
];

export function retentionJobForSweep(sweepName: string): RetentionJobDeclaration | undefined {
  return RETENTION_JOBS.find((job) => job.sweepName === sweepName);
}
