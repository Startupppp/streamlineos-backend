#!/usr/bin/env node
/**
 * Gate: every call to an AiGatewayService invoke method in backend/src must declare
 * the `charge` field explicitly — either `charge: true` (tenant pays) or `charge: false`
 * (platform cost). An absent field is indistinguishable from a forgotten one and silently
 * makes the feature's AI_FEATURE_COSTS entry dead (zero reservation, zero settlement).
 *
 * Methods checked: invokeStructured, invokeStructuredWithUsage, invokeStructuredWithImage,
 * invokeStructuredWithImageWithUsage, invokeText, invokeTextWithUsage,
 * embedQueryWithCredit, embedBatchWithCredit.
 * The self-test derives this list from AiGatewayService itself, so a new paid
 * entry point fails the gate rather than escaping the scan.
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

// Every paid entry point on AiGatewayService. Widening this alternation is not
// optional bookkeeping: `embed(Query|Batch)WithCredit` were absent, so six live
// embedding call sites — the KB indexing loop among them — were outside the scan
// entirely and the count sat at a stable, reassuring 113 across a refactor that
// added them. The self-test now derives the required set from the gateway source
// (see assertCoversEveryPaidEntryPoint) so a new entry point fails this gate
// instead of silently escaping it.
const INVOKE_RE =
  /\.(invokeStructured(?:WithImage)?(?:WithUsage)?|invokeText(?:WithUsage)?|embed(?:Query|Batch)WithCredit)\s*\(/g;

const GATEWAY_SERVICE_REL = "src/modules/ai/core/gateway/ai-gateway.service.ts";

/**
 * Public methods on AiGatewayService whose name marks them a paid provider call.
 * A gate whose coverage is "the names I thought of when I wrote it" stops covering
 * a surface the moment someone adds an entry point; this reads the surface instead.
 */
export function paidEntryPointsFromGateway(source) {
  const names = new Set();
  for (const m of source.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][A-Za-z0-9_]*)\s*[(<]/gm)) {
    const name = m[1];
    if (/^(?:constructor|private|public|protected|get|set|if|for|while|return|catch)$/.test(name)) continue;
    if (/^(?:invoke|embed)/.test(name) && !/^is[A-Z]/.test(name)) names.add(name);
  }
  return names;
}

export function methodIsCovered(name) {
  const probe = `this.aiGateway.${name}({ charge: true })`;
  INVOKE_RE.lastIndex = 0;
  return INVOKE_RE.test(probe);
}

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
  const byMethod = new Map();
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
      byMethod.set(match[1], (byMethod.get(match[1]) ?? 0) + 1);

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

  return { violations, staleAllowlistEntries, totalInvocations, byMethod };
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

  // The embedding surface. These shapes were invisible to the previous regex, so
  // every fixture above passed while six live paid call sites went unscanned.
  const embedAbsent = `
    const embedResult = await this.aiGateway.embedBatchWithCredit({
      texts: pending.map((i) => chunks[i]),
      orgId,
      feature: KB_INDEXING_FEATURE,
    });
  `;
  const embedCharged = `
    return this.aiGateway.embedQueryWithCredit({
      text,
      orgId,
      feature: KB_SEARCH_FEATURE,
      charge: true,
    });
  `;
  assert("an embedBatchWithCredit call with no charge is a violation", findViolations(embedAbsent).length === 1);
  assert("the embedding violation names the method", findViolations(embedAbsent)[0] === "embedBatchWithCredit");
  assert("an embedQueryWithCredit call declaring charge passes", findViolations(embedCharged).length === 0);

  // Structural coverage: read the gateway and require every paid entry point on it
  // to be matched. This is what makes the self-test unable to share the gate's
  // blind spot — a fixture can only test the shapes its author thought of.
  const gatewaySource = readFileSync(join(BACKEND_ROOT, GATEWAY_SERVICE_REL), "utf8");
  const paidEntryPoints = [...paidEntryPointsFromGateway(gatewaySource)];
  const uncovered = paidEntryPoints.filter((n) => !methodIsCovered(n));
  assert(
    `the gateway source yields a plausible number of paid entry points (found ${paidEntryPoints.length})`,
    paidEntryPoints.length >= 8,
  );
  assert(
    `every paid entry point on AiGatewayService is inside the scan${uncovered.length ? ` — UNCOVERED: ${uncovered.join(", ")}` : ""}`,
    uncovered.length === 0,
  );
  assert(
    "the coverage check can actually fail — an unknown paid method is reported uncovered",
    methodIsCovered("embedImageWithCreditNotYetSupported") === false,
  );

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

const { violations, staleAllowlistEntries, totalInvocations, byMethod } = scan(SRC_DIR);

// Print the per-method breakdown always. A stable total across a refactor that
// added six credited embedding calls looked exactly like success; a per-method
// line makes a surface that drops to zero visible at a glance.
const gatewayEntryPoints = [...paidEntryPointsFromGateway(readFileSync(join(BACKEND_ROOT, GATEWAY_SERVICE_REL), "utf8"))].sort();
console.log("Paid gateway entry points and call sites found:");
for (const name of gatewayEntryPoints) {
  const covered = methodIsCovered(name);
  console.log(`  ${covered ? " " : "!"} ${name.padEnd(36)} ${covered ? String(byMethod.get(name) ?? 0) : "NOT SCANNED — widen INVOKE_RE"}`);
}
const uncoveredEntryPoints = gatewayEntryPoints.filter((n) => !methodIsCovered(n));
if (uncoveredEntryPoints.length > 0) {
  console.error(
    `\ncheck-ai-charge-declared: INCONCLUSIVE — ${uncoveredEntryPoints.length} paid entry point(s) on AiGatewayService are outside this scan: ${uncoveredEntryPoints.join(", ")}. A clean result cannot cover them.`,
  );
  process.exit(2);
}

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
