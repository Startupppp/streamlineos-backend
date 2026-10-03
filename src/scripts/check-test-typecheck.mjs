#!/usr/bin/env node
/**
 * Gate: the `test/**` tree is typechecked.
 *
 * THE HOLE THIS CLOSES. `tsconfig.build.json` (what `pnpm typecheck` runs) and
 * `tsconfig.json` (what `pnpm check:spec-typecheck` runs) both `include` only
 * `src/**\/*` and `evals/**\/*`. Nothing in `test/**` was in either program, so
 * no repo gate had ever compiled an e2e or seeded spec. Jest cannot substitute:
 * ts-jest runs with `isolatedModules` and `diagnostics: false`, which transpiles
 * without typechecking, so a spec there could call a method that no longer
 * exists and jest would still report green — which is exactly how a spec stops
 * testing anything without anybody noticing.
 *
 * SCOPE. `tsconfig.test.json` is `tsconfig.json` plus `test/**\/*`; src and
 * evals stay in the program because the specs import them, but errors in those
 * trees are NOT this gate's to fail on — `check:spec-typecheck` already owns
 * them and failing here too would report one regression as two. Any such error
 * is printed under its own heading so nothing is silently swallowed.
 *
 * This is a hard gate, not a ratchet: the measured count in `test/**` at the
 * time it was introduced was 21 errors across 6 files, all of which were fixed,
 * so it starts and must stay at zero. Nothing here is baselined.
 *
 * Usage:
 *   node src/scripts/check-test-typecheck.mjs             # normal gate
 *   node src/scripts/check-test-typecheck.mjs --self-test # proves the gate bites
 *
 * NOTE: the typecheck subprocess is given NODE_OPTIONS=--max-old-space-size=12288.
 *       At 8192 tsc dies with "Ineffective mark-compacts near heap limit", exit 134,
 *       printing zero type errors — a false pass for any caller reading output.
 *       A crashed tsc prints no diagnostics, which greps as "0 errors" — this
 *       script treats a non-zero exit with no parseable diagnostics as a crash
 *       and fails, rather than reporting a clean tree.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const resolvePath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const BACKEND_ROOT = resolvePath("../../");
const TSC = resolvePath("../../node_modules/typescript/bin/tsc");
const PROJECT = "tsconfig.test.json";

/** The tree this gate is responsible for. */
const OWNED_PREFIX = "test/";

/** A diagnostic line, as tsc emits it: `path/to/file.ts(12,7): error TS1234: ...` */
const DIAGNOSTIC = /^([^\s(][^(]*)\((\d+),(\d+)\): error (TS\d+): /;

function runTypecheck(project = PROJECT) {
  return spawnSync(process.execPath, [TSC, "--noEmit", "-p", project], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=12288" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parse(result) {
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const owned = [];
  const foreign = [];

  for (const line of output.split("\n")) {
    const match = DIAGNOSTIC.exec(line);
    if (!match) continue;
    const file = match[1].replace(/\\/g, "/");
    (file.startsWith(OWNED_PREFIX) ? owned : foreign).push(line);
  }

  return { output, owned, foreign };
}

function reportForeign(foreign) {
  if (foreign.length === 0) return;
  const files = new Set(foreign.map((line) => DIAGNOSTIC.exec(line)[1]));
  console.log(
    `\nNOT THIS GATE'S SCOPE — ${String(foreign.length)} error(s) in ${String(files.size)} file(s) ` +
      "outside test/. These belong to `pnpm check:spec-typecheck`, which fails on them:",
  );
  for (const line of foreign) console.log("  " + line);
}

function selfTest() {
  const dir = join(BACKEND_ROOT, ".check-test-typecheck-selftest");
  const fixture = join(dir, "planted.spec.ts");
  const project = join(dir, "tsconfig.selftest.json");

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    fixture,
    'function requires2(a: string, b: string): string { return a + b; }\n' +
      'export const _planted = requires2("only-one-arg");\n',
    "utf8",
  );
  /*
   * The fixture lives outside test/ so a crashed run cannot leave a defect in a
   * tree another agent is working in, and the temporary project rewrites the
   * owned prefix onto it so the real gate logic — not a special case — is what
   * decides. `extends` inherits the real strict compilerOptions.
   *
   * Include covers ONLY the planted spec. The previous include pulled in
   * `../src/**\/*` and `../evals/**\/*` to match the real gate's scope, but those
   * globs are resolved at tsc startup: a concurrent gate (check:spec-typecheck
   * --self-test) plants a file in src/scripts/__tests__/ and then deletes it,
   * so tsc would see TS6053 "File not found" rather than the planted arity error,
   * causing the self-test to report FAIL even though the gate itself is correct.
   * The planted spec is self-contained (no imports from src/ or evals/), so the
   * wider includes added nothing to what the self-test actually asserts.
   */
  writeFileSync(
    project,
    JSON.stringify(
      { extends: "../tsconfig.test.json", include: ["./*.ts"] },
      null,
      2,
    ),
    "utf8",
  );

  let result;
  let parsed;
  try {
    result = runTypecheck(".check-test-typecheck-selftest/tsconfig.selftest.json");
    parsed = parse(result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const planted = [...parsed.owned, ...parsed.foreign].filter((line) =>
    line.includes("planted.spec.ts"),
  );

  if (result.status === 0) {
    console.error(
      "check-test-typecheck --self-test FAIL: the typecheck passed despite a deliberate arity " +
        "error in the planted spec. The gate does not bite.",
    );
    process.exit(1);
  }

  if (planted.length === 0) {
    console.error(
      "check-test-typecheck --self-test FAIL: the typecheck failed but never named the planted " +
        "spec, so the failure was something else and proves nothing.",
    );
    console.error(parsed.output.slice(0, 2000));
    process.exit(1);
  }

  console.log("check-test-typecheck --self-test PASS: the gate caught the planted arity error.");
  for (const line of planted) console.log("  " + line);
  process.exit(0);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const result = runTypecheck();
  const { output, owned, foreign } = parse(result);

  if (result.status !== 0 && owned.length === 0 && foreign.length === 0) {
    console.error(
      `check-test-typecheck: tsc exited ${String(result.status)}` +
        (result.signal ? ` (signal ${result.signal})` : "") +
        " with no parseable diagnostics. That is a CRASH, not a clean tree — an out-of-memory " +
        "tsc prints nothing and greps as zero errors. Not reporting this as a pass.",
    );
    if (output.trim()) console.error(output.slice(0, 4000));
    process.exit(result.status ?? 1);
  }

  if (owned.length > 0) {
    const files = new Set(owned.map((line) => DIAGNOSTIC.exec(line)[1]));
    console.error(
      `check-test-typecheck: ${String(owned.length)} type error(s) in ${String(files.size)} file(s) under test/.`,
    );
    for (const line of owned) console.error("  " + line);
    console.error(
      "\nThe test/ tree is in no other typecheck. ts-jest transpiles it with isolatedModules and " +
        "diagnostics off, so jest stays green over a spec that calls a method which no longer " +
        "exists. Fix the spec — or delete it if what it tested is gone.",
    );
    reportForeign(foreign);
    process.exit(1);
  }

  console.log(
    "check-test-typecheck: test/ typechecks clean under the repo's strict settings " +
      "(tsconfig.test.json). This is a hard gate at zero, not a baseline.",
  );
  reportForeign(foreign);
  process.exit(0);
}
