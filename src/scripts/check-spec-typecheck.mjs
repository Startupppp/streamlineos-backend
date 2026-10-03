#!/usr/bin/env node
/**
 * Gate: spec-inclusive TypeScript typecheck.
 *
 * tsconfig.build.json excludes **\/*.spec.ts, so pnpm typecheck never checks
 * spec files. ts-jest uses isolatedModules (transpile-only). This script runs
 * the full tsconfig.json — which includes spec files — and fails on any error.
 *
 * Usage:
 *   node src/scripts/check-spec-typecheck.mjs            # normal gate
 *   node src/scripts/check-spec-typecheck.mjs --self-test # proves the gate bites
 *
 * NOTE: the typecheck subprocess is given NODE_OPTIONS=--max-old-space-size=12288.
 *       At 8192 tsc dies with "Ineffective mark-compacts near heap limit", exit 134,
 *       printing zero type errors — a false pass for any caller reading output.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolvePath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const BACKEND_ROOT = resolvePath("../../");
const TSC = resolvePath("../../node_modules/typescript/bin/tsc");
const FIXTURE = resolvePath("./__tests__/_spec-typecheck-self-test.spec.ts");

const FIXTURE_CONTENT = `
function requires2(a: string, b: string): string { return a + b; }
export const _selfTestBad = requires2("only-one-arg");
`;

function runTypecheck() {
  return spawnSync(
    process.execPath,
    [TSC, "--noEmit", "-p", "tsconfig.json"],
    {
      cwd: BACKEND_ROOT,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=12288" },
      encoding: "utf8",
    },
  );
}

function selfTest() {
  if (existsSync(FIXTURE)) unlinkSync(FIXTURE);
  writeFileSync(FIXTURE, FIXTURE_CONTENT.trimStart(), "utf8");

  let result;
  try {
    result = runTypecheck();
  } finally {
    if (existsSync(FIXTURE)) unlinkSync(FIXTURE);
  }

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const fixtureRelative = "_spec-typecheck-self-test.spec.ts";

  if (result.status === 0) {
    console.error("check-spec-typecheck --self-test FAIL: typecheck passed despite the deliberate arity error in the fixture");
    process.exit(1);
  }

  if (!output.includes(fixtureRelative)) {
    console.error("check-spec-typecheck --self-test FAIL: typecheck failed but did not name the fixture file in its output");
    console.error("Output was:\n" + output.slice(0, 2000));
    process.exit(1);
  }

  const fixtureLines = output.split("\n").filter((l) => l.includes(fixtureRelative));
  console.log("check-spec-typecheck --self-test PASS: gate correctly caught the deliberate arity error.");
  console.log("Fixture errors reported:");
  for (const line of fixtureLines) console.log("  " + line);
  process.exit(0);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const result = runTypecheck();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    process.stderr.write(
      "\ncheck-spec-typecheck: spec-inclusive typecheck failed (tsconfig.json).\n" +
      "NOTE: NODE_OPTIONS=--max-old-space-size=12288 is required for this check.\n",
    );
    process.exit(result.status ?? 1);
  }

  process.stdout.write("check-spec-typecheck: spec-inclusive typecheck passed.\n");
  process.exit(0);
}
