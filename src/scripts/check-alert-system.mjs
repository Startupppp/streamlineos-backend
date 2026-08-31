import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALERT_SCRIPTS = [
  "alert-dead-outbox.mjs",
  "alert-dead-delivery.mjs",
  "alert-sig-failures.mjs",
  "alert-tenant-ctx-errors.mjs",
  "alert-p95.mjs",
  "alert-seam-latency.mjs",
  "alert-pool-saturation.mjs",
  "alert-tenant-cost.mjs",
  "alert-queue-age.mjs",
  "alert-dispatch.mjs",
  "alert-cell-recovery.mjs",
];

function runSelfTest(script) {
  return new Promise((resolve) => {
    const proc = spawn("node", [join(__dirname, script), "--self-test"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.stdin.end();
    proc.on("close", (code) => {
      let result = null;
      try {
        const lastLine = out.trim().split("\n").at(-1) ?? "";
        if (lastLine) result = JSON.parse(lastLine);
      } catch {
        void 0;
      }
      resolve({ script, code: code ?? 1, result, err: err.slice(0, 500) });
    });
  });
}

const results = await Promise.all(ALERT_SCRIPTS.map(runSelfTest));

let allPassed = true;
for (const { script, code, result, err } of results) {
  const passed = code === 0 && result !== null && result.pass === true;
  if (!passed) allPassed = false;
  process.stdout.write(
    JSON.stringify({
      script,
      passed,
      code,
      selfTest: result,
      ...(err ? { stderr: err } : {}),
    }) + "\n",
  );
}

process.stdout.write(
  JSON.stringify({ allPassed, checkedScripts: ALERT_SCRIPTS.length }) + "\n",
);

if (!allPassed) {
  process.stderr.write(
    `\ncheck-alert-system: one or more self-tests failed. ` +
      `Fix the failing predicates before relying on these alerts in production.\n`,
  );
}

process.exit(allPassed ? 0 : 1);
