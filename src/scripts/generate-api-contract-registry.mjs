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
 * `deprecationFor` reads a sunset the document ADVERTISES. `sunsetAt`/`sunsetEvidence`
 * record a sunset a human AUTHORISED. Announcing a removal and being allowed to make
 * one are different acts, which is why they stay two fields from two sources.
 *
 * If the registry already exists, manually-set fields (owner, version, consumers,
 * sunsetAt, sunsetEvidence, classificationOverride) are preserved for entries that
 * still exist in the OpenAPI document. Entries for operations that no longer exist
 * are RETAINED.
 *
 * `sunsetAt`/`sunsetEvidence` are also READ from published-contract-terms.json, and
 * the authored value wins over the preserved one. Without that path the workflow
 * check-contract-breaking-change prints — "declare the deprecation in
 * contracts/published-contract-terms.json, set sunsetAt + sunsetEvidence on the
 * entry, and re-run pnpm registry:generate" — could not be carried out: the
 * generator read neither field from the terms file, so the only way to authorise a
 * removal was to hand-edit the generated registry, which the same message forbids.
 * The three entries that carry a `sunsetEvidence` today got it exactly that way.
 *
 * Retention is deliberate and load-bearing. check-contract-breaking-change.mjs
 * detects a removal by finding a registry entry with no matching operation in
 * openapi.json. Dropping those entries here would let anyone silence that gate
 * by running the very command the gate's own failure message recommends:
 * delete a published route, see the gate fail, run `registry:generate`, and the
 * evidence of the removal disappears along with the finding. The registry is a
 * ledger of what was ever exposed, not a mirror of what is exposed now.
 *
 * PUBLISHED-ONLY FIELDS (ticket 34)
 * A published entry additionally carries:
 *   version         — the `/v<N>/` segment of its path when it has one, else the
 *                     value declared in contracts/published-contract-terms.json
 *   deprecation     — {sunsetAt, replacedBy} read off `deprecated` / `x-sunset` /
 *                     `x-deprecation-link` in the OpenAPI document, so the date
 *                     advertised to consumers and the date recorded here cannot
 *                     drift. Separate from sunsetAt/sunsetEvidence: announcing a
 *                     sunset is not the same act as authorising a removal.
 *   knownParameters — the frozen baseline check-contract-breaking-change compares
 *                     against, recorded on first classification and preserved
 *                     thereafter
 *   idempotency     — {mode, key, replay, source} derived from the HTTP method,
 *                     `x-idempotent`, or the authored terms file
 *   contractEvidence— the authored note recording who was consulted
 *
 * contracts/published-contract-terms.json is hand-authored INPUT to this
 * generator. contracts/api-contract-registry.json is the generator's OUTPUT and
 * is never hand-edited: a human declaration goes in the terms file and reaches
 * the registry by re-running this command.
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
const TERMS_PATH = join(BACKEND_ROOT, "contracts", "published-contract-terms.json");
export const SRC_ROOT = resolve(__dirname, "..");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SAFE_METHODS = new Set(["GET"]);

/**
 * This module exports the classifier and the webhook scanner, which
 * check-api-contract-registry.mjs and check-contract-breaking-change.mjs import
 * so the gates and the generator cannot drift apart. Importing it must therefore
 * neither rewrite the committed registry nor hijack `--self-test` from the
 * importing script — both are gated on being run directly.
 */
const IS_DIRECT_RUN =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

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

/**
 * The version a published operation actually ships under.
 *
 * A `/v<N>/` segment in the path is the contract's own statement of its version
 * and outranks anything recorded in the registry, so bumping `/agent/v1/` to
 * `/agent/v2/` cannot leave a stale `"version": "1"` behind. Paths without such a
 * segment take the version declared in published-contract-terms.json, then the
 * value already in the registry, then "1".
 */
export function versionFromPath(pathTemplate) {
  for (const segment of String(pathTemplate).split("/")) {
    if (/^v[0-9]+$/.test(segment)) return segment.slice(1);
  }
  return null;
}

