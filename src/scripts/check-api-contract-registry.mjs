#!/usr/bin/env node
/**
 * check-api-contract-registry.mjs
 *
 * Fail-closed API contract registry gate.
 *
 * WHAT IT CHECKS
 * 1. COMPLETENESS — every HTTP operation in the current openapi.json has an
 *    explicit entry in contracts/api-contract-registry.json. An operation absent
 *    from the registry is treated as "published" (strictest class) and the gate
 *    exits non-zero. This is the fail-closed guarantee: a new route requires
 *    explicit classification before the gate passes.
 *
 * 2. SCHEMA VALIDITY — every registry entry carries the required fields with
 *    valid values (classification, xExposure, operationId).
 *
 * 3. DUPLICATE OPERATIONID COLLISION REPORT — operations sharing an operationId
 *    are reported (known defect: 28 ops published another route's contract). The
 *    gate keys on method+path, never on operationId alone. Duplicates are
 *    reported but do not fail the gate — deletion requires caller/dependency proof.
 *
 * 4. STALE ENTRIES — registry entries whose method+path no longer appear in the
 *    current OpenAPI are flagged as stale. They do not fail the gate (the
 *    breaking-change gate handles removals) but are reported for cleanup.
 *
 * FAIL-CLOSED SEMANTICS
 * Unknown operation (in OpenAPI, absent from registry) → treated as "published"
 * → gate exits 1 → human must run `pnpm registry:generate` and commit.
 *
 * SELF-TEST (--self-test)
 * Creates synthetic fixtures to prove:
 *   - An operation in OpenAPI but not in registry → gate exits 1 (bites)
 *   - All operations in registry → gate exits 0 (passes)
 *   - A known-bad fixture (extra op, missing entry) → non-zero exit
 *   - Duplicate operationId detection works
 *
 * Usage:
 *   node src/scripts/check-api-contract-registry.mjs [--self-test]
 *   pnpm check:contract-registry
 *   pnpm check:contract-registry:self-test
 *
 * Exit codes:
 *   0 — all operations classified (or self-test passed)
 *   1 — one or more unclassified operations, or self-test failed
 *   2 — document or registry unreadable, or self-test infrastructure error
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SRC_ROOT, collectTsFiles, scanWebhookEvents } from "./generate-api-contract-registry.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const REGISTRY_PATH = join(BACKEND_ROOT, "contracts", "api-contract-registry.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const VALID_CLASSIFICATIONS = new Set(["internal", "published"]);

function makeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

export function findUnclassifiedOperations(document, registry) {
  const violations = [];
  const registryOps = registry.operations ?? {};
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;

      const key = makeKey(method, pathTemplate);
      const entry = registryOps[key];

      if (!entry) {
        violations.push({ key, issue: "absent from registry — treated as published (fail-closed)" });
      } else if (!VALID_CLASSIFICATIONS.has(entry.classification)) {
        violations.push({ key, issue: `invalid classification "${String(entry.classification)}" — must be "internal" or "published"` });
      }
    }
  }

  return violations;
}

/**
 * Schema validity for EVERY registry entry, live or retained.
 *
 * findUnclassifiedOperations walks the OpenAPI document, so it can only see
 * entries that still have a live operation. A retained entry — the tombstone
 * check-contract-breaking-change reads to detect a removal — has no live
 * operation and was therefore never validated by anything. Corrupting a
 * published tombstone's classification to "internl" silenced the removal
 * finding with every gate green. The generator's retention comment guards
 * against deleting a tombstone; this guards against mutating one.
 */
