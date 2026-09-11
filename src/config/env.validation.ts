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

const AWS_RDS_HOST = /\.rds\.amazonaws\.com$/i;
const DATABASE_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

function parseDatabaseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const databaseUrl = (name: string) =>
  z.string().trim().superRefine((value, context) => {
    const parsed = parseDatabaseUrl(value);
    if (!parsed) {
      context.addIssue({ code: "custom", message: `${name} must be a valid PostgreSQL URL` });
      return;
    }
    if (!DATABASE_PROTOCOLS.has(parsed.protocol))
      context.addIssue({ code: "custom", message: `${name} must use postgres:// or postgresql://` });
    if (!parsed.username)
      context.addIssue({ code: "custom", message: `${name} must include a database username` });
    if (!parsed.hostname)
      context.addIssue({ code: "custom", message: `${name} must include a database hostname` });
    if (!parsed.pathname || parsed.pathname === "/")
      context.addIssue({ code: "custom", message: `${name} must include a database name` });

    if (AWS_RDS_HOST.test(parsed.hostname)) {
      const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
      if (!sslMode || !["require", "verify-ca", "verify-full"].includes(sslMode))
        context.addIssue({
          code: "custom",
          message: `${name} points at AWS RDS/Aurora and must set sslmode=require (or verify-ca/verify-full)`,
        });
    }
  });

const optionalDatabaseUrl = (name: string) =>
  z.preprocess(emptyToUndefined, databaseUrl(name).optional());

function endpointIdentity(url: URL): string {
  const host = url.hostname
    .replace(/-pooler(?=\.)/i, "")
    .replace(/\.cluster-ro-(?=[a-z0-9-]+\.)/i, ".cluster-")
    .toLowerCase();
  return `${host}:${url.port || "5432"}${url.pathname}`;
}

function decodedUsername(url: URL): string {
  try {
    return decodeURIComponent(url.username);
  } catch {
    return url.username;
  }
}

const baseSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(1500),
    DATABASE_URL: databaseUrl("DATABASE_URL"),
    /** The RLS-enforced application role. Falling back to DATABASE_URL bypasses every tenant policy. */
    APP_DATABASE_URL: optionalDatabaseUrl("APP_DATABASE_URL"),
    /** Session-mode connection for migrations and db:verify-rls; only Neon can be derived automatically. */
    DIRECT_DATABASE_URL: optionalDatabaseUrl("DIRECT_DATABASE_URL"),
    /** Setup-only inputs consumed by db:bootstrap-role; runtime traffic uses APP_DATABASE_URL. */
    APP_DB_ROLE: z.preprocess(
      emptyToUndefined,
      z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/i, "APP_DB_ROLE must be a PostgreSQL identifier").optional(),
    ),
    APP_DB_PASSWORD: z.preprocess(
      emptyToUndefined,
      z.string().min(16, "APP_DB_PASSWORD must be at least 16 characters").optional(),
    ),
    APP_DB_SCHEMA: z.preprocess(emptyToUndefined, z.string().trim().optional()),
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
    REQUIRE_ROUTE_CLASSIFICATION: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Comma-separated user ids holding the vendor's platform-only capabilities (global blog administration). Unset means nobody. */
    PLATFORM_ADMIN_USER_IDS: z.preprocess(emptyToUndefined, z.string().optional()),
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
    PLACEMENT_SIGNING_KEY_PREVIOUS_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    ...poolEnvShape,
    BACKEND_JWT_SECRET: z
      .string()
      .min(
        44,
        "BACKEND_JWT_SECRET must be at least 44 characters (256-bit base64)",
      ),
    /** Ed25519 keypair(s) for asymmetric JWT signing. JSON array of {kid, privateKey (JWK), publicKey (JWK)}. */
    AUTH_SIGNING_KEYS: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Shared with the frontend NextAuth instance; used by the backend to verify session-exchange proofs. Must match NEXTAUTH_SECRET in frontend/.env. */
    NEXTAUTH_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
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
    WAITLIST_NOTIFICATION_EMAILS: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    EMAIL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["zeptomail", "resend"]).optional()),
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
    /** Below 100ms the cache factory throws at boot; bound here so the error appears in the aggregated env-validation report. */
    REDIS_COMMAND_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(100).optional()),
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
    /** Guards POST /webhooks/calendar/provider (@Public). Unset = receiver not deployed (it 503s deliveries). Min 32 chars — the only gate on that public endpoint. */
    CALENDAR_PROVIDER_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().min(32, "CALENDAR_PROVIDER_WEBHOOK_SECRET must be at least 32 characters — it is the only check on the public calendar webhook endpoint.").optional()),
    /** "1" re-arms live email under NODE_ENV=test, which is off by default so a suite cannot send real mail. Anything else, including unset, keeps the provider clients null. */
    EMAIL_ALLOW_LIVE_SEND: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).optional()),
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
    /** `!== "false"` so unset leaves retention ON. Enum prevents `=0` silently disabling it (same shape as OUTBOX_DISPATCH_ENABLED). */
    RETENTION_SCHEDULER_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
    /** Milliseconds between retention passes; unset uses 600000ms. Bound prevents a typo from running at an unintended cadence. */
    RETENTION_SCHEDULER_TICK_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
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
    OUTBOX_INPROCESS_WORKER: z.preprocess(
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
    const owner = parseDatabaseUrl(config.DATABASE_URL);
    const app = config.APP_DATABASE_URL ? parseDatabaseUrl(config.APP_DATABASE_URL) : null;
    const direct = config.DIRECT_DATABASE_URL ? parseDatabaseUrl(config.DIRECT_DATABASE_URL) : null;

    if (owner && app) {
      if (owner.username === app.username) {
        context.addIssue({
          code: "custom",
          path: ["APP_DATABASE_URL"],
          message: "APP_DATABASE_URL must use a different database user from DATABASE_URL so RLS cannot be bypassed",
        });
      }
      if (endpointIdentity(owner) !== endpointIdentity(app)) {
        context.addIssue({
          code: "custom",
          path: ["APP_DATABASE_URL"],
          message: "APP_DATABASE_URL must target the same database and port as DATABASE_URL",
        });
      }
      const expectedRole = config.APP_DB_ROLE ?? "streamline_app";
      if (decodedUsername(app) !== expectedRole) {
        context.addIssue({
          code: "custom",
          path: ["APP_DATABASE_URL"],
          message: `APP_DATABASE_URL username must match APP_DB_ROLE (${expectedRole})`,
        });
      }
    }

    const replica = config.DB_REPLICA_URL ? parseDatabaseUrl(config.DB_REPLICA_URL) : null;
    if (app && replica) {
      if (endpointIdentity(app) !== endpointIdentity(replica)) {
        context.addIssue({
          code: "custom",
          path: ["DB_REPLICA_URL"],
          message: "DB_REPLICA_URL must be a reader endpoint for the same database as APP_DATABASE_URL",
        });
      }
      if (app.username !== replica.username) {
        context.addIssue({
          code: "custom",
          path: ["DB_REPLICA_URL"],
          message: "DB_REPLICA_URL must use the same restricted application role as APP_DATABASE_URL",
        });
      }
    }

    if (owner && direct) {
      if (endpointIdentity(owner) !== endpointIdentity(direct) || owner.username !== direct.username) {
        context.addIssue({
          code: "custom",
          path: ["DIRECT_DATABASE_URL"],
          message: "DIRECT_DATABASE_URL must target the same database as DATABASE_URL using the owner user",
        });
      }
    }

    if (config.NODE_ENV !== "production") return;
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

    if (owner && AWS_RDS_HOST.test(owner.hostname) && !owner.password)
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must include the RDS password; IAM-only authentication is not supported by this runtime",
      });

    if (app && AWS_RDS_HOST.test(app.hostname) && !app.password)
      context.addIssue({
        code: "custom",
        path: ["APP_DATABASE_URL"],
        message: "APP_DATABASE_URL must include the application-role password; IAM-only authentication is not supported by this runtime",
      });
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
