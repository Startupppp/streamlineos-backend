#!/usr/bin/env node
/**
 * generate-api-contract-registry.mjs
 *
 * Derives the fail-closed API contract registry from:
 *   1. The committed openapi.json (all HTTP operations + exposure class)
 *   2. OutboxWriter.emit() scan (outbox events) — same logic as check-outbox-consumers.mjs
 *
 * Classification rules
 *   x-exposure = "permissioned" | "universal" → internal (first-party frontend only)
 *   x-exposure = "in-service"                 → internal, unless the path is on the
 *                                               published allowlist
 *   x-exposure = "public"                     → internal, unless the path is on the
 *                                               published allowlist
 *   absent or unrecognised                    → published (fail closed)
 *
 * `x-exposure` answers "how is this route authorized", not "who committed to it".
 * Mapping every permissioned route to published made all 3,539 ordinary app routes
 * customer contracts, so the deprecation rule fired on routine internal refactoring
 * and the registry could not distinguish a breaking change from a rename. Approved
 * decision 12 settles it: only published customer/integration contracts require
 * backward compatibility, and a route whose sole consumer is our own Next.js app is
 * internal. PUBLISHED_PATHS is therefore the real committed set — every entry names
 * an external consumer that is not our frontend.
 *
 * The fail-closed default is unchanged and load-bearing in two places: an operation
 * with no recognised exposure is published here, and an operation absent from the
 * registry is treated as published by check-api-contract-registry.mjs.
 *
 * A deliberate human decision that departs from the rule goes in
 * `classificationOverride` with `sunsetEvidence` explaining it; the derived value is
 * otherwise authoritative, so the rule cannot silently drift from the file.
 *
 * If the registry already exists, manually-set fields (owner, version, consumers,
 * sunsetAt, sunsetEvidence, classificationOverride) are preserved for entries that
 * still exist in the OpenAPI document. Entries for operations that no longer exist
 * are RETAINED.
 *
 * Retention is deliberate and load-bearing. check-contract-breaking-change.mjs
 * detects a removal by finding a registry entry with no matching operation in
 * openapi.json. Dropping those entries here would let anyone silence that gate
 * by running the very command the gate's own failure message recommends:
 * delete a published route, see the gate fail, run `registry:generate`, and the
 * evidence of the removal disappears along with the finding. The registry is a
 * ledger of what was ever exposed, not a mirror of what is exposed now.
 *
 * Usage:
 *   node src/scripts/generate-api-contract-registry.mjs
 *   pnpm registry:generate
 *
 * Exit codes:
 *   0 — registry written successfully
 *   1 — error (parse failure, missing openapi.json)
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const REGISTRY_PATH = join(BACKEND_ROOT, "contracts", "api-contract-registry.json");
const SRC_ROOT = resolve(__dirname, "..");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Paths whose consumer is somebody other than our own frontend. Each entry names
 * that consumer, because "externally reachable" and "committed contract" are not
 * the same thing — /cron and /health are reachable and owned by our own
 * infrastructure, so breaking them breaks nobody outside this repository.
 */
const PUBLISHED_PATHS = [
  { prefix: "/agent/v1/", consumer: "external automation agents holding an agent token (AgentTokenGuard)" },
  { prefix: "/public/", consumer: "unauthenticated external users via share links, embedded widgets and emailed forms" },
  { prefix: "/portal/v1/", consumer: "external project clients holding a portal JWT (PortalJwtAuthGuard)" },
  { exact: "/portal/auth/accept-invitation", consumer: "external project clients redeeming a portal invitation" },
  { prefix: "/webhooks/", consumer: "inbound provider webhooks (email, payments, Razorpay)" },
  { exact: "/integrations/git/webhook", consumer: "inbound GitHub/GitLab webhooks" },
  { prefix: "/support/chat/", consumer: "the external support chat widget embedded on customer sites" },
  { prefix: "/support/inbound/", consumer: "inbound email/SMS/WhatsApp provider push" },
  { prefix: "/support/csat/", consumer: "external CSAT links delivered by email" },
  { prefix: "/csat/", consumer: "external CSAT survey respondents" },
  { exact: "/leads/ingest", consumer: "external lead sources holding an API key (ApiKeyGuard)" },
  { exact: "/auth/.well-known/jwks.json", consumer: "external verifiers of our issued JWTs" },
  { prefix: "/notifications/unsubscribe/", consumer: "mail clients and providers following List-Unsubscribe links" },
  { prefix: "/organization/invitations/", consumer: "invitees following an emailed invitation link" },
  { prefix: "/crm/consent/", consumer: "external recipients managing marketing consent" },
  { exact: "/crm/mailboxes/push", consumer: "inbound mail provider push notifications" },
  { prefix: "/blog/", consumer: "the public marketing site and any feed reader" },
  { exact: "/careers", consumer: "the public careers page" },
  { prefix: "/careers/", consumer: "external applicants" },
  { exact: "/platform/contact", consumer: "the public contact form" },
];

