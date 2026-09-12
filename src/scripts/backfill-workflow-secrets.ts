import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { encryptSecret, isEncryptedSecret } from "../common/security/secret-encryption.util";

interface PlaintextRow extends Record<string, unknown> {
  id: string;
  encrypted_value: string;
};

async function backfill(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!process.env.ENCRYPTION_KEY)
    throw new Error("ENCRYPTION_KEY is not set — refusing to run backfill");

  const client = postgres(databaseUrl, { prepare: false, max: 1 });
  const db = drizzle(client);

  try {
    const rows = await db.execute<PlaintextRow>(
      sql`SELECT id, encrypted_value FROM workflow_secrets WHERE encrypted_value NOT LIKE 'enc:v1:%'`,
    );

    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      if (isEncryptedSecret(row.encrypted_value)) {
        skipped++;
        continue;
      }
      const ciphertext = encryptSecret(row.encrypted_value);
      await db.execute(
        sql`UPDATE workflow_secrets SET encrypted_value = ${ciphertext}, updated_at = now() WHERE id = ${row.id} AND encrypted_value NOT LIKE 'enc:v1:%'`,
      );
      updated++;
    }

    process.stdout.write(
      `backfill-workflow-secrets: updated=${updated} skipped=${skipped} total=${rows.length}\n`,
    );
  } finally {
    await client.end();
  }
}

backfill().catch((err: unknown) => {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\n");
  process.exit(1);
});
