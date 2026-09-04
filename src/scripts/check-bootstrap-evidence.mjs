#!/usr/bin/env node
/**
 * Gate: the retained head-bootstrap evidence bundle still describes the CURRENT
 * migration chain.
 *
 * PRD-C056 requires release SHA, commands, database identity, journal hash/count,
 * catalog diff, sanitized logs and artifact hashes to be retained "for the
 * current-head bootstrap and migration evidence". The bundle was produced once —
 * `evidence/bootstrap-head-637` — and then the journal moved 637 -> 685 and nothing
 * failed. `check:evidence-seal` kept passing the whole time, because a seal proves
 * the bytes did not change; it cannot notice that what those bytes describe is no
 * longer head. That is the exact way this criterion rotted, so the missing check is
 * not another hash of the bundle, it is a comparison of the bundle against the live
 * chain.
 *
 * Five ways this must fail, all bite-proven in the self-test:
 *   1. no retained bundle describes the current journal count;
 *   2. a bundle claims the current count but its chain/hash-set digest or head tag
 *      disagrees with the live migrations (a migration was edited under it);
 *   3. a per-file hash in the bundle no longer matches the file it names;
 *   4. a clause is present but vacuous — zero logs, zero comparisons, fewer than
 *      three databases, a comparison that is not `differences=0`;
 *   5. a retained log carries a connection string, so "sanitized" is false.
 *
 * And an anti-vacuity floor: a bundle describing fewer than MIN_JOURNAL_ENTRIES
 * migrations cannot satisfy this release, so a truncated journal (or a fixture left
 * behind) fails instead of passing over nothing.
 *
 * Byte integrity of the bundle is NOT re-implemented here — `check:evidence-seal`
 * already owns it. This gate asserts the seal exists and names every retained file.
 *
 * Usage:
 *   node src/scripts/check-bootstrap-evidence.mjs
 *   node src/scripts/check-bootstrap-evidence.mjs --self-test
 *
 * Exit codes:
 *   0  a retained bundle describes the live chain and every clause holds
 *   1  no bundle describes head, or a clause failed
 *   2  INCONCLUSIVE — the workspace or the migrations directory is unreachable
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT, workspaceAvailable, workspaceUnreachableReason } from "./check-repo-paths.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "../..");
const EVIDENCE_REL = join("architecture-refactor", "final-refactor", "evidence");
const BUNDLE_PREFIX = "bootstrap-head-";
const SEAL_FILENAME = "artifact-hashes.json";

/** Floors. A bundle under any of these is describing a corpus too small to be this release. */
export const FLOORS = {
  journalEntries: 685,
  logs: 3,
  comparisons: 2,
  databases: 3,
  commands: 4,
  catalogCategories: 13,
};

/** A retained log that matches any of these is not sanitized. */
const SECRET_PATTERNS = [
  /postgres(?:ql)?:\/\/[^\s"']*@/i,
  /\bpassword\s*=\s*\S/i,
  /[A-Za-z0-9_.-]+\.neon\.tech/i,
  /\bsslmode=/i,
];

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * The canonical recipes are the ones the bootstrap-head-637 bundle recorded and this
 * gate reproduces byte for byte: no trailing newline on either join.
 */
export function journalFacts(migrationsDir) {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const entries = journal.entries;
  const perFile = entries.map((e) => ({
    tag: e.tag,
    sha256: sha256(readFileSync(join(migrationsDir, `${e.tag}.sql`))),
  }));
  const unique = [...new Set(perFile.map((p) => p.sha256))].sort();
  const sqlOnDisk = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const tags = new Set(entries.map((e) => e.tag));
  return {
    entries: entries.length,
    firstTag: entries[0]?.tag ?? null,
    headTag: entries[entries.length - 1]?.tag ?? null,
    headWhen: entries[entries.length - 1]?.when ?? null,
    journalFileSha256: sha256(readFileSync(journalPath)),
    chainDigest: sha256(perFile.map((p) => `${p.tag}:${p.sha256}`).join("\n")),
    hashSetDigest: sha256(unique.join("\n")),
    perFile,
    sqlFilesOnDisk: sqlOnDisk.length,
    orphans: sqlOnDisk.map((f) => f.slice(0, -4)).filter((t) => !tags.has(t)).sort(),
  };
}

function listFilesRecursive(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full, `${prefix}${entry}/`));
    else out.push(`${prefix}${entry}`);
  }
  return out;
}

