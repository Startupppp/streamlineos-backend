#!/usr/bin/env node
/**
 * check-baseline-integrity.mjs — no gate's own numbers move in the unsafe
 * direction, and none of them moves invisibly.
 *
 * WHY THIS EXISTS
 * Ticket 35 box 5 forbids "baselines raised merely to turn a regression green".
 * Auditing that by walking each identifier's git history has a hole, and the
 * hole is on record: commit `c0daca5b` lowered `UNDETECTED_CLAIM_BASELINE`
 * 2 -> 0 in check-db-call-count.mjs while introducing
 * `ACTIONABLE_UNDETECTED_BASELINE = 3` in the same file. Per identifier both
 * moves look fine — one went down, the other is new and has never moved. The
 * FILE's baselines went 2 -> 3. A net raise carried across a rename is
 * invisible to `git log -L` and to every reviewer reading a diff hunk.
 *
 * WHAT CLOSES IT
 * Every top-level integer constant in every `check-*.mjs` / `check-*.ts` gate
 * script is registered here with a DIRECTION. The gate then fails on:
 *   · a constant that moved in its unsafe direction;
 *   · a constant present in source and ABSENT from the registry — which is what
 *     a rename looks like, and what an inserted second baseline looks like;
 *   · a constant present in the registry and ABSENT from source — the other
 *     half of a rename, and what a silent deletion looks like;
 *   · a registered entry with no direction, or a debt entry with no owner.
 * So a rename cannot land without touching this file, and touching this file
 * shows the reviewer the net movement per gate script.
 *
 * THE THREE DIRECTIONS, AND WHY THERE ARE THREE
 *   ratchet  may only DECREASE. Debt counts and policy ceilings: TIER2_RATCHET,
 *            VOID_FILE_BASELINE, over-300's BASELINE, MAX_GROWING_SITES,
 *            file-sizes' LIMIT. Raising one hides a regression.
 *   floor    may only INCREASE. Anti-vacuity floors: MIN_SPEC_FILES,
 *            MIN_FILES, SCAN_FLOOR_FILES, and the detector look-around windows
 *            (LOOKAHEAD/LOOKBACK/LOOKFORWARD), where a SMALLER number makes the
 *            detector see less. Lowering one is how a gate goes blind while
 *            still printing OK — the defect this ticket exists to remove.
 *   pinned   may not change at all without re-registering. Used where the safe
 *            direction is genuinely not obvious (a migration watermark, a
 *            borrow count). `pinned` is the honest default: it forces a human
 *            to state the direction rather than letting this gate guess one.
 *
 * A DOWNWARD RATCHET MOVE AND AN UPWARD FLOOR MOVE PASS, and the gate prints
 * "lower/raise the registry" so the gain is banked rather than left as slack —
 * four sites of unclaimed slack is four regressions a future change lands for
 * free, which is a baseline raise pointing the other way.
 *
 * VACUITY FLOORS — this gate is subject to its own rule. It exits 2
 * INCONCLUSIVE rather than 0 when it walks too few gate scripts or reads too
 * few constants, so a broken walker or a broken parser cannot report "all
 * baselines intact" over nothing.
 *
 * Usage:
 *   node src/scripts/check-baseline-integrity.mjs
 *   node src/scripts/check-baseline-integrity.mjs --list
 *   node src/scripts/check-baseline-integrity.mjs --emit      # regenerate skeleton
 *   node src/scripts/check-baseline-integrity.mjs --self-test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(HERE, "baselines", "ratchets.json");

const MIN_GATE_SCRIPTS = 40;
const MIN_CONSTANTS = 100;
const MIN_BASELINE_JSON_FILES = 5;
const MIN_JSON_RATCHETS = 5;

const GATE_RE = /^check-.*\.(mjs|ts)$/;
const CONST_RE = /^const\s+([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+)\s*;/gm;
const DIRECTIONS = new Set(["ratchet", "floor", "pinned"]);

/**
 * A baseline JSON file mixes RATCHETS with recorded MEASUREMENTS, and no
 * mechanical rule separates them by value — `authz-deny.json` holds
 * `uncovered: 2453` (a measurement, which moves freely) beside
 * `uncoveredRatchet: 2441` (the number CI enforces). So the rule is by KEY
 * NAME, stated here rather than inferred: a numeric field is a ratchet when
 * some key on its path is named for one. `cap` deliberately requires a word
 * boundary — a bare /cap$/ matched the path segment `cron-weekly-recap` and
 * would have registered a per-file read count as a ratchet.
 */
