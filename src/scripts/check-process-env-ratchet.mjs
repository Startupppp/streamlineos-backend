#!/usr/bin/env node
/**
 * Zero-growth gate for the `process.env` ratchet in `eslint.config.mjs`.
 *
 * The lint rule itself only asks "does this file read `process.env`". It cannot
 * ask the question that matters, which is "did you fix the read, or did you add
 * your filename to the list". Both make the rule pass. This gate closes that:
 * the exemption list may shrink and may not grow.
 *
 * Two lists are counted, and they are not the same kind of thing:
 *
 *  - The PRINCIPLED block holds files where injection is structurally
 *    impossible — a module factory that builds the very container that would
 *    supply APP_CONFIG, a module-level const evaluated before any injector
 *    exists, a reader whose key set is computed at runtime and so cannot be
 *    enumerated in a static schema. These are permanent and each carries its
 *    reason inline.
 *  - The RATCHET block holds files that simply predate the config seam. Every
 *    one is a debt to be paid, and the count is expected to fall.
 *
 * The gate is on the combined total, deliberately: gating them separately would
 * let a file be quietly reclassified from "debt" to "permanent" to dodge the
 * ratchet, which is the same evasion in a different coat.
 *
 * Stale entries are also failures. A listed path that no longer exists exempts
 * nothing, and it hides the fact that the debt was already paid — the count
 * should have gone down and did not.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, "..", "..");
const CONFIG = join(BACKEND, "eslint.config.mjs");

const BASELINE = 62;

async function ratchetedFiles(configPath) {
  const config = (await import(`file://${configPath}`)).default;
  return config
    .filter((block) => block?.rules?.["no-restricted-syntax"] === "off")
    .flatMap((block) => block.files ?? []);
}

function report(lines) {
  for (const line of lines) console.log(line);
}

async function main() {
  const files = await ratchetedFiles(CONFIG);
  const total = files.length;
  const duplicates = files.filter((f, i) => files.indexOf(f) !== i);
  const stale = files.filter((f) => !existsSync(join(BACKEND, f)));

  const failures = [];
  if (total > BASELINE)
    failures.push(
      `ratchet grew: ${total} exempted files, baseline ${BASELINE}. Fix the process.env read instead of adding the file.`,
    );
  if (duplicates.length > 0)
    failures.push(`duplicate entries: ${[...new Set(duplicates)].join(", ")}`);
  if (stale.length > 0)
    failures.push(
      `stale entries (path does not exist, so the exemption is dead and the count should have fallen):\n    ${stale.join("\n    ")}`,
    );

  report([
    `process.env ratchet: ${total} files (baseline ${BASELINE})`,
    total < BASELINE
      ? `  ${BASELINE - total} paid down — lower the baseline in this script to lock it in.`
      : "  at baseline",
  ]);

  if (failures.length > 0) {
    console.error("\ncheck:process-env-ratchet FAILED");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("check:process-env-ratchet passed");
}

async function selfTest() {
  const real = await ratchetedFiles(CONFIG);
  const checks = [];

  checks.push([
    "reads a non-empty list from the real config",
    real.length > 0,
    `resolved ${real.length} entries`,
  ]);

  const source = readFileSync(CONFIG, "utf8");
  checks.push([
    "the config actually carries the rule this gate guards",
    source.includes("no-restricted-syntax"),
    "no-restricted-syntax present in eslint.config.mjs",
  ]);

  checks.push([
    "baseline matches the config, so the gate is neither slack nor already red",
    real.length === BASELINE,
    `config has ${real.length}, baseline is ${BASELINE}`,
  ]);

  const overBaseline = real.length + 1 > BASELINE;
  checks.push([
    "one more entry than the baseline would fail",
    overBaseline,
    `${real.length + 1} > ${BASELINE}`,
  ]);

  const everyPathResolves = real.every((f) => existsSync(join(BACKEND, f)));
  checks.push([
    "every listed path resolves from the backend root, so the existence probe is not vacuously true",
    everyPathResolves,
    "all entries resolve",
  ]);

  checks.push([
    "a fabricated path is detected as stale",
    !existsSync(join(BACKEND, "src/does-not-exist-probe.ts")),
    "probe path correctly absent",
  ]);

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"}  ${name} — ${detail}`);
    if (!ok) failed++;
  }
  if (failed > 0) {
    console.error(`\nself-test FAILED: ${failed} of ${checks.length}`);
    process.exit(1);
  }
  console.log(`\nself-test passed: ${checks.length} checks`);
}

if (process.argv.includes("--self-test")) await selfTest();
else await main();
