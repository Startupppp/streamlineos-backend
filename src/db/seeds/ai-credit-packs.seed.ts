import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";
import { aiCreditPacks } from "../schema";

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

const PACKS = [
  { name: "Starter Pack", credits: 500, bonusCredits: 0, priceInPaise: 49900, sortOrder: 1 },
  { name: "Growth Pack", credits: 2000, bonusCredits: 200, priceInPaise: 149900, sortOrder: 2 },
  { name: "Scale Pack", credits: 5000, bonusCredits: 750, priceInPaise: 299900, sortOrder: 3 },
  { name: "Enterprise Pack", credits: 15000, bonusCredits: 3000, priceInPaise: 699900, sortOrder: 4 },
];

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
    for (const pack of PACKS) {
      await db.insert(aiCreditPacks).values(pack).onConflictDoNothing();
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
