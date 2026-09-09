import { z } from "zod";
import { poolEnvShape } from "../db/pool.config";
import { REGION_KEY_PATTERN } from "../common/region/region.config";

const deploymentSecret = z.string().min(32).optional();
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalEmail = z.preprocess(
  emptyToUndefined,
  z.string().trim().email().optional(),
);
const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().url().optional(),
);

const baseSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    RBAC_MIGRATION_MODE: z.enum(["off", "degrade"]).default("off"),
    PORT: z.coerce.number().int().positive().default(1500),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    /** The RLS-enforced application role. Falling back to DATABASE_URL bypasses every tenant policy. */
    APP_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Session-mode connection for migrations and db:verify-rls; only Neon can be derived automatically. */
    DIRECT_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
    /** The region new organisations are placed in; the primary inherits the flat DATABASE_URL and R2_* vars. */
    PRIMARY_REGION: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(REGION_KEY_PATTERN, "PRIMARY_REGION is lowercase letters, digits and dashes")
        .optional(),
    ),
    /** Release identifier stamped onto every error report and span. */
    APP_RELEASE: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Set to "false" to disable RouteClassifierGuard's boot-time and request-time enforcement. */
    REQUIRE_ROUTE_CLASSIFICATION: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    /** Comma-separated regions this deployment serves; each secondary needs its own REGION_<KEY>_APP_DATABASE_URL. */
    REGION_KEYS: z.preprocess(emptyToUndefined, z.string().optional()),
    /** The cell this deployment is. Defaults to `legacy-1`, the pre-cell production deployment. */
    CELL_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    DATABASE_SHARD: z.preprocess(emptyToUndefined, z.string().optional()),
    SEARCH_CLUSTER: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Signs the placement a session carries so a cell verifies it rather than trusting its cache; falls back to BACKEND_JWT_SECRET. */
    PLACEMENT_SIGNING_KEY: z.preprocess(emptyToUndefined, deploymentSecret),
    PLACEMENT_SIGNING_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    PLACEMENT_SIGNING_KEY_PREVIOUS: z.preprocess(emptyToUndefined, deploymentSecret),
    PLACEMENT_SIGNING_KEY_PREVIOUS_ID: z.preprocess(
      emptyToUndefined,
      z.string().optional(),
    ),
    ...poolEnvShape,
    BACKEND_JWT_SECRET: z
      .string()
      .min(
        44,
        "BACKEND_JWT_SECRET must be at least 44 characters (256-bit base64)",
      ),
    /** Optional HMAC key for pseudonymising public-roadmap voter IPs; falls back to BACKEND_JWT_SECRET. */
    VOTE_IP_SALT: z.preprocess(emptyToUndefined, deploymentSecret),
    PORTAL_JWT_SECRET: z
      .string()
      .min(
        44,
        "PORTAL_JWT_SECRET must be at least 44 characters (256-bit base64)",
      ),
    CORS_ORIGINS: z.string().min(1, "CORS_ORIGINS is required"),
    APP_URL: z.string().url("APP_URL must be a valid URL"),
    CRON_SECRET: deploymentSecret,
    INTERNAL_API_SECRET: deploymentSecret,
    CONTACT_NOTIFICATION_EMAIL: optionalEmail,
    WAITLIST_NOTIFICATION_EMAILS: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    EMAIL_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["zeptomail", "resend"]).optional(),
    ),
    ZEPTOMAIL_API_URL: optionalUrl,
    ZEPTOMAIL_TOKEN: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(40, "ZEPTOMAIL_TOKEN looks truncated").optional(),
    ),
    /** Absent, the ZeptoMail webhook rejects every delivery — it fails closed, not open. */
    ZEPTOMAIL_WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    RESEND_WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    /** Below 32 characters the unsubscribe signer refuses to mint a token at all. */
    UNSUBSCRIBE_TOKEN_SECRET: deploymentSecret,
    EMAIL_FROM_ADDRESS: optionalEmail,
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),
    ABLY_API_KEY: z.string().optional(),
    ENCRYPTION_KEY: z
      .string()
      .min(32, "ENCRYPTION_KEY must be at least 32 characters — it protects PII at rest"),
    AI_CONFIRMATION_SECRET: z.string().optional(),
    COMPOSIO_API_KEY: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_OUTLOOK: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_GMAIL: z.string().optional(),
    /**
     * E6 — which sales-channel adapter this deployment runs.
     *
     * Absent or `none` means no adapter is registered and nothing outbound
     * happens: every channel resolves to the manual adapter and a refetch
     * reports `NO_ADAPTER` without opening a socket. `fake` registers the
     * deterministic development adapter, which contacts no marketplace.
     *
     * A real marketplace adapter does not belong here — third-party
     * connectivity goes through Composio in the `integrations` module, and its
     * credentials live on the connected account, never in this file or our
     * database (root CLAUDE.md §5).
     */
    INV_CHANNEL_ADAPTER: z.preprocess(
      emptyToUndefined,
      z.enum(["none", "fake"]).optional(),
    ),
    /**
     * E6 — the HMAC secret an inbound channel webhook is verified against.
     *
     * Deployment configuration rather than a tenant column, because a store's
     * shared secret is a provider credential and §5 keeps those out of our
     * database. Absent means the corresponding channel type refuses every
     * delivery — an unconfigured secret is never "skip verification".
     */
    INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY: z.preprocess(emptyToUndefined, z.string().optional()),
    INV_CHANNEL_WEBHOOK_SECRET_WOOCOMMERCE: z.preprocess(emptyToUndefined, z.string().optional()),
    INV_CHANNEL_WEBHOOK_SECRET_DEFAULT: z.preprocess(emptyToUndefined, z.string().optional()),
    EMAIL_FROM_NAME: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    EMAIL_APP_URL: optionalUrl,
    NOREPLY_EMAIL: optionalEmail,
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    OPENROUTER_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    GOOGLE_GENERATIVE_AI_API_KEY: z.preprocess(
      emptyToUndefined,
      z.string().optional(),
    ),
    AI_LLM_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["openai", "openrouter"]).optional(),
    ),
    AI_CHAT_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["google", "openrouter"]).optional(),
    ),
    AI_FAST_FALLBACK_MODELS: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    AI_STANDARD_FALLBACK_MODELS: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    /** Left unbounded above; the retry policy clamps to 5 rather than failing a boot over it. */
    AI_LLM_MAX_RETRIES: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).optional(),
    ),
    RAZORPAY_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    RAZORPAY_KEY_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    RAZORPAY_WEBHOOK_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().optional(),
    ),
    VAPID_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    VAPID_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_REGION: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_BUCKET_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_KB_BUCKET_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
    R2_ENDPOINT: optionalUrl,
    NEXT_PUBLIC_R2_PUBLIC_URL: optionalUrl,
    R2_KB_PUBLIC_URL: optionalUrl,
    TWILIO_ACCOUNT_SID: z.preprocess(emptyToUndefined, z.string().optional()),
    TWILIO_AUTH_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    TWILIO_FROM_NUMBER: z.preprocess(emptyToUndefined, z.string().optional()),
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
    TURN_URLS: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    TURN_USERNAME: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    TURN_CREDENTIAL: z.preprocess(emptyToUndefined, z.string().trim().optional()),
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
    HR_EXPORT_WORKER_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["true", "false"]).optional(),
    ),
    PAYROLL_EXPORT_WORKER_ENABLED: z.preprocess(
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
    AV_SCANNER: z.preprocess(
      emptyToUndefined,
      z.enum(["clamav", "virustotal"]).optional(),
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
    /** Override default STARTER trial length (days). Defaults to 14 when unset. */
    TRIAL_DAYS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(365).optional(),
    ),
  });

