/**
 * check-log-secrets.mjs
 *
 * Two static checks:
 *
 * CHECK 1 — Secret/PII leak into logs
 *   Finds source lines where a variable whose name suggests a secret (password,
 *   token, secret, apiKey, …) is passed directly into logger.* or console.*
 *   outside the redact() call chain.
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
 * Usage:  node src/scripts/check-log-secrets.mjs [--self-test]
 * Exit:   0 clean · 1 violation found · 2 broken scan
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const MODULES_DIR = join(BACKEND_ROOT, "src", "modules");
const COMMON_DIR = join(BACKEND_ROOT, "src", "common");
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
  /\b(?:password|passwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|session[_-]?id|access[_-]?key|auth[_-]?token|bearer|jwt|otp|pin|cvv|ssn|pan)\b/i;

const LOG_CALL_RE =
  /\b(?:this\.)?(?:logger|console)\s*\.\s*(?:log|warn|error|debug|verbose|fatal)\s*\(/i;

const REDACT_RE = /redact\s*\(/;

const RATE_LIMIT_DECORATOR_RE = /@UseRateLimit\(\s*["']([^"']+)["']\s*\)/g;

function walkTs(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name))
      results.push(full);
  }
  return results;
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

const tiersSource = readFileSync(RATE_LIMIT_FILE, "utf8");
const tiers = parseTiers(tiersSource);

if (tiers.size < 10) {
  process.stderr.write(
    `Parsed only ${tiers.size} TIERS entries — the TIERS block pattern is broken.\n`,
  );
  process.exit(2);
}

const files = [
  ...walkTs(MODULES_DIR),
  ...walkTs(COMMON_DIR),
];

const logFindings = [];
const tierFindings = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  logFindings.push(...findSecretLogLines(src, file));
  tierFindings.push(...findMissingRateLimitTiers(src, file, tiers));
}

console.log(`Scanned    ${files.length} source files`);
console.log(`TIERS map  ${tiers.size} entries`);
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

if (!failed) {
  console.log(
    "OK — no plaintext secret logging found and all @UseRateLimit keys are in TIERS.",
  );
  process.exit(0);
}

console.error(
  `FAIL — ${logFindings.length} secret log leak(s) and ${tierFindings.length} missing TIERS entry(ies).`,
);
process.exit(1);
