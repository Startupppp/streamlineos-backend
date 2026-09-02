/**
 * Temporary interrupt-bootstrap runner.
 * Usage: node src/scripts/_interrupt-bootstrap.mjs <db-name> <kill-after-N-OK>
 * Spawns db-bootstrap.mjs, kills it after N "OK" lines, reports count.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const dbName = process.argv[2];
const killAfter = parseInt(process.argv[3] ?? "0", 10);

if (!dbName || !dbName.startsWith("scratch_boot_") || !killAfter) {
  process.stderr.write("Usage: node _interrupt-bootstrap.mjs <scratch_boot_*> <kill-after-N-OK>\n");
  process.exit(2);
}

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
let okCount = 0;
let lastTag = "";
let killed = false;

const child = spawn("node", ["src/scripts/db-bootstrap.mjs"], {
  cwd: process.cwd(),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (d) => {
  const text = d.toString();
  process.stdout.write(text);
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("OK    [")) {
      okCount++;
      const m = line.match(/\[(.+)\]/);
      if (m) lastTag = m[1];
      if (!killed && okCount >= killAfter) {
        killed = true;
        process.stdout.write(`\n[INTERRUPT] Killing after ${okCount} OK (last: ${lastTag})\n`);
        child.kill("SIGTERM");
      }
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write(d));

child.on("close", (code, signal) => {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(`\n[INTERRUPT_RESULT] ok=${okCount} last_tag=${lastTag} signal=${signal} code=${code} wall=${elapsed}s\n`);
  process.exit(killed ? 0 : (code ?? 0));
});