export function publishedConsumerFor(pathTemplate) {
  const path = String(pathTemplate);
  for (const entry of PUBLISHED_PATHS) {
    if (entry.exact !== undefined && path === entry.exact) return entry.consumer;
    if (entry.prefix !== undefined && path.startsWith(entry.prefix)) return entry.consumer;
  }
  return null;
}

export function classifyOperation(xExposure, pathTemplate) {
  if (xExposure === "permissioned" || xExposure === "universal") return "internal";
  if (xExposure === "public" || xExposure === "in-service")
    return publishedConsumerFor(pathTemplate) !== null ? "published" : "internal";
  return "published";
}

function makeOperationKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

function collectTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) results.push(full);
  }
  return results;
}

function resolveConstValue(raw, constMap) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed.slice(1, -1);
  return constMap.get(trimmed) ?? null;
}

function scanOutboxEvents() {
  const allFiles = collectTsFiles(SRC_ROOT);
  const constMap = new Map();
  const sourceByFile = new Map();
  const CONST_RE = /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*(["'][^"']+["'])/gm;

  for (const filePath of allFiles) {
    const src = readFileSync(filePath, "utf8");
    sourceByFile.set(filePath, src);
    for (const m of src.matchAll(CONST_RE)) {
      if (!constMap.has(m[1])) constMap.set(m[1], m[2].slice(1, -1));
    }
  }

  const emitted = new Set();
  const consumed = new Set();

  for (const [, src] of sourceByFile) {
    const emitRe = /OutboxWriter\.emit\s*\(/g;
    let match;
    while ((match = emitRe.exec(src)) !== null) {
      const window = src.slice(match.index, match.index + 600);
      const tm = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/.exec(window);
      if (!tm) continue;
      const val = resolveConstValue(tm[1], constMap);
      if (val) emitted.add(val);
    }

    const consumerRe = /\breadonly\s+eventType\s*=\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/g;
    while ((match = consumerRe.exec(src)) !== null) {
      const val = resolveConstValue(match[1], constMap);
      if (val) consumed.add(val);
    }

    const inlineRe = /\bregistry\.register\s*\(/g;
    while ((match = inlineRe.exec(src)) !== null) {
      const window = src.slice(match.index, match.index + 400);
      const tm = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/.exec(window);
      if (!tm) continue;
      const val = resolveConstValue(tm[1], constMap);
      if (val) consumed.add(val);
    }
  }

  return { emitted: [...emitted].sort(), consumed: [...consumed].sort() };
}

if (process.argv.includes("--self-test")) {
  let failed = false;
  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };
  const expect = (label, actual, wanted) => {
    if (actual === wanted) pass(`${label} — ${wanted}`);
    else fail(label, `expected ${wanted}, got ${actual}`);
  };

  expect("permissioned-is-internal", classifyOperation("permissioned", "/build/tickets"), "internal");
  expect("universal-is-internal", classifyOperation("universal", "/me/access"), "internal");
  expect("public-cron-is-internal", classifyOperation("public", "/cron/sweep-outbox"), "internal");
  expect("public-health-is-internal", classifyOperation("public", "/health/ready"), "internal");
  expect("public-login-is-internal", classifyOperation("public", "/auth/magic-link"), "internal");
  expect("public-agent-api-is-published", classifyOperation("public", "/agent/v1/projects"), "published");
  expect("public-widget-is-published", classifyOperation("public", "/public/kb/widget/o1"), "published");
  expect("public-webhook-is-published", classifyOperation("public", "/webhooks/razorpay/o1"), "published");
  expect("in-service-portal-is-published", classifyOperation("in-service", "/portal/v1/projects"), "published");
  expect("in-service-other-is-internal", classifyOperation("in-service", "/module-access/x"), "internal");

  // The fail-closed default. An operation the classifier does not recognise must
  // be treated as a customer contract, never quietly waved through as internal.
  expect("unknown-exposure-fails-closed", classifyOperation("", "/something/new"), "published");
  expect("absent-exposure-fails-closed", classifyOperation(undefined, "/something/new"), "published");

  // Anchoring: a path that merely contains an allowlisted token is not published.
  expect("contains-but-not-prefixed-is-internal", classifyOperation("public", "/internal/public-report"), "internal");
  expect("agent-lookalike-is-internal", classifyOperation("public", "/build/agent/v1/status"), "internal");

  if (publishedConsumerFor("/agent/v1/projects") === null)
    fail("published-path-names-a-consumer", "an allowlisted path must name its external consumer");
  else pass("published-path-names-a-consumer — every allowlisted path records who consumes it");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`generate-api-contract-registry: openapi.json not found at ${OPENAPI_PATH}\nRun: pnpm openapi:generate\n`);
  process.exit(1);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`generate-api-contract-registry: failed to parse openapi.json: ${err.message}\n`);
  process.exit(1);
}