export function findInvalidEntries(registry) {
  const violations = [];
  for (const [key, entry] of Object.entries(registry.operations ?? {})) {
    if (typeof entry !== "object" || entry === null) {
      violations.push({ key, issue: "registry entry is not an object" });
      continue;
    }
    if (!VALID_CLASSIFICATIONS.has(entry.classification)) {
      violations.push({
        key,
        issue: `invalid classification ${JSON.stringify(entry.classification ?? null)} — must be "internal" or "published"`,
      });
    }
    if (entry.classificationOverride !== undefined && entry.classificationOverride !== null && !VALID_CLASSIFICATIONS.has(entry.classificationOverride)) {
      violations.push({
        key,
        issue: `invalid classificationOverride ${JSON.stringify(entry.classificationOverride)} — must be "internal", "published" or null`,
      });
    }
  }
  return violations;
}

/**
 * Ticket 34's published-contract terms, enforced on exactly the set the registry
 * classifies as published — never on `x-exposure`, which answers "how is this
 * route authorized", not "who committed to it".
 *
 * Every published operation must carry:
 *   - a version, matching the `/v<N>/` segment of its path when it has one, OR a
 *     declared deprecation window with a date
 *   - at least one named consumer
 *   - an idempotency/replay rule
 *   - a frozen parameter baseline for check-contract-breaking-change to compare
 *     against
 */
export function findPublishedContractGaps(registry) {
  const violations = [];
  for (const [key, entry] of Object.entries(registry.operations ?? {})) {
    if (entry?.classification !== "published") continue;
    const pathTemplate = key.slice(key.indexOf(" ") + 1);

    const pathVersion = (pathTemplate.split("/").find((s) => /^v[0-9]+$/.test(s)) ?? "").slice(1) || null;
    const version = typeof entry.version === "string" && entry.version.length > 0 ? entry.version : null;
    const deprecationDate = typeof entry.deprecation?.sunsetAt === "string" ? entry.deprecation.sunsetAt : null;

    if (version === null && deprecationDate === null) {
      violations.push({ key, issue: "published operation has neither a version nor a deprecation window with a date" });
    }
    if (pathVersion !== null && version !== pathVersion) {
      violations.push({
        key,
        issue: `version "${String(entry.version)}" disagrees with the "/v${pathVersion}/" segment in its own path`,
      });
    }
    if (deprecationDate !== null && Number.isNaN(new Date(deprecationDate).getTime())) {
      violations.push({ key, issue: `deprecation.sunsetAt "${deprecationDate}" is not a parseable date` });
    }
    if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
      violations.push({ key, issue: "published operation names no consumer" });
    }
    if (!Array.isArray(entry.knownParameters)) {
      violations.push({ key, issue: "published operation has no recorded parameter baseline (knownParameters)" });
    }
    const idem = entry.idempotency;
    if (typeof idem !== "object" || idem === null || typeof idem.mode !== "string" || typeof idem.replay !== "string" || idem.replay.length === 0) {
      violations.push({
        key,
        issue: "published operation documents no idempotency/replay rule — declare it in contracts/published-contract-terms.json",
      });
    }
  }
  return violations;
}

/**
 * Outbound customer webhook events. `registry.events` holds OutboxWriter events,
 * which our own relay consumes and which are internal by construction. These are
 * the names a customer subscribes to and reads out of the delivered body, so
 * renaming one breaks somebody else's endpoint. Until ticket 34 the registry's
 * `webhooks` object was an empty `{}` the generator never wrote to, so no gate
 * in the repository read them at all.
 */
/**
 * The same fail-closed rule operations get, applied to webhook event names: an
 * event a dispatcher emits today but the registry has never seen is unclassified,
 * and unclassified means published. Scanning the source here rather than trusting
 * the registry's own snapshot is what makes the gate bite on a rename that was
 * never followed by `registry:generate` — which is precisely how `deal.won` could
 * be renamed with every gate green.
 */
export function findUnclassifiedWebhookEvents(emittedNames, registry) {
  const known = new Set(Object.keys(registry.webhooks ?? {}));
  return emittedNames.filter((n) => !known.has(n)).map((name) => ({
    key: `webhook ${name}`,
    issue: "emitted by a dispatcher but absent from the registry — treated as published (fail-closed)",
  }));
}

