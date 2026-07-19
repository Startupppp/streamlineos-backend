import { z } from "zod";

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

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(1500),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    BACKEND_JWT_SECRET: z
      .string()
      .min(
        44,
        "BACKEND_JWT_SECRET must be at least 44 characters (256-bit base64)",
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
    EMAIL_FROM_ADDRESS: optionalEmail,
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),
    ABLY_API_KEY: z.string().optional(),
    ENCRYPTION_KEY: z.string().optional(),
    AI_CONFIRMATION_SECRET: z.string().optional(),
    COMPOSIO_API_KEY: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_OUTLOOK: z.string().optional(),
    COMPOSIO_AUTH_CONFIG_GMAIL: z.string().optional(),
  })
  .superRefine((config, context) => {
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
