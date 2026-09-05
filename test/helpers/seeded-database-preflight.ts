import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { assertSeededProcessIsolation } from "./seeded-process-environment";

const journalSchema = z.object({ entries: z.array(z.object({ when: z.number(), tag: z.string().regex(/^[a-zA-Z0-9_-]+$/) })) });

export async function verifySeededDatabaseHead(env: NodeJS.ProcessEnv, backendRoot: string): Promise<void> {
  assertSeededProcessIsolation(env);
  const journal = journalSchema.parse(JSON.parse(readFileSync(resolve(backendRoot, "migrations/meta/_journal.json"), "utf8")));
  const expected = journal.entries.map((entry) => ({
    when: String(entry.when),
    hash: createHash("sha256").update(readFileSync(resolve(backendRoot, "migrations", `${entry.tag}.sql`))).digest("hex"),
  })).sort((a, b) => Number(a.when) - Number(b.when));
  for (const key of ["DATABASE_URL", "APP_DATABASE_URL"]) {
    const url = env[key];
    if (!url) throw new Error(`[seeded-e2e] missing ${key}`);
    const client = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
    try {
      await client.begin("read only", async (tx) => {
        await tx`SET LOCAL statement_timeout = '15s'`;
        const [identity] = await tx`SELECT current_database() AS database, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
        if (identity?.database !== env.SEEDED_E2E_DATABASE)
          throw new Error(`[seeded-e2e] ${key} resolved to an unexpected database`);
        if (key === "APP_DATABASE_URL" && (identity?.rolsuper !== false || identity?.rolbypassrls !== false))
          throw new Error("[seeded-e2e] application role bypasses tenant isolation");
        if (key === "DATABASE_URL") {
          const ledger = await tx`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
          if (ledger.length !== expected.length || ledger.some((row, index) => row.hash !== expected[index]?.hash || String(row.created_at) !== expected[index]?.when))
            throw new Error(`[seeded-e2e] scratch migration ledger does not match current ${expected.length}-entry journal; bootstrap scratch before running`);
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("[seeded-e2e]")) throw error;
      throw new Error(`[seeded-e2e] read-only ${key} preflight failed; no application was booted`);
    } finally {
      await client.end({ timeout: 5 });
    }
  }
}