export function findWebhookContractGaps(registry) {
  const violations = [];
  for (const [name, entry] of Object.entries(registry.webhooks ?? {})) {
    if (typeof entry !== "object" || entry === null) {
      violations.push({ key: `webhook ${name}`, issue: "registry entry is not an object" });
      continue;
    }
    if (!VALID_CLASSIFICATIONS.has(entry.classification)) {
      violations.push({
        key: `webhook ${name}`,
        issue: `invalid classification ${JSON.stringify(entry.classification ?? null)} — must be "internal" or "published"`,
      });
    }
    if (entry.classification === "internal") continue;
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      violations.push({ key: `webhook ${name}`, issue: "published webhook event has no version" });
    }
    if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
      violations.push({ key: `webhook ${name}`, issue: "published webhook event names no consumer" });
    }
  }
  return violations;
}

export function findStaleEntries(document, registry) {
  const registryOps = registry.operations ?? {};
  const paths = document.paths ?? {};
  const liveKeys = new Set();

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) liveKeys.add(makeKey(method, pathTemplate));
    }
  }

  return Object.keys(registryOps).filter((k) => !liveKeys.has(k));
}

export function findDuplicateOperationIds(document) {
  const seen = new Map();
  const duplicates = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const { operationId } = operation;
      if (typeof operationId !== "string") continue;
      const key = makeKey(method, pathTemplate);
      if (seen.has(operationId)) {
        duplicates.push({ operationId, first: seen.get(operationId), second: key });
      } else {
        seen.set(operationId, key);
      }
    }
  }

  return duplicates;
}

