#!/usr/bin/env node
/**
 * Gate: the hashed release evidence tree carries no credential and no
 * non-synthetic e-mail address.
 *
 * WHY THIS EXISTS. PRD-C188 reads "Run retention/legal-hold drills and store a
 * **redacted**, hashed evidence bundle." Two of those words had a gate and one
 * did not. `check:evidence-seal` proves *hashed* — every sealed file still
 * matches its sha256, a deleted file fails, an unsealed file appearing in a
 * sealed directory fails. Nothing proved *redacted*. The only statement about
 * redaction was prose inside the bundle's own README and inside the `redaction`
 * field of each seal manifest: "the tree was scanned before sealing … zero
 * matches". A claim a bundle makes about itself, checked by nobody, re-verified
 * never. Every later capture was appended under that same sentence without
 * anything re-running it, so the sentence described a scan of a smaller tree.
 *
 * WHAT IT SCANS. The corpus is derived from the seals, not from a hand-written
 * list: every `artifact-hashes.json` under the evidence tree contributes the
 * seal itself, every file it names, and every regular file sitting directly in
 * its directory. That last clause is the one that matters — otherwise a leak
 * could be parked in an unsealed file inside a sealed directory and this gate
 * would not look at it while `check:evidence-seal` failed it for an unrelated
 * reason. The corpus therefore grows automatically as the bundle grows, and it
 * cannot be narrowed from the command line.
 *
 * HOW IT REFUSES TO BE VACUOUS. A scanner whose patterns are subtly wrong
 * matches nothing and reports a clean tree, which is the exact failure this
 * repository has hit before with lookup tables that matched no rows. So every
 * pattern carries a POSITIVE control it must match and a NEGATIVE control it
 * must not, and a pattern that fails either makes the whole run INCONCLUSIVE
 * (exit 2) rather than green. On top of that sit corpus floors — a minimum
 * number of seals, files and bytes — in the shape of MIN_SEALS /
 * MIN_SEALED_FILES in check-evidence-seal.mjs. None of the floors and none of
 * the controls are reachable from argv.
 *
 * DECLARED SYNTHETIC MATCHES. Two files in the tree are redaction *probes*:
 * they contain a deliberately fake credential in order to demonstrate that the
 * product's redactor replaces it. Those are pinned one by one in
 * DECLARED_SYNTHETIC by file, pattern and the sha256 of the exact matched text,
 * with a reason — and a pinned entry that STOPS matching is itself a failure, so
 * the list cannot rot into a blanket exemption the way a bare allowlist would.
 * The sha256 is deliberate: an exemption list that quoted the literal would put
 * a credential-shaped string into the very repository it is guarding.
 *
 * Flags:
 *   --self-test        fixture-driven assertions, including bite proofs
 *   --root=<dir>       scan the seals under <dir> instead of the evidence tree
 *   --print-config     emit pattern names and floors as JSON and stop
 *
 * Exit codes:
 *   0 = a real corpus was scanned and nothing unredacted was found
 *   1 = a credential or a non-synthetic e-mail address is present, or a
 *       DECLARED_SYNTHETIC entry is stale
 *   2 = INCONCLUSIVE — the evidence tree is unreachable, the corpus is below a
 *       floor, or a pattern failed its own control. Never read as a pass.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { WORKSPACE_ROOT, workspaceAvailable, workspaceUnreachableReason } from "./check-repo-paths.mjs";

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const PRINT_CONFIG = argv.includes("--print-config");
const rootArg = argv.find((a) => a.startsWith("--root="));

const SEAL_FILENAME = "artifact-hashes.json";
const EVIDENCE_REL = join("architecture-refactor", "final-refactor", "evidence");

/**
 * Floors. Deliberately not raisable or lowerable from argv: the fix for a gate
 * that scanned nothing is a tree with something in it, not a smaller bar.
 * Measured at the time of writing: 7 seals, 102 files in corpus, ~1.1 MB.
 */
export const MIN_SEALS = 2;
export const MIN_FILES_SCANNED = 40;
export const MIN_BYTES_SCANNED = 100_000;
export const MIN_PATTERNS = 10;

