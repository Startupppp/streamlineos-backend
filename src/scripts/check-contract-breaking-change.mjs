#!/usr/bin/env node
/**
 * check-contract-breaking-change.mjs
 *
 * Breaking-change gate for the API contract registry.
 *
 * WHAT IT CHECKS
 * 1. REMOVAL — a published operation that is in the registry but absent from the
 *    current openapi.json is a breaking change unless the registry entry carries:
 *    - a non-null sunsetAt date that is in the past (deprecation window satisfied), AND
 *    - a non-null sunsetEvidence value (dependency proof on file)
 *    Internal operations may be removed freely.
 *
 * 2. PARAMETER NARROWING — a published operation that previously accepted an
 *    optional query/path parameter now marks it required, drops it entirely, or
 *    adds a required parameter that was not in the recorded baseline.
 *    Internal operations may narrow freely.
 *
 *    The baseline lives in each published entry's `knownParameters`, frozen by
 *    generate-api-contract-registry.mjs the first time the operation is
 *    classified. Before ticket 34 the generator never wrote that field, so
 *    `knownParameters ?? []` was empty for all 3,625 entries and this half of
 *    the gate could not fire on real data — its self-test passed only because
 *    the fixtures hand-built a field the generator never produced.
 *
 * FAIL-CLOSED CLASSIFICATION
 * Both checks exempt an entry only when `classification` is exactly "internal".
 * An unrecognised, null or missing classification is treated as published.
 *
 * Architecture decision 12 (root CLAUDE.md §3):
 *   "internal frontend/backend routes, types and schemas may break during this
 *   coordinated refactor. Only published customer/integration contracts require
 *   backward compatibility or explicit versioned deprecation."
 *
 * DEPRECATION WINDOW RULE
 * sunsetAt must be a past ISO date (already elapsed) AND sunsetEvidence must be
 * a non-empty string. If either is missing the gate fails.
 *
 * SELF-TEST (--self-test)
 * Proves:
 *   - A removed published operation without sunset data → gate bites (exit 1)
 *   - A removed published operation WITH past sunsetAt + evidence → gate passes
 *   - A removed internal operation → gate passes (internal may break freely)
 *   - A parameter narrowed on a published route → gate bites
 *   - No removals → gate passes
 *
 * Usage:
 *   node src/scripts/check-contract-breaking-change.mjs [--self-test]
 *   pnpm check:contract-breaking-change
 *   pnpm check:contract-breaking-change:self-test
 *
 * Exit codes:
 *   0 — no breaking changes (or self-test passed)
 *   1 — breaking change detected, or self-test failed
 *   2 — document or registry unreadable
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

function makeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Fail-closed reading of `classification`. Only the exact string "internal" buys
 * an exemption; everything else — "published", a typo, a null, a missing field —
 * is treated as a published contract.
 *
 * The earlier `classification !== "published"` test failed OPEN on a retained
 * entry. A retained entry describes an operation that is no longer in
 * openapi.json, so check-api-contract-registry's completeness pass (which walks
 * the OpenAPI document) never inspects it, and nothing else validated its
 * schema. Editing a published tombstone's classification to "internl" therefore
 * silenced the removal finding with both gates green — the same evasion the
 * generator's retention comment guards against, reached by mutation instead of
 * deletion.
 */
export function isExemptFromBackwardCompatibility(entry) {
  return entry?.classification === "internal";
}

function isDeprecationWindowSatisfied(entry) {
  if (!entry.sunsetAt || !entry.sunsetEvidence) return false;
  const sunset = new Date(entry.sunsetAt);
  if (isNaN(sunset.getTime())) return false;
  return sunset < new Date();
}

export function findBreakingRemovals(document, registry) {
  const liveKeys = new Set();
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) liveKeys.add(makeKey(method, pathTemplate));
    }
  }

  const violations = [];
  for (const [key, entry] of Object.entries(registry.operations ?? {})) {
    if (liveKeys.has(key)) continue;
    if (isExemptFromBackwardCompatibility(entry)) continue;
    if (isDeprecationWindowSatisfied(entry)) continue;
    const unrecognised =
      entry.classification !== "published"
        ? ` [classification ${JSON.stringify(entry.classification ?? null)} is not a recognised value — treated as published, fail-closed]`
        : "";
    violations.push({
      key,
      issue:
        (entry.sunsetAt
          ? `published operation removed without a satisfied deprecation window (sunsetAt=${String(entry.sunsetAt)}, evidence=${entry.sunsetEvidence ? "present" : "MISSING"})`
          : "published operation removed without sunsetAt date or dependency proof") + unrecognised,
    });
  }

  return violations;
}