export function countByClassification(registry) {
  const ops = registry.operations ?? {};
  let internal = 0;
  let published = 0;
  let invalid = 0;
  for (const entry of Object.values(ops)) {
    if (entry.classification === "internal") internal++;
    else if (entry.classification === "published") published++;
    else invalid++;
  }
  return { internal, published, invalid };
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const makeDoc = (ops) => ({
    paths: Object.fromEntries(
      ops.map(({ path, method, operationId, exposure }) => [
        path,
        { [method]: { operationId, "x-exposure": exposure } },
      ]),
    ),
  });

  const goodOps = [
    { path: "/projects", method: "get", operationId: "ProjectsController_list", exposure: "permissioned" },
    { path: "/auth/login", method: "post", operationId: "AuthController_login", exposure: "public" },
    { path: "/internal/sync", method: "post", operationId: "SyncController_sync", exposure: "in-service" },
  ];

  const goodRegistry = {
    operations: {
      "GET /projects": { classification: "published", xExposure: "permissioned" },
      "POST /auth/login": { classification: "published", xExposure: "public" },
      "POST /internal/sync": { classification: "internal", xExposure: "in-service" },
    },
  };

  const r1 = findUnclassifiedOperations(makeDoc(goodOps), goodRegistry);
  if (r1.length !== 0)
    fail("all-classified-passes", `expected 0 violations, got ${JSON.stringify(r1)}`);
  else pass("all-classified-passes — all ops in registry produce 0 violations");

  const badRegistry = { operations: { "GET /projects": { classification: "published", xExposure: "permissioned" } } };
  const r2 = findUnclassifiedOperations(makeDoc(goodOps), badRegistry);
  if (r2.length !== 2)
    fail("missing-entries-detected", `expected 2 violations for 2 missing ops, got ${r2.length}: ${JSON.stringify(r2)}`);
  else pass("missing-entries-detected — 2 ops absent from registry produce 2 violations");

  const extraOp = { path: "/new/unclassified", method: "get", operationId: "NewController_list", exposure: "permissioned" };
  const r3 = findUnclassifiedOperations(makeDoc([...goodOps, extraOp]), goodRegistry);
  if (r3.length !== 1 || !r3[0].key.includes("/new/unclassified"))
    fail("extra-op-fail-closed", `expected 1 violation for the extra unclassified op, got ${JSON.stringify(r3)}`);
  else pass("extra-op-fail-closed — extra op absent from registry → fail-closed (1 violation)");

  const invalidClassRegistry = { operations: { "GET /projects": { classification: "BOGUS", xExposure: "permissioned" } } };
  const r4 = findUnclassifiedOperations(makeDoc([goodOps[0]]), invalidClassRegistry);
  if (r4.length !== 1 || !r4[0].issue.includes("BOGUS"))
    fail("invalid-classification-flagged", `expected 1 violation for invalid classification, got ${JSON.stringify(r4)}`);
  else pass("invalid-classification-flagged — invalid classification value produces a violation");

  const dupeDoc = {
    paths: {
      "/a": { get: { operationId: "ApprovalsController_approve", "x-exposure": "permissioned" } },
      "/b": { post: { operationId: "ApprovalsController_approve", "x-exposure": "permissioned" } },
    },
  };
  const dups = findDuplicateOperationIds(dupeDoc);
  if (dups.length !== 1 || dups[0].operationId !== "ApprovalsController_approve")
    fail("duplicate-operationid-detected", `expected 1 duplicate, got ${JSON.stringify(dups)}`);
  else pass("duplicate-operationid-detected — duplicate operationId is reported");

  const nodupeDoc = { paths: { "/a": { get: { operationId: "A_list" } }, "/b": { post: { operationId: "B_create" } } } };
  if (findDuplicateOperationIds(nodupeDoc).length !== 0)
    fail("no-duplicate-passes", "clean doc should have 0 duplicates");
  else pass("no-duplicate-passes — unique operationIds produce 0 duplicates");

  const staleRegistry = {
    operations: {
      "GET /projects": { classification: "published" },
      "GET /old-removed": { classification: "published" },
    },
  };
  const staleDoc = makeDoc([goodOps[0]]);
  const stale = findStaleEntries(staleDoc, staleRegistry);
  if (stale.length !== 1 || stale[0] !== "GET /old-removed")
    fail("stale-entries-detected", `expected 1 stale entry, got ${JSON.stringify(stale)}`);
  else pass("stale-entries-detected — registry entry for removed op is flagged as stale");

  const counts = countByClassification({ operations: {
    "GET /a": { classification: "published" },
    "GET /b": { classification: "internal" },
    "GET /c": { classification: "published" },
    "GET /d": { classification: "INVALID" },
  }});
  if (counts.published !== 2 || counts.internal !== 1 || counts.invalid !== 1)
    fail("count-by-classification", `expected 2/1/1, got ${JSON.stringify(counts)}`);
  else pass("count-by-classification — counts by classification are accurate");

  // A retained tombstone has no live operation, so findUnclassifiedOperations
  // (which walks the OpenAPI document) cannot see it. Before ticket 34 nothing
  // validated it, and mutating its classification silenced a real removal.
  for (const bad of ["internl", null, "published ", "Internal"]) {
    const entry = { xExposure: "public", sunsetAt: null, sunsetEvidence: null };
    if (bad !== null) entry.classification = bad;
    const reg = { operations: { "GET /old-removed": entry } };
    const viaCompleteness = findUnclassifiedOperations({ paths: {} }, reg).length;
    const viaEntryScan = findInvalidEntries(reg).length;
    if (viaCompleteness !== 0)
      fail("tombstone-invisible-to-completeness", `expected the completeness pass to see 0, got ${viaCompleteness}`);
    else if (viaEntryScan !== 1)
      fail(`tombstone-classification-validated(${String(bad)})`, `expected 1 violation, got ${viaEntryScan}`);
    else pass(`tombstone-classification-validated(${String(bad)}) — a retained entry's classification is validated even though no live operation exists`);
  }

  if (findInvalidEntries({ operations: { "GET /a": { classification: "published" }, "GET /b": { classification: "internal" } } }).length !== 0)
    fail("valid-entries-pass", "two well-formed entries should produce 0 violations");
  else pass("valid-entries-pass — well-formed entries produce 0 violations");

  if (findInvalidEntries({ operations: { "GET /a": { classification: "internal", classificationOverride: "BOGUS" } } }).length !== 1)
    fail("invalid-override-flagged", "an unrecognised classificationOverride should be flagged");
  else pass("invalid-override-flagged — an unrecognised classificationOverride is a violation");

  const goodPublished = {
    classification: "published",
    version: "1",
    consumers: ["external automation agents"],
    knownParameters: [],
    idempotency: { mode: "safe", key: null, replay: "Safe method." },
    deprecation: null,
  };
  if (findPublishedContractGaps({ operations: { "GET /public/x": goodPublished } }).length !== 0)
    fail("complete-published-entry-passes", "a fully specified published entry should produce 0 gaps");
  else pass("complete-published-entry-passes — a fully specified published entry produces 0 gaps");

  if (findPublishedContractGaps({ operations: { "GET /public/x": { ...goodPublished, idempotency: null } } }).length !== 1)
    fail("missing-idempotency-flagged", "a published entry with no idempotency rule should be flagged");
  else pass("missing-idempotency-flagged — a published operation with no replay rule is a gap");

  if (findPublishedContractGaps({ operations: { "GET /public/x": { ...goodPublished, knownParameters: undefined } } }).length !== 1)
    fail("missing-baseline-flagged", "a published entry with no parameter baseline should be flagged");
  else pass("missing-baseline-flagged — a published operation with no parameter baseline is a gap");

  if (findPublishedContractGaps({ operations: { "GET /public/x": { ...goodPublished, consumers: [] } } }).length !== 1)
    fail("no-consumer-flagged", "a published entry naming no consumer should be flagged");
  else pass("no-consumer-flagged — a published operation naming no consumer is a gap");

  const unversioned = { ...goodPublished, version: "", deprecation: null };
  if (findPublishedContractGaps({ operations: { "GET /public/x": unversioned } }).length !== 1)
    fail("unversioned-without-window-flagged", "an unversioned entry with no deprecation window should be flagged");
  else pass("unversioned-without-window-flagged — no version and no dated deprecation window is a gap");

  const unversionedButDeprecated = { ...unversioned, deprecation: { sunsetAt: "2026-10-25", replacedBy: "/crm/organizations" } };
  if (findPublishedContractGaps({ operations: { "GET /public/x": unversionedButDeprecated } }).length !== 0)
    fail("deprecation-window-satisfies-versioning", "a dated deprecation window should satisfy the versioning requirement");
  else pass("deprecation-window-satisfies-versioning — a dated deprecation window is an accepted alternative to a version");

  const mismatched = { operations: { "GET /agent/v2/projects": { ...goodPublished, version: "1" } } };
  const mismatchGaps = findPublishedContractGaps(mismatched);
  if (mismatchGaps.length !== 1 || !mismatchGaps[0].issue.includes("disagrees"))
    fail("path-version-mismatch-flagged", `expected a version/path disagreement, got ${JSON.stringify(mismatchGaps)}`);
  else pass("path-version-mismatch-flagged — a registry version that disagrees with the path's /vN/ segment is a gap");

  if (findPublishedContractGaps({ operations: { "GET /internal/x": { classification: "internal" } } }).length !== 0)
    fail("internal-entries-exempt-from-terms", "internal entries should not be held to published terms");
  else pass("internal-entries-exempt-from-terms — internal operations are not held to published contract terms");

  const goodWebhook = { classification: "published", version: "1", consumers: ["customer endpoints"] };
  if (findWebhookContractGaps({ webhooks: { "deal.won": goodWebhook } }).length !== 0)
    fail("complete-webhook-passes", "a fully specified webhook event should produce 0 gaps");
  else pass("complete-webhook-passes — a versioned webhook event with a named consumer produces 0 gaps");

  if (findWebhookContractGaps({ webhooks: { "deal.won": { ...goodWebhook, version: "" } } }).length !== 1)
    fail("unversioned-webhook-flagged", "an unversioned published webhook event should be flagged");
  else pass("unversioned-webhook-flagged — an unversioned published webhook event is a gap");

  if (findWebhookContractGaps({ webhooks: { "deal.won": { classification: "wat", version: "1", consumers: ["x"] } } }).length !== 1)
    fail("webhook-classification-validated", "an unrecognised webhook classification should be flagged");
  else pass("webhook-classification-validated — an unrecognised webhook classification is a gap");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-api-contract-registry: openapi.json not found at ${OPENAPI_PATH}\nRun: pnpm openapi:generate\n`);
  process.exit(2);
}
if (!existsSync(REGISTRY_PATH)) {
  process.stderr.write(`check-api-contract-registry: registry not found at ${REGISTRY_PATH}\nRun: pnpm registry:generate\n`);
  process.exit(2);
}

let document, registry;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-api-contract-registry: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-api-contract-registry: failed to parse registry: ${err.message}\n`);
  process.exit(2);
}