/** The schema's own key list, so a coverage test need not restate it. */
export const CONFIG_VARIABLE_NAMES: string[] = Object.keys(baseSchema.shape);

const schema = baseSchema
  .superRefine((config, context) => {
    if (config.NODE_ENV !== "production") return;
    if (config.RBAC_MIGRATION_MODE === "degrade") {
      context.addIssue({
        code: "custom",
        path: ["RBAC_MIGRATION_MODE"],
        message:
          "RBAC_MIGRATION_MODE=degrade is forbidden in production because missing entitlement tables must fail closed",
      });
    }
    for (const variableName of [
      "CRON_SECRET",
      "INTERNAL_API_SECRET",
      "CONTACT_NOTIFICATION_EMAIL",
    ] as const) {
      if (config[variableName]) continue;
      context.addIssue({
        code: "custom",
        path: [variableName],
        message: `${variableName} is required in production`,
      });
    }

    if (!config.APP_DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["APP_DATABASE_URL"],
        message:
          "APP_DATABASE_URL is required in production — without it the app connects as the database owner, which has BYPASSRLS and silently disables every tenant isolation policy. Provision the role with `pnpm db:bootstrap-role`.",
      });
    }

    if (config.APP_DATABASE_URL === config.DATABASE_URL) {
      context.addIssue({
        code: "custom",
        path: ["APP_DATABASE_URL"],
        message:
          "APP_DATABASE_URL must not equal DATABASE_URL — they are the application role and the owner role, and pointing both at the owner defeats RLS.",
      });
    }

    // INV-27. `fake` answers every marketplace snapshot with a quantity derived
    // from a hash of the SKU. Those numbers are not discarded: they are written
    // to `inv_channel_snapshot_diffs`, served to an operator at
    // `GET /inventory/channels/:id/snapshot-differences`, and — where the
    // channel's policy is ALLOW_ADJUSTMENT — acceptable straight into
    // `inv_stock_transactions`. A boot-time `logger.warn` was the entire
    // safeguard, and a warning in a log nobody is reading is not one. Refusing
    // to start is, and the failure is at boot rather than at the first
    // reconciliation, which is the difference between a deployment that never
    // happens and stock corrected against a number nobody sent.
    if (config.INV_CHANNEL_ADAPTER === "fake") {
      context.addIssue({
        code: "custom",
        path: ["INV_CHANNEL_ADAPTER"],
        message:
          "INV_CHANNEL_ADAPTER=fake is forbidden in production. The fake adapter invents stock quantities from a hash of the SKU, and those quantities are presentable as a marketplace's own count and acceptable into the stock ledger. Use `none` until a real channel integration exists.",
      });
    }
  });

export type AppConfig = z.infer<typeof schema> & { corsOrigins: string[] };

export function validateEnv(
  source: Record<string, unknown> = process.env,
): AppConfig {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[env] Validation failed:\n${issues}`);
  }
  const corsOrigins = result.data.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ...result.data, corsOrigins };
}
