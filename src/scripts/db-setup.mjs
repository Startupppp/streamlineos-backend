import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import postgres from "postgres";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes");
const skipSeeds = args.includes("--skip-seeds");
const skipAppRole = args.includes("--skip-app-role");
const fromStep = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);

if (args.includes("--help")) {
  console.log(`
Provision a database from empty to ready, in order.

  pnpm -C backend db:setup [--yes] [--skip-seeds] [--skip-app-role] [--from=<id>]

  --yes             Skip the confirmation prompt (only shown for a non-empty DB).
  --skip-seeds      Schema, RLS role and permission catalog only; no reference data.
  --skip-app-role   Do not create/repair the NOBYPASSRLS application role.
                    RLS policies still install, but nothing enforces them at runtime.
  --from=<id>       Resume from a step id (see the step list printed on failure).

Every step is idempotent — re-running is safe.
`);
  process.exit(0);
}

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return null;
  const match = fs.readFileSync(envPath, "utf8").match(/^DATABASE_URL\s*=\s*(.+)$/m);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

const STEPS = [
  {
    id: "schema",
    label: "Extensions + migrations (creates every table, and the RLS policies)",
    script: "db:bootstrap",
    required: true,
  },
  {
    id: "app-role",
    label: "Application role (NOBYPASSRLS) + grants — this is what ENFORCES RLS",
    script: "db:bootstrap-role",
    required: true,
    skip: () => skipAppRole,
  },
  {
    id: "permissions",
    label: "Permission catalog sync",
    script: "seed:permissions",
    required: true,
  },
  {
    id: "seed-ai-credits",
    label: "Reference data: AI credit packs",
    script: "seed:ai-credit-packs",
    required: false,
    skip: () => skipSeeds,
  },
  {
    id: "seed-coupons",
    label: "Reference data: coupons",
    script: "seed:demo-coupons",
    required: false,
    skip: () => skipSeeds,
  },
  {
    id: "seed-payroll",
    label: "Reference data: payroll templates",
    script: "seed:payroll-templates",
    required: false,
    skip: () => skipSeeds,
  },
  {
    id: "seed-marketplace",
    label: "Reference data: marketplace apps",
    script: "seed:marketplace-apps",
    required: false,
    skip: () => skipSeeds,
  },
  {
    id: "system-roles",
    label: "System roles per existing org (no-op on an empty database)",
    script: "backfill:system-roles",
    required: true,
  },
  {
    id: "member-roles",
    label: "MEMBER role assignments for existing members (no-op on an empty database)",
    script: "backfill:member-roles",
    scriptArgs: ["--execute"],
    required: true,
  },
  {
    id: "verify-rls",
    label: "Verify RLS is enabled and enforced",
    script: "db:verify-rls",
    required: true,
  },
];

function run(step) {
  const argv = ["run", step.script];
  if (step.scriptArgs) argv.push("--", ...step.scriptArgs);
  const res = spawnSync("pnpm", argv, { stdio: "inherit", shell: true });
  return res.status === 0;
}

async function tableCount(url) {
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    return rows[0]?.n ?? 0;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function main() {
  const url = loadDatabaseUrl();
  if (!url) {
    console.error("DATABASE_URL is not set and no .env was found.");
    process.exit(1);
  }

  let host = "unknown";
  let database = "unknown";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    database = parsed.pathname.replace(/^\//, "");
  } catch {
    // leave defaults
  }

  const existingTables = await tableCount(url);

  console.log(`\nTarget   : ${database} @ ${host}`);
  console.log(`State    : ${existingTables === 0 ? "EMPTY — fresh provision" : `${existingTables} existing table(s) — will bring up to date`}`);
  console.log(`Steps    : ${STEPS.filter((s) => !s.skip?.()).length} of ${STEPS.length}\n`);

  if (existingTables > 0 && !assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`This database is not empty. Continue? (yes/no) `);
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.error("Aborted.");
      process.exit(1);
    }
  }

  let started = !fromStep;
  const done = [];

  for (const step of STEPS) {
    if (!started) {
      if (step.id === fromStep) started = true;
      else {
        console.log(`SKIP  [${step.id}] ${step.label}  (before --from)`);
        continue;
      }
    }
    if (step.skip?.()) {
      console.log(`SKIP  [${step.id}] ${step.label}`);
      continue;
    }

    console.log(`\n${"=".repeat(72)}\nSTEP  [${step.id}] ${step.label}\n${"=".repeat(72)}`);
    const ok = run(step);

    if (!ok) {
      if (step.required) {
        console.error(`\nFAILED at step [${step.id}].`);
        console.error(`Fix the cause, then resume with:\n  pnpm -C backend db:setup --from=${step.id} --yes\n`);
        console.error(`Remaining steps: ${STEPS.slice(STEPS.indexOf(step)).map((s) => s.id).join(" -> ")}`);
        process.exit(1);
      }
      console.warn(`\nWARN  optional step [${step.id}] failed — continuing.`);
      continue;
    }
    done.push(step.id);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`RESULT: SETUP COMPLETE — ${done.length} step(s) succeeded`);
  console.log(`${"=".repeat(72)}`);
  if (skipAppRole) {
    console.log(`\nWARNING: --skip-app-role was used. RLS policies exist but the app will`);
    console.log(`connect as a role that bypasses them. Run db:bootstrap-role before going live.`);
  } else {
    console.log(`\nPoint APP_DATABASE_URL at the application role so the app runs under RLS.`);
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
