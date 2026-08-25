import { z } from "zod";
import { poolEnvShape } from "../db/pool.config";

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
    CHAT_FANOUT: z.enum(["in-process", "queued"]).default("in-process"),
    PORT: z.coerce.number().int().positive().default(1500),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    /** The RLS-enforced application role. Falling back to DATABASE_URL bypasses every tenant policy. */
    APP_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
    /** Session-mode connection for migrations and db:verify-rls; only Neon can be derived automatically. */
    DIRECT_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),
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