let existing = null;
if (existsSync(REGISTRY_PATH)) {
  try {
    existing = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    process.stderr.write("generate-api-contract-registry: existing registry unreadable — regenerating from scratch\n");
  }
}

const existingOps = existing?.operations ?? {};
const existingEvents = existing?.events ?? {};

const operations = {};
const paths = document.paths ?? {};

for (const [pathTemplate, pathItem] of Object.entries(paths)) {
  if (typeof pathItem !== "object" || pathItem === null) continue;
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(method)) continue;
    if (typeof operation !== "object" || operation === null) continue;

    const key = makeOperationKey(method, pathTemplate);
    const xExposure = String(operation["x-exposure"] ?? "");
    const derived = classifyOperation(xExposure, pathTemplate);
    const prev = existingOps[key];
    const override = prev?.classificationOverride ?? null;
    const publishedConsumer = publishedConsumerFor(pathTemplate);

    operations[key] = {
      classification: override ?? derived,
      classificationOverride: override,
      xExposure,
      operationId: operation.operationId ?? null,
      owner: prev?.owner ?? null,
      version: prev?.version ?? "1",
      consumers:
        prev?.consumers !== undefined && prev.consumers.length > 0
          ? prev.consumers
          : publishedConsumer !== null
            ? [publishedConsumer]
            : [],
      sunsetAt: prev?.sunsetAt ?? null,
      sunsetEvidence: prev?.sunsetEvidence ?? null,
    };
  }
}

// A retained entry has no operation left to derive from, so its recorded
// classification stands — but an explicit override still wins. Copying `prev`
// verbatim ignored the override on exactly the entries check-contract-breaking-change
// reads, so re-publishing a tombstone to prove the gate bites did nothing.
for (const [key, prev] of Object.entries(existingOps)) {
  if (operations[key] !== undefined) continue;
  const override = prev.classificationOverride ?? null;
  operations[key] = {
    ...prev,
    classificationOverride: override,
    classification: override ?? prev.classification,
  };
}

const eventScan = scanOutboxEvents();
const events = {};

for (const eventType of eventScan.emitted) {
  const prev = existingEvents[eventType];
  events[eventType] = {
    classification: prev?.classification ?? "internal",
    owner: prev?.owner ?? null,
    consumers: eventScan.consumed.filter((c) => c === eventType).length > 0 ? ["outbox-relay"] : [],
    sunsetAt: prev?.sunsetAt ?? null,
    sunsetEvidence: prev?.sunsetEvidence ?? null,
  };
}

const registry = {
  version: "1",
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  description:
    "Fail-closed API contract registry. Every HTTP operation, outbox event, and webhook is classified as 'internal' or 'published'. Operations absent from this registry are treated as 'published' by check-api-contract-registry.mjs.",
  operations,
  events,
  webhooks: existing?.webhooks ?? {},
};

const operationCount = Object.keys(operations).length;
const internalCount = Object.values(operations).filter((o) => o.classification === "internal").length;
const publishedCount = operationCount - internalCount;
const eventCount = Object.keys(events).length;

writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");

process.stdout.write(
  `generate-api-contract-registry: registry written to contracts/api-contract-registry.json\n` +
  `  operations: ${String(operationCount)} total (${String(publishedCount)} published, ${String(internalCount)} internal)\n` +
  `  events: ${String(eventCount)}\n` +
  `  webhooks: ${String(Object.keys(registry.webhooks).length)}\n`,
);
process.exit(0);