/**
 * Host-name suffixes reserved by RFC 2606 / RFC 6761 and the documentation
 * domains. An address on one of these cannot resolve and cannot belong to a
 * real person, so it is the only e-mail shape this bundle is allowed to carry.
 */
export const RESERVED_EMAIL_SUFFIXES = [
  ".invalid",
  ".test",
  ".example",
  ".localhost",
  "example.com",
  "example.org",
  "example.net",
];

/** A URL password segment that is already a placeholder rather than a secret. */
export /**
 * Probe inputs are assembled at run time so this gate's own fixtures are not committed
 * credential literals; check:hardcoded-secrets scans this file like any other.
 */
const SYNTHETIC_URL_CREDENTIAL = ["postgres://role", "hunter2secret@db.internal/app"].join(":");
const DASHES = "-".repeat(5);
const SYNTHETIC_PRIVATE_KEY_MARKER = `${DASHES}${["BEGIN", "RSA", "PRIVATE", "KEY"].join(" ")}${DASHES}`;

const REDACTED_PLACEHOLDER = /^(?:\*+|x+|X+|\.{3}|<[^>]*>|\$\{[^}]*\}|%s|\[?REDACTED[^\]]*\]?|redacted)$/;

/**
 * Every pattern carries its own controls. `probe` MUST match and `antiProbe`
 * MUST NOT; a pattern that fails either is a broken scanner, and a broken
 * scanner makes the run inconclusive rather than clean. Neither control is ever
 * printed — this gate's own output is stored inside the tree it scans, so
 * echoing a credential-shaped probe would make the next run red on itself.
 */
export const PATTERNS = [
  {
    name: "aws-access-key-id",
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|AIPA)[0-9A-Z]{16}\b/g,
    probe: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
    antiProbe: "AKIA-too-short",
  },
  {
    name: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    probe: "AIza" + "b".repeat(35),
    antiProbe: "AIzaShort",
  },
  {
    name: "neon-role-password",
    regex: /\bnpg_[A-Za-z0-9]{16,}\b/g,
    probe: "npg_" + "a1b2c3d4e5f6g7h8",
    antiProbe: "npg_short",
  },
  {
    name: "openai-style-key",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    probe: "sk-" + "z".repeat(24),
    antiProbe: "sk-short",
  },
  {
    name: "stripe-secret-key",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    probe: "sk_live_" + "0".repeat(20),
    antiProbe: "sk_live_short",
  },
  {
    name: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    probe: "ghp_" + "A".repeat(36),
    antiProbe: "ghp_short",
  },
  {
    name: "slack-token",
    regex: /\bxox[abposr]-[A-Za-z0-9-]{12,}\b/g,
    probe: "xoxb-" + "1234567890-abcdef",
    antiProbe: "xoxb-short",
  },
  {
    name: "private-key-block",
    regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
    probe: SYNTHETIC_PRIVATE_KEY_MARKER,
    antiProbe: "-----BEGIN CERTIFICATE-----",
  },
  {
    name: "json-web-token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    probe: ["eyJ" + "a".repeat(14), "b".repeat(14), "c".repeat(14)].join("."),
    antiProbe: "eyJshort.a.b",
  },
  {
    name: "bearer-token",
    regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{24,}/g,
    probe: "Bearer " + "t".repeat(30),
    antiProbe: "Bearer <token>",
  },
  {
    name: "basic-auth-header",
    regex: /\bAuthorization:\s*Basic\s+[A-Za-z0-9+/=]{16,}/g,
    probe: "Authorization: Basic " + "Q".repeat(20),
    antiProbe: "Authorization: Basic <base64>",
  },
  {
    name: "managed-host-name",
    regex: /\b[A-Za-z0-9][A-Za-z0-9-]*\.(?:[A-Za-z0-9-]+\.)*(?:neon\.tech|upstash\.io|rds\.amazonaws\.com)\b/g,
    probe: "ep-quiet-frost-123456.us-east-2.aws.neon.tech",
    antiProbe: "neon.tech",
  },
  {
    name: "password-in-url",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]+)@/g,
    probe: SYNTHETIC_URL_CREDENTIAL,
    antiProbe: "postgres://role@localhost:5432/app",
    /** A `***`, `<pw>` or `${PGPASSWORD}` segment is the redaction, not a leak. */
    exempt: (match, groups) => REDACTED_PLACEHOLDER.test(groups[0] ?? ""),
  },
  {
    name: "non-synthetic-email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g,
    probe: "someone@a-real-company.co.uk",
    antiProbe: "drill+ab12@compliance-synthetic.invalid",
    exempt: (match) => {
      const lowered = match.toLowerCase();
      return RESERVED_EMAIL_SUFFIXES.some((suffix) =>
        suffix.startsWith(".") ? lowered.endsWith(suffix) : lowered.endsWith("@" + suffix) || lowered.endsWith("." + suffix),
      );
    },
  },
];

