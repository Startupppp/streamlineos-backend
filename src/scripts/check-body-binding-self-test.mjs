/**
 * Bite-proof for check:body-binding.
 *
 * The gate detects @Body() / @Query() parameters whose declared type does NOT
 * originate from the Zod schema in the companion @Validate decorator. It uses
 * the full TypeScript compiler to resolve type declarations.
 *
 * This self-test:
 *   1. Writes a synthetic *.controller.ts file with an UNBOUND @Body() parameter
 *      (hand-written `{ name: string }` instead of `z.infer<typeof schema>`)
 *   2. Runs check-body-binding.mjs against the live tsconfig.build.json (which
 *      includes src/**\/*, so the temp file is in scope)
 *   3. Asserts the gate outputs "UNBOUND" with the temp file name
 *   4. Deletes the temp file (in the finally block)
 *
 * Expected gate output fragment:
 *   UNBOUND  src/scripts/__gate_body_self_test__.controller.ts ...
 *
 * Exits 0 when the bite is confirmed. Exits 1 otherwise.
 */
import { writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(DIR, "..", "..");
const TEMP_CONTROLLER = resolve(DIR, "__gate_body_self_test__.controller.ts");
const TEMP_BASENAME = "__gate_body_self_test__.controller.ts";

// A controller whose @Body() parameter is hand-typed, NOT from z.infer<typeof schema>.
// The gate must classify this slot as UNBOUND.
const TEMP_CONTENT = `
import { Controller, Post, Body } from "@nestjs/common";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";

const gateBodySelfTestSchema = z.object({ name: z.string(), email: z.string() });

@Controller("gate-body-self-test")
export class GateBodySelfTestController {
  @Post()
  @Validate({ body: gateBodySelfTestSchema })
  create(@Body() body: { name: string; email: string }): void {
    void body;
  }
}
`.trimStart();

let wrote = false;

function check(condition, message) {
  if (!condition) throw new Error(`self-test assertion failed: ${message}`);
}

async function main() {
  process.stdout.write("=== check:body-binding self-test ===\n");
  process.stdout.write(`Temp controller: ${TEMP_BASENAME}\n`);
  process.stdout.write("Plants: @Body() typed as hand-written { name: string; email: string } (not z.infer)\n");
  process.stdout.write('Expected detection: gate reports "UNBOUND" for that controller\n\n');
  process.stdout.write("Running TypeScript compiler (this takes 30-120 seconds)...\n");

  await writeFile(TEMP_CONTROLLER, TEMP_CONTENT, "utf8");
  wrote = true;

  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=8192", "src/scripts/check-body-binding.mjs"],
    {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? -1;

  if (result.error) {
    process.stdout.write(`spawnSync error: ${result.error.message}\n`);
    throw new Error(`gate process error: ${result.error.message}`);
  }

  process.stdout.write(`Gate exit code: ${status}\n`);

  // The gate writes per-route details (filename, method) to stderr via console.error,
  // and the UNBOUND count summary to stdout via console.log. Check both.
  const combined = stdout + stderr;
  const hasUnbound = combined.includes("UNBOUND") && combined.includes(TEMP_BASENAME);
  process.stdout.write(`Output contains UNBOUND + temp file name: ${hasUnbound}\n\n`);

  // Show the relevant lines from both streams
  const lines = combined.split("\n").filter(
    (l) => l.includes(TEMP_BASENAME) || l.includes("UNBOUND") || l.includes("slots") || l.includes("unbound"),
  );
  if (lines.length > 0) {
    process.stdout.write("Relevant gate output (stdout+stderr):\n");
    for (const line of lines) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  }

  check(
    hasUnbound,
    `gate did not report UNBOUND for ${TEMP_BASENAME}. combined:\n${combined.slice(0, 2000)}`,
  );

  // The gate must exit non-zero when there are unbound slots
  check(status !== 0, `gate must exit non-zero when UNBOUND slots exist, but exited ${status}`);

  process.stdout.write(`✓ Bite confirmed: gate detected UNBOUND @Body() parameter in ${TEMP_BASENAME}\n`);
}

async function cleanup() {
  if (wrote) {
    await unlink(TEMP_CONTROLLER).catch((err) =>
      process.stderr.write(`cleanup warning: could not delete ${TEMP_CONTROLLER}: ${err?.message}\n`),
    );
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`FAIL: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
