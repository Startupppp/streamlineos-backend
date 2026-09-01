#!/usr/bin/env node
/**
 * Gate: every call to an AiGatewayService invoke method in backend/src must declare
 * the `charge` field explicitly — either `charge: true` (tenant pays) or `charge: false`
 * (platform cost). An absent field is indistinguishable from a forgotten one and silently
 * makes the feature's AI_FEATURE_COSTS entry dead (zero reservation, zero settlement).
 *
 * Methods checked: invokeStructured, invokeStructuredWithUsage, invokeStructuredWithImage,
 * invokeStructuredWithImageWithUsage, invokeText, invokeTextWithUsage.
 *
 * Excluded from the scan (internal machinery — different option shapes):
 *   src/modules/ai/core/gateway/ai-gateway-runner.helper.ts
 *   src/modules/ai/core/providers/llm.service.ts
 *   *.spec.ts, *.e2e-spec.ts  (test files)
 *
 * Allowlisted paths (recorded reason, intentional omission):
 *   see ALLOWLIST below. A stale allowlist entry (no violation found for it) is a failure.
 *
 * Flags:
 *   --self-test   Run internal assertions against in-memory fixtures and exit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const INVOKE_RE = /\.(invokeStructured(?:WithImage)?(?:WithUsage)?|invokeText(?:WithUsage)?)\s*\(/g;

const EXCLUDED_PATHS = [
  "src/modules/ai/core/gateway/ai-gateway-runner.helper.ts",
  "src/modules/ai/core/providers/llm.service.ts",
];

const ALLOWLIST = [
  {
    path: "src/modules/ai/core/services/crm-content.service.ts",
    reason: "Excluded CRM domain — 6 calls tracked in Lane 18 handoff; fix is owned by the CRM lane, not this gate run.",
  },
];

const ANTI_VACUITY_MIN = 80;

function resolvePath(rel) {
  return new URL(rel, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
}

const SRC_DIR = resolvePath("../");
const BACKEND_ROOT = resolvePath("../../");

function* walkTs(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) yield* walkTs(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) yield full;
  }
}

function isTestFile(filename) {
  return filename.endsWith(".spec.ts") || filename.endsWith(".e2e-spec.ts");
}

function normalizeRel(absPath) {
  return relative(BACKEND_ROOT, absPath).replace(/\\/g, "/");
}

function isExcluded(rel) {
  return EXCLUDED_PATHS.some((ex) => rel === ex || rel.endsWith(ex));
}

function isAllowlisted(rel) {
  return ALLOWLIST.find((a) => rel === a.path || rel.endsWith(a.path));
}

function extractOptionsObject(text, afterOpenParen) {
  let pos = afterOpenParen;
  while (pos < text.length && text[pos] !== "{" && text[pos] !== ")") pos++;
  if (pos >= text.length || text[pos] === ")") return null;
  let depth = 0;
  const start = pos;
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, pos + 1);
    }
    pos++;
  }
  return null;
}

function hasChargeProp(objText) {
  return /\bcharge\s*:/.test(objText);
}

function lineOf(text, pos) {
  return text.slice(0, pos).split("\n").length;
}

function scan(srcDir) {
  const violations = [];
  const matchedAllowlistPaths = new Set();
  let totalInvocations = 0;

  for (const absPath of walkTs(srcDir)) {
    const rel = normalizeRel(absPath);
    if (isTestFile(rel)) continue;
    if (isExcluded(rel)) continue;

    let text;
    try {
      text = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    INVOKE_RE.lastIndex = 0;
    let match;
    while ((match = INVOKE_RE.exec(text)) !== null) {
      const afterParen = match.index + match[0].length;
      const opts = extractOptionsObject(text, afterParen);
      if (!opts) continue;

      totalInvocations++;

      if (!hasChargeProp(opts)) {
        const entry = isAllowlisted(rel);
        if (entry) {
          matchedAllowlistPaths.add(entry.path ?? entry);
        } else {
          violations.push({
            file: rel,
            line: lineOf(text, match.index),
            method: match[1],
          });
        }
      }
    }
  }

  const staleAllowlistEntries = ALLOWLIST.filter(
    (a) => !matchedAllowlistPaths.has(a.path),
  );

  return { violations, staleAllowlistEntries, totalInvocations };
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  const absent = `
    const result = await this.gateway.invokeText({
      actor: { orgId, userId: null },
      feature: "test.feature",
      tier: "fast",
      prompt: { system: "s", user: "u" },
    });
  `;

  const withTrue = `
    const result = await this.gateway.invokeText({
      actor: { orgId, userId: null },
      feature: "test.feature",
      charge: true,
      prompt: { system: "s", user: "u" },
    });
  `;

  const withFalse = `
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: null },
      feature: "test.feature",
      charge: false,
      schema: mySchema,
      prompt: { system: "s", user: "u" },
    });
  `;

  const nested = `
    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: null },
      feature: "test.feature",
      charge: true,
      prompt: {
        system: "nested { braces } here",
        user: "more { nesting { deeply } } done",
      },
    });
  `;

  function findViolations(code) {
    const violations = [];
    INVOKE_RE.lastIndex = 0;
    let m;
    while ((m = INVOKE_RE.exec(code)) !== null) {
      const opts = extractOptionsObject(code, m.index + m[0].length);
      if (!opts) continue;
      if (!hasChargeProp(opts)) violations.push(m[1]);
    }
    return violations;
  }

  assert("absent charge is detected as a violation", findViolations(absent).length === 1);
  assert("charge: true passes (no violation)", findViolations(withTrue).length === 0);
  assert("charge: false passes (no violation)", findViolations(withFalse).length === 0);
  assert("nested braces in prompt do not confuse the extractor", findViolations(nested).length === 0);
  assert("absent charge names the correct method", findViolations(absent)[0] === "invokeText");

  const { violations, staleAllowlistEntries, totalInvocations } = scan(SRC_DIR);

  assert(
    `anti-vacuity: parser found at least ${ANTI_VACUITY_MIN} invocations in the real codebase (found ${totalInvocations})`,
    totalInvocations >= ANTI_VACUITY_MIN,
  );

  assert(
    "allowlist entry for crm-content.service.ts is still active (not stale)",
    staleAllowlistEntries.length === 0,
  );

  if (violations.length > 0) {
    console.error("  Self-test: violations still present in codebase after fixes:");
    for (const v of violations) console.error(`    ${v.file}:${v.line} — ${v.method}`);
  }
  assert("real codebase scan finds zero violations after the fix", violations.length === 0);

  if (failed > 0) {
    console.error(`\ncheck-ai-charge-declared --self-test: ${failed} FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-ai-charge-declared --self-test: ${passed} passed (${totalInvocations} invocations scanned)`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) {
  runSelfTests();
}

const { violations, staleAllowlistEntries, totalInvocations } = scan(SRC_DIR);

if (totalInvocations < ANTI_VACUITY_MIN) {
  console.error(
    `check-ai-charge-declared: vacuity guard — only ${totalInvocations} invocations found (expected ≥ ${ANTI_VACUITY_MIN}); scan is likely broken`,
  );
  process.exit(1);
}

if (staleAllowlistEntries.length > 0) {
  console.error(`check-ai-charge-declared: ${staleAllowlistEntries.length} stale allowlist entry(ies) — no violations matched:`);
  for (const e of staleAllowlistEntries) {
    console.error(`  ${e.path}  (${e.reason})`);
  }
  console.error("Remove stale entries from ALLOWLIST in check-ai-charge-declared.mjs.");
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`check-ai-charge-declared: ${violations.length} gateway call(s) missing explicit \`charge\` field:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  .${v.method}({...})`);
  }
  console.error(
    "\nAdd `charge: true` (tenant pays) or `charge: false` (platform cost, with justification).",
  );
  process.exit(1);
}

console.log(
  `check-ai-charge-declared: ${totalInvocations} invocations scanned — all declare \`charge\` explicitly (${ALLOWLIST.length} allowlisted)`,
);
process.exit(0);
