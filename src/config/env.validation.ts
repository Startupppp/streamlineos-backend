import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(1500),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BACKEND_JWT_SECRET: z
    .string()
    .min(44, "BACKEND_JWT_SECRET must be at least 44 characters (256-bit base64)"),
  CORS_ORIGINS: z.string().default("http://localhost:1000"),
  APP_URL: z.string().url().default("http://localhost:1000"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR: z.string().optional(),
  COMPOSIO_AUTH_CONFIG_OUTLOOK: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & { corsOrigins: string[] };

export function validateEnv(source: Record<string, unknown> = process.env): AppConfig {
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