const JSON_RATCHET_KEY =
  /^(ratchets?|.*Ratchet|.*[Bb]aseline|.*[Aa]llowed|.*[Cc]eiling|max|.*Max|cap|.*Cap|limit|.*Limit)$/;
const REGISTRY_BASENAME = "ratchets.json";

function readConstants(dir) {
  const out = [];
  let scripts = 0;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!GATE_RE.test(name)) continue;
    scripts += 1;
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    for (const m of src.matchAll(CONST_RE))
      out.push({ file: name, name: m[1], value: Number(m[2]) });
  }
  return { constants: out, scripts };
}

function keyOf(entry) {
  return `${entry.file}::${entry.name}`;
}

function jsonRatchets(dir) {
  const out = [];
  let files = 0;
  let baselineDir;
  try {
    baselineDir = fs.readdirSync(dir).sort();
  } catch {
    return { constants: out, files };
  }
  for (const name of baselineDir) {
    if (!name.endsWith(".json") || name === REGISTRY_BASENAME) continue;
    files += 1;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const visit = (node, trail) => {
      if (node === null || typeof node !== "object" || Array.isArray(node)) return;
      for (const [key, value] of Object.entries(node)) {
        const next = [...trail, key];
        if (typeof value === "number" && Number.isInteger(value)) {
          if (next.some((segment) => JSON_RATCHET_KEY.test(segment)))
            out.push({ file: `baselines/${name}`, name: next.join("."), value });
        } else visit(value, next);
      }
    };
    visit(parsed, []);
  }
  return { constants: out, files };
}

function violates(direction, registered, current) {
  if (direction === "ratchet") return current > registered;
  if (direction === "floor") return current < registered;
  return current !== registered;
}