const registryOpCount = Object.keys(registry.operations ?? {}).length;
const registryEventCount = Object.keys(registry.events ?? {}).length;
const webhookEntries = Object.entries(registry.webhooks ?? {});
const publishedWebhooks = webhookEntries.filter(([, w]) => w?.classification !== "internal").length;
const { internal, published } = countByClassification(registry);

process.stdout.write(
  `check-api-contract-registry: registry v${String(registry.version ?? "?")} — ` +
  `${String(registryOpCount)} operations (${String(published)} published, ${String(internal)} internal), ` +
  `${String(registryEventCount)} outbox events, ` +
  `${String(webhookEntries.length)} outbound webhook events (${String(publishedWebhooks)} published)\n`,
);

const duplicates = findDuplicateOperationIds(document);
if (duplicates.length > 0) {
  process.stdout.write(`  REPORT: ${String(duplicates.length)} duplicate operationId collision(s) found (reported only — fix requires caller proof):\n`);
  for (const { operationId, first, second } of duplicates.slice(0, 20)) {
    process.stdout.write(`    operationId "${operationId}": ${first} collides with ${second}\n`);
  }
  if (duplicates.length > 20) process.stdout.write(`    ... and ${String(duplicates.length - 20)} more\n`);
}

const stale = findStaleEntries(document, registry);
if (stale.length > 0) {
  process.stdout.write(`  REPORT: ${String(stale.length)} retained entry/entries (operation removed from OpenAPI):\n`);
  for (const k of stale.slice(0, 20)) process.stdout.write(`    ${k}\n`);
  if (stale.length > 20) process.stdout.write(`    ... and ${String(stale.length - 20)} more\n`);
  process.stdout.write(
    `  These are retained on purpose: check-contract-breaking-change detects a removal\n` +
      `  by finding exactly this state. Do not delete them to quieten the report — clear\n` +
      `  each one by satisfying its deprecation window or reclassifying it as internal.\n`,
  );
}

