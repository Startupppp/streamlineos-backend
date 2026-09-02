#!/usr/bin/env node
// Secret gate: no credential literal is committed to the tree. --self-test runs fixtures.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIN_FILES = 1500;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "drizzle",
]);

const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".sql",
  ".sh",
  ".md",
];

const isPrivateEnvFile = (name) =>
  name === ".env" || (name.startsWith(".env.") && !/\.(example|sample|template)$/.test(name));

const isTemplateEnvFile = (name) => /^\.env\.(example|sample|template)$/.test(name);

const PLACEHOLDER = /^(\*+|x+|<[^>]*>|\$\{[^}]*\}|%[^%]*%|(?:process\.env\.[\w.]+))$/i;
const PLACEHOLDER_WORDS = new Set([
  "password",
  "pass",
  "pwd",
  "secret",
  "redacted",
  "changeme",
  "change-me",
  "your-password",
  "yourpassword",
  "example",
  "placeholder",
  "dummy",
  "test",
  "postgres",
  "user",
  "username",
]);

const URL_CREDENTIAL =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?|https?):\/\/([A-Za-z0-9._%-]+):([^@\s'"`]+)@/g;

const KEY_PATTERNS = [
  ["neon", /\bnpg_[A-Za-z0-9]{12,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  // The access-key id alone was covered; the secret half was not, and a planted
  // AWS_SECRET_ACCESS_KEY passed this gate over 15,572 files.
  ["aws-secret-access-key", /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/],
  ["github-pat", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["github-fine-grained", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["stripe-live", /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ["stripe-restricted-live", /\brk_live_[A-Za-z0-9]{20,}\b/],
  ["razorpay-live", /\brzp_live_[A-Za-z0-9]{10,}\b/],
  ["google-api", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["google-oauth-client-secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/],
  // This product ships an AI gateway; provider keys were the one credential
  // class with no pattern at all.
  ["openai", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/],
  ["anthropic", /\bsk-ant-(?:api|admin)[A-Za-z0-9_-]{20,}\b/],
  ["sendgrid", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
];

// A named secret assigned a high-entropy literal, whatever the provider.
// Anchored on the NAME so an ordinary long string is never a finding.
const TEST_FIXTURE_PATH =
  /(?:^|\/)(?:test|tests|__tests__|__mocks__|testing|fixtures)\/|\.(?:spec|e2e-spec|test|fixture|mock)\.[cm]?tsx?$/;

export function allowsFakeSecrets(relPath) {
  return TEST_FIXTURE_PATH.test(String(relPath).replace(/\\/g, "/"));
}

const NAMED_SECRET_ASSIGNMENT =
  /\b[A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?TOKEN|PRIVATE_?KEY|AUTH_?TOKEN)[A-Za-z0-9_]*\s*[:=]\s*["'`]([^"'`\n]{12,})["'`]/gi;

const ALLOWED_FILES = {};

const MIN_CREDENTIAL_LENGTH = 12;

function looksLikeRealCredential(password) {
  if (password.length < MIN_CREDENTIAL_LENGTH) return false;
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  return classes >= 2;
}

function isPlaceholderPassword(password) {
  if (PLACEHOLDER.test(password)) return true;
  if (PLACEHOLDER_WORDS.has(password.toLowerCase())) return true;
  return !looksLikeRealCredential(password);
}

export function findSecrets(source, fileName = "", relPath = fileName) {
  const findings = [];
  const templateEnv = isTemplateEnvFile(fileName);
  // A named literal in a spec or fixture is a deliberate fake, not a leak. The
  // provider-specific patterns above still apply there — a real AKIA/sk-ant key
  // must never reach a commit, test file or not.
  const fakeSecretsAllowed = allowsFakeSecrets(relPath);

  for (const match of source.matchAll(URL_CREDENTIAL)) {
    const password = match[2];
    if (isPlaceholderPassword(password)) continue;
    findings.push({ kind: "url-credential", user: match[1] });
  }

  for (const [label, pattern] of KEY_PATTERNS) {
    if (!pattern.test(source)) continue;
    if (templateEnv) continue;
    findings.push({ kind: label });
  }

  if (!templateEnv && !fakeSecretsAllowed) {
    NAMED_SECRET_ASSIGNMENT.lastIndex = 0;
    for (const match of source.matchAll(NAMED_SECRET_ASSIGNMENT)) {
      const value = match[1];
      if (isPlaceholderPassword(value)) continue;
      if (/^process\.env\b|^\$\{|^<|^\*+$/.test(value)) continue;
      if (/\s/.test(value)) continue;
      findings.push({ kind: "named-secret-assignment" });
    }
  }

  return findings;
}

function scannableFile(name) {
  if (isPrivateEnvFile(name)) return false;
  if (isTemplateEnvFile(name)) return true;
  return SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, rel, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relative = rel ? `${rel}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, relative, acc);
      continue;
    }
    if (!scannableFile(entry)) continue;
    acc.scanned++;
    const findings = findSecrets(readFileSync(full, "utf8"), entry, relative);
    if (findings.length > 0) acc.violations.push({ path: relative, findings });
  }
  return acc;
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  };

  const pgHost = "@ep-orange-mode.aws.neon.tech/neondb?sslmode=require";
  const livePassword = "npg_" + "aB3xY9zQ1mNp";

  assert(
    "a postgres URL with a real password is a finding — the exact defect this gate exists for",
    findSecrets("const U = 'postgres" + "ql://neondb_owner:" + livePassword + pgHost + "';").length >
      0,
  );
  assert(
    "a redacted password passes",
    findSecrets("postgres" + "ql://neondb_owner:***" + pgHost).length === 0,
  );
  assert(
    "an env-interpolated password passes",
    findSecrets("postgres" + "ql://user:${DB_PASSWORD}@host/db").length === 0,
  );
  assert(
    "a process.env password passes",
    findSecrets("postgres" + "ql://user:process.env.DB_PASS@host/db").length === 0,
  );
  assert(
    "the literal word password passes — it is a template, not a credential",
    findSecrets("postgres" + "ql://user:password@localhost:5432/db").length === 0,
  );
  assert(
    "a URL with no credential at all passes",
    findSecrets("postgres" + "ql://localhost:5432/db").length === 0,
  );
  assert(
    "a bare npg_ key outside a URL is still a finding",
    findSecrets("const KEY = '" + livePassword + "';").length > 0,
  );
  assert(
    "an AWS access key id is a finding",
    findSecrets("AKIA" + "IOSFODNN7EXAMPLE").length > 0,
  );
  assert(
    "a github pat is a finding",
    findSecrets("ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789").length > 0,
  );
  assert(
    "a private key block is a finding",
    findSecrets("-----BEGIN RSA " + "PRIVATE KEY-----\nMIIE...").length > 0,
  );
  assert(
    "a short fixture password passes — pw, p, ci, probe are not credentials",
    findSecrets("postgres" + "://app:pw@db.internal:5432").length === 0 &&
      findSecrets("postgres" + "://ci:ci@127.0.0.1:5432").length === 0 &&
      findSecrets("postgres" + "ql://baduser:badpassword@localhost:5432").length === 0,
  );
  assert(
    "a long mixed-class password on a real host is still a finding",
    findSecrets("postgres" + "://svc:Xq7hZ2mK9wLp@db.example.com/app").length > 0,
  );
  assert(
    "prose mentioning a prefix without a key body passes",
    findSecrets("Set the sk_live_ prefix in the dashboard. Tokens start with ghp_ or xoxb-.")
      .length === 0,
  );
  assert(
    "a template env file may carry an example key shape",
    findSecrets("NEON_KEY=" + livePassword, ".env.example").length === 0,
  );
  assert(
    "a private env file is never scanned",
    scannableFile(".env") === false && scannableFile(".env.production") === false,
  );
  assert("a template env file is scanned", scannableFile(".env.example") === true);
  assert(
    "every recorded exception carries a reason",
    Object.values(ALLOWED_FILES).every((v) => typeof v === "string" && v.length > 20),
  );

  // Each of these was planted as a real file in the scanned tree and confirmed to
  // pass the gate before the pattern existed. The AWS secret half and every AI
  // provider key were uncovered: 15,572 files scanned, zero findings.
  const kind = (src, rel = "src/modules/x/x.service.ts") =>
    findSecrets(src, rel.split("/").pop(), rel).map((f) => f.kind);

  assert(
    "an AWS secret access key is a finding",
    kind("AWS_SECRET_ACCESS" + "_KEY=wJalrXUtnFEMI/K7MDENG/bP" + "xRfiCYEXAMPLEKEY").includes("aws-secret-access-key"),
  );
  assert(
    "an OpenAI project key is a finding",
    kind('const k = "sk-' + 'proj-4kQ2xR9vLmNp7Ts3Wz8Yb1Ac5De6Fg0Hi2Jk4Lm6No8Pq";').includes("openai"),
  );
  assert(
    "an Anthropic API key is a finding",
    kind('K="sk-' + 'ant-api03-Zx9Yw8Vu7Ts6Rq5Pn4Mk3Lj2Ih1Gf0Ed"').includes("anthropic"),
  );
  assert(
    "a Google OAuth client secret is a finding",
    kind("GOCSPX" + "-aB3xY9zQ1mNp7Ts3Wz8Yb1Ac5De").includes("google-oauth-client-secret"),
  );
  assert(
    "a SendGrid key is a finding",
    kind("SG" + ".aB3xY9zQ1mNp7Ts3.Wz8Yb1Ac5De6Fg0Hi2Jk4Lm6No8Pq").includes("sendgrid"),
  );
  assert(
    "a restricted live Stripe key is a finding",
    kind("rk_" + "live_aB3xY9zQ1mNp7Ts3Wz8Yb1Ac5").includes("stripe-restricted-live"),
  );
  assert(
    "a named secret assigned a high-entropy literal is a finding",
    kind('const JWT_SEC' + 'RET = "s3cr3t-Th1s-Is-A-Real-Value-9182";').includes("named-secret-assignment"),
  );
  assert(
    "an ordinary long string is NOT a finding",
    kind('const greeting = "hello world, this is an ordinary long string";').length === 0,
  );
  assert(
    "a placeholder word is NOT a finding",
    kind('const PASSWORD_FIELD_LABEL = "password";').length === 0,
  );
  assert(
    "a value read from the environment is NOT a finding",
    kind("const API_KEY = process.env.API_KEY;").length === 0,
  );
  assert(
    "a fake secret inside a spec file is NOT a finding",
    kind('const API_' + 'KEY = "s3cr3t-Th1s-Is-A-Real-Value-9182";', "src/modules/x/x.service.spec.ts").length === 0,
  );
  assert(
    "a fake secret under test/ is NOT a finding",
    kind('const API_' + 'KEY = "s3cr3t-Th1s-Is-A-Real-Value-9182";', "test/security/appsec/x.ts").length === 0,
  );
  assert(
    "a REAL provider key inside a spec file IS still a finding",
    kind('const K = "sk-' + 'ant-api03-Zx9Yw8Vu7Ts6Rq5Pn4Mk3Lj2Ih1Gf0Ed";', "src/modules/x/x.spec.ts").includes("anthropic"),
  );
  assert("allowsFakeSecrets recognises a spec file", allowsFakeSecrets("src/a/b.spec.ts") === true);
  assert("allowsFakeSecrets recognises the test/ tree", allowsFakeSecrets("test/x/y.ts") === true);
  assert(
    "allowsFakeSecrets does NOT exempt production source",
    allowsFakeSecrets("src/modules/billing/billing.service.ts") === false,
  );
  assert(
    "allowsFakeSecrets does NOT exempt a path merely containing the word test",
    allowsFakeSecrets("src/modules/latest/latest.service.ts") === false,
  );

  if (failed > 0) {
    console.error(`check-hardcoded-secrets self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-hardcoded-secrets self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const result = walk(ROOT, "", { scanned: 0, violations: [] });

if (result.scanned < MIN_FILES) {
  console.error(
    `check-hardcoded-secrets: vacuity guard — only ${result.scanned} files scanned under ${ROOT} (expected >= ${MIN_FILES}); the scan is broken`,
  );
  process.exit(1);
}

const unexplained = result.violations.filter((v) => !Object.hasOwn(ALLOWED_FILES, v.path));
const stale = Object.keys(ALLOWED_FILES).filter(
  (p) => !result.violations.some((v) => v.path === p),
);

console.log(
  `check-hardcoded-secrets: scanned ${result.scanned} files — ${unexplained.length} file(s) with a committed credential`,
);

if (stale.length > 0) {
  console.error(`\nRecorded exceptions that no longer match — remove them:`);
  for (const p of stale) console.error(`  ${p}`);
}

if (unexplained.length > 0) {
  console.error(`\nCommitted credential literals:`);
  for (const v of unexplained) {
    const kinds = [...new Set(v.findings.map((f) => f.kind))].join(", ");
    console.error(`  ${v.path}  [${kinds}]`);
  }
  console.error(
    `\nTo fix: read the value from the environment and fail fast when it is absent.\n` +
      `  const URL = process.env.DATABASE_URL;\n` +
      `  if (!URL) throw new Error("DATABASE_URL is required");\n` +
      `Rotate any credential that reached a commit — removing the line does not un-leak it.`,
  );
}

process.exit(unexplained.length > 0 || stale.length > 0 ? 1 : 0);
