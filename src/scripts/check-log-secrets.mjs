/**
 * check-log-secrets.mjs
 *
 * Three static checks:
 *
 * CHECK 1 — Secret/PII leak into logs
 *   Finds source lines where a variable whose name suggests a secret (password,
 *   token, secret, apiKey, prompt, …) is passed directly into logger.* or
 *   console.* outside the redact() call chain.
 *
 *   FALSE POSITIVE GUARDS:
 *     – A line already calling redact() is ignored.
 *     – Comments are ignored.
 *     – Type annotations (`: password`, `key: "token"`) are ignored — only
 *       argument positions count.
 *
 * CHECK 2 — @UseRateLimit key absent from TIERS (SEC-004 class)
 *   An unknown key passed to @UseRateLimit silently denies (post-SEC-004 fix),
 *   but the decorator's presence also creates a false impression of protection.
 *   Finds every @UseRateLimit("key") usage in source and verifies the key
 *   exists in the TIERS map parsed from rate-limit.service.ts.
 *
 * CHECK 3 — Redactor parity
 *   This script's own idea of "sensitive" must match the runtime redactor's.
 *   Everything CHECK 1 knows to look for must be a name that
 *   common/observability/redact.ts actually withholds, because CHECK 1 only
 *   inspects source text: a leak written in a shape it cannot parse — a spread,
 *   a helper, a variable built two lines earlier — is caught at emission by the
 *   redactor or not at all. A name in one list and not the other is a gate
 *   asserting its own constants while the emitting side lets the value through,
 *   which is how `accessKey`, `bearer` and `jwt` were flagged as dangerous here
 *   and printed verbatim at runtime.
 *
 * SCOPE: every .ts under src/ except src/test and src/@types. It once covered
 * only src/modules and src/common, so src/db (which logs driver failures),
 * src/main.ts, src/health and src/degradation were unscanned.
 *
 * Usage:  node src/scripts/check-log-secrets.mjs [--self-test]
 * Exit:   0 clean · 1 violation found · 2 broken scan
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SRC_DIR = join(BACKEND_ROOT, "src");
const MODULES_DIR = join(SRC_DIR, "modules");
const SKIPPED_DIRS = new Set(["test", "@types"]);
const REDACT_FILE = join(SRC_DIR, "common", "observability", "redact.ts");
const RATE_LIMIT_FILE = join(
  BACKEND_ROOT,
  "src",
  "common",
  "ratelimit",
  "rate-limit.service.ts",
);

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

const SENSITIVE_NAME_RE =
  /\b(?:password|passwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|session[_-]?id|access[_-]?key|auth[_-]?token|bearer|jwt|otp|pin|cvv|ssn|pan|\w*prompt)\b/i;

const LOG_CALL_RE =
  /\b(?:this\.)?(?:logger|console)\s*\.\s*(?:log|warn|error|debug|verbose|fatal)\s*\(/i;

const REDACT_RE = /redact\s*\(/;

const RATE_LIMIT_DECORATOR_RE = /@UseRateLimit\(\s*["']([^"']+)["']\s*\)/g;

function walkTs(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name))
      results.push(full);
  }
  return results;
}

/**
 * The runtime redactor's two name lists, read out of its source.
 *
 * Parsed rather than imported because this is an .mjs gate and redact.ts is
 * TypeScript; a parse that finds nothing exits 2 rather than passing vacuously.
 */
export function parseRedactorNames(src) {
  const substrings = new Set();
  const exact = new Set();

  const substringBlock = src.match(/SENSITIVE_SUBSTRINGS\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (substringBlock) {
    for (const m of substringBlock[1].matchAll(/"([^"]+)"/g)) substrings.add(m[1]);
  }

  const exactBlock = src.match(/SENSITIVE_EXACT\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (exactBlock) {
    for (const m of exactBlock[1].matchAll(/"([^"]+)"/g)) exact.add(m[1]);
  }

  return { substrings, exact };
}

/** The same decision `isSensitive` makes in redact.ts, on a normalised key. */
export function redactorWouldWithhold(name, { substrings, exact }) {
  const normalised = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (exact.has(normalised)) return true;
  return [...substrings].some((needle) => normalised.includes(needle));
}

/**
 * The names CHECK 1 treats as dangerous, spelled out so CHECK 3 can compare
 * them against the redactor. Kept beside SENSITIVE_NAME_RE — the regex is the
 * matcher, this is the roster, and they must not drift.
 */
export const GATE_SENSITIVE_NAMES = [
  "password",
  "passwd",
  "secret",
  "token",
  "apiKey",
  "credential",
  "privateKey",
  "sessionId",
  "accessKey",
  "authToken",
  "bearer",
  "jwt",
  "otp",
  "pin",
  "cvv",
  "ssn",
  "pan",
  "prompt",
];

export function findRedactorGaps(names, redactorNames) {
  return names.filter((name) => !redactorWouldWithhold(name, redactorNames));
}

// Parses the TIERS map from rate-limit.service.ts by reading the key strings.
export function parseTiers(src) {
  const tiers = new Set();
  const tierBlockMatch = src.match(
    /const\s+TIERS\s*:\s*Record[^=]+=\s*\{([\s\S]*?)\n\}/,
  );
  if (!tierBlockMatch) return tiers;
  const block = tierBlockMatch[1];
  const keyRe = /["']([^"']+)["']\s*:/g;
  let m;
  while ((m = keyRe.exec(block)) !== null) tiers.add(m[1]);
  return tiers;
}

function stripStringLiterals(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, (tpl) =>
      [...tpl.matchAll(/\$\{([^}]*)\}/g)].map((m) => " " + m[1] + " ").join("") || " "
    );
}