function improves(direction, registered, current) {
  if (direction === "ratchet") return current < registered;
  if (direction === "floor") return current > registered;
  return false;
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-selftest-"));
  fs.writeFileSync(
    path.join(dir, "check-a.mjs"),
    "const TIER2_RATCHET = 10;\nconst MIN_FILES = 100;\nconst PINNED_THING = 5;\nlet x = 1;\nconst lower = 2;\n  const INDENTED = 9;\n",
  );
  fs.writeFileSync(path.join(dir, "check-b.ts"), "const MAX_SITES = 3;\n");
  fs.writeFileSync(path.join(dir, "not-a-gate.mjs"), "const SHOULD_NOT_BE_SEEN = 7;\n");

  const { constants, scripts } = readConstants(dir);
  const has = (n) => constants.some((c) => c.name === n);
  const valueOf = (n) => constants.find((c) => c.name === n)?.value;

  const bdir = path.join(dir, "baselines");
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(
    path.join(bdir, "sample.json"),
    JSON.stringify({
      covered: 767,
      uncovered: 2453,
      uncoveredRatchet: 2441,
      ratchets: { NO_ASSERTION: 1 },
      unbounded: { "/cron/cron-weekly-recap.service.ts": 2 },
      version: 1,
      files: 3587,
    }),
  );
  fs.writeFileSync(path.join(bdir, REGISTRY_BASENAME), JSON.stringify({ entries: { "x.mjs": { BASELINE: { value: 9 } } } }));
  const js = jsonRatchets(bdir);
  const jhas = (n) => js.constants.some((c) => c.name === n);

  const checks = [
    ["a .mjs gate script is read", has("TIER2_RATCHET")],
    ["a .ts gate script is read", has("MAX_SITES")],
    ["a non-gate file is NOT read", !has("SHOULD_NOT_BE_SEEN")],
    ["a lowercase const is not a baseline", !constants.some((c) => c.name === "lower")],
    ["a `let` is not a baseline", !constants.some((c) => c.name === "x")],
    ["an indented const is not top-level and is skipped", !has("INDENTED")],
    ["values parse", valueOf("TIER2_RATCHET") === 10 && valueOf("MIN_FILES") === 100],
    ["both gate scripts counted, the third not", scripts === 2],
    ["ratchet: raising violates", violates("ratchet", 10, 11)],
    ["ratchet: lowering does not violate", !violates("ratchet", 10, 9)],
    ["ratchet: lowering is an improvement to bank", improves("ratchet", 10, 9)],
    ["floor: lowering violates", violates("floor", 100, 99)],
    ["floor: raising does not violate", !violates("floor", 100, 101)],
    ["floor: raising is an improvement to bank", improves("floor", 100, 101)],
    ["pinned: any change violates", violates("pinned", 5, 6) && violates("pinned", 5, 4)],
    ["pinned: no change does not violate", !violates("pinned", 5, 5)],
    ["pinned is never an improvement — it must be re-registered", !improves("pinned", 5, 4)],
    ["the gate-script floor would reject this fixture dir", scripts < MIN_GATE_SCRIPTS],
    ["the constant floor would reject this fixture dir", constants.length < MIN_CONSTANTS],
    ["every known direction is handled", [...DIRECTIONS].every((d) => typeof violates(d, 1, 1) === "boolean")],
    ["a json ratchet field is read", jhas("uncoveredRatchet")],
    ["a nested ratchets.<class> field is read", jhas("ratchets.NO_ASSERTION")],
    ["a recorded MEASUREMENT is not read as a ratchet", !jhas("covered") && !jhas("uncovered")],
    ["`version` and `files` are not read as ratchets", !jhas("version") && !jhas("files")],
    [
      "the cap rule does not match the path segment `cron-weekly-recap`",
      !js.constants.some((c) => c.name.includes("recap")),
    ],
    [
      "the registry file itself is not scanned as a baseline file",
      !js.constants.some((c) => c.name.includes("BASELINE")) && js.files === 1,
    ],
    ["the baseline-json floor would reject this fixture dir", js.files < MIN_BASELINE_JSON_FILES],
    [
      "the json-ratchet floor would reject this fixture dir",
      js.constants.length < MIN_JSON_RATCHETS,
    ],
  ];

  fs.rmSync(dir, { recursive: true, force: true });

  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
    }
  }
  console.log(`check-baseline-integrity self-test: ${checks.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

function guessDirection(name) {
  if (/^MIN_|_FLOOR$|^SCAN_FLOOR|LOOKAHEAD|LOOKBACK|LOOKFORWARD|^ANTI_VACUITY/.test(name)) return "floor";
  if (/RATCHET|BASELINE|^MAX_|_CAP$|CEILING|^LIMIT$/.test(name)) return "ratchet";
  return "pinned";
}

function emit(constants) {
  const byFile = new Map();
  for (const c of constants) {
    if (!byFile.has(c.file)) byFile.set(c.file, {});
    byFile.get(c.file)[c.name] = { value: c.value, direction: guessDirection(c.name) };
  }
  const out = { note: "regenerated skeleton — classify each direction by hand", entries: {} };
  for (const f of [...byFile.keys()].sort()) out.entries[f] = byFile.get(f);
  console.log(JSON.stringify(out, null, 2));
}

function main() {
  if (process.argv.includes("--self-test")) process.exit(selfTest());

  const fromScripts = readConstants(HERE);
  const fromJson = jsonRatchets(path.join(HERE, "baselines"));
  const constants = [...fromScripts.constants, ...fromJson.constants];
  const scripts = fromScripts.scripts;

  if (process.argv.includes("--emit")) {
    emit(constants);
    process.exit(0);
  }

  if (scripts < MIN_GATE_SCRIPTS) {
    console.error(
      `INCONCLUSIVE — walked ${scripts} gate scripts, below the floor of ${MIN_GATE_SCRIPTS}. The scan did not reach src/scripts; this is not a clean result.`,
    );
    process.exit(2);
  }
  if (constants.length < MIN_CONSTANTS) {
    console.error(
      `INCONCLUSIVE — read ${constants.length} baseline constants, below the floor of ${MIN_CONSTANTS}. The constant parser measured nothing.`,
    );
    process.exit(2);
  }
  if (fromJson.files < MIN_BASELINE_JSON_FILES) {
    console.error(
      `INCONCLUSIVE — read ${fromJson.files} baseline JSON file(s), below the floor of ${MIN_BASELINE_JSON_FILES}. The JSON walk measured nothing, so a ratchet living in a .json rather than a const would be unguarded.`,
    );
    process.exit(2);
  }
  if (fromJson.constants.length < MIN_JSON_RATCHETS) {
    console.error(
      `INCONCLUSIVE — matched ${fromJson.constants.length} ratchet field(s) in baselines/*.json, below the floor of ${MIN_JSON_RATCHETS}. The key-name rule matched nothing.`,
    );
    process.exit(2);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const registered = new Map();
  for (const [file, names] of Object.entries(registry.entries))
    for (const [name, spec] of Object.entries(names)) registered.set(`${file}::${name}`, { file, name, ...spec });

  const current = new Map(constants.map((c) => [keyOf(c), c]));

  const unregistered = constants.filter((c) => !registered.has(keyOf(c)));
  const stale = [...registered.values()].filter((e) => !current.has(`${e.file}::${e.name}`));
  const violations = [];
  const improvements = [];
  const malformed = [];

  for (const entry of registered.values()) {
    const key = `${entry.file}::${entry.name}`;
    const now = current.get(key);
    if (!now) continue;
    if (!DIRECTIONS.has(entry.direction)) {
      malformed.push(`${key} — direction '${entry.direction ?? "(missing)"}' is not one of ${[...DIRECTIONS].join("/")}`);
      continue;
    }
    if (entry.direction === "ratchet" && entry.value > 0 && !entry.owner)
      malformed.push(`${key} — a nonzero ratchet is debt and must name an owner`);
    if (violates(entry.direction, entry.value, now.value))
      violations.push({ ...entry, current: now.value });
    else if (improves(entry.direction, entry.value, now.value))
      improvements.push({ ...entry, current: now.value });
  }

  if (process.argv.includes("--list"))
    for (const c of constants) {
      const e = registered.get(keyOf(c));
      console.log(`${c.file}\t${c.name}\t${c.value}\t${e?.direction ?? "UNREGISTERED"}`);
    }

  // Net movement per gate script, which is what a rename hides.
  // Summed over the UNION of registered and current, not over the survivors:
  // a rename removes one name and adds another, so summing only the names still
  // present would report the vanished side as 0 and understate the net move.
  const netByFile = new Map();
  const bump = (file) => {
    if (!netByFile.has(file)) netByFile.set(file, { registered: 0, current: 0 });
    return netByFile.get(file);
  };
  for (const e of registered.values()) bump(e.file).registered += e.value;
  for (const c of constants) bump(c.file).current += c.value;

  console.log(
    `Gate scripts ${scripts}  ·  constants ${fromScripts.constants.length}  ·  json ratchets ${fromJson.constants.length} in ${fromJson.files} baseline file(s)  ·  registered ${registered.size}`,
  );
  const dirCounts = { ratchet: 0, floor: 0, pinned: 0 };
  for (const e of registered.values()) if (e.direction in dirCounts) dirCounts[e.direction] += 1;
  console.log(
    `  ratchet ${dirCounts.ratchet}  ·  floor ${dirCounts.floor}  ·  pinned ${dirCounts.pinned}  ·  unregistered ${unregistered.length}  ·  stale ${stale.length}`,
  );

  let rc = 0;
  if (unregistered.length > 0) {
    rc = 1;
    console.error(`\n${unregistered.length} baseline constant(s) are NOT registered in baselines/ratchets.json:`);
    for (const c of unregistered) {
      const net = netByFile.get(c.file);
      console.error(
        `  ${c.file} :: ${c.name} = ${c.value}` +
          `\n      that file's registered baselines total ${net.registered}, its current ones total ${net.current}` +
          (net.current > net.registered
            ? ` — a NET RAISE of ${net.current - net.registered}. If this is a rename, say so and lower another; a rename is exactly how a net raise stays invisible to per-identifier history.`
            : ""),
      );
    }
  }
  if (stale.length > 0) {
    rc = 1;
    console.error(`\n${stale.length} registered baseline(s) no longer exist in source — renamed or deleted:`);
    for (const e of stale) console.error(`  ${e.file} :: ${e.name} (was ${e.value}, ${e.direction})`);
  }
  if (violations.length > 0) {
    rc = 1;
    console.error(`\n${violations.length} baseline(s) moved in the UNSAFE direction:`);
    for (const v of violations)
      console.error(
        `  ${v.file} :: ${v.name}  ${v.value} -> ${v.current}  (${v.direction}: may only ${v.direction === "ratchet" ? "decrease" : v.direction === "floor" ? "increase" : "stay put"})` +
          (v.reason ? `\n      registered reason: ${v.reason}` : ""),
      );
    console.error(
      `\nFix the code, not the number. A ratchet raised to make a red gate green is the defect this gate exists to catch.`,
    );
  }
  for (const m of malformed) {
    rc = 1;
    console.error(`\nMalformed registry entry: ${m}`);
  }

  if (improvements.length > 0)
    console.log(
      `\n${improvements.length} baseline(s) IMPROVED — bank the gain by updating baselines/ratchets.json:` +
        improvements.map((i) => `\n  ${i.file} :: ${i.name}  ${i.value} -> ${i.current}`).join(""),
    );

  if (rc === 0)
    console.log(
      `\nOK — every gate's own numbers are registered, and none moved in its unsafe direction.`,
    );
  process.exit(rc);
}

main();
