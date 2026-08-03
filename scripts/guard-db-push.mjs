import { spawnSync } from "node:child_process";

const env = process.env;
const isProd = env.NODE_ENV === "production";
const isCI = env.CI === "true" || env.CI === "1";
const forced = env.ALLOW_DB_PUSH === "1";

if ((isProd || isCI) && !forced) {
  console.error(
    [
      "",
      "✖ db:push is FORBIDDEN outside local development.",
      "  Production/CI schema changes MUST go through `pnpm db:generate` + `pnpm db:migrate`",
      "  (durable, auditable, journal-tracked). `push` bypasses the migration ledger and is the",
      "  documented root cause of the current journal drift (schema-change-plan Wave 0 / CLAUDE.md §19).",
      "  For a deliberate LOCAL push against a dev database, set ALLOW_DB_PUSH=1.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const result = spawnSync("drizzle-kit", ["push", "--config", "drizzle.config.ts"], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