/**
 * A renamed or deleted outbound webhook event name.
 *
 * A customer subscribes to these names through the webhooks API and reads them
 * out of the `event` field of every delivered body, so renaming one silently
 * breaks somebody else's endpoint. Until ticket 34 nothing in the repository
 * read them: `registry.events` holds OutboxWriter events, which our own relay
 * consumes and which are internal by construction, and `registry.webhooks` was
 * an empty `{}` that the generator never wrote to. Renaming `deal.won` therefore
 * passed every gate.
 *
 * `emittedNames` is scanned from the source, so this bites on a rename whether
 * or not the registry was regenerated afterwards — an entry's own `emittedFrom`
 * would exempt every name it records, which is no check at all.
 *
 * The one exemption is `declaredIn`: a name no literal dispatch site spells out
 * (a dispatcher called with a variable, or an enum of subscribable triggers) is
 * declared by hand in published-contract-terms.json against the file that proves
 * it. Removing that declaration is the deliberate act that retires such a name.
 */
export function findBreakingWebhookRemovals(emittedNames, registry) {
  const live = new Set(emittedNames);
  const violations = [];
  for (const [name, entry] of Object.entries(registry.webhooks ?? {})) {
    if (live.has(name)) continue;
    if (typeof entry?.declaredIn === "string" && entry.declaredIn.length > 0) continue;
    if (isExemptFromBackwardCompatibility(entry)) continue;
    if (isDeprecationWindowSatisfied(entry)) continue;
    violations.push({
      key: `webhook ${name}`,
      issue:
        "published webhook event name is no longer emitted (renamed or deleted) and has no satisfied deprecation window. " +
        "Customers subscribed to this name stop receiving deliveries with no error on their side.",
    });
  }
  return violations;
}