/**
 * Verify one bundle directory against live journal facts. Returns every failure
 * separately so the report says which clause broke, not "mismatch".
 */
export function verifyBundle(bundleDir, facts, floors = FLOORS, backendRoot = BACKEND_ROOT) {
  const fail = [];
  const manifestPath = join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath)) return { fail: ["manifest.json is absent"], checks: 0 };
  let m;
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { fail: [`manifest.json does not parse: ${String(err)}`], checks: 0 };
  }
  let checks = 0;
  const eq = (label, actual, expected) => {
    checks++;
    if (actual !== expected) fail.push(`${label}: bundle ${String(actual)} != live ${String(expected)}`);
  };
  const atLeast = (label, actual, min) => {
    checks++;
    if (!(actual >= min)) fail.push(`${label}: ${String(actual)} is below the floor of ${min}`);
  };

  // Clause: journal hash/count.
  const j = m.journalAtProofCapture ?? {};
  eq("journal entries", j.entries, facts.entries);
  eq("journal head tag", j.headTag, facts.headTag);
  eq("journal head when", j.headWhen, facts.headWhen);
  eq("_journal.json sha256", j.journalFileSha256, facts.journalFileSha256);
  eq("chain digest", j.chainDigest, facts.chainDigest);
  eq("hash-set digest", j.hashSetDigest, facts.hashSetDigest);
  atLeast("journal entries floor", Number(j.entries), floors.journalEntries);

  // Clause: journal hash/count, per file.
  checks++;
  const perFileRel = j.perFileHashes;
  if (typeof perFileRel !== "string" || !existsSync(join(bundleDir, perFileRel))) {
    fail.push("per-file hash listing is missing from the bundle");
  } else {
    // Tolerates both retained layouts: `<sha256>  <tag>.sql` and the
    // `idx  when  tag  sha256` table the 637 bundle used. The hash is the only
    // 64-hex token on the line; the tag is the only token carrying an underscore.
    const recorded = new Map();
    for (const line of readFileSync(join(bundleDir, perFileRel), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const tokens = t.split(/\s+/);
      const hash = tokens.find((x) => /^[0-9a-f]{64}$/.test(x));
      const tag = tokens.find((x) => /_/.test(x));
      if (hash === undefined || tag === undefined) continue;
      recorded.set(tag.replace(/\.sql$/, ""), hash);
    }
    if (recorded.size !== facts.perFile.length)
      fail.push(`per-file hash listing has ${recorded.size} rows, the journal has ${facts.perFile.length}`);
    const drifted = facts.perFile.filter((p) => recorded.get(p.tag) !== p.sha256);
    if (drifted.length > 0)
      fail.push(`per-file hash listing disagrees with ${drifted.length} migration(s), first: ${drifted[0].tag}`);
  }

  // Clause: release SHA.
  const rel = m.releaseIdentity ?? {};
  for (const side of ["backend", "frontend"]) {
    checks++;
    const sha = rel[side]?.shaAtProofCapture;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha))
      fail.push(`release SHA for ${side} is absent or not a full 40-hex commit id`);
  }

  // Clause: commands.
  const commands = Array.isArray(m.commands) ? m.commands : [];
  atLeast("commands recorded", commands.length, floors.commands);
  for (const c of commands) {
    checks++;
    if (typeof c?.command !== "string" || c.command.trim() === "") fail.push("a recorded command is empty");
    else if (typeof c?.script !== "string" || !existsSync(join(backendRoot, c.script)))
      fail.push(`recorded command names a script that does not exist: ${String(c?.script)}`);
  }

  // Clause: database identity.
  const targets = Array.isArray(m.databaseIdentity?.targets) ? m.databaseIdentity.targets : [];
  atLeast("databases recorded", targets.length, floors.databases);
  for (const t of targets) {
    checks++;
    if (!t?.database || !t?.role || !m.databaseIdentity?.hostPort || !m.databaseIdentity?.server)
      fail.push(`database identity is incomplete for ${String(t?.database)}`);
    else if (t.ledgerRows !== facts.entries)
      fail.push(`${t.database} ledger has ${String(t.ledgerRows)} rows, the journal has ${facts.entries}`);
  }
  checks++;
  if (SECRET_PATTERNS.some((p) => p.test(JSON.stringify(m))))
    fail.push("the manifest itself carries a connection string");

  // Clause: catalog diff.
  const comparisons = Array.isArray(m.results?.catalogDiff) ? m.results.catalogDiff : [];
  atLeast("catalog comparisons", comparisons.length, floors.comparisons);
  for (const c of comparisons) {
    checks++;
    const logPath = join(bundleDir, String(c?.log ?? ""));
    if (!c?.log || !existsSync(logPath)) {
      fail.push(`catalog comparison "${String(c?.label)}" names a log that is absent`);
      continue;
    }
    const body = readFileSync(logPath, "utf8");
    const passes = (body.match(/^PASS\s+\w+/gm) ?? []).length;
    if (c.differences !== 0) fail.push(`catalog comparison "${c.label}" records differences=${String(c.differences)}`);
    if (!/RESULT:\s*SCHEMAS IDENTICAL\s+differences=0/.test(body))
      fail.push(`catalog comparison log ${c.log} does not end in SCHEMAS IDENTICAL differences=0`);
    if (passes < floors.catalogCategories)
      fail.push(`catalog comparison log ${c.log} shows ${passes} PASS categories, floor is ${floors.catalogCategories}`);
  }

  // Clause: sanitized logs.
  const logs = Array.isArray(m.logs) ? m.logs : [];
  atLeast("retained logs", logs.length, floors.logs);
  for (const l of logs) {
    checks++;
    const p = join(bundleDir, String(l?.file ?? ""));
    if (!l?.file || !existsSync(p)) {
      fail.push(`retained log is absent: ${String(l?.file)}`);
      continue;
    }
    const body = readFileSync(p, "utf8");
    const hit = SECRET_PATTERNS.find((re) => re.test(body));
    if (hit) fail.push(`retained log ${l.file} is not sanitized — it matches ${hit}`);
  }
  checks++;
  const bootstrapLogs = (m.results?.cleanBootstraps ?? []).map((b) => b?.log).filter(Boolean);
  for (const relLog of bootstrapLogs) {
    const p = join(bundleDir, String(relLog));
    if (!existsSync(p)) fail.push(`clean-bootstrap log is absent: ${relLog}`);
    else if (!new RegExp(`RESULT:\\s*REACHED_HEAD\\s+${facts.entries}/${facts.entries}`).test(readFileSync(p, "utf8")))
      fail.push(`clean-bootstrap log ${relLog} does not record REACHED_HEAD ${facts.entries}/${facts.entries}`);
  }
  if (bootstrapLogs.length < 2) fail.push(`only ${bootstrapLogs.length} clean bootstrap(s) recorded, two independent ones are required`);

  // Clause: artifact hashes.
  checks++;
  const sealPath = join(bundleDir, SEAL_FILENAME);
  if (!existsSync(sealPath)) {
    fail.push("artifact-hashes.json is absent — nothing seals this bundle");
  } else {
    const seal = JSON.parse(readFileSync(sealPath, "utf8"));
    const sealed = new Set(Object.keys(seal.hashes ?? seal.files ?? {}));
    const present = listFilesRecursive(bundleDir).filter((f) => f !== SEAL_FILENAME);
    const unsealed = present.filter((f) => !sealed.has(f));
    if (unsealed.length > 0) fail.push(`${unsealed.length} bundle file(s) are outside the seal, first: ${unsealed[0]}`);
  }

  return { fail, checks };
}