/**
 * The frozen parameter baseline check-contract-breaking-change compares against.
 * Recorded as {name, in, required} so a query parameter and a path parameter of
 * the same name stay distinguishable in the diff.
 */
export function parameterBaseline(operation) {
  const params = Array.isArray(operation?.parameters) ? operation.parameters : [];
  return params
    .filter((p) => typeof p === "object" && p !== null && typeof p.name === "string")
    .map((p) => ({ name: p.name, in: typeof p.in === "string" ? p.in : "unknown", required: p.required === true }))
    .sort((a, b) => (a.name === b.name ? a.in.localeCompare(b.in) : a.name.localeCompare(b.name)));
}

/**
 * The idempotency and replay rule for one published operation.
 *
 * Derived, in order of authority:
 *   1. a safe method is safe by definition
 *   2. `x-idempotent` on the operation — the @Idempotent(command) interceptor is
 *      wired, so the caller's Idempotency-Key header is the replay boundary
 *   3. the rule authored in published-contract-terms.json for this operation or
 *      its path family
 * A mutating published operation matching none of these gets null, and
 * check-api-contract-registry fails it. Inventing a plausible-sounding rule for
 * an operation nobody has read would be worse than the gap it papers over.
 */
export function idempotencyFor(key, method, operation, terms) {
  if (SAFE_METHODS.has(method)) {
    return {
      mode: "safe",
      key: null,
      replay: "Safe method — repeating the request produces no additional side effect.",
      source: "http-method",
    };
  }

  if (operation?.["x-idempotent"] === true) {
    const command = operation["x-idempotency-command"];
    return {
      mode: "idempotency-key",
      key: "Idempotency-Key",
      replay:
        `Guarded by @Idempotent(${typeof command === "string" ? command : "?"}). A repeat carrying the same ` +
        "Idempotency-Key replays the stored response instead of re-executing the command.",
      source: "x-idempotent",
    };
  }

  const authored = termsFor(key, terms);
  if (authored?.idempotency) return { ...authored.idempotency, source: "published-contract-terms" };
  return null;
}

export function termsFor(key, terms) {
  if (!terms) return null;
  const exact = terms.operations?.[key];
  if (exact) return exact;
  const path = key.slice(key.indexOf(" ") + 1);
  let match = null;
  for (const family of terms.families ?? []) {
    if (typeof family.prefix === "string" && path.startsWith(family.prefix)) {
      if (match === null || family.prefix.length > match.prefix.length) match = family;
    } else if (family.exact === path) {
      return family;
    }
  }
  return match;
}

/**
 * The removal a human authorised, for one operation.
 *
 * Only an EXACT operation entry counts. `termsFor` falls back to a path family,
 * which is right for an idempotency rule — a family shares one replay story — and
 * wrong here: a family-level sunset would authorise the removal of every route
 * under that prefix at once, including ones nobody has looked at. A removal is
 * approved one operation at a time or not at all.
 *
 * Both fields must be present together. A date with no evidence is a bare
 * assertion that a window elapsed, and evidence with no date says the removal was
 * reviewed but never says when it became permissible; check-contract-breaking-change
 * demands both, so accepting half a declaration here would only move the failure.
 */
export function authorisedSunset(key, terms) {
  const exact = terms?.operations?.[key];
  const at = exact?.sunsetAt;
  const evidence = exact?.sunsetEvidence;
  if (typeof at !== "string" || at.length === 0) return null;
  if (typeof evidence !== "string" || evidence.length === 0) return null;
  return { sunsetAt: at, sunsetEvidence: evidence };
}

/**
 * A declared deprecation window, read straight off the OpenAPI document so the
 * date the contract advertises to consumers and the date the registry records
 * cannot drift apart. `sunsetAt`/`sunsetEvidence` stay separate and hand-authored
 * in published-contract-terms.json (see `authorisedSunset`): announcing a sunset
 * is not the same act as authorising a removal.
 */
