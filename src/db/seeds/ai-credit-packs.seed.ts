import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";
import { aiCreditPacks } from "../schema";
import { DEFAULT_AI_CREDIT_PACKS } from "../../modules/billing/core/ai-credit-packs.constants";

function normalizeDatabaseUrl(url: string): string {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

async function seedAiCreditPacks(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const connectionString = normalizeDatabaseUrl(raw);
  const isNeon = /\.neon\.tech/i.test(connectionString);
  const client = postgres(connectionString, {
    prepare: false,
    max: 5,
    idle_timeout: 20,
    connect_timeout: isNeon ? 60 : 30,
    ...(isNeon ? { ssl: "require" as const } : {}),
  });
  const db = drizzle(client, { schema });
  try {
    process.stdout.write("Seeding AI credit packs...\n");
    await client`CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_credit_packs_name ON ai_credit_packs (name)`;
    for (const pack of DEFAULT_AI_CREDIT_PACKS) {
      await db
        .insert(aiCreditPacks)
        .values({
          name: pack.name,
          credits: pack.credits,
          bonusCredits: pack.bonusCredits,
          priceInPaise: pack.priceInPaise,
          sortOrder: pack.sortOrder,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: aiCreditPacks.name,
          set: {
            credits: pack.credits,
            bonusCredits: pack.bonusCredits,
            priceInPaise: pack.priceInPaise,
            sortOrder: pack.sortOrder,
            isActive: true,
          },
        });
    }
    process.stdout.write("Done.\n");
  } finally {
    await client.end({ timeout: 5 });
  }
}

seedAiCreditPacks()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `[seed:ai-credit-packs] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