export function findBreakingNarrowings(document, registry) {
  const violations = [];
  const paths = document.paths ?? {};

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;

      const key = makeKey(method, pathTemplate);
      const entry = (registry.operations ?? {})[key];
      if (!entry || isExemptFromBackwardCompatibility(entry)) continue;

      // An absent baseline means nothing was ever recorded, so there is nothing
      // to compare against. An empty ARRAY is a recorded fact — the operation
      // took no parameters — and a required parameter appearing against it is a
      // narrowing. check-api-contract-registry fails a published operation that
      // carries no baseline at all, so absence cannot persist unnoticed.
      if (!Array.isArray(entry.knownParameters)) continue;
      const registryParams = new Map(entry.knownParameters.map((p) => [p.name, p]));

      const currentParams = new Map(
        (operation.parameters ?? [])
          .filter((p) => typeof p === "object" && p !== null && typeof p.name === "string")
          .map((p) => [p.name, p]),
      );

      for (const [name, regParam] of registryParams) {
        const curParam = currentParams.get(name);
        if (!curParam) {
          violations.push({ key, issue: `published operation dropped previously-known parameter "${name}"` });
        } else if (!regParam.required && curParam.required === true) {
          violations.push({ key, issue: `published operation made optional parameter "${name}" required (narrowing)` });
        }
      }

      for (const [name, curParam] of currentParams) {
        if (registryParams.has(name)) continue;
        if (curParam.required !== true) continue;
        violations.push({
          key,
          issue: `published operation added required parameter "${name}" that was not in the recorded baseline (narrowing)`,
        });
      }
    }
  }

  return violations;
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const emptyDoc = { paths: {} };

  const r1 = findBreakingRemovals(emptyDoc, {
    operations: { "GET /old": { classification: "published", sunsetAt: null, sunsetEvidence: null } },
  });
  if (r1.length !== 1)
    fail("published-removal-bites", `expected 1 violation for published removal without sunset, got ${r1.length}`);
  else pass("published-removal-bites — published removal without sunset fails the gate");

  const r2 = findBreakingRemovals(emptyDoc, {
    operations: { "GET /old": { classification: "published", sunsetAt: pastDate, sunsetEvidence: "ticket-123: all consumers migrated" } },
  });
  if (r2.length !== 0)
    fail("published-removal-with-sunset-passes", `expected 0 violations with past sunsetAt, got ${r2.length}`);
  else pass("published-removal-with-sunset-passes — past sunsetAt + evidence allows the removal");

  const r3 = findBreakingRemovals(emptyDoc, {
    operations: { "GET /old": { classification: "published", sunsetAt: futureDate, sunsetEvidence: "ticket-123" } },
  });
  if (r3.length !== 1)
    fail("future-sunsetat-still-fails", `expected 1 violation for future sunsetAt, got ${r3.length}`);
  else pass("future-sunsetat-still-fails — future sunsetAt does not satisfy the window");

  const r4 = findBreakingRemovals(emptyDoc, {
    operations: { "POST /internal/sync": { classification: "internal", sunsetAt: null, sunsetEvidence: null } },
  });
  if (r4.length !== 0)
    fail("internal-removal-passes", `expected 0 violations for internal removal, got ${r4.length}`);
  else pass("internal-removal-passes — internal operations may be removed freely");

  const docWithOp = { paths: { "/projects": { get: { operationId: "P_list", parameters: [{ name: "limit", in: "query", required: false }] } } } };
  const r5 = findBreakingNarrowings(docWithOp, {
    operations: { "GET /projects": { classification: "published", knownParameters: [{ name: "limit", required: false }] } },
  });
  if (r5.length !== 0)
    fail("no-narrowing-passes", `expected 0 violations when param stays optional, got ${r5.length}`);
  else pass("no-narrowing-passes — optional param staying optional produces no violations");

  const docNarrowed = { paths: { "/projects": { get: { operationId: "P_list", parameters: [{ name: "limit", in: "query", required: true }] } } } };
  const r6 = findBreakingNarrowings(docNarrowed, {
    operations: { "GET /projects": { classification: "published", knownParameters: [{ name: "limit", required: false }] } },
  });
  if (r6.length !== 1 || !r6[0].issue.includes("narrowing"))
    fail("narrowing-bites", `expected 1 narrowing violation, got ${JSON.stringify(r6)}`);
  else pass("narrowing-bites — making optional param required is a narrowing violation");

  const docDropped = { paths: { "/projects": { get: { operationId: "P_list", parameters: [] } } } };
  const r7 = findBreakingNarrowings(docDropped, {
    operations: { "GET /projects": { classification: "published", knownParameters: [{ name: "limit", required: false }] } },
  });
  if (r7.length !== 1 || !r7[0].issue.includes("dropped"))
    fail("dropped-param-bites", `expected 1 dropped-param violation, got ${JSON.stringify(r7)}`);
  else pass("dropped-param-bites — dropping a known published parameter is flagged");

  const docInternal = { paths: { "/internal/sync": { post: { operationId: "S_sync", parameters: [] } } } };
  const r8 = findBreakingNarrowings(docInternal, {
    operations: { "POST /internal/sync": { classification: "internal", knownParameters: [{ name: "dryRun", required: false }] } },
  });
  if (r8.length !== 0)
    fail("internal-narrowing-passes", `expected 0 violations for internal narrowing, got ${r8.length}`);
  else pass("internal-narrowing-passes — internal operations may narrow freely");

  // Fail-closed classification. A retained tombstone is invisible to
  // check-api-contract-registry's completeness pass (it walks the OpenAPI
  // document, and a tombstone has no live operation), so if this gate exempted
  // everything that was not literally "published", corrupting the field would
  // silence a real removal with both gates green.
  const corruptions = [
    { label: "typo", classification: "internl" },
    { label: "null", classification: null },
    { label: "absent", classification: undefined },
    { label: "trailing-space", classification: "published " },
    { label: "capitalised", classification: "Internal" },
  ];
  for (const { label, classification } of corruptions) {
    const entry = { xExposure: "public", sunsetAt: null, sunsetEvidence: null };
    if (classification !== undefined) entry.classification = classification;
    const got = findBreakingRemovals(emptyDoc, { operations: { "GET /public/widget": entry } });
    if (got.length !== 1)
      fail(`corrupt-classification-fails-closed(${label})`, `expected 1 violation, got ${got.length}`);
    else pass(`corrupt-classification-fails-closed(${label}) — classification "${String(classification)}" is treated as published`);
  }

  const rNoBaseline = findBreakingNarrowings(
    { paths: { "/public/x": { get: { operationId: "X", parameters: [{ name: "orgId", in: "query", required: true }] } } } },
    { operations: { "GET /public/x": { classification: "published" } } },
  );
  if (rNoBaseline.length !== 0)
    fail("absent-baseline-is-not-compared", `expected 0 violations with no knownParameters, got ${rNoBaseline.length}`);
  else pass("absent-baseline-is-not-compared — an entry with no recorded baseline is left to the registry gate");

  const rAdded = findBreakingNarrowings(
    { paths: { "/public/x": { get: { operationId: "X", parameters: [{ name: "orgId", in: "query", required: true }] } } } },
    { operations: { "GET /public/x": { classification: "published", knownParameters: [] } } },
  );
  if (rAdded.length !== 1 || !rAdded[0].issue.includes("added required parameter"))
    fail("added-required-param-bites", `expected 1 added-required violation, got ${JSON.stringify(rAdded)}`);
  else pass("added-required-param-bites — a new required parameter against a recorded empty baseline is a narrowing");

  const rAddedOptional = findBreakingNarrowings(
    { paths: { "/public/x": { get: { operationId: "X", parameters: [{ name: "cursor", in: "query", required: false }] } } } },
    { operations: { "GET /public/x": { classification: "published", knownParameters: [] } } },
  );
  if (rAddedOptional.length !== 0)
    fail("added-optional-param-passes", `expected 0 violations for a new optional parameter, got ${rAddedOptional.length}`);
  else pass("added-optional-param-passes — widening with an optional parameter is not a breaking change");

  // The renamed-webhook case the whole webhook catalogue exists for.
  // The entries carry emittedFrom, as every scanned entry in the real registry
  // does. Exempting a name because its own entry records where it used to be
  // emitted would exempt every name there is, which is how the first version of
  // this check silently passed a rename.
  const webhookRegistry = {
    webhooks: {
      "deal.won": { classification: "published", version: "1", emittedFrom: ["src/modules/deals/deals.service.ts"], declaredIn: null, sunsetAt: null, sunsetEvidence: null },
      "deal.lost": { classification: "published", version: "1", emittedFrom: ["src/modules/deals/deals.service.ts"], declaredIn: null, sunsetAt: null, sunsetEvidence: null },
    },
  };
  const wStill = findBreakingWebhookRemovals(["deal.won", "deal.lost"], webhookRegistry);
  if (wStill.length !== 0)
    fail("webhook-still-emitted-passes", `expected 0 violations while both names are emitted, got ${wStill.length}`);
  else pass("webhook-still-emitted-passes — an event name still emitted by a dispatcher is not a removal");

  const wRenamed = findBreakingWebhookRemovals(["deal.closed_won", "deal.lost"], webhookRegistry);
  if (wRenamed.length !== 1 || wRenamed[0].key !== "webhook deal.won")
    fail("webhook-rename-bites", `expected renaming deal.won to be flagged, got ${JSON.stringify(wRenamed)}`);
  else pass("webhook-rename-bites — renaming deal.won is a breaking change");

  const wDeprecated = findBreakingWebhookRemovals(["deal.lost"], {
    webhooks: {
      "deal.won": { classification: "published", emittedFrom: ["src/modules/deals/deals.service.ts"], declaredIn: null, sunsetAt: pastDate, sunsetEvidence: "ticket-34: no subscriber uses it" },
      "deal.lost": { classification: "published", emittedFrom: ["src/modules/deals/deals.service.ts"], declaredIn: null, sunsetAt: null, sunsetEvidence: null },
    },
  });
  if (wDeprecated.length !== 0)
    fail("webhook-satisfied-window-passes", `expected 0 violations with a satisfied window, got ${JSON.stringify(wDeprecated)}`);
  else pass("webhook-satisfied-window-passes — a past sunsetAt plus evidence permits retiring an event name");

  const wDeclared = findBreakingWebhookRemovals([], {
    webhooks: { "survey.published": { classification: "published", emittedFrom: [], declaredIn: "src/modules/surveys/dto/survey-automation.schemas.ts" } },
  });
  if (wDeclared.length !== 0)
    fail("webhook-declared-not-scanned-passes", "an event declared in the terms file must not read as removed");
  else pass("webhook-declared-not-scanned-passes — an event the scanner cannot reach stays live via its declaring file");

  const wInternal = findBreakingWebhookRemovals([], {
    webhooks: { "internal.thing": { classification: "internal", emittedFrom: ["src/x.ts"], declaredIn: null } },
  });
  if (wInternal.length !== 0)
    fail("webhook-internal-removal-passes", "an internal event may be removed freely");
  else pass("webhook-internal-removal-passes — an internal event name may be removed freely");

  const wCorrupt = findBreakingWebhookRemovals([], {
    webhooks: { "deal.won": { classification: "internl", emittedFrom: ["src/modules/deals/deals.service.ts"], declaredIn: null, sunsetAt: null, sunsetEvidence: null } },
  });
  if (wCorrupt.length !== 1)
    fail("webhook-corrupt-classification-fails-closed", `expected 1 violation, got ${wCorrupt.length}`);
  else pass("webhook-corrupt-classification-fails-closed — an unrecognised webhook classification is treated as published");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-contract-breaking-change: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}
