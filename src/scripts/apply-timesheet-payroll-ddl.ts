import postgres from "postgres";

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

async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const connectionString = normalizeDatabaseUrl(raw);
  const isNeon = /\.neon\.tech/i.test(connectionString);
  const client = postgres(connectionString, {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: isNeon ? 60 : 30,
    ...(isNeon ? { ssl: "require" as const } : {}),
  });

  try {
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "timesheet_exports" (
        "id" serial PRIMARY KEY NOT NULL,
        "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "export_type" text NOT NULL DEFAULT 'PAYROLL',
        "status" text NOT NULL DEFAULT 'COMPLETED',
        "date_range_start" date NOT NULL,
        "date_range_end" date NOT NULL,
        "format" text NOT NULL,
        "filters" jsonb,
        "snapshot" jsonb NOT NULL,
        "entry_count" integer NOT NULL DEFAULT 0,
        "total_hours" numeric(10,2) NOT NULL DEFAULT '0',
        "file_url" text,
        "note" text,
        "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_timesheet_exports_org_type_created"
        ON "timesheet_exports"("org_id","export_type","created_at");
    `);

    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "timesheet_settings" (
        "id" serial PRIMARY KEY NOT NULL,
        "org_id" text NOT NULL UNIQUE REFERENCES "organizations"("id") ON DELETE CASCADE,
        "work_week_start" integer NOT NULL DEFAULT 1,
        "required_fields" jsonb,
        "rounding_rule" text NOT NULL DEFAULT 'NONE',
        "max_hours_per_day" numeric(4,2) NOT NULL DEFAULT '24',
        "allow_overlapping_entries" boolean NOT NULL DEFAULT true,
        "allow_backdated_entries" boolean NOT NULL DEFAULT true,
        "backdate_limit_days" integer,
        "approval_mode" text NOT NULL DEFAULT 'MANAGER',
        "client_approval_enabled" boolean NOT NULL DEFAULT false,
        "lock_after_approval" boolean NOT NULL DEFAULT true,
        "lock_after_invoice" boolean NOT NULL DEFAULT true,
        "reminder_rules" jsonb,
        "pay_period" text NOT NULL DEFAULT 'MONTHLY',
        "overtime_daily_hours" numeric(4,2) NOT NULL DEFAULT '8',
        "overtime_weekly_hours" numeric(5,2) NOT NULL DEFAULT '40',
        "include_non_billable" boolean NOT NULL DEFAULT true,
        "payroll_mapping" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    await client.unsafe(`
      ALTER TABLE "timesheets"
        ADD COLUMN IF NOT EXISTS "payroll_status" text NOT NULL DEFAULT 'UNPROCESSED',
        ADD COLUMN IF NOT EXISTS "payroll_export_id" integer REFERENCES "timesheet_exports"("id") ON DELETE SET NULL;
    `);

    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_timesheets_org_payroll"
        ON "timesheets"("org_id","payroll_status","date");
    `);

    process.stdout.write("DDL applied successfully.\n");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`apply-timesheet-payroll-ddl failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