export function findBundles(evidenceDir) {
  if (!existsSync(evidenceDir)) return [];
  return readdirSync(evidenceDir)
    .filter((d) => d.startsWith(BUNDLE_PREFIX))
    .filter((d) => statSync(join(evidenceDir, d)).isDirectory())
    .sort();
}

/* ------------------------------------------------------------------ self-test */

function fixture(root, { entries = 3, breakChain = false } = {}) {
  const mig = join(root, "migrations");
  mkdirSync(join(mig, "meta"), { recursive: true });
  const tags = [];
  for (let i = 0; i < entries; i++) {
    const tag = `000${i}_fixture`;
    tags.push({ idx: i, version: "7", when: 1000 + i, tag, breakpoints: true });
    writeFileSync(join(mig, `${tag}.sql`), `SELECT ${i};\n`);
  }
  writeFileSync(join(mig, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: tags }, null, 2));
  const facts = journalFacts(mig);

  const bundle = join(root, `${BUNDLE_PREFIX}${facts.entries}`);
  mkdirSync(join(bundle, "logs"), { recursive: true });
  const categories = "tables columns constraints indexes policies functions triggers extensions enums rlsState sequences views migrationLedger".split(" ");
  const cmpLog = ["Bootstrap parity comparison", ...categories.map((c) => `PASS  ${c}   A=     1  B=     1`), "", "RESULT: SCHEMAS IDENTICAL  differences=0", ""].join("\n");
  writeFileSync(join(bundle, "logs", "cmp-a-b.log"), cmpLog);
  writeFileSync(join(bundle, "logs", "cmp-a-ir.log"), cmpLog);
  const bootLog = `OK    [${facts.headTag}]\n\nRESULT: REACHED_HEAD ${facts.entries}/${facts.entries}\n`;
  writeFileSync(join(bundle, "logs", "boot-a.log"), bootLog);
  writeFileSync(join(bundle, "logs", "boot-b.log"), bootLog);
  writeFileSync(join(bundle, "logs", "boot-ir.log"), bootLog);
  writeFileSync(join(bundle, "journal-file-hashes.txt"), facts.perFile.map((p) => `${p.sha256}  ${p.tag}.sql`).join("\n") + "\n");

  const manifest = {
    bundle: `${BUNDLE_PREFIX}${facts.entries}`,
    releaseIdentity: {
      backend: { shaAtProofCapture: "a".repeat(40) },
      frontend: { shaAtProofCapture: "b".repeat(40) },
    },
    journalAtProofCapture: {
      entries: facts.entries,
      headTag: facts.headTag,
      headWhen: facts.headWhen,
      journalFileSha256: facts.journalFileSha256,
      chainDigest: breakChain ? "0".repeat(64) : facts.chainDigest,
      hashSetDigest: facts.hashSetDigest,
      perFileHashes: "journal-file-hashes.txt",
    },
    databaseIdentity: {
      server: "PostgreSQL 18.4",
      hostPort: "127.0.0.1:5432",
      targets: [
        { database: "fx_a", role: "r", ledgerRows: facts.entries },
        { database: "fx_b", role: "r", ledgerRows: facts.entries },
        { database: "fx_ir", role: "r", ledgerRows: facts.entries },
      ],
    },
    commands: [1, 2, 3, 4].map(() => ({ command: "node src/scripts/db-bootstrap.mjs", script: "src/scripts/db-bootstrap.mjs" })),
    results: {
      cleanBootstraps: [{ log: "logs/boot-a.log" }, { log: "logs/boot-b.log" }],
      interruptedResume: { log: "logs/boot-ir.log" },
      catalogDiff: [
        { label: "a vs b", log: "logs/cmp-a-b.log", differences: 0 },
        { label: "a vs ir", log: "logs/cmp-a-ir.log", differences: 0 },
      ],
    },
    logs: [{ file: "logs/boot-a.log" }, { file: "logs/boot-b.log" }, { file: "logs/boot-ir.log" }],
  };
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest, null, 2));

  const hashes = {};
  for (const f of listFilesRecursive(bundle)) hashes[f] = sha256(readFileSync(join(bundle, f)));
  writeFileSync(join(bundle, SEAL_FILENAME), JSON.stringify({ bundle: manifest.bundle, hashes }, null, 2));

  return { mig, bundle, facts, manifest };
}

