import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";
import { marketplaceApps } from "../schema";

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

const APPS = [
  {
    slug: "google-calendar",
    name: "Google Calendar",
    description: "Sync team schedules and meetings with Google Calendar",
    category: "Operations",
    pricingType: "free",
    monthlyPrice: 0,
    annualPrice: 0,
    trialDays: 0,
    features: ["Two-way sync", "Meeting creation", "Reminders"],
    sortOrder: 1,
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Send notifications and alerts directly to Slack channels",
    category: "Operations",
    pricingType: "free",
    monthlyPrice: 0,
    annualPrice: 0,
    trialDays: 0,
    features: ["Channel notifications", "DM alerts", "Slash commands"],
    sortOrder: 2,
  },
  {
    slug: "ai-writer",
    name: "AI Writer",
    description: "Generate HR documents, job descriptions, and emails with AI",
    category: "AI",
    pricingType: "paid",
    monthlyPrice: 49900,
    annualPrice: 479040,
    trialDays: 14,
    features: ["Job descriptions", "Offer letters", "Policy drafts"],
    sortOrder: 3,
  },
  {
    slug: "quickbooks",
    name: "QuickBooks",
    description: "Sync invoices and payments with QuickBooks accounting",
    category: "Finance",
    pricingType: "paid",
    monthlyPrice: 99900,
    annualPrice: 958080,
    trialDays: 7,
    features: ["Invoice sync", "Payment tracking", "Tax reports"],
    sortOrder: 4,
  },
  {
    slug: "linkedin-recruiter",
    name: "LinkedIn Recruiter",
    description: "Import candidates and sync job postings with LinkedIn",
    category: "People",
    pricingType: "paid",
    monthlyPrice: 199900,
    annualPrice: 1919040,
    trialDays: 0,
    features: ["Candidate import", "Job posting", "InMail integration"],
    sortOrder: 5,
  },
  {
    slug: "freshdesk",
    name: "Freshdesk",
    description: "Connect your support inbox and sync customer tickets",
    category: "Support",
    pricingType: "free",
    monthlyPrice: 0,
    annualPrice: 0,
    trialDays: 0,
    features: ["Ticket sync", "Status updates", "SLA tracking"],
    sortOrder: 6,
  },
];

async function seedMarketplaceApps(): Promise<void> {
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
    process.stdout.write("Seeding marketplace apps...\n");
    for (const app of APPS) {
      await db.insert(marketplaceApps).values(app).onConflictDoNothing();
    }
    process.stdout.write("Done.\n");
  } finally {
    await client.end({ timeout: 5 });
  }
}

seedMarketplaceApps()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `[seed:marketplace-apps] failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