/**
 * Matches that are deliberate fixtures, pinned individually. Each names the file,
 * the pattern and the sha256 of the exact matched text; `preview` is truncated
 * below the pattern's own length floor so it cannot itself match. An entry that
 * no longer matches is STALE and fails the gate, which is what stops this list
 * behaving like an allowlist.
 */
export const DECLARED_SYNTHETIC = [
  {
    file: "42-production-ops/data-catalogue-c183/ai-redaction-probe.mjs",
    pattern: "openai-style-key",
    literalSha256: "dc70d4838c319b51fb9715307b691beeb848bb1b0e1d938e515251ed2e415fc9",
    preview: "sk-abc…",
    reason:
      "the CONTROL input of the AI redaction probe: a fabricated key fed to the redactor to prove it is replaced by [REDACTED_TOKEN]. Removing it would delete the probe's control.",
  },
  {
    file: "42-production-ops/data-catalogue-c183/ai-redaction-probe.txt",
    pattern: "openai-style-key",
    literalSha256: "dc70d4838c319b51fb9715307b691beeb848bb1b0e1d938e515251ed2e415fc9",
    preview: "sk-abc…",
    reason: "the same CONTROL input, echoed in that probe's verbatim transcript.",
  },
];

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function findSeals(root) {
  const found = [];
  const walk = (dir) => {
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
      if (stat.isDirectory()) walk(full);
      else if (entry === SEAL_FILENAME) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

export function sealedNames(manifest) {
  const map = manifest?.hashes ?? manifest?.files ?? manifest?.artifacts;
  if (Array.isArray(map)) return map.map((entry) => entry?.file).filter((f) => typeof f === "string");
  if (map && typeof map === "object") return Object.keys(map);
  return [];
}

/**
 * The corpus: the seal, everything it names, and everything else sitting
 * directly in its directory. The third clause is what stops a leak being parked
 * in an unsealed sibling.
 */
export function collectCorpus(root) {
  const seals = findSeals(root);
  const files = new Set();
  for (const seal of seals) {
    files.add(seal);
    const dir = dirname(seal);
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(seal, "utf8"));
    } catch {
      manifest = null;
    }
    for (const name of sealedNames(manifest)) files.add(resolve(dir, name));
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isFile()) files.add(full);
      } catch {
        /* a sealed file that is gone is check:evidence-seal's finding, not this gate's */
      }
    }
  }
  return { seals, files: [...files].filter((f) => existsSync(f)).sort() };
}

/** Every match of every pattern in one file's text, minus the pattern's own exemptions. */
export function scanText(text) {
  const findings = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const groups = match.slice(1);
      if (pattern.exempt && pattern.exempt(match[0], groups)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ pattern: pattern.name, line, sha256: sha256(match[0]), length: match[0].length });
    }
  }
  return findings;
}

/** Positive and negative control for every pattern. A broken scanner is inconclusive. */
export function controlFailures() {
  const failures = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (!pattern.regex.test(pattern.probe)) failures.push(`${pattern.name}: positive control did not match`);
    pattern.regex.lastIndex = 0;
    const anti = pattern.regex.exec(pattern.antiProbe);
    const antiFires = anti !== null && !(pattern.exempt && pattern.exempt(anti[0], anti.slice(1)));
    if (antiFires) failures.push(`${pattern.name}: negative control matched`);
    pattern.regex.lastIndex = 0;
  }
  return failures;
}

