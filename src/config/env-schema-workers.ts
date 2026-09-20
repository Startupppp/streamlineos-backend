import { z } from "zod";
import { emptyToUndefined, optionalEmail, optionalUrl } from "./env-schema-helpers";

export const workerEnvShape = {
    APP_BRAND_NAME: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    BRAND_SUPPORT_EMAIL: optionalEmail,
    NEXT_PUBLIC_SUPPORT_EMAIL: optionalEmail,
    EMAIL_LOGO_PATH: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    CHAT_REPLY_REMINDER_MINUTES: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    NOTIFICATIONS_WORKER_INTERVAL_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    NOTIFICATIONS_INPROCESS_WORKER: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /** In-process payroll job claim/reclaim loop. Defaults on; set false for local/dev. */
    PAYROLL_INPROCESS_WORKER: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /**
     * Turns an undeclared route from a boot-report line into a hard failure.
     * `RouteClassifierGuard` takes it through `APP_CONFIG` rather than reading
     * `process.env` itself, so this enum is the whole contract and not most of
     * it: a misspelled value fails validation at boot instead of falling
     * through the guard's `!== "false"` test to "enforce".
     */
    REQUIRE_ROUTE_CLASSIFICATION: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /**
     * Which e-invoice transport is wired up.
     *
     * `none` is the default and the only honest value until a provider exists:
     * a reportable document is recorded as `pending` and nobody sends it.
     * `mock` exercises the whole submit path against an adapter that invents
     * nothing — it stamps the row `mock_irp` and returns a visibly fake
     * acknowledgement, so a mock filing can never be mistaken for a real one,
     * in a database or in a screenshot.
     *
     * `irp` is ACC-14's live provider and files for real. It is refused at boot
     * unless all five `COMPLIANCE_IRP_*` credentials are set — see the
     * superRefine below — because the failure mode of a half-configured live
     * transport is a deployment that believes its invoices are being filed while
     * every one of them stays `pending`.
     */
    COMPLIANCE_TRANSPORT: z.preprocess(
      emptyToUndefined,
      z.enum(["none", "mock", "irp"]).optional(),
    ),
    /**
     * The live Invoice Registration Portal connection — ACC-14.
     *
     * All optional, and all five needed together. Absent, `LiveIrpAdapter` is
     * not configured, the registry will not resolve it, and the product keeps
     * today's behaviour exactly: a reportable document is recorded `pending` and
     * the submit route answers an honest 409. That default must never change by
     * accident, which is why nothing here has one.
     *
     * `COMPLIANCE_IRP_URL` is the FULL endpoint the GSP documents for
     * registering a document — no path is appended to it, because every GSP
     * mounts it somewhere different and a guessed suffix is a 404 that reads
     * like an outage. The adapter refuses a non-HTTPS URL (except loopback, for
     * its own tests): these credentials would otherwise cross the network in
     * clear text.
     */
    COMPLIANCE_IRP_URL: optionalUrl,
    COMPLIANCE_IRP_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    COMPLIANCE_IRP_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    COMPLIANCE_IRP_USERNAME: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    COMPLIANCE_IRP_PASSWORD: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    /** How long to wait for the portal. Unset uses the adapter's 15s default. */
    COMPLIANCE_IRP_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    HR_EXPORT_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    PAYROLL_EXPORT_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    PAYROLL_JOBS_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    EXPENSE_EXPORT_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    FINANCE_REPORT_EXPORT_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    GDPR_EXPORT_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    KB_CHAT_PURGE_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /** `!== "false"` so unset leaves retention ON. Enum prevents `=0` silently disabling it (same shape as OUTBOX_DISPATCH_ENABLED). */
    RETENTION_SCHEDULER_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
    RBAC_GRANT_RECONCILE_ON_BOOT: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /** Milliseconds between retention passes; unset uses 600000ms. Bound prevents a typo from running at an unintended cadence. */
    RETENTION_SCHEDULER_TICK_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
    AV_SCANNER: z.preprocess(
      emptyToUndefined,
      z.enum(["content", "clamav", "virustotal"]).optional(),
    ),
    CLAMAV_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
    CLAMAV_PORT: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    VIRUSTOTAL_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    OUTBOX_DISPATCH_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /**
     * User ids permitted to run a data subject erasure or export.
     *
     * Comma-separated, and UNSET AUTHORISES NOBODY. The permission key alone
     * cannot express this: `access.service.ts` returns scope "all" for any
     * organisation owner before a grant is consulted, so every tenant owner on
     * the platform holds `compliance:subject-requests:execute` the moment it is
     * catalogued -- and a subject request is cross-tenant by design.
     */
    COMPLIANCE_SUBJECT_REQUEST_OPERATORS: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    OUTBOX_INPROCESS_WORKER: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /** Override default STARTER trial length (days). Defaults to 14 when unset. */
    TRIAL_DAYS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(365).optional(),
    ),
};
