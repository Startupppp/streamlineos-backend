import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const baseUrl = process.env.DATABASE_URL || "";

// Replace only the DATABASE NAME segment in the URL path
// URL format: postgres://user:pass@host/dbname?params
const scratchUrl = baseUrl.replace(/\/neondb(\?|$)/, "/scratch_boot_a$1");

// Safety: parse pathname to verify we're pointing at scratch_boot_a
const urlObj = new URL(scratchUrl);
const dbName = urlObj.pathname.slice(1).split("?")[0];
if (dbName !== "scratch_boot_a") {
  console.error(`SAFETY: DB is '${dbName}', expected scratch_boot_a. Aborting.`);
  process.exit(1);
}
if (scratchUrl.includes("cell2")) {
  console.error("SAFETY: URL contains 'cell2'. Aborting.");
  process.exit(1);
}

console.log(`Target DB: ${urlObj.host}/${dbName}`);

const sql = postgres(scratchUrl, {
  prepare: false,
  max: 1,
  onnotice: () => {},
  connect_timeout: 20,
  idle_timeout: 30,
});

const migrations = [
  "0943_ar02_build_composite_fks.sql",
  "0944_ar02_build_composite_fks.sql",
  "0945_ar02_build_composite_fks.sql",
  "0946_ar02_build_composite_fks.sql",
  "0947_ar02_build_composite_fks.sql",
  "0948_ar02_drop_build_single_fks.sql",
];

let overallFail = 0;

for (const fname of migrations) {
  const path = resolve(process.cwd(), "migrations", fname);
  const raw = readFileSync(path, "utf8");

  // Split on statement-breakpoints; filter comment-only and empty blocks
  const stmts = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => {
      const stripped = s.replace(/--[^\n]*/g, "").trim();
      return stripped.length > 0;
    });

  console.log(`\nApplying ${fname} (${stmts.length} statements)...`);
  let ok = 0;
  let fail = 0;

  for (const stmt of stmts) {
    try {
      await sql.unsafe(stmt);
      ok++;
    } catch (e) {
      const msg = e.message ?? String(e);
      if (
        msg.includes("already exists") ||
        msg.includes("does not exist") ||
        msg.includes("duplicate_constraint")
      ) {
        ok++;
      } else {
        console.error(`  FAIL: ${msg.slice(0, 300)}`);
        console.error(`  Stmt: ${stmt.slice(0, 200)}`);
        fail++;
        overallFail++;
        if (fail >= 5) {
          console.error("  5 failures in this migration — stopping this file.");
          break;
        }
      }
    }
  }

  console.log(`  ${fname}: ${ok} ok, ${fail} failed`);
  if (fail > 0) {
    console.error(`STOPPING after failures in ${fname}.`);
    break;
  }
}

await sql.end();
process.exit(overallFail > 0 ? 1 : 0);