export function findSecretLogLines(src, filePath) {
  const findings = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    if (!LOG_CALL_RE.test(line)) continue;
    if (REDACT_RE.test(line)) continue;
    const stripped = stripStringLiterals(line);
    if (!SENSITIVE_NAME_RE.test(stripped)) continue;
    const commentIdx = stripped.indexOf("//");
    const inComment = commentIdx >= 0 && commentIdx < stripped.search(SENSITIVE_NAME_RE);
    if (inComment) continue;
    findings.push({ file: filePath, line: i + 1, text: line.trim() });
  }
  return findings;
}

export function findMissingRateLimitTiers(src, filePath, tiers) {
  const findings = [];
  let m;
  const re = new RegExp(RATE_LIMIT_DECORATOR_RE.source, "g");
  while ((m = re.exec(src)) !== null) {
    const key = m[1];
    if (!tiers.has(key)) {
      const lineNum = src.slice(0, m.index).split("\n").length;
      findings.push({ file: filePath, line: lineNum, key });
    }
  }
  return findings;
}

// ─── self-test ────────────────────────────────────────────────────────────────

if (SELF_TEST) {
  const knownBadLog = `
    async loginUser(password: string) {
      this.logger.log("Logging in with password " + password);
    }
  `;
  const knownGoodLog = `
    async loginUser(password: string) {
      this.logger.log("Logging in", { password: redact(password) });
    }
  `;
  const knownGoodAction = `
    async loginUser(password: string) {
      const hash = await argon2.hash(password);
      this.logger.log("User logged in", { userId });
    }
  `;
  const knownBadTier = `@UseRateLimit("nonexistent:tier:key")`;
  const knownGoodTier = `@UseRateLimit("auth:login")`;

  const tiersRaw = existsSync(RATE_LIMIT_FILE)
    ? readFileSync(RATE_LIMIT_FILE, "utf8")
    : "";
  const tiers = parseTiers(tiersRaw);

  const knownBadTemplateLiteral = `
    async loginUser(password: string) {
      this.logger.error(\`Auth failed with password \${password}\`);
    }
  `;
  const knownSafeTemplateLiteral = `
    async loginUser(userId: string) {
      this.logger.log(\`User \${userId} logged in successfully\`);
    }
  `;

  const badLogFindings = findSecretLogLines(knownBadLog, "synthetic/bad.ts");
  const goodLogFindings = findSecretLogLines(knownGoodLog, "synthetic/good.ts");
  const goodActionFindings = findSecretLogLines(
    knownGoodAction,
    "synthetic/action.ts",
  );
  const badTplFindings = findSecretLogLines(knownBadTemplateLiteral, "synthetic/tpl-leak.ts");
  const safeTplFindings = findSecretLogLines(knownSafeTemplateLiteral, "synthetic/tpl-safe.ts");
  const badTierFindings = findMissingRateLimitTiers(
    knownBadTier,
    "synthetic/bad.ts",
    tiers,
  );
  const goodTierFindings = findMissingRateLimitTiers(
    knownGoodTier,
    "synthetic/good.ts",
    tiers,
  );

  const knownBadPrompt = `
    async summarise(systemPrompt: string) {
      this.logger.debug(\`Calling model with \${systemPrompt}\`);
    }
  `;
  const badPromptFindings = findSecretLogLines(knownBadPrompt, "synthetic/prompt.ts");

  const redactorSource = existsSync(REDACT_FILE) ? readFileSync(REDACT_FILE, "utf8") : "";
  const redactorNames = parseRedactorNames(redactorSource);
  const realGaps = findRedactorGaps(GATE_SENSITIVE_NAMES, redactorNames);
  // A name the redactor has never heard of must be reported as a gap; without
  // this the parity check would pass on an empty parse.
  const syntheticGaps = findRedactorGaps(
    ["password", "definitelyNotInTheRedactor"],
    redactorNames,
  );

  const checks = {
    parsedTiersFromFile: tiers.size > 10,
    tiersContainsAuthLogin: tiers.has("auth:login"),
    tiersContainsHrFormPublicSubmit: tiers.has("hr-form:public-submit"),
    catchesSecretInLogLine: badLogFindings.length === 1,
    missesRedactedLogLine: goodLogFindings.length === 0,
    missesLogLineWithoutSensitiveName: goodActionFindings.length === 0,
    catchesTemplateLiteralSecretLeak: badTplFindings.length === 1,
    missesTemplateLiteralSafeInterpolation: safeTplFindings.length === 0,
    catchesMissingTierKey: badTierFindings.length === 1,
    missesPresentTierKey: goodTierFindings.length === 0,
    catchesPromptInterpolatedIntoMessage: badPromptFindings.length === 1,
    parsedRedactorSubstrings: redactorNames.substrings.size > 5,
    parsedRedactorExact: redactorNames.exact.size > 5,
    everyGateNameIsWithheldByTheRedactor: realGaps.length === 0,
    parityCheckReportsAnUnknownName: syntheticGaps.length === 1,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// ─── run ──────────────────────────────────────────────────────────────────────

if (!existsSync(MODULES_DIR)) {
  process.stderr.write(`Cannot find modules dir: ${MODULES_DIR}\n`);
  process.exit(2);
}

if (!existsSync(RATE_LIMIT_FILE)) {
  process.stderr.write(`Cannot find rate-limit.service.ts: ${RATE_LIMIT_FILE}\n`);
  process.exit(2);
}

if (!existsSync(REDACT_FILE)) {
  process.stderr.write(`Cannot find redact.ts: ${REDACT_FILE}\n`);
  process.exit(2);
}

const redactorNames = parseRedactorNames(readFileSync(REDACT_FILE, "utf8"));
if (redactorNames.substrings.size < 5 || redactorNames.exact.size < 5) {
  process.stderr.write(
    `Parsed only ${redactorNames.substrings.size} substring and ${redactorNames.exact.size} exact ` +
      `redactor names — the redact.ts list pattern is broken, so CHECK 3 would pass vacuously.\n`,
  );
  process.exit(2);
}

const tiersSource = readFileSync(RATE_LIMIT_FILE, "utf8");
const tiers = parseTiers(tiersSource);

if (tiers.size < 10) {
  process.stderr.write(
    `Parsed only ${tiers.size} TIERS entries — the TIERS block pattern is broken.\n`,
  );
  process.exit(2);
}

const files = walkTs(SRC_DIR);

// A walk that reaches nothing produces zero findings, which reads exactly like a
// clean tree. This gate guards secrets reaching the logs; it must never report OK
// without having looked.
const MIN_SOURCE_FILES = 500;
if (files.length < MIN_SOURCE_FILES) {
  console.error(
    `INCONCLUSIVE — the scan reached only ${files.length} source file(s) under ${SRC_DIR} ` +
      `(floor ${MIN_SOURCE_FILES}). This run proves nothing about secrets in logs.`,
  );
  process.exit(2);
}

const logFindings = [];
const tierFindings = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  logFindings.push(...findSecretLogLines(src, file));
  tierFindings.push(...findMissingRateLimitTiers(src, file, tiers));
}

const redactorGaps = findRedactorGaps(GATE_SENSITIVE_NAMES, redactorNames);

console.log(`Scanned    ${files.length} source files`);
console.log(`TIERS map  ${tiers.size} entries`);
console.log(
  `Redactor   ${redactorNames.substrings.size} substrings + ${redactorNames.exact.size} exact names`,
);
console.log("");

let failed = false;

if (logFindings.length > 0) {
  failed = true;
  console.error("SECRET/PII LOG LEAKS — sensitive variable name passed directly to a logger:");
  for (const f of logFindings) {
    console.error(
      `  FAIL  ${relative(BACKEND_ROOT, f.file).replace(/\\/g, "/")}:${f.line}`,
    );
    console.error(`        ${f.text}`);
  }
  console.error("");
}

if (tierFindings.length > 0) {
  failed = true;
  console.error(
    "MISSING TIERS ENTRIES — @UseRateLimit key not in TIERS (silently denies all requests, SEC-004 class):",
  );
  for (const f of tierFindings) {
    console.error(
      `  FAIL  "${f.key}"  ${relative(BACKEND_ROOT, f.file).replace(/\\/g, "/")}:${f.line}`,
    );
  }
  console.error("");
}

if (redactorGaps.length > 0) {
  failed = true;
  console.error(
    "REDACTOR PARITY — this gate treats these names as sensitive but " +
      "common/observability/redact.ts does not withhold them, so a value under such a key " +
      "is printed verbatim on any path this static scan cannot see:",
  );
  for (const name of redactorGaps) console.error(`  FAIL  ${name}`);
  console.error("");
}

if (!failed) {
  console.log(
    "OK — no plaintext secret logging found, all @UseRateLimit keys are in TIERS, " +
      "and every name this gate guards is withheld by the runtime redactor.",
  );
  process.exit(0);
}

console.error(
  `FAIL — ${logFindings.length} secret log leak(s), ${tierFindings.length} missing TIERS entry(ies), ` +
    `${redactorGaps.length} redactor parity gap(s).`,
);
process.exit(1);