export function deprecationFor(operation) {
  const sunset = operation?.["x-sunset"];
  const deprecated = operation?.deprecated === true;
  if (!deprecated && typeof sunset !== "string") return null;
  return {
    declaredIn: "openapi",
    sunsetAt: typeof sunset === "string" ? sunset : null,
    replacedBy: typeof operation?.["x-deprecation-link"] === "string" ? operation["x-deprecation-link"] : null,
  };
}

export function collectTsFiles(dir) {
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

/**
 * Outbound customer webhook events — the names a customer subscribes to when
 * they register an endpoint through the webhooks API, and the strings we then
 * ship in the delivered body's `event` field.
 *
 * These are a published contract by every test the registry applies: the
 * consumer is somebody else's HTTP endpoint, and renaming one breaks it
 * silently. They were nonetheless invisible to every gate in the repository.
 * `registry.events` holds OutboxWriter events, which are internal by
 * construction — they are consumed by our own outbox relay — and
 * `registry.webhooks` was an empty object the generator never wrote to. So
 * renaming `deal.won` changed a customer-facing contract and no gate noticed.
 *
 * Two dispatchers emit them:
 *   WebhooksDispatchService.dispatch(orgId, name, payload)                   — org scope
 *   ProjectsWebhooksDispatchService.enqueue(tx, orgId, projectId, name, ...)  — project scope
 */
export function scanWebhookEvents(files, readFile) {
  const found = new Map();
  const record = (name, scope, dispatcher, file) => {
    const existing = found.get(name);
    if (existing) {
      if (!existing.sites.includes(file)) existing.sites.push(file);
      return;
    }
    found.set(name, { name, scope, dispatcher, sites: [file] });
  };

  const ORG_RE = /\.dispatch\s*\(\s*[A-Za-z0-9_.$]+\s*,\s*"([a-z][\w.-]*)"/g;
  const PROJECT_RE = /\.enqueue\s*\(\s*[A-Za-z0-9_.$]+\s*,\s*[A-Za-z0-9_.$]+\s*,\s*[A-Za-z0-9_.$]+\s*,\s*"([a-z][\w.-]*)"/g;

  for (const filePath of files) {
    if (filePath.endsWith(".spec.ts") || filePath.endsWith(".e2e-spec.ts")) continue;
    const src = readFile(filePath);
    if (!src.includes("WebhooksDispatchService")) continue;
    const projectScoped = src.includes("ProjectsWebhooksDispatchService");
    for (const m of src.matchAll(ORG_RE)) record(m[1], "organization", "WebhooksDispatchService", filePath);
    if (projectScoped) {
      for (const m of src.matchAll(PROJECT_RE)) record(m[1], "project", "ProjectsWebhooksDispatchService", filePath);
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

if (IS_DIRECT_RUN && process.argv.includes("--self-test")) {
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

  // A retained (removed-operation) entry is re-derived from its recorded
  // xExposure and path, so a route that was only "published" under the old
  // blanket rule stops reporting a false breaking removal — while a genuinely
  // published path still does.
  const retained = (prev, key) => {
    const override = prev.classificationOverride ?? null;
    return override ?? classifyOperation(prev.xExposure, key.slice(key.indexOf(" ") + 1));
  };
  expect(
    "retained-permissioned-rederives-internal",
    retained({ xExposure: "permissioned", classification: "published" }, "POST /payments/x/rotate"),
    "internal",
  );
  expect(
    "retained-public-allowlisted-stays-published",
    retained({ xExposure: "public", classification: "published" }, "GET /public/kb/widget/o1"),
    "published",
  );
  expect(
    "retained-override-wins",
    retained({ xExposure: "permissioned", classification: "internal", classificationOverride: "published" }, "GET /billing/razorpay"),
    "published",
  );

  expect("version-from-path-agent", versionFromPath("/agent/v1/projects"), "1");
  expect("version-from-path-portal", versionFromPath("/portal/v1/projects/{projectId}"), "1");
  expect("version-from-path-v2", versionFromPath("/agent/v2/projects"), "2");
  expect("version-from-path-absent", versionFromPath("/public/kb/{slug}"), null);
  expect("version-from-path-not-a-version", versionFromPath("/public/vendor-portal/{token}"), null);

  const baseline = parameterBaseline({
    parameters: [
      { name: "orgId", in: "path", required: true },
      { name: "cursor", in: "query", required: false },
      { name: "cursor", in: "header" },
    ],
  });
  expect("parameter-baseline-length", baseline.length, 3);
  expect("parameter-baseline-sorted", baseline[0].name, "cursor");
  expect("parameter-baseline-required-flag", baseline[2].required, true);
  expect("parameter-baseline-missing-required-is-false", baseline[0].required, false);
  expect("parameter-baseline-no-params", parameterBaseline({}).length, 0);

  expect("idempotency-get-is-safe", idempotencyFor("GET /public/kb", "GET", {}, null)?.mode, "safe");
  expect(
    "idempotency-x-idempotent-wins",
    idempotencyFor("POST /x", "POST", { "x-idempotent": true, "x-idempotency-command": "build.ticket.create" }, null)?.mode,
    "idempotency-key",
  );
  expect(
    "idempotency-x-idempotent-names-the-header",
    idempotencyFor("POST /x", "POST", { "x-idempotent": true, "x-idempotency-command": "c" }, null)?.key,
    "Idempotency-Key",
  );
  expect("idempotency-undeclared-mutation-is-null", idempotencyFor("POST /x", "POST", {}, null), null);

  const fakeTerms = {
    families: [
      { prefix: "/public/", idempotency: { mode: "at-least-once", key: null, replay: "family rule" } },
      { prefix: "/public/sign/", idempotency: { mode: "single-use-token", key: null, replay: "longer prefix wins" } },
    ],
    operations: { "POST /public/sign/{token}/auth": { idempotency: { mode: "exact", key: null, replay: "exact wins" } } },
  };
  expect("terms-longest-prefix-wins", idempotencyFor("POST /public/sign/{token}/complete", "POST", {}, fakeTerms)?.replay, "longer prefix wins");
  expect("terms-exact-beats-family", idempotencyFor("POST /public/sign/{token}/auth", "POST", {}, fakeTerms)?.replay, "exact wins");
  expect("terms-records-its-source", idempotencyFor("POST /public/waitlist", "POST", {}, fakeTerms)?.source, "published-contract-terms");

  const sunsetTerms = {
    families: [{ prefix: "/public/", sunsetAt: "2020-01-01", sunsetEvidence: "a family may not authorise a removal" }],
    operations: {
      "DELETE /public/a": { sunsetAt: "2026-09-10", sunsetEvidence: "no caller on any frontend branch" },
      "DELETE /public/b": { sunsetAt: "2026-09-10" },
      "DELETE /public/c": { sunsetEvidence: "reviewed, but no date" },
    },
  };
  expect("sunset-exact-entry-is-read", authorisedSunset("DELETE /public/a", sunsetTerms)?.sunsetAt, "2026-09-10");
  expect("sunset-needs-evidence", authorisedSunset("DELETE /public/b", sunsetTerms), null);
  expect("sunset-needs-a-date", authorisedSunset("DELETE /public/c", sunsetTerms), null);
  expect("sunset-family-never-authorises", authorisedSunset("DELETE /public/d", sunsetTerms), null);
  expect("sunset-absent-terms", authorisedSunset("DELETE /public/a", null), null);

  expect("deprecation-absent", deprecationFor({ operationId: "x" }), null);
  expect(
    "deprecation-reads-x-sunset",
    deprecationFor({ deprecated: true, "x-sunset": "2026-10-25", "x-deprecation-link": "/crm/organizations" })?.sunsetAt,
    "2026-10-25",
  );
  expect(
    "deprecation-reads-replacement",
    deprecationFor({ deprecated: true, "x-sunset": "2026-10-25", "x-deprecation-link": "/crm/organizations" })?.replacedBy,
    "/crm/organizations",
  );
  expect("deprecation-without-date-still-recorded", deprecationFor({ deprecated: true })?.sunsetAt, null);

  const fakeFiles = {
    "/src/modules/deals/deals.service.ts":
      'import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";\n' +
      'this.webhooksDispatch.dispatch(orgId, "deal.won", { id });\n' +
      'this.webhooksDispatch.dispatch(orgId, "deal.lost", { id });\n',
    "/src/modules/build/core/tickets/projects-tickets-create.service.ts":
      'import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";\n' +
      'await this.webhooksDispatch.enqueue(tx, u.orgId, projectId, "ticket.created", { id });\n',
    "/src/modules/deals/deals.spec.ts":
      'WebhooksDispatchService\nthis.webhooksDispatch.dispatch(orgId, "deal.fake", {});\n',
    "/src/modules/other/unrelated.service.ts": 'this.queue.dispatch(orgId, "not.a.webhook", {});\n',
  };
  const scannedEvents = scanWebhookEvents(Object.keys(fakeFiles), (p) => fakeFiles[p]);
  const scannedNames = scannedEvents.map((e) => e.name).join(",");
  expect("webhook-scan-finds-literals", scannedNames, "deal.lost,deal.won,ticket.created");
  expect("webhook-scan-records-scope", scannedEvents.find((e) => e.name === "ticket.created")?.scope, "project");
  expect("webhook-scan-records-org-scope", scannedEvents.find((e) => e.name === "deal.won")?.scope, "organization");
  expect("webhook-scan-skips-specs", scannedNames.includes("deal.fake"), false);
  expect("webhook-scan-ignores-unrelated-dispatch", scannedNames.includes("not.a.webhook"), false);

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (IS_DIRECT_RUN) {
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

  let terms = null;
  if (existsSync(TERMS_PATH)) {
    try {
      terms = JSON.parse(readFileSync(TERMS_PATH, "utf8"));
    } catch (err) {
      process.stderr.write(`generate-api-contract-registry: failed to parse published-contract-terms.json: ${err.message}\n`);
      process.exit(1);
    }
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

      const classification = override ?? derived;
      const authored = termsFor(key, terms);
      const sunset = authorisedSunset(key, terms);

      const entry = {
        classification,
        classificationOverride: override,
        xExposure,
        operationId: operation.operationId ?? null,
        owner: authored?.owner ?? prev?.owner ?? null,
        version: versionFromPath(pathTemplate) ?? authored?.version ?? prev?.version ?? "1",
        consumers:
          prev?.consumers !== undefined && prev.consumers.length > 0
            ? prev.consumers
            : publishedConsumer !== null
              ? [publishedConsumer]
              : [],
        sunsetAt: sunset?.sunsetAt ?? prev?.sunsetAt ?? null,
        sunsetEvidence: sunset?.sunsetEvidence ?? prev?.sunsetEvidence ?? null,
      };

      // The versioning, replay and baseline fields exist to serve the published
      // set. Stamping them on all 3,524 internal entries would quadruple a 1.2 MB
      // generated file for operations no gate reads them on, and would bury the
      // 101 entries that matter in the diff.
      if (classification === "published") {
        entry.deprecation = deprecationFor(operation);
        // Frozen on first classification, exactly like a retained tombstone.
        // Re-deriving it every run would let `registry:generate` — the command the
        // gate's own failure message tells you to run — erase the evidence of a
        // narrowing. A deliberate reset is declared in published-contract-terms.json.
        const resetApproved = typeof terms?.parameterBaselineResets?.[key] === "string";
        entry.knownParameters =
          !resetApproved && Array.isArray(prev?.knownParameters)
            ? prev.knownParameters
            : parameterBaseline(operation);
        entry.idempotency = idempotencyFor(key, method.toUpperCase(), operation, terms);
        entry.contractEvidence = authored?.evidence ?? prev?.contractEvidence ?? null;
      }

      operations[key] = entry;
    }
  }

  // A retained entry has no live operation, but it still records the path and the
  // `xExposure` it had, so the same rule applies to it. Two earlier versions were
  // wrong in opposite directions: copying `prev` verbatim ignored
  // `classificationOverride` on exactly the entries check-contract-breaking-change
  // reads, so re-publishing a tombstone to prove the gate bites did nothing; and
  // trusting `prev.classification` carried the old blanket "permissioned means
  // published" verdict forward, so deleting an ordinary internal route reported a
  // breaking published removal. Re-derive, and let an explicit override win.
  for (const [key, prev] of Object.entries(existingOps)) {
    if (operations[key] !== undefined) continue;
    const override = prev.classificationOverride ?? null;
    const pathTemplate = key.slice(key.indexOf(" ") + 1);
    // A tombstone is where an authorised sunset actually matters: the operation is
    // already gone, and this entry is the only record that its removal was reviewed.
    const sunset = authorisedSunset(key, terms);
    operations[key] = {
      ...prev,
      classificationOverride: override,
      classification: override ?? classifyOperation(prev.xExposure, pathTemplate),
      sunsetAt: sunset?.sunsetAt ?? prev.sunsetAt ?? null,
      sunsetEvidence: sunset?.sunsetEvidence ?? prev.sunsetEvidence ?? null,
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

  const webhookFiles = collectTsFiles(SRC_ROOT);
  const webhookSource = new Map();
  const scanned = scanWebhookEvents(webhookFiles, (p) => {
    if (!webhookSource.has(p)) webhookSource.set(p, readFileSync(p, "utf8"));
    return webhookSource.get(p);
  });

  const existingWebhooks = existing?.webhooks ?? {};
  const webhooks = {};

  for (const { name, scope, dispatcher, sites } of scanned) {
    const prev = existingWebhooks[name];
    const authored = terms?.webhookEvents?.[name];
    webhooks[name] = {
      classification: prev?.classification ?? "published",
      scope,
      dispatcher,
      version: authored?.version ?? prev?.version ?? "1",
      consumers: prev?.consumers?.length ? prev.consumers : ["customer-registered webhook endpoints (webhooks API subscriptions)"],
      emittedFrom: sites
        .map((p) => p.replaceAll("\\", "/"))
        .map((p) => p.slice(p.indexOf("src/")))
        .sort(),
      declaredIn: null,
      subscribable: true,
      sunsetAt: prev?.sunsetAt ?? null,
      sunsetEvidence: prev?.sunsetEvidence ?? null,
    };
  }

  // Names a customer can subscribe to that no literal dispatch site names — a
  // dispatcher called with a variable, or an enum of subscribable triggers. They
  // are declared in the authored terms file with the file that proves them.
  for (const [name, authored] of Object.entries(terms?.webhookEvents ?? {})) {
    if (webhooks[name] !== undefined) continue;
    const prev = existingWebhooks[name];
    webhooks[name] = {
      classification: prev?.classification ?? authored.classification ?? "published",
      scope: authored.scope ?? "organization",
      dispatcher: authored.dispatcher ?? "WebhooksDispatchService",
      version: authored.version ?? prev?.version ?? "1",
      consumers: prev?.consumers?.length ? prev.consumers : ["customer-registered webhook endpoints (webhooks API subscriptions)"],
      emittedFrom: [],
      declaredIn: typeof authored.declaredIn === "string" ? authored.declaredIn : null,
      subscribable: true,
      sunsetAt: prev?.sunsetAt ?? null,
      sunsetEvidence: prev?.sunsetEvidence ?? null,
    };
  }

  // Retention, for the same reason operations are retained: a renamed or deleted
  // webhook event must leave a tombstone, or check-contract-breaking-change has
  // nothing to find and a rename ships silently.
  for (const [name, prev] of Object.entries(existingWebhooks)) {
    if (webhooks[name] !== undefined) continue;
    webhooks[name] = { ...prev, emittedFrom: [], declaredIn: null };
  }

  const registry = {
    version: "1",
    schemaVersion: "1.1",
    generatedAt: new Date().toISOString(),
    description:
      "Fail-closed API contract registry. Every HTTP operation, outbox event, and outbound customer webhook event is classified as 'internal' or 'published'. Operations absent from this registry are treated as 'published' by check-api-contract-registry.mjs.",
    operations,
    events,
    webhooks: Object.fromEntries(Object.keys(webhooks).sort().map((k) => [k, webhooks[k]])),
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
}

