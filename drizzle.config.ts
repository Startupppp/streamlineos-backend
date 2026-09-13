import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

export function assertNamedMigrationTarget(
  url: string | undefined,
  allowProduction: string | undefined,
): { allowed: boolean; reason: string } {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((pattern) => url.includes(pattern));
  if (!matched) return { allowed: true, reason: "target is not a known production host" };
  if (allowProduction === "1") return { allowed: true, reason: `production host '${matched}' explicitly allowed` };
  return {
    allowed: false,
    reason: `DATABASE_URL names production host '${matched}'; set ALLOW_PRODUCTION_MIGRATION=1 to proceed deliberately`,
  };
}

const target = process.env.DATABASE_URL ?? process.env.DB;
const verdict = assertNamedMigrationTarget(target, process.env.ALLOW_PRODUCTION_MIGRATION);
if (!verdict.allowed) throw new Error(`[drizzle.config] refusing to resolve a migration target: ${verdict.reason}`);

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: target!,
  },
});
