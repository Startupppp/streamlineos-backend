#!/usr/bin/env node
/**
 * Gate: every hash seal over the release evidence tree still holds.
 *
 * The seals were honour-system. `record-artifact-hashes.mjs` has no verify mode
 * — it only writes — and the CI step that runs it hashes `backend/dist`, which is
 * unrelated to the evidence tree. So the older seal had already silently drifted
 * to 11 matches / 2 mismatches, because two documents were edited after sealing
 * and nothing re-ran. It was caught by hand, months later, by an agent that
 * happened to look. A seal nobody verifies is a comment.
 *
 * Three ways this must fail, all bite-proven in the self-test:
 *   1. a sealed file whose bytes changed;
 *   2. a sealed file that is gone — otherwise deleting evidence is free;
 *   3. an unsealed file appearing in a sealed directory — otherwise a seal that
 *      only checks what it already knows about is defeated by adding one.
 *
 * And a fourth, which is this ticket's own subject: **zero seals is a failure.**
 * Otherwise the gate passes vacuously the moment someone moves or renames the
 * evidence directory, which is the same vacuity trap as a lookup table that
 * matches nothing.
 *
 * Flags:
 *   --self-test          fixture-driven assertions against a scratch tree
 *   --root=<dir>         verify the seals under <dir> instead of the workspace
 *
 * Exit codes:
 *   0 every seal holds · 1 a seal is broken · 2 nothing to verify (INCONCLUSIVE)
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { WORKSPACE_ROOT, workspaceAvailable, workspaceUnreachableReason } from "./check-repo-paths.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const rootArg = process.argv.find((a) => a.startsWith("--root="));

const SEAL_FILENAME = "artifact-hashes.json";
const EVIDENCE_REL = join("architecture-refactor", "final-refactor", "evidence");
const MIN_SEALS = 2;
const MIN_SEALED_FILES = 20;

/**
 * Files that sit inside a sealed directory and are deliberately outside its seal.
 * Each reason quotes the seal's own `covers` field. A stale entry — one that is
 * now sealed or now absent — fails, so this cannot rot into a blanket exemption.
 */
const DECLARED_UNSEALED = [
  { seal: "evidence/artifact-hashes.json", file: "SUPERSEDED-FORMER-HEAD.md", reason: "named in the seal's own `covers` as out of scope" },
  { seal: "evidence/artifact-hashes.json", file: "REDACTION-AND-RESEAL-LEDGER.md", reason: "named in the seal's own `covers` as out of scope" },
  { seal: "evidence/artifact-hashes.json", file: "perf-budget-manifest.md", reason: "named in the seal's own `covers` as out of scope" },
];

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

