#!/usr/bin/env node
/**
 * generate-api-contract-registry.mjs
 *
 * Derives the fail-closed API contract registry from:
 *   1. The committed openapi.json (all HTTP operations + exposure class)
 *   2. OutboxWriter.emit() scan (outbox events) — same logic as check-outbox-consumers.mjs
 *
 * Classification rules
 *   x-exposure = "in-service"                          → internal
 *   x-exposure = "permissioned" | "public" | "universal" → published
 *   absent (should never happen after check-openapi-coverage passes) → published
 *
 * If the registry already exists, manually-set fields (owner, version, consumers,
 * sunsetAt, sunsetEvidence) are preserved for entries that still exist in the
 * OpenAPI document. Entries for operations that no longer exist are removed.
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

function classifyByExposure(xExposure) {
  if (xExposure === "in-service") return "internal";
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
    const classification = classifyByExposure(xExposure);
    const prev = existingOps[key];

    operations[key] = {
      classification: prev?.classification ?? classification,
      xExposure,
      operationId: operation.operationId ?? null,
      owner: prev?.owner ?? null,
      version: prev?.version ?? "1",
      consumers: prev?.consumers ?? [],
      sunsetAt: prev?.sunsetAt ?? null,
      sunsetEvidence: prev?.sunsetEvidence ?? null,
    };
  }
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
