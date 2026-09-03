/**
 * The cadence declaration for every sweep that must run on a timer — one source of
 * truth for three consumers.
 *
 * `CronRetentionSchedulerService` runs these in process, `alert-retention-dead-man.mjs`
 * alerts on their heartbeats, and `retention-schedule-parity.spec.ts` asserts that the
 * three agree. Before this existed the sweeps were reachable only as `POST /cron/<job>`
 * and no scheduler in either repository ever sent that request, so every drain was
 * correct and dead.
 *
 * Most entries are retention drains, which is where the name comes from. It is no
 * longer only that. `ai-reservations-sweep` is a **compensator**, `monthly-plan-grants`
 * is an **allocation customers are owed**, and `trial-expiry` is a **lifecycle
 * transition** — all three were unscheduled, and all three cost money in one direction
 * or the other rather than disk. Anything whose absence has a consequence belongs on
 * this list; the name is now narrower than the contract and renaming it is a follow-up,
 * not a licence to start a second list.
 *
 * A job only joins this list once its own idempotency is established, because the
 * scheduler is not the guard: `CronLeaseService.withLease` runs **without dedup** when
 * Redis is absent or erroring (`cron-lease.service.ts:41,54`), and `isDue()` returns
 * true with no Redis. The lease reduces duplicate runs; only the job's own natural key
 * prevents a duplicate effect. `UNSCHEDULED_BILLING_JOBS` below records the ones that
 * failed that test.
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
    jobKey: "gdpr-export-artifact-retention",
    sweepName: "gdpr-export-retention",
    leaseSeconds: 900,
    intervalMs: HOUR_MS,
    maxAgeMs: 3 * HOUR_MS,
    label: "GDPR subject-export artifact retention (72h expiry, object purge, stale-job reclaim)",
  },
  {
    /*
     * Not retention — the monthly credit allocation paying customers are owed.
     *
     * `processMonthlyPlanGrants` was reachable only as `POST /cron/monthly-plan-grants`,
     * which nothing in either repository sends, so **no organisation had ever received a
     * monthly plan grant from this path**. That is money owed to customers, not disk.
     *
     * Daily rather than monthly on purpose. The grant is idempotent per calendar month at
     * three layers — `getMonthlyGrantedOrgIds` skips an org that already has a PLAN_GRANT
     * this month, `grantPlanCredits` re-checks the `${plan}-monthly-YYYY-MM` reference
     * inside its own transaction, and `uq_ai_credit_txns_plan_grant_ref`
     * (UNIQUE (org_id, reference_id) WHERE type='PLAN_GRANT') refuses a duplicate in the
     * database — so a daily cadence grants once and skips for the rest of the month, and
     * self-heals if the process was down on the 1st. A monthly cadence would make a single
     * missed run cost a customer a month of credits.
     */
    jobKey: "monthly-plan-grants",
    sweepName: "billing-monthly-grants",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Monthly plan credit grants (one PLAN_GRANT per organisation per calendar month)",
  },
  {
    /*
     * Not retention — trial lifecycle, and the opposite direction of the same defect.
     *
     * `processTrialExpiry` was reachable only as `POST /cron/trial-expiry`, which nothing
     * sends, so **no trial had ever ended and no expiry reminder had ever been sent**.
     *
     * Idempotent by construction: the expiry is one conditional UPDATE
     * (`status='TRIAL' AND trial_ends_at < now` -> `EXPIRED` ... RETURNING), so a second
     * run matches no rows and emits no second churn event; the reminders carry
     * `dedupeKey = trial-expiry:<date>:<days>` against
     * `uniq_notification_outbox_dedupe (org_id, dedupe_key)`, so a second run the same day
     * inserts nothing.
     */
    jobKey: "trial-expiry",
    sweepName: "billing-trial-expiry",
    leaseSeconds: 300,
    intervalMs: DAY_MS,
    maxAgeMs: DAILY_MAX_AGE_MS,
    label: "Trial expiry and expiry reminders (TRIAL -> EXPIRED, 7/3/1-day notices)",
  },
  {
    /*
     * Not retention — the compensator for AI credit reservations.
     *
     * `reserve` debits the wallet by the catalogue ceiling up front and writes a
     * RESERVED row expiring in 15 minutes; `settle` refunds the over-estimate. A lost
     * or failed settle therefore leaves the organisation charged the ceiling with no
     * `ai_credit_transactions` row explaining it, and this sweep is the only thing that
     * gives the money back. It was reachable only as `POST /cron/ai-reservations-sweep`,
     * which nothing sent — the README's external contract named five jobs and not this
     * one — so no over-charge had ever been refunded.
     *
     * Cadence is 15 minutes, not daily, because the reservation window is 15 minutes:
     * a daily sweep would leave the balance wrong for most of a day. The lease matches
     * the HTTP route's 120s so an external POST and this scheduler take the same lock.
     */
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

/**
 * Leased `/cron/*` jobs whose key reads like retention work but which are deliberately
 * NOT on this schedule. Each is still reachable only by an external POST that nothing
 * sends, so each is an open finding — not a closed decision — and is listed here so the
 * omission is reviewable rather than an accident of a regex.
 *
 * They sit outside `RETENTION-POLICY.md`'s per-table inventory, so scheduling them is a
 * product decision rather than a mechanical one: `org-purge-worker` performs irreversible
 * organisation deletion, and the other three drain lifecycle state that the policy
 * document has never classified.
 */
/**
 * Leased `/cron/*` billing jobs that are deliberately NOT on the schedule above.
 *
 * All six routes on `CronBillingController` were unscheduled — nothing in either
 * repository sends any of them. Three are now scheduled. These are the ones where being
 * unscheduled is not the biggest problem, and switching them on would ship a worse one.
 * Each entry names the single specific thing that would have to change first, so this is
 * a reviewable decision rather than an omission.
 */
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
    jobKey: "kb-trash-purge",
    reason: "KB trash lifecycle; no entry in RETENTION-POLICY.md's per-table inventory",
  },
  {
    jobKey: "session-revocation-prune",
    reason: "session revocation tombstones; no entry in RETENTION-POLICY.md's per-table inventory",
  },
];

/** Reverse lookup for the durable per-tenant failure record `forEachOrg` writes. */
export function retentionJobForSweep(sweepName: string): RetentionJobDeclaration | undefined {
  return RETENTION_JOBS.find((job) => job.sweepName === sweepName);
}
