#!/usr/bin/env node
/**
 * A gate must report the size of the corpus it scanned, not just its findings.
 *
 * Written 2026-09-03 for v2 ticket 30, after NINE gates in this release were found reporting a
 * clean or complete result over a corpus that was empty, filtered to near-nothing, or structurally
 * invisible to them. The common shape in every one: **the reported denominator was the gate's own
 * filtered subset, not the corpus.**
 *
 *   check:openapi-coverage   "response-schemas: 3642/3642 (100%)"  — real coverage 1/3642 (0.027%)
 *   check:envelope-consistency  green                              — 336 paginated GETs, 0 readable
 *   check:multipart-contracts   green                              — 9 of 3,644 handlers (0.25%)
 *   check:public-object-urls    green                              — 0 enforceable sites after allowlist
 *   check:retention-coverage    green                              — 14 of 944 tables
 *   check:outbox-consumers      green                              — blind to `eventType` as a variable
 *   check:idempotent-commands   green                              — 129 of 2,030 handlers (6.4%)
 *   check:db-generate-guard     green                              — read no files at all
 *   knip (both repos)           green                              — specs are entry points
 *
 * `0 violations` and `nothing to check` print identically unless the gate says how much it read.
 * This is the shared way to say it, and adopting it buys an anti-vacuity floor for free: the
 * reporter itself REFUSES a report whose corpus is empty, because that is never a pass.
 *
 * Usage:
 *   import { reportCorpus } from "./gate-corpus.mjs";
 *   reportCorpus({ gate: "check-x", scanned: files.length, total: allFiles.length, unit: "file" });
 *
 * `scanned` is what the gate actually evaluated; `total` is the corpus it was pointed at. When a
 * gate evaluates everything it sees, pass the same number for both. The gap between them IS the
 * finding in every case above, which is why they are separate arguments and why the gap is
 * printed rather than left for the reader to compute.
 */

/** Percentage, never rounded up to a false "100%". */
export function coveragePct(scanned, total) {
  if (total === 0) return "0%";
  if (scanned === total) return "100%";
  const pct = (scanned / total) * 100;
  const fixed = pct.toFixed(2);
  // 99.996 must not print as "100.00%" beside a real gap.
  if (fixed === "100.00") return "99.99%";
  if (fixed === "0.00" && scanned > 0) return "<0.01%";
  return `${fixed}%`;
}

/**
 * Build the line. Separated from printing so a self-test can assert the text without stdout.
 * Returns { line, vacuous, reason }.
 */
export function corpusLine({ gate, scanned, total, unit = "item" }) {
  const plural = `${unit}${total === 1 ? "" : "s"}`;
  if (!Number.isInteger(scanned) || !Number.isInteger(total) || scanned < 0 || total < 0)
    return { line: "", vacuous: true, reason: `corpus counts must be non-negative integers, got scanned=${String(scanned)} total=${String(total)}` };
  if (scanned > total)
    return { line: "", vacuous: true, reason: `scanned ${String(scanned)} exceeds the corpus of ${String(total)} — the count is wrong, not the code` };
  if (total === 0)
    return { line: "", vacuous: true, reason: `the corpus is EMPTY — 0 ${plural} were available to scan, so a clean result proves nothing` };
  if (scanned === 0)
    return { line: "", vacuous: true, reason: `scanned 0 of ${String(total)} ${plural} — every one was filtered out, so a clean result proves nothing` };

  const gap = total - scanned;
  const base = `${gate}: scanned ${String(scanned)} of ${String(total)} ${plural} (${coveragePct(scanned, total)})`;
  return {
    line: gap === 0 ? `${base} — the whole corpus` : `${base} — ${String(gap)} NOT scanned by this gate`,
    vacuous: false,
    reason: null,
  };
}

/**
 * Print the corpus line, or fail the gate when the corpus is empty.
 *
 * Exits 2 (INCONCLUSIVE, the project-wide code for "the rule could not be checked") rather than 1:
 * an empty corpus is not a violation of the rule, it is the absence of evidence about it. The
 * distinction is the one `run-gate.mjs` relies on.
 */
export function reportCorpus(spec) {
  const { line, vacuous, reason } = corpusLine(spec);
  if (vacuous) {
    process.stderr.write(`INCONCLUSIVE — ${spec.gate}: ${reason}\n`);
    process.exit(2);
  }
  process.stdout.write(`${line}\n`);
  return line;
}

function runSelfTest() {
  const failures = [];
  let passed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const ok = corpusLine({ gate: "g", scanned: 10, total: 10, unit: "file" });
  assert("a full scan is not vacuous", ok.vacuous === false);
  assert("a full scan says so", ok.line.includes("the whole corpus"));
  assert("a full scan prints both numbers", ok.line.includes("10 of 10"));

  const partial = corpusLine({ gate: "g", scanned: 9, total: 3644, unit: "handler" });
  assert("a filtered scan is not vacuous", partial.vacuous === false);
  assert("a filtered scan names the gap", partial.line.includes("3635 NOT scanned"));
  assert("a filtered scan shows the real percentage", partial.line.includes("0.25%"));

  // The whole point: these two must not be reportable as a pass.
  const empty = corpusLine({ gate: "g", scanned: 0, total: 0 });
  assert("an EMPTY corpus is vacuous", empty.vacuous === true);
  assert("an empty corpus says a clean result proves nothing", empty.reason.includes("proves nothing"));

  const allFiltered = corpusLine({ gate: "g", scanned: 0, total: 336, unit: "endpoint" });
  assert("scanning 0 of a non-empty corpus is vacuous", allFiltered.vacuous === true);
  assert("it names the corpus it failed to reach", allFiltered.reason.includes("0 of 336"));

  const impossible = corpusLine({ gate: "g", scanned: 11, total: 10 });
  assert("scanning more than the corpus is a counting bug, not a pass", impossible.vacuous === true);

  assert("negative counts are rejected", corpusLine({ gate: "g", scanned: -1, total: 10 }).vacuous === true);
  assert("non-integer counts are rejected", corpusLine({ gate: "g", scanned: 1.5, total: 10 }).vacuous === true);

  // formatPct must never launder a gap into 100%.
  assert("exact coverage is 100%", coveragePct(10, 10) === "100%");
  assert("a near-miss is NOT rounded to 100%", coveragePct(99999, 100000) === "99.99%");
  assert("one in 3642 is not rounded to 0", coveragePct(1, 3642) === "0.03%");
  assert("a tiny non-zero coverage never prints 0.00%", coveragePct(1, 1000000) === "<0.01%");
  assert("zero of zero is 0%", coveragePct(0, 0) === "0%");

  // The real numbers this helper exists because of.
  assert(
    "the openapi-coverage defect renders honestly",
    corpusLine({ gate: "check-openapi-coverage", scanned: 25, total: 3642, unit: "operation" }).line.includes("3617 NOT scanned"),
  );
  assert("singular unit is not pluralised", corpusLine({ gate: "g", scanned: 1, total: 1, unit: "table" }).line.includes("1 table "));

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`gate-corpus self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`gate-corpus self-tests: ${passed} passed`);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly && process.argv.includes("--self-test")) runSelfTest();