const violations = findUnclassifiedOperations(document, registry);
if (violations.length > 0) {
  process.stderr.write(`\ncheck-api-contract-registry: FAIL — ${String(violations.length)} operation(s) absent from registry (treated as published)\n\n`);
  for (const { key, issue } of violations.slice(0, 50)) {
    process.stderr.write(`  ${key}\n`);
    process.stderr.write(`      ${issue}\n`);
  }
  if (violations.length > 50) process.stderr.write(`  ... and ${String(violations.length - 50)} more\n`);
  process.stderr.write(`\nRun: pnpm registry:generate to classify new operations and commit the result.\n`);
  process.exit(1);
}

const invalid = findInvalidEntries(registry);
if (invalid.length > 0) {
  process.stderr.write(`\ncheck-api-contract-registry: FAIL — ${String(invalid.length)} registry entry/entries carry an invalid classification\n`);
  process.stderr.write(`  (this pass covers RETAINED entries too — they have no live operation, so the completeness pass above never sees them)\n\n`);
  for (const { key, issue } of invalid.slice(0, 50)) {
    process.stderr.write(`  ${key}\n      ${issue}\n`);
  }
  if (invalid.length > 50) process.stderr.write(`  ... and ${String(invalid.length - 50)} more\n`);
  process.exit(1);
}