if (!existsSync(REGISTRY_PATH)) {
  process.stderr.write(`check-contract-breaking-change: registry not found at ${REGISTRY_PATH}\nRun: pnpm registry:generate\n`);
  process.exit(2);
}

let document, registry;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-contract-breaking-change: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-contract-breaking-change: failed to parse registry: ${err.message}\n`);
  process.exit(2);
}

const sourceCache = new Map();
const emittedWebhookEvents = scanWebhookEvents(collectTsFiles(SRC_ROOT), (p) => {
  if (!sourceCache.has(p)) sourceCache.set(p, readFileSync(p, "utf8"));
  return sourceCache.get(p);
}).map((e) => e.name);

const removals = findBreakingRemovals(document, registry);
const narrowings = findBreakingNarrowings(document, registry);
const webhookRemovals = findBreakingWebhookRemovals(emittedWebhookEvents, registry);
const totalViolations = removals.length + narrowings.length + webhookRemovals.length;

const publishedOps = Object.values(registry.operations ?? {}).filter((e) => e.classification === "published").length;
const internalOps = Object.values(registry.operations ?? {}).filter((e) => e.classification === "internal").length;
const publishedWebhooks = Object.values(registry.webhooks ?? {}).filter((e) => e.classification !== "internal").length;

process.stdout.write(
  `check-contract-breaking-change: ${String(publishedOps)} published operations, ${String(internalOps)} internal, ` +
  `${String(publishedWebhooks)} published webhook event names\n`,
);

if (removals.length > 0) {
  process.stderr.write(`\n  BREAKING: ${String(removals.length)} published operation(s) removed without satisfied deprecation window:\n`);
  for (const { key, issue } of removals) {
    process.stderr.write(`    ${key}\n`);
    process.stderr.write(`        ${issue}\n`);
  }
}

if (narrowings.length > 0) {
  process.stderr.write(`\n  BREAKING: ${String(narrowings.length)} published parameter narrowing(s):\n`);
  for (const { key, issue } of narrowings) {
    process.stderr.write(`    ${key}\n`);
    process.stderr.write(`        ${issue}\n`);
  }
}

if (webhookRemovals.length > 0) {
  process.stderr.write(`\n  BREAKING: ${String(webhookRemovals.length)} published webhook event name(s) renamed or removed:\n`);
  for (const { key, issue } of webhookRemovals) {
    process.stderr.write(`    ${key}\n`);
    process.stderr.write(`        ${issue}\n`);
  }
}

if (totalViolations > 0) {
  process.stderr.write(
    `\ncheck-contract-breaking-change: FAIL — ${String(totalViolations)} breaking change(s) detected.\n` +
    `To permit a published removal: declare the deprecation in contracts/published-contract-terms.json,\n` +
    `set sunsetAt (past date) + sunsetEvidence on the entry, and re-run \`pnpm registry:generate\`.\n` +
    `contracts/api-contract-registry.json is generated output and is never hand-edited.\n`,
  );
  process.exit(1);
}

process.stdout.write(`  OK — no breaking changes detected\n`);
process.exit(0);
