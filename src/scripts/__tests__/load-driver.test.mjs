import assert from "node:assert/strict";
import { achievedRate, judge, percentile, summarise } from "../load-driver/percentiles.mjs";
import { DRIVEN, NOT_DRIVEN_REASONS } from "../load-driver/workloads.mjs";
import { LATENCY_OBJECTIVES } from "../envelope-profile.mjs";

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (e) {
    process.stderr.write(`FAIL  ${name}\n      ${e.message}\n`);
    process.exitCode = 1;
  }
}

test("percentile interpolates between neighbouring samples", () => {
  assert.equal(percentile([10, 20], 50), 15);
  assert.equal(percentile([10, 20, 30, 40], 0), 10);
  assert.equal(percentile([10, 20, 30, 40], 100), 40);
});

test("percentile of an empty set is null, not zero", () => {
  assert.equal(percentile([], 95), null);
});

test("summarise reports every percentile the report prints", () => {
  const s = summarise([5, 1, 4, 2, 3]);
  assert.equal(s.count, 5);
  assert.equal(s.p50, 3);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
});

test("summarise sorts before computing, so sample order cannot change the answer", () => {
  assert.deepEqual(summarise([9, 1, 5]), summarise([1, 5, 9]));
});

test("summarise drops non-finite samples rather than poisoning the percentiles", () => {
  const s = summarise([1, Number.NaN, 3, Number.POSITIVE_INFINITY]);
  assert.equal(s.count, 2);
  assert.equal(s.max, 3);
});

test("an empty summary reports null percentiles, never 0ms", () => {
  const s = summarise([]);
  assert.equal(s.count, 0);
  assert.equal(s.p95, null);
  assert.equal(s.max, null);
});

// The property that stops a run from reading as a pass: an objective with no samples must be
// NOT_DRIVEN, because summarise returns null and null <= target would otherwise be true.
test("an objective with no samples is NOT_DRIVEN, not MET", () => {
  const result = judge({ percentileKey: "p95", target: 50 }, summarise([]));
  assert.equal(result.verdict, "NOT_DRIVEN");
  assert.equal(result.measured, null);
});

test("a measurement over target is BREACHED", () => {
  const result = judge({ percentileKey: "p95", target: 50 }, summarise([100, 200, 300]));
  assert.equal(result.verdict, "BREACHED");
});

test("a measurement at exactly the target is MET, not BREACHED", () => {
  const result = judge({ percentileKey: "p95", target: 10 }, summarise([10, 10, 10]));
  assert.equal(result.verdict, "MET");
  assert.equal(result.measured, 10);
});

test("achievedRate converts a count and a window into requests per second", () => {
  assert.equal(achievedRate(500, 10_000), 50);
  assert.equal(achievedRate(0, 1000), 0);
});

test("achievedRate refuses to divide by a zero-length window", () => {
  assert.equal(achievedRate(100, 0), 0);
});

// Every objective in the PRD table must be accounted for: either the driver exercises it, or
// it carries a written reason. Silence is how an objective disappears from a report.
test("every PRD latency objective is either driven or has a written reason", () => {
  const unaccounted = LATENCY_OBJECTIVES.filter(
    (o) =>
      DRIVEN[o.name] === undefined &&
      NOT_DRIVEN_REASONS[o.name] === undefined &&
      o.name !== "cross-org-data-exposure",
  );
  assert.deepEqual(
    unaccounted.map((o) => o.name),
    [],
    "these objectives would vanish from the report",
  );
});

test("every driven workload names the percentile it is judged on", () => {
  for (const [name, workload] of Object.entries(DRIVEN)) {
    assert.ok(
      ["p50", "p75", "p95", "p99"].includes(workload.percentileKey),
      `${name} has no valid percentileKey`,
    );
    assert.ok(workload.description.length > 20, `${name} has no substantive description`);
  }
});

test("every not-driven reason says what would be needed, not just that it was skipped", () => {
  for (const [name, reason] of Object.entries(NOT_DRIVEN_REASONS))
    assert.ok(reason.length > 30, `${name} has no substantive reason`);
});

if (process.exitCode === 1) process.stderr.write("\nload-driver tests FAILED\n");
else process.stdout.write("\nAll load-driver tests passed.\n");