const LOOSE = { ...FLOORS, journalEntries: 1 };

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, cond) => (cond ? passed++ : failures.push(label));
  const root = mkdtempSync(join(tmpdir(), "bootstrap-evidence-"));
  const rewrite = (bundle, mutate) => {
    const p = join(bundle, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    mutate(m);
    writeFileSync(p, JSON.stringify(m, null, 2));
    const seal = JSON.parse(readFileSync(join(bundle, SEAL_FILENAME), "utf8"));
    seal.hashes["manifest.json"] = sha256(readFileSync(p));
    writeFileSync(join(bundle, SEAL_FILENAME), JSON.stringify(seal, null, 2));
  };
  try {
    const { mig, bundle, facts } = fixture(root);
    assert("a complete bundle passes", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.length === 0);
    assert("a complete bundle runs more than 20 checks", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).checks > 20);

    // (1) the bundle no longer describes head
    const root2 = mkdtempSync(join(tmpdir(), "bootstrap-evidence-b-"));
    const grown = fixture(root2, { entries: 4 });
    assert(
      "a bundle describing a different journal count fails",
      verifyBundle(bundle, grown.facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.startsWith("journal entries:")),
    );
    rmSync(root2, { recursive: true, force: true });

    // (2) a migration was edited under a bundle that still claims the same count
    writeFileSync(join(mig, `${facts.headTag}.sql`), "SELECT 999;\n");
    const edited = journalFacts(mig);
    const afterEdit = verifyBundle(bundle, edited, LOOSE, BACKEND_ROOT).fail;
    assert("an edited migration breaks the chain digest", afterEdit.some((f) => f.startsWith("chain digest:")));
    assert("an edited migration breaks the per-file listing", afterEdit.some((f) => f.includes("per-file hash listing disagrees")));
    writeFileSync(join(mig, `${facts.headTag}.sql`), `SELECT ${facts.entries - 1};\n`);
    assert("restoring the migration restores the pass", verifyBundle(bundle, journalFacts(mig), LOOSE, BACKEND_ROOT).fail.length === 0);

    // (3) vacuity — the clause is present but empty
    rewrite(bundle, (m) => { m.logs = []; });
    assert("zero retained logs fails the floor", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.startsWith("retained logs:")));
    rewrite(bundle, (m) => { m.logs = [{ file: "logs/boot-a.log" }, { file: "logs/boot-b.log" }, { file: "logs/boot-ir.log" }]; });

    rewrite(bundle, (m) => { m.results.catalogDiff[0].differences = 4; });
    assert("a comparison with differences fails", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.includes("records differences=4")));
    rewrite(bundle, (m) => { m.results.catalogDiff[0].differences = 0; });

    rewrite(bundle, (m) => { m.databaseIdentity.targets = m.databaseIdentity.targets.slice(0, 1); });
    assert("fewer than three databases fails the floor", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.startsWith("databases recorded:")));
    rewrite(bundle, (m) => {
      m.databaseIdentity.targets = ["fx_a", "fx_b", "fx_ir"].map((d) => ({ database: d, role: "r", ledgerRows: facts.entries }));
    });

    rewrite(bundle, (m) => { m.databaseIdentity.targets[0].ledgerRows = 2; });
    assert("a target whose ledger disagrees with the journal fails", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.includes("ledger has 2 rows")));
    rewrite(bundle, (m) => { m.databaseIdentity.targets[0].ledgerRows = facts.entries; });

    rewrite(bundle, (m) => { m.releaseIdentity.backend.shaAtProofCapture = "not-a-sha"; });
    assert("a release SHA that is not a commit id fails", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.includes("release SHA for backend")));
    rewrite(bundle, (m) => { m.releaseIdentity.backend.shaAtProofCapture = "a".repeat(40); });

    rewrite(bundle, (m) => { m.commands[0].script = "src/scripts/does-not-exist.mjs"; });
    assert("a command naming a script that does not exist fails", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.includes("does-not-exist")));
    rewrite(bundle, (m) => { m.commands[0].script = "src/scripts/db-bootstrap.mjs"; });

    // (4) sanitization
    const logPath = join(bundle, "logs", "boot-a.log");
    const clean = readFileSync(logPath, "utf8");
    writeFileSync(logPath, `${clean}connecting to postgresql://user:hunter2@db.example.neon.tech/neondb\n`);
    assert("a log carrying a connection string fails", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.includes("is not sanitized")));
    writeFileSync(logPath, clean);

    // (5) the seal must cover every retained file
    writeFileSync(join(bundle, "logs", "stowaway.log"), "added after sealing\n");
    assert("a file added after sealing fails", verifyBundle(bundle, facts, LOOSE, BACKEND_ROOT).fail.some((f) => f.includes("outside the seal")));
    rmSync(join(bundle, "logs", "stowaway.log"));

    // (6) the production floor itself bites
    assert(
      "the production journal floor rejects a 3-entry bundle",
      verifyBundle(bundle, facts, FLOORS, BACKEND_ROOT).fail.some((f) => f.startsWith("journal entries floor:")),
    );

    // (7) a missing bundle is a failure, never a silent pass
    assert("an absent bundle fails", verifyBundle(join(root, "no-such-bundle"), facts, LOOSE, BACKEND_ROOT).fail.length > 0);
    assert("the bundle is discoverable by prefix", findBundles(root).length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`check-bootstrap-evidence self-tests: ${failures.length} FAILED`);
    for (const f of failures) console.error(`  FAIL  ${f}`);
    process.exit(1);
  }
  console.log(`check-bootstrap-evidence self-tests: ${passed} passed`);
  process.exit(0);
}

