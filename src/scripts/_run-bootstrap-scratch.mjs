/**
 * Temporary runner - deletes itself after use.
 * Usage: node src/scripts/_run-bootstrap-scratch.mjs <db-name>
 * Reads DATABASE_URL from .env, patches the pathname, runs db-bootstrap.mjs.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";

const dbName = process.argv[2];
if (!dbName || !dbName.startsWith("scratch_boot_")) {
  process.stderr.write("Usage: node _run-bootstrap-scratch.mjs <scratch_boot_*>\n");
  process.exit(2);
}

// Parse .env manually (dotenv not available as CJS import here; use a simple parser)
const envPath = resolve(process.cwd(), ".env");
const envContent = readFileSync(envPath, "utf8");
let poolerUrl = null;
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^DATABASE_URL=(.+)$/);
  if (m) { poolerUrl = m[1].trim().replace(/^['"]|['"]$/g, ""); break; }
}
if (!poolerUrl) { process.stderr.write("DATABASE_URL not found in .env\n"); process.exit(1); }

const u = new URL(poolerUrl);
u.pathname = "/" + dbName;
const scratchUrl = u.toString();

const env = { ...process.env, DATABASE_URL: scratchUrl, DIRECT_DATABASE_URL: "" };

const start = Date.now();
const child = spawn("node", ["src/scripts/db-bootstrap.mjs"], {
  cwd: process.cwd(),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { process.stdout.write(d); stdout += d; });
child.stderr.on("data", (d) => { process.stderr.write(d); stderr += d; });

child.on("close", (code) => {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`\nWALL_TIME: ${elapsed}s\n`);
  process.exit(code ?? 0);
});
