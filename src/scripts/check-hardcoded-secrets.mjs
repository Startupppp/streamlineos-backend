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
  ["github-pat", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["github-fine-grained", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["stripe-live", /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ["razorpay-live", /\brzp_live_[A-Za-z0-9]{10,}\b/],
  ["google-api", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
];

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

export function findSecrets(source, fileName = "") {
  const findings = [];
  const templateEnv = isTemplateEnvFile(fileName);

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
    const findings = findSecrets(readFileSync(full, "utf8"), entry);
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
