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
 * ---------------------------------------------------------------------------
 * 2026-09-04 (v2 ticket 30) — A FIFTH, one level down: **a seal that attests to
 * nothing must not read as verified.**
 *
 * The manifest reader was `manifest.hashes ?? manifest.files ?? {}` — a bare
 * fallback to an empty object. Any manifest whose file list sat under a key it
 * did not recognise resolved to zero sealed files, and zero of zero files match,
 * so the seal printed `OK … 0/0 files match` and the run exited 0. The aggregate
 * floor could not catch it either: MIN_SEALED_FILES existed only inside the
 * self-test, and the other seals' 80 files satisfied it whatever any one seal
 * did. Reproduced against a manifest listing two files under `artifacts` that do
 * not exist on disk: `2 seal(s) verified · 1/1 sealed files match · 0 broken`,
 * exit 0.
 *
 * So the reader now NORMALISES the shapes that exist (`hashes`/`files` as a map,
 * `artifacts`/`files` as an array of `{file, sha256}`), and anything it cannot
 * recognise is BROKEN by name and by key list rather than empty. A recognised
 * but EMPTY seal is broken too: attesting to nothing is not the same as holding.
 *
 * Flags:
 *   --self-test          fixture-driven assertions against a scratch tree
 *   --root=<dir>         verify the seals under <dir> instead of the workspace
 *
 * Exit codes:
 *   0 every seal holds · 1 a seal is broken · 2 nothing to verify (INCONCLUSIVE)
 */

import { execFileSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
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

const TEXT_EVIDENCE = /\.(md|txt|json|sql|mjs|ts|js|csv|log|yml|yaml|sh|ps1|patch|diff|conf|ini)$/i;

/**
 * Text evidence is hashed with line endings normalised to LF, because a Windows
 * checkout rewrites LF to CRLF and that is a transport artifact, not a change to
 * what was attested. Binary evidence is still hashed byte for byte. This is the
 * digest the report prints as `actual`.
 */
export function sha256File(filePath) {
  const bytes = readFileSync(filePath);
  const normalised = bytes.toString("utf8").split("\r\n").join("\n");
  const content = TEXT_EVIDENCE.test(filePath) ? Buffer.from(normalised, "utf8") : bytes;
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Every digest a seal over this file may legitimately carry.
 *
 * ---------------------------------------------------------------------------
 * 2026-09-12 — normalising to ONE form was only half the fix.
 *
 * The docblock above already said the right thing ("Seals in this tree were
 * taken on both forms, so a byte hash can never be green for all of them on one
 * platform") — and then compared against LF only. A seal taken on a Windows
 * checkout hashes the CRLF bytes, so it mismatched on every run, forever, and
 * no amount of re-sealing fixes it for both platforms at once.
 *
 * Measured on the live tree: 38 of 106 sealed files were reported CHANGED while
 * `git status` showed the evidence directory clean, and every single one of the
 * 38 matched its seal EXACTLY under the CRLF form. Zero matched neither form.
 * That is not evidence drift, it is the gate comparing against the wrong
 * normalisation.
 *
 * Accepting both forms narrows nothing, because the two forms differ only in
 * line endings: a file whose CONTENT changed matches neither, so all four
 * failure modes still bite. The self-test proves that directly — a CRLF-sealed
 * file that is ALSO tampered with is still rejected.
 */
export function sha256FileVariants(filePath) {
  const bytes = readFileSync(filePath);
  const digest = (buf) => createHash("sha256").update(buf).digest("hex");
  if (!TEXT_EVIDENCE.test(filePath)) return [digest(bytes)];
  const lf = bytes.toString("utf8").split("\r\n").join("\n");
  return [digest(Buffer.from(lf, "utf8")), digest(Buffer.from(lf.split("\n").join("\r\n"), "utf8"))];
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
 * Resolve a manifest to `{ file -> sha256 }`, or to `null` when its shape is not
 * one this gate understands.
 *
 * `null` is the whole point. The previous reader fell back to `{}`, which is
 * indistinguishable from a seal covering nothing — and a seal covering nothing
 * passes every check below it. Two shapes exist in the tree and both are
 * accepted; a third one is a defect to report, never a silent empty.
 */
export function normaliseSealHashes(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
    return { hashes: null, shape: null };

  const asMap = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const out = {};
    for (const [file, digest] of Object.entries(value)) {
      if (typeof file !== "string" || file === "" || typeof digest !== "string" || digest === "") return null;
      out[file] = digest;
    }
    return out;
  };

  const asList = (value) => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const out = {};
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      const file = entry.file ?? entry.path ?? entry.name;
      const digest = entry.sha256 ?? entry.hash ?? entry.digest;
      if (typeof file !== "string" || file === "" || typeof digest !== "string" || digest === "") return null;
      out[file] = digest;
    }
    return out;
  };

  for (const key of ["hashes", "files"]) {
    const map = asMap(manifest[key]);
    if (map !== null) return { hashes: map, shape: key };
  }
  for (const key of ["artifacts", "files", "entries"]) {
    const list = asList(manifest[key]);
    if (list !== null) return { hashes: list, shape: `${key}[]` };
  }
  return { hashes: null, shape: null };
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
    return {
      sealPath,
      unreadable: String(err),
      unrecognised: null,
      changed: [],
      missing: [],
      unsealed: [],
      matched: 0,
      sealedCount: 0,
      shape: null,
    };
  }

  const { hashes, shape } = normaliseSealHashes(manifest);
  if (hashes === null) {
    const keys = manifest !== null && typeof manifest === "object" ? Object.keys(manifest) : [];
    return {
      sealPath,
      unreadable: null,
      unrecognised: `the seal declares no recognisable file list (keys: ${keys.length ? keys.join(", ") : "none"})`,
      changed: [],
      missing: [],
      unsealed: [],
      matched: 0,
      sealedCount: 0,
      shape: null,
    };
  }
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
    // Both line-ending normalisations are accepted; see `sha256FileVariants`.
    const accepted = sha256FileVariants(full);
    if (!accepted.includes(hashes[rel]))
      changed.push({ file: rel, expected: hashes[rel], actual: sha256File(full) });
    else matched++;
  }

  const sealedSet = new Set(sealedNames);
  const allowed = new Set(declaredUnsealed);
  const unsealed = topLevelFiles(dir).filter((f) => !sealedSet.has(f) && !allowed.has(f));

  return {
    sealPath,
    unreadable: null,
    unrecognised: null,
    changed,
    missing,
    unsealed,
    matched,
    sealedCount: sealedNames.length,
    shape,
  };
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

    // (5) LINE ENDINGS, both directions — the 2026-09-12 defect. A seal taken on
    // a CRLF checkout must verify against the same evidence checked out LF, and
    // the reverse. Until this, only the LF direction worked, so 38 of 106 files
    // in the live tree read as CHANGED while their content was untouched.
    {
      const crlfDir = join(fixtureRoot, "crlf");
      mkdirSync(crlfDir, { recursive: true });
      const body = "line one\nline two\nline three\n";
      const digest = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

      // Sealed as CRLF (Windows), on disk as LF (macOS/Linux).
      writeFileSync(join(crlfDir, "taken-on-windows.log"), body);
      // Sealed as LF, on disk as CRLF.
      writeFileSync(join(crlfDir, "taken-on-linux.log"), body.split("\n").join("\r\n"));
      // Sealed as CRLF AND edited since — content differs, not just endings.
      writeFileSync(join(crlfDir, "tampered.log"), "line one\nline TWO\nline three\n");

      writeFileSync(
        join(crlfDir, SEAL_FILENAME),
        JSON.stringify({
          hashes: {
            "taken-on-windows.log": digest(body.split("\n").join("\r\n")),
            "taken-on-linux.log": digest(body),
            "tampered.log": digest(body.split("\n").join("\r\n")),
          },
        }),
      );

      const endings = verifySeal(join(crlfDir, SEAL_FILENAME));
      assert(
        "a CRLF-taken seal verifies against an LF checkout — the defect: this used to be reported CHANGED",
        !endings.changed.some((c) => c.file === "taken-on-windows.log"),
      );
      assert(
        "an LF-taken seal still verifies against a CRLF checkout",
        !endings.changed.some((c) => c.file === "taken-on-linux.log"),
      );
      assert(
        "BITE: accepting both line endings does NOT accept a changed file — content differing by more than endings matches neither form",
        endings.changed.length === 1 && endings.changed[0].file === "tampered.log",
      );
      assert("and two of the three still count as matched", endings.matched === 2);
    }

    // An unreadable seal is a failure, never a pass.
    writeFileSync(join(nested, SEAL_FILENAME), "{ not json");
    assert("a corrupt seal file is reported, not skipped", verifySeal(join(nested, SEAL_FILENAME)).unreadable !== null);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // 2026-09-04 (v2 ticket 30) — the vacuity class, at the unit level and then
  // END TO END through the real exit code. The unit assertions alone would not
  // have caught the original defect: `verifySeal` returned matched=0 of 0 and
  // every caller read that as success.
  // ---------------------------------------------------------------------------

  assert(
    "a `hashes` map is recognised",
    normaliseSealHashes({ hashes: { "a.txt": "aa" } }).shape === "hashes",
  );
  assert(
    "a `files` map is recognised",
    normaliseSealHashes({ files: { "a.txt": "aa" } }).shape === "files",
  );
  assert(
    "an `artifacts: [{file, sha256}]` LIST is normalised into the hash map — the shape the " +
      "data-catalogue seal ships and the reader silently discarded",
    (() => {
      const { hashes, shape } = normaliseSealHashes({
        artifacts: [
          { file: "catalogue.csv", sha256: "deadbeef" },
          { file: "policy.md", sha256: "cafebabe" },
        ],
      });
      return shape === "artifacts[]" && hashes?.["catalogue.csv"] === "deadbeef" && Object.keys(hashes).length === 2;
    })(),
  );
  assert(
    "a manifest whose file list sits under an UNRECOGNISED key resolves to null, not to {}",
    normaliseSealHashes({ algorithm: "sha256", attests: { "a.txt": "aa" } }).hashes === null,
  );
  assert("a non-object manifest resolves to null", normaliseSealHashes(null).hashes === null);
  assert("an array manifest resolves to null", normaliseSealHashes([]).hashes === null);
  assert(
    "a malformed list entry ({file} with no digest) resolves to null rather than a partial map",
    normaliseSealHashes({ artifacts: [{ file: "a.txt" }] }).hashes === null,
  );

  // --- live path, as a child process, so the assertion is on the EXIT CODE ---
  const SCRIPT = fileURLToPath(import.meta.url);
  const runLive = (root) => {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, `--root=${root}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out: stdout };
    } catch (err) {
      return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  const sealDir = (dir, names) => {
    const hashes = {};
    for (const n of names) hashes[n] = sha256File(join(dir, n));
    writeFileSync(join(dir, SEAL_FILENAME), JSON.stringify({ sourceDir: dir, fileCount: names.length, hashes }, null, 2));
  };

  const buildTree = (label, perDir, mutate) => {
    const root = mkdtempSync(join(tmpdir(), `evidence-seal-${label}-`));
    const evidenceDir = join(root, "evidence");
    const nestedDir = join(evidenceDir, "bootstrap");
    mkdirSync(nestedDir, { recursive: true });
    const outer = [];
    const inner = [];
    for (let i = 0; i < perDir; i++) {
      const a = `a${i}.log`;
      const b = `b${i}.log`;
      writeFileSync(join(evidenceDir, a), `alpha ${i}\n`);
      writeFileSync(join(nestedDir, b), `bravo ${i}\n`);
      outer.push(a);
      inner.push(b);
    }
    // The three files DECLARED_UNSEALED names, so a fixture root exercises that
    // check rather than tripping its staleness rule.
    for (const d of DECLARED_UNSEALED) writeFileSync(join(evidenceDir, d.file), `${d.file}\n`);
    sealDir(evidenceDir, outer);
    sealDir(nestedDir, inner);
    if (mutate !== undefined) mutate(evidenceDir);
    return { root, evidenceDir };
  };

  const scratchTrees = [];
  try {
    const healthy = buildTree("healthy", 12);
    scratchTrees.push(healthy.root);
    const healthyRun = runLive(healthy.evidenceDir);
    assert("CONTROL: a healthy fixture tree exits 0", healthyRun.status === 0);
    assert("CONTROL: and says so", healthyRun.out.includes("every evidence seal holds"));

    // The exact fixture that reproduced the defect: a seal declaring two files
    // under `artifacts`, neither of which exists on disk. At head this printed
    // `OK ... 0/0 files match` and the run exited 0.
    const vacuous = buildTree("vacuous", 12, (evidenceDir) => {
      const dir = join(evidenceDir, "vacuous");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, SEAL_FILENAME),
        JSON.stringify({
          algorithm: "sha256",
          covers: "the production data catalogue",
          artifacts: [
            { file: "catalogue.csv", sha256: "deadbeef" },
            { file: "policy.md", sha256: "cafebabe" },
          ],
        }),
      );
    });
    scratchTrees.push(vacuous.root);
    const vacuousRun = runLive(vacuous.evidenceDir);
    assert(
      "a seal attesting to files that do not exist FAILS the run — it used to read as 0/0 and pass",
      vacuousRun.status === 1,
    );
    assert("and both attested files are named as MISSING", vacuousRun.out.includes("MISSING  catalogue.csv"));

    // A manifest this gate cannot understand is BROKEN, not empty.
    const mystery = buildTree("mystery", 12, (evidenceDir) => {
      const dir = join(evidenceDir, "mystery");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SEAL_FILENAME), JSON.stringify({ algorithm: "sha256", attests: { "a.txt": "aa" } }));
    });
    scratchTrees.push(mystery.root);
    const mysteryRun = runLive(mystery.evidenceDir);
    assert("a seal in an unrecognised shape FAILS the run", mysteryRun.status === 1);
    assert(
      "and the report names the keys it did find, so the shape can be fixed",
      mysteryRun.out.includes("no recognisable file list") && mysteryRun.out.includes("attests"),
    );

    // An explicitly empty seal. Recognised shape, zero files, still not a pass.
    const empty = buildTree("empty", 12, (evidenceDir) => {
      const dir = join(evidenceDir, "empty");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SEAL_FILENAME), JSON.stringify({ algorithm: "sha256", hashes: {} }));
    });
    scratchTrees.push(empty.root);
    const emptyRun = runLive(empty.evidenceDir);
    assert("a seal covering zero files FAILS the run", emptyRun.status === 1);
    assert("and says it attests to nothing", emptyRun.out.includes("attests to nothing"));

    // The aggregate floor, now in the live path rather than only in here.
    const shrunk = buildTree("shrunk", 2);
    scratchTrees.push(shrunk.root);
    const shrunkRun = runLive(shrunk.evidenceDir);
    assert(
      `a tree covering fewer than ${MIN_SEALED_FILES} files is INCONCLUSIVE (exit 2), never a pass`,
      shrunkRun.status === 2,
    );
    assert("and it is not reported as a clean run", !shrunkRun.out.includes("every evidence seal holds"));
  } finally {
    for (const t of scratchTrees) rmSync(t, { recursive: true, force: true });
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

  // A manifest whose file list this gate cannot find. Reading it as an empty
  // seal is how a document attesting to two files that do not exist printed
  // `OK — 0/0 files match` and exited 0.
  if (result.unrecognised !== null) {
    console.error(`BROKEN  ${sealRel} — ${result.unrecognised}.`);
    console.error(
      "  A seal whose shape this gate does not understand is not an empty seal. Write the file " +
        "list under `hashes` (a map) or `artifacts` (a list of {file, sha256}), or teach " +
        "normaliseSealHashes the new shape — do not leave it reading as nothing.",
    );
    broken++;
    continue;
  }

  // A recognised but EMPTY seal. Zero of zero files match, which is not the same
  // as a seal that holds. This is an INVARIANT, not a tunable floor: the aggregate
  // MIN_SEALED_FILES cannot catch it either way, because the other seals satisfy
  // it whatever this one covers.
  if (result.sealedCount === 0) {
    console.error(
      `BROKEN  ${sealRel} — the seal covers no files at all. A seal that attests to nothing ` +
        "verifies nothing; delete it or re-run the sealer over the directory it claims to cover.",
    );
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

// The aggregate floor, in the LIVE path. It existed only inside the self-test,
// where it can only ever describe the tree the self-test happens to find.
if (broken === 0 && totalSealed < MIN_SEALED_FILES) {
  console.error(
    `\nINCONCLUSIVE — ${seals.length} seal(s) cover only ${totalSealed} file(s) (floor ` +
      `${MIN_SEALED_FILES}). "Every seal holds" over almost nothing proves almost nothing.`,
  );
  process.exit(2);
}

if (broken > 0) {
  console.error("A broken seal means the evidence no longer is what it was attested to be. Re-run the sealer only after establishing why it changed.");
  process.exit(1);
}
console.log("OK — every evidence seal holds.");