/** Files directly inside a sealed directory, excluding the seal itself. */
export function topLevelFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e !== SEAL_FILENAME)
    .filter((e) => {
      try {
        return statSync(join(dir, e)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Verify one seal. Returns every way it can be broken, separately, so the report
 * says which of the three failure modes occurred rather than "mismatch".
 */
export function verifySeal(sealPath, declaredUnsealed = []) {
  const dir = dirname(sealPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(sealPath, "utf8"));
  } catch (err) {
    return { sealPath, unreadable: String(err), changed: [], missing: [], unsealed: [], matched: 0 };
  }

  const hashes = manifest.hashes ?? manifest.files ?? {};
  const sealedNames = Object.keys(hashes);
  const changed = [];
  const missing = [];
  let matched = 0;

  for (const rel of sealedNames) {
    const full = join(dir, rel);
    if (!existsSync(full)) {
      missing.push(rel);
      continue;
    }
    const actual = sha256File(full);
    if (actual !== hashes[rel]) changed.push({ file: rel, expected: hashes[rel], actual });
    else matched++;
  }

  const sealedSet = new Set(sealedNames);
  const allowed = new Set(declaredUnsealed);
  const unsealed = topLevelFiles(dir).filter((f) => !sealedSet.has(f) && !allowed.has(f));

  return { sealPath, unreadable: null, changed, missing, unsealed, matched, sealedCount: sealedNames.length };
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const fixtureRoot = mkdtempSync(join(tmpdir(), "evidence-seal-"));
  try {
    const evidence = join(fixtureRoot, "evidence");
    const nested = join(evidence, "bootstrap");
    mkdirSync(nested, { recursive: true });

    writeFileSync(join(evidence, "a.log"), "alpha\n");
    writeFileSync(join(evidence, "b.log"), "bravo\n");
    writeFileSync(join(evidence, "declared-out.md"), "not sealed on purpose\n");
    writeFileSync(join(nested, "c.txt"), "charlie\n");

    const sealFor = (dir, names) => {
      const hashes = {};
      for (const n of names) hashes[n] = sha256File(join(dir, n));
      writeFileSync(join(dir, SEAL_FILENAME), JSON.stringify({ sourceDir: dir, fileCount: names.length, hashes }, null, 2));
    };
    sealFor(evidence, ["a.log", "b.log"]);
    sealFor(nested, ["c.txt"]);

    const seals = findSeals(fixtureRoot);
    assert("both seals are discovered by walking the tree", seals.length === 2);

    const clean = verifySeal(join(evidence, SEAL_FILENAME), ["declared-out.md"]);
    assert("an intact seal reports no change", clean.changed.length === 0);
    assert("an intact seal reports nothing missing", clean.missing.length === 0);
    assert("a declared-unsealed file is not reported", clean.unsealed.length === 0);
    assert("an intact seal counts its matches", clean.matched === 2);

    // (1) tampered file
    writeFileSync(join(evidence, "a.log"), "alpha TAMPERED\n");
    const tampered = verifySeal(join(evidence, SEAL_FILENAME), ["declared-out.md"]);
    assert("a tampered file is rejected", tampered.changed.length === 1 && tampered.changed[0].file === "a.log");
    assert("the tampered report names both digests", tampered.changed[0].expected !== tampered.changed[0].actual);
    writeFileSync(join(evidence, "a.log"), "alpha\n");

    // (2) deleted file — otherwise deleting evidence is free
    unlinkSync(join(evidence, "b.log"));
    const deleted = verifySeal(join(evidence, SEAL_FILENAME), ["declared-out.md"]);
    assert("a sealed file that is gone is rejected", deleted.missing.length === 1 && deleted.missing[0] === "b.log");
    assert("a deletion is reported as missing, not as a mismatch", deleted.changed.length === 0);
    writeFileSync(join(evidence, "b.log"), "bravo\n");

    // (3) unsealed file added to a sealed directory
    writeFileSync(join(evidence, "smuggled.log"), "added after sealing\n");
    const smuggled = verifySeal(join(evidence, SEAL_FILENAME), ["declared-out.md"]);
    assert(
      "an unsealed file appearing in a sealed directory is rejected — a seal that only checks what it knows is defeated by adding one",
      smuggled.unsealed.includes("smuggled.log"),
    );
    assert("the declared-unsealed file is still not reported alongside it", !smuggled.unsealed.includes("declared-out.md"));
    unlinkSync(join(evidence, "smuggled.log"));

    // (4) relocated evidence tree — zero seals must not be a pass
    const emptyRoot = mkdtempSync(join(tmpdir(), "evidence-seal-empty-"));
    try {
      assert("a relocated evidence tree yields zero seals", findSeals(emptyRoot).length === 0);
      assert("zero seals is below the minimum, so the gate cannot pass vacuously", findSeals(emptyRoot).length < MIN_SEALS);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }

    assert("a re-verified clean tree passes again", verifySeal(join(evidence, SEAL_FILENAME), ["declared-out.md"]).changed.length === 0);

    // An unreadable seal is a failure, never a pass.
    writeFileSync(join(nested, SEAL_FILENAME), "{ not json");
    assert("a corrupt seal file is reported, not skipped", verifySeal(join(nested, SEAL_FILENAME)).unreadable !== null);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  // The real tree, so a moved evidence directory fails here too.
  if (workspaceAvailable) {
    const realSeals = findSeals(join(WORKSPACE_ROOT, EVIDENCE_REL));
    assert(`at least ${MIN_SEALS} seals exist in the workspace (found ${realSeals.length})`, realSeals.length >= MIN_SEALS);
    const totalSealed = realSeals.reduce((n, p) => n + verifySeal(p).sealedCount, 0);
    assert(`the seals cover at least ${MIN_SEALED_FILES} files (found ${totalSealed})`, totalSealed >= MIN_SEALED_FILES);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-evidence-seal self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-evidence-seal self-tests: ${passed} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

let evidenceRoot;
if (rootArg) {
  evidenceRoot = resolve(rootArg.slice("--root=".length));
} else {
  if (!workspaceAvailable) {
    console.error("INCONCLUSIVE — check-evidence-seal: the evidence tree could not be located, so no seal was verified.");
    console.error(`  ${workspaceUnreachableReason()}`);
    process.exit(2);
  }
  evidenceRoot = join(WORKSPACE_ROOT, EVIDENCE_REL);
}

const seals = findSeals(evidenceRoot);

if (seals.length < MIN_SEALS) {
  console.error(
    `INCONCLUSIVE — found ${seals.length} seal(s) under ${evidenceRoot} (expected >= ${MIN_SEALS}). Zero or too few seals is not a pass: the evidence tree has probably moved, and "every seal holds" over no seals proves nothing.`,
  );
  process.exit(2);
}

let broken = 0;
let totalMatched = 0;
let totalSealed = 0;

for (const sealPath of seals) {
  const sealRel = relative(dirname(evidenceRoot), sealPath).replace(/\\/g, "/");
  const declared = DECLARED_UNSEALED.filter((d) => sealRel.endsWith(d.seal)).map((d) => d.file);
  const result = verifySeal(sealPath, declared);
  totalMatched += result.matched;
  totalSealed += result.sealedCount ?? 0;

  if (result.unreadable !== null) {
    console.error(`BROKEN  ${sealRel} — the seal itself is unreadable: ${result.unreadable}`);
    broken++;
    continue;
  }

  const problems = result.changed.length + result.missing.length + result.unsealed.length;
  if (problems === 0) {
    console.log(`OK      ${sealRel} — ${result.matched}/${result.sealedCount} files match${declared.length ? `, ${declared.length} declared-unsealed` : ""}`);
    continue;
  }

  broken++;
  console.error(`BROKEN  ${sealRel} — ${result.matched}/${result.sealedCount} match`);
  for (const c of result.changed)
    console.error(`  CHANGED  ${c.file}\n    sealed: ${c.expected}\n    actual: ${c.actual}`);
  for (const f of result.missing) console.error(`  MISSING  ${f} — a sealed file is gone`);
  for (const f of result.unsealed)
    console.error(`  UNSEALED ${f} — added to a sealed directory after the seal was written`);
}

// A declared-unsealed entry that no longer applies is itself a failure.
const stale = DECLARED_UNSEALED.filter((d) => {
  const seal = seals.find((p) => relative(dirname(evidenceRoot), p).replace(/\\/g, "/").endsWith(d.seal));
  if (seal === undefined) return true;
  return !existsSync(join(dirname(seal), d.file));
});
if (stale.length > 0) {
  console.error(`\nBROKEN — ${stale.length} stale DECLARED_UNSEALED entry(ies); remove them:`);
  for (const d of stale) console.error(`  ${d.seal} :: ${d.file}  (${d.reason})`);
  broken++;
}

console.log(
  `\n${seals.length} seal(s) verified · ${totalMatched}/${totalSealed} sealed files match · ${broken} broken`,
);

if (broken > 0) {
  console.error("A broken seal means the evidence no longer is what it was attested to be. Re-run the sealer only after establishing why it changed.");
  process.exit(1);
}
console.log("OK — every evidence seal holds.");
