import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { asRecord } from "../common/openapi/zod-operation-contracts";
import { OPENAPI_ARTIFACT_PATH, generateOpenApiJson } from "./generate-openapi";

interface Difference {
  kind: "added" | "removed" | "changed";
  pointer: string;
}

function operationIndex(json: string): Map<string, string> {
  const parsed: unknown = JSON.parse(json);
  const index = new Map<string, string>();
  if (typeof parsed !== "object" || parsed === null) return index;
  const paths: unknown = Reflect.get(parsed, "paths");
  if (typeof paths !== "object" || paths === null) return index;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      index.set(`${method.toUpperCase()} ${path}`, JSON.stringify(operation));
    }
  }
  return index;
}

export function diffArtifacts(committed: string, generated: string): Difference[] {
  const before = operationIndex(committed);
  const after = operationIndex(generated);
  const differences: Difference[] = [];

  for (const [pointer, shape] of after) {
    const previous = before.get(pointer);
    if (previous === undefined) differences.push({ kind: "added", pointer });
    else if (previous !== shape) differences.push({ kind: "changed", pointer });
  }
  for (const pointer of before.keys()) {
    if (!after.has(pointer)) differences.push({ kind: "removed", pointer });
  }

  return differences.sort((left, right) => left.pointer.localeCompare(right.pointer));
}

function selfTest(): void {
  const base = {
    paths: {
      "/timesheets/entries": {
        get: { operationId: "TimesheetsController_list" },
        post: { operationId: "TimesheetsController_create" },
      },
    },
  };
  const committed = JSON.stringify(base);

  const parsed1 = asRecord(JSON.parse(committed));
  if (!parsed1) {
    process.stderr.write("self-test: committed is not a JSON object\n");
    process.exit(1);
  }
  const paths1 = asRecord(parsed1["paths"]);
  if (!paths1) {
    process.stderr.write("self-test: committed.paths is not an object\n");
    process.exit(1);
  }
  const entry1 = asRecord(paths1["/timesheets/entries"]);
  if (!entry1) {
    process.stderr.write("self-test: committed path entry is not an object\n");
    process.exit(1);
  }
  entry1["post"] = { operationId: "TimesheetsController_createEntry" };
  paths1["/timesheets/entries"] = entry1;
  parsed1["paths"] = paths1;
  const renamedField = JSON.stringify(parsed1);

  const parsed2 = asRecord(JSON.parse(committed));
  if (!parsed2) {
    process.stderr.write("self-test: committed is not a JSON object\n");
    process.exit(1);
  }
  const paths2 = asRecord(parsed2["paths"]);
  if (!paths2) {
    process.stderr.write("self-test: committed.paths is not an object\n");
    process.exit(1);
  }
  delete paths2["/timesheets/entries"];
  parsed2["paths"] = paths2;
  const removedRoute = JSON.stringify(parsed2);

  const parsed3 = asRecord(JSON.parse(committed));
  if (!parsed3) {
    process.stderr.write("self-test: committed is not a JSON object\n");
    process.exit(1);
  }
  const paths3 = asRecord(parsed3["paths"]);
  if (!paths3) {
    process.stderr.write("self-test: committed.paths is not an object\n");
    process.exit(1);
  }
  paths3["/timesheets/entries/:entryId/submit"] = {
    post: { operationId: "TimesheetsController_submit" },
  };
  parsed3["paths"] = paths3;
  const addedRoute = JSON.stringify(parsed3);

  const cases: Array<[string, string, Difference["kind"]]> = [
    ["a changed operation", renamedField, "changed"],
    ["a removed route", removedRoute, "removed"],
    ["an added route", addedRoute, "added"],
  ];

  const failures: string[] = [];
  for (const [label, generated, expected] of cases) {
    const differences = diffArtifacts(committed, generated);
    if (!differences.some((difference) => difference.kind === expected))
      failures.push(`${label}: expected a "${expected}" difference, got ${JSON.stringify(differences)}`);
  }

  if (diffArtifacts(committed, committed).length !== 0)
    failures.push("an identical artifact reported a difference");

  if (failures.length > 0) {
    process.stderr.write(`self-test FAILED\n${failures.join("\n")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    "self-test passed — the staleness check detects a changed operation, a removed route and an added route, and reports nothing for an identical artifact\n",
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  if (!existsSync(OPENAPI_ARTIFACT_PATH)) {
    process.stderr.write(
      `openapi.json is missing at ${OPENAPI_ARTIFACT_PATH}. Run: pnpm openapi:generate\n`,
    );
    process.exit(1);
  }

  const committed = readFileSync(OPENAPI_ARTIFACT_PATH, "utf8");
  const generated = await generateOpenApiJson();

  if (generated.unconvertible.length > 0) {
    process.stderr.write(
      `OpenAPI validation contract conversion failed for ${String(generated.unconvertible.length)} schema(s):\n`,
    );
    for (const failure of generated.unconvertible.slice(0, 50))
      process.stderr.write(`  ${failure}\n`);
    if (generated.unconvertible.length > 50)
      process.stderr.write(`  ... and ${String(generated.unconvertible.length - 50)} more\n`);
    process.exit(1);
  }

  if (committed === generated.json) {
    process.stdout.write(
      `openapi.json is current — ${String(generated.operations)} operations, ${String(generated.contractsApplied)} carrying a zod contract\n`,
    );
    return;
  }

  const differences = diffArtifacts(committed, generated.json);
  process.stderr.write("openapi.json is STALE. Run: pnpm openapi:generate\n");
  if (differences.length === 0) {
    process.stderr.write(
      "The operation set is unchanged, so the drift is in components, ordering or formatting.\n",
    );
  } else {
    for (const difference of differences.slice(0, 50))
      process.stderr.write(`  ${difference.kind.padEnd(7)} ${difference.pointer}\n`);
    if (differences.length > 50)
      process.stderr.write(`  ... and ${String(differences.length - 50)} more\n`);
  }
  process.exit(1);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `openapi freshness check failed to run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