const gaps = findPublishedContractGaps(registry);
if (gaps.length > 0) {
  process.stderr.write(`\ncheck-api-contract-registry: FAIL — ${String(gaps.length)} published contract term(s) missing\n\n`);
  for (const { key, issue } of gaps.slice(0, 60)) {
    process.stderr.write(`  ${key}\n      ${issue}\n`);
  }
  if (gaps.length > 60) process.stderr.write(`  ... and ${String(gaps.length - 60)} more\n`);
  process.stderr.write(
    `\nDeclare the missing term in contracts/published-contract-terms.json and re-run\n` +
    `  pnpm registry:generate\n` +
    `contracts/api-contract-registry.json is generated output and is never hand-edited.\n`,
  );
  process.exit(1);
}

const sourceCache = new Map();
const emittedWebhookEvents = scanWebhookEvents(collectTsFiles(SRC_ROOT), (p) => {
  if (!sourceCache.has(p)) sourceCache.set(p, readFileSync(p, "utf8"));
  return sourceCache.get(p);
}).map((e) => e.name);

const webhookGaps = [
  ...findUnclassifiedWebhookEvents(emittedWebhookEvents, registry),
  ...findWebhookContractGaps(registry),
];
if (webhookGaps.length > 0) {
  process.stderr.write(`\ncheck-api-contract-registry: FAIL — ${String(webhookGaps.length)} outbound webhook contract gap(s)\n\n`);
  for (const { key, issue } of webhookGaps) process.stderr.write(`  ${key}\n      ${issue}\n`);
  process.stderr.write(`\nRun: pnpm registry:generate to catalogue new webhook event names and commit the result.\n`);
  process.exit(1);
}

const declaredOnlyWebhooks = Object.entries(registry.webhooks ?? {}).filter(
  ([name, w]) => !emittedWebhookEvents.includes(name) && typeof w?.declaredIn === "string" && w.declaredIn.length > 0,
);
if (declaredOnlyWebhooks.length > 0) {
  process.stdout.write(
    `  REPORT: ${String(declaredOnlyWebhooks.length)} webhook event name(s) reached only through a variable dispatch,\n` +
    `  declared by hand in contracts/published-contract-terms.json against the file that proves them:\n`,
  );
  for (const [name, w] of declaredOnlyWebhooks) process.stdout.write(`    ${name}  <- ${w.declaredIn}\n`);
}

const retiredWebhooks = Object.entries(registry.webhooks ?? {}).filter(
  ([name, w]) =>
    !emittedWebhookEvents.includes(name) && !(typeof w?.declaredIn === "string" && w.declaredIn.length > 0),
);
if (retiredWebhooks.length > 0) {
  process.stdout.write(`  REPORT: ${String(retiredWebhooks.length)} retained webhook event(s) no longer emitted by any dispatcher:\n`);
  for (const [name] of retiredWebhooks) process.stdout.write(`    ${name}\n`);
  process.stdout.write(`  check-contract-breaking-change reads exactly this state to detect a rename.\n`);
}

process.stdout.write(`  OK — all ${String(registryOpCount)} operations are classified\n`);
process.stdout.write(`  OK — all ${String(published)} published operations carry a version or dated deprecation window, a named consumer, an idempotency/replay rule and a parameter baseline\n`);
process.stdout.write(`  OK — all ${String(webhookEntries.length)} outbound webhook event names are catalogued and versioned\n`);
process.exit(0);
