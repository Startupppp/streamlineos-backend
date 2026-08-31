#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const OPENAPI_PATH = join(SCRIPT_DIR, "../../openapi.json");

function findDuplicates(doc) {
  const seen = new Map();
  const duplicates = [];

  const paths = doc.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== "object" || operation === null) continue;
      const { operationId } = operation;
      if (typeof operationId !== "string") continue;
      if (seen.has(operationId)) {
        duplicates.push({ operationId, first: seen.get(operationId), second: `${method.toUpperCase()} ${path}` });
      } else {
        seen.set(operationId, `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return { seen, duplicates };
}

function runSelfTests() {
  const cleanDoc = {
    paths: {
      "/a": { get: { operationId: "AController_list" } },
      "/b": { post: { operationId: "BController_create" } },
    },
  };
  const { duplicates: cleanDups } = findDuplicates(cleanDoc);
  if (cleanDups.length !== 0) {
    process.stderr.write("SELF-TEST FAIL: a clean document was flagged as having duplicates\n");
    process.exit(1);
  }

  const dupeDoc = {
    paths: {
      "/a": { get: { operationId: "ApprovalsController_approve" } },
      "/b": { post: { operationId: "ApprovalsController_approve" } },
    },
  };
  const { duplicates: dupeDups } = findDuplicates(dupeDoc);
  if (dupeDups.length !== 1) {
    process.stderr.write("SELF-TEST FAIL: known duplicate operationId was not detected\n");
    process.exit(1);
  }
  if (dupeDups[0].operationId !== "ApprovalsController_approve") {
    process.stderr.write(`SELF-TEST FAIL: wrong operationId reported: ${dupeDups[0].operationId}\n`);
    process.exit(1);
  }

  const multiDoc = {
    paths: {
      "/a": { get: { operationId: "X_list" }, post: { operationId: "X_create" } },
      "/b": { get: { operationId: "X_list" } },
    },
  };
  const { duplicates: multiDups } = findDuplicates(multiDoc);
  if (multiDups.length !== 1) {
    process.stderr.write("SELF-TEST FAIL: expected exactly one duplicate in multi-method doc\n");
    process.exit(1);
  }

  process.stdout.write("Self-tests passed.\n");
}

runSelfTests();

if (process.argv.includes("--self-test")) process.exit(0);

let doc;
try {
  const raw = readFileSync(OPENAPI_PATH, "utf8");
  doc = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`Cannot read openapi.json at ${OPENAPI_PATH}: ${err.message}\nFailing closed.\n`);
  process.exit(1);
}

const { seen, duplicates } = findDuplicates(doc);
const totalOperations = seen.size + duplicates.length;

process.stdout.write(`check:operation-ids scanning ${totalOperations} operation(s) across ${Object.keys(doc.paths ?? {}).length} path(s).\n`);

if (duplicates.length === 0) {
  process.stdout.write("No duplicate operationIds found. Gate passed.\n");
  process.exit(0);
}

process.stderr.write("\ncheck:operation-ids FAILED — duplicate operationIds detected:\n");
for (const { operationId, first, second } of duplicates) {
  process.stderr.write(`  "${operationId}" is shared by:\n    ${first}\n    ${second}\n`);
}
process.exit(1);