/* ----------------------------------------------------------------------- main */

if (SELF_TEST) runSelfTest();

const migrationsDir = join(BACKEND_ROOT, "migrations");
if (!existsSync(join(migrationsDir, "meta", "_journal.json"))) {
  console.error("INCONCLUSIVE — check:bootstrap-evidence: migrations/meta/_journal.json is unreadable.");
  process.exit(2);
}
if (!workspaceAvailable) {
  console.error("INCONCLUSIVE — check:bootstrap-evidence: the evidence tree could not be reached.");
  console.error(`  ${workspaceUnreachableReason()}`);
  process.exit(2);
}

const facts = journalFacts(migrationsDir);
const evidenceDir = join(WORKSPACE_ROOT, EVIDENCE_REL);
const bundles = findBundles(evidenceDir);

console.log("check-bootstrap-evidence");
console.log(`  live chain: ${facts.entries} journalled migrations, head ${facts.headTag}`);
console.log(`  chain digest ${facts.chainDigest.slice(0, 16)}…  hash-set ${facts.hashSetDigest.slice(0, 16)}…`);
console.log(`  retained bundles: ${bundles.length === 0 ? "none" : bundles.join(", ")}`);

if (bundles.length === 0) {
  console.error(`\nFAIL — no ${BUNDLE_PREFIX}* bundle is retained under ${EVIDENCE_REL}.`);
  process.exit(1);
}

const results = bundles.map((b) => ({ name: b, ...verifyBundle(join(evidenceDir, b), facts) }));
const current = results.filter((r) => r.fail.length === 0);

console.log("");
for (const r of results) {
  if (r.fail.length === 0) console.log(`OK    ${r.name} — ${r.checks} checks, describes the live chain`);
  else console.log(`stale ${r.name} — ${r.fail.length} clause(s) do not hold`);
}

if (current.length > 0) {
  console.log(`\nOK — ${current.length} retained bundle(s) describe the current head bootstrap.`);
  process.exit(0);
}

console.error("\nFAIL — no retained bundle describes the current migration chain.");
for (const r of results) {
  console.error(`\n  ${r.name}:`);
  for (const f of r.fail.slice(0, 12)) console.error(`    ${f}`);
  if (r.fail.length > 12) console.error(`    … and ${r.fail.length - 12} more`);
}
console.error("\nRecapture: re-run the bootstraps against fresh databases and write a new");
console.error(`${EVIDENCE_REL}/${BUNDLE_PREFIX}<n> bundle. See the newest bundle's README.md > Recapture.`);
process.exit(1);