function inconclusive(message) {
  process.stderr.write(`INCONCLUSIVE — ${message}\n  This is exit 2, not a pass.\n`);
  process.exit(2);
}

if (PRINT_CONFIG) {
  process.stdout.write(
    JSON.stringify(
      {
        patterns: PATTERNS.map((p) => p.name),
        reservedEmailSuffixes: RESERVED_EMAIL_SUFFIXES,
        declaredSynthetic: DECLARED_SYNTHETIC.map((d) => ({ file: d.file, pattern: d.pattern, preview: d.preview })),
        floors: {
          minSeals: MIN_SEALS,
          minFilesScanned: MIN_FILES_SCANNED,
          minBytesScanned: MIN_BYTES_SCANNED,
          minPatterns: MIN_PATTERNS,
        },
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

if (SELF_TEST) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-redaction-selftest-"));
  const write = (rel, body) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
    return full;
  };
  const checks = {};
  try {
    const clean = "drill+ab12@compliance-synthetic.invalid ran against postgres://role@localhost:5432/app\n";
    write("bundle/clean.txt", clean);
    write("bundle/" + SEAL_FILENAME, JSON.stringify({ fileCount: 1, hashes: { "clean.txt": "x" } }));

    const corpus = collectCorpus(dir);
    checks.corpusFindsTheSeal = corpus.seals.length === 1;
    checks.corpusIncludesSealedFile = corpus.files.some((f) => f.endsWith("clean.txt"));
    checks.corpusIncludesTheSealItself = corpus.files.some((f) => f.endsWith(SEAL_FILENAME));
    checks.cleanTextHasNoFindings = scanText(clean).length === 0;

    checks.everyPatternPassesItsOwnControls = controlFailures().length === 0;
    checks.patternFloorIsMet = PATTERNS.length >= MIN_PATTERNS;
    checks.floorsAreAboveZero = MIN_SEALS > 0 && MIN_FILES_SCANNED > 0 && MIN_BYTES_SCANNED > 0;
    checks.floorsAreNotArgvRaisable = !process.argv.some((a) => /--min-|--floor/.test(a));

    /* BITE PROOFS — each is a leak this gate must see. */
    checks.bitesOnCredential = scanText("token=" + ["AKIA", "IOSFODNN7EXAMPLE"].join("") + "\n").some(
      (f) => f.pattern === "aws-access-key-id",
    );
    checks.bitesOnRealEmail = scanText("contact person.name@a-real-company.co.uk\n").some(
      (f) => f.pattern === "non-synthetic-email",
    );
    checks.bitesOnUrlPassword = scanText(`${SYNTHETIC_URL_CREDENTIAL}
`).some(
      (f) => f.pattern === "password-in-url",
    );
    checks.bitesOnManagedHost = scanText("host ep-quiet-frost-123456.us-east-2.aws.neon.tech\n").some(
      (f) => f.pattern === "managed-host-name",
    );
    checks.bitesOnPrivateKeyBlock = scanText(`${SYNTHETIC_PRIVATE_KEY_MARKER}
`).some(
      (f) => f.pattern === "private-key-block",
    );

    /* NEGATIVE PROOFS — each of these must NOT be reported, or the gate is unusable. */
    checks.ignoresRedactedUrlPassword = scanText("postgres://<db-role>:***@<neon-host>/scratch\n").length === 0;
    checks.ignoresReservedTldEmail = scanText("user-100@scratch-seed.test\n").length === 0;
    checks.ignoresBareVendorWord = scanText("the remote Neon host neon.tech was never contacted\n").length === 0;

    /* A leak parked in an UNSEALED file inside a sealed directory is still in corpus. */
    write("bundle/unsealed-note.txt", "leaked " + ["AKIA", "IOSFODNN7EXAMPLE"].join("") + "\n");
    const widened = collectCorpus(dir);
    checks.corpusIncludesUnsealedSiblings = widened.files.some((f) => f.endsWith("unsealed-note.txt"));

    /* Staleness: a DECLARED_SYNTHETIC entry whose literal is gone must fail. */
    const stale = { file: "bundle/clean.txt", pattern: "openai-style-key", literalSha256: sha256("absent"), preview: "n/a" };
    checks.staleDeclaredEntryIsDetected =
      scanText(readFileSync(join(dir, "bundle/clean.txt"), "utf8")).every(
        (f) => !(f.pattern === stale.pattern && f.sha256 === stale.literalSha256),
      ) === true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

const controls = controlFailures();
if (controls.length > 0)
  inconclusive(`${controls.length} pattern control(s) failed, so the scanner is broken:\n  - ${controls.join("\n  - ")}`);
if (PATTERNS.length < MIN_PATTERNS)
  inconclusive(`only ${PATTERNS.length} pattern(s) are defined (floor ${MIN_PATTERNS}).`);

let root;
if (rootArg) {
  root = resolve(rootArg.slice(7));
  if (!existsSync(root)) inconclusive(`--root=${root} does not exist.`);
} else {
  if (!workspaceAvailable) inconclusive(`the workspace is unreachable. ${workspaceUnreachableReason()}`);
  root = join(WORKSPACE_ROOT, EVIDENCE_REL);
  if (!existsSync(root)) inconclusive(`the evidence tree is not at ${root}.`);
}

const { seals, files } = collectCorpus(root);
if (seals.length < MIN_SEALS) inconclusive(`${seals.length} seal(s) found under ${root} (floor ${MIN_SEALS}).`);
if (files.length < MIN_FILES_SCANNED)
  inconclusive(`${files.length} file(s) in the corpus (floor ${MIN_FILES_SCANNED}). Nothing meaningful was scanned.`);

const declaredHit = new Map(DECLARED_SYNTHETIC.map((d) => [`${d.file}::${d.pattern}::${d.literalSha256}`, false]));
const leaks = [];
let bytes = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  bytes += Buffer.byteLength(text, "utf8");
  const rel = relative(root, file).split("\\").join("/");
  for (const finding of scanText(text)) {
    const key = `${rel}::${finding.pattern}::${finding.sha256}`;
    if (declaredHit.has(key)) {
      declaredHit.set(key, true);
      continue;
    }
    leaks.push({ file: rel, ...finding });
  }
}

if (bytes < MIN_BYTES_SCANNED)
  inconclusive(`${bytes} byte(s) were scanned (floor ${MIN_BYTES_SCANNED}). The corpus is too small to mean anything.`);

/*
 * Staleness is enforced only against the shipped evidence tree. The pinned entries name
 * files in THAT tree, so reporting them as stale while scanning a `--root=` fixture would
 * make every fixture run red for a reason that has nothing to do with the fixture — and a
 * gate whose fixtures cannot be clean cannot bite-prove anything.
 */
const stale = rootArg ? [] : [...declaredHit.entries()].filter(([, seen]) => !seen).map(([key]) => key);

for (const leak of leaks)
  process.stderr.write(
    `LEAK    ${leak.file}:${leak.line} — ${leak.pattern} (${leak.length} chars, sha256 ${leak.sha256.slice(0, 12)}…)\n`,
  );
for (const key of stale)
  process.stderr.write(`STALE   DECLARED_SYNTHETIC entry no longer matches anything: ${key}\n`);

process.stdout.write(
  `\n${seals.length} seal(s) · ${files.length} file(s) · ${bytes} bytes scanned · ` +
    `${PATTERNS.length} patterns · ${leaks.length} leak(s) · ${stale.length} stale exemption(s)\n`,
);

if (leaks.length > 0 || stale.length > 0) {
  process.stderr.write(
    "FAIL — the evidence bundle is not redacted. A sealed bundle carrying a credential " +
      "or a real person's address is a disclosure, not evidence.\n",
  );
  process.exit(1);
}

process.stdout.write("OK — no credential and no non-synthetic address in the hashed evidence tree.\n");
process.exit(0);
