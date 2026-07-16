import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";
import { coupons } from "../schema";
import { eq } from "drizzle-orm";

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

const DEMO_COUPONS = [
  { code: "DEMO25", type: "PERCENTAGE" as const, value: "25", maxUses: 100 },
  { code: "DEMO50", type: "PERCENTAGE" as const, value: "50", maxUses: 50 },
  { code: "WELCOME10", type: "PERCENTAGE" as const, value: "10", maxUses: 500 },
];

async function seedDemoCoupons(): Promise<void> {
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
    process.stdout.write("Seeding demo promo coupons...\n");
    for (const coupon of DEMO_COUPONS) {
      const [existing] = await db
        .select({ id: coupons.id })
        .from(coupons)
        .where(eq(coupons.code, coupon.code));
      if (existing) {
        process.stdout.write(`  Skipping ${coupon.code} (already exists)\n`);
        continue;
      }
      await db.insert(coupons).values({
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        maxUses: coupon.maxUses,
        isActive: true,
        applicablePlans: null,
        orgId: null,
      });
      process.stdout.write(`  Inserted ${coupon.code}\n`);
    }
    process.stdout.write("Done.\n");
  } finally {
    await client.end({ timeout: 5 });
  }
}

seedDemoCoupons()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `[seed:demo-coupons] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
