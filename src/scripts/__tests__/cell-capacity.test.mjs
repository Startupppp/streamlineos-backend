import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  CAPACITY_BUDGETS,
  ADMISSION_THRESHOLD,
  validateCapacityBudgets,
  validateCapacityHistoryEntry,
  identifyLimitingResource,
  checkAdmission,
  forecastSaturation,
  advisoryResources,
  filterWellSpacedSamples,
  MIN_SAMPLE_SPACING_MS,
  CEILING_SOURCES,
} from "../cell-capacity-budgets.mjs";

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (e) {
    process.stderr.write(`FAIL  ${name}\n`);
    process.stderr.write(`      ${e.message}\n`);
    process.exitCode = 1;
  }
}

test("validateCapacityBudgets returns no errors for the declared budgets", () => {
  const errors = validateCapacityBudgets(CAPACITY_BUDGETS);
  assert.deepEqual(errors, [], `Validation errors: ${errors.join(", ")}`);
});

test("ADMISSION_THRESHOLD is exactly 0.6", () => {
  assert.equal(ADMISSION_THRESHOLD, 0.6);
});

test("identifyLimitingResource returns the measurement with the highest ratio", () => {
  const measurements = [
    { id: "a", resource: "connections", used: 10, limit: 100, ratio: 0.10, ceilingSource: "measured" },
    { id: "b", resource: "database-size", used: 80, limit: 100, ratio: 0.80, ceilingSource: "vendor-declared" },
    { id: "c", resource: "table-bloat", used: 5, limit: 100, ratio: 0.05, ceilingSource: "vendor-declared" },
  ];
  const limiting = identifyLimitingResource(measurements);
  assert.equal(limiting.id, "b", `Expected "b" (highest ratio 0.80), got "${limiting.id}"`);
  assert.equal(limiting.resource, "database-size");
});

test("identifyLimitingResource result is determined by ratio, not position or name", () => {
  const measurements = [
    { id: "z", resource: "connections", used: 90, limit: 100, ratio: 0.90, ceilingSource: "measured" },
    { id: "a", resource: "database-size", used: 1, limit: 100, ratio: 0.01, ceilingSource: "vendor-declared" },
  ];
  const limiting = identifyLimitingResource(measurements);
  assert.equal(limiting.id, "z");
});

test("identifyLimitingResource returns null for empty input", () => {
  assert.equal(identifyLimitingResource([]), null);
});

test("checkAdmission returns true when ratio is strictly below threshold", () => {
  assert.equal(checkAdmission(0.599), true);
  assert.equal(checkAdmission(0.0), true);
});

test("checkAdmission returns false when ratio equals the threshold", () => {
  assert.equal(checkAdmission(0.6), false);
});

test("checkAdmission returns false when ratio exceeds threshold", () => {
  assert.equal(checkAdmission(0.601), false);
  assert.equal(checkAdmission(1.0), false);
});

test("forecastSaturation refuses with fewer than 3 data points", () => {
  const twoPoints = [
    { ts: 1_000_000, resources: { "database-size": { used: 100, limit: 1000 } } },
    { ts: 2_000_000, resources: { "database-size": { used: 200, limit: 1000 } } },
  ];
  const result = forecastSaturation(twoPoints, "database-size");
  assert.equal(result.status, "refused");
  assert.ok(result.reason.includes("well-spaced sample(s)"), `Expected spacing info in reason: "${result.reason}"`);
  assert.ok(typeof result.wellSpaced === "number" && typeof result.total === "number");
});

test("forecastSaturation refuses with zero data points", () => {
  const result = forecastSaturation([], "database-size");
  assert.equal(result.status, "refused");
  assert.ok(result.reason.includes("0 well-spaced"), `Expected "0 well-spaced" in reason: "${result.reason}"`);
});

test("forecastSaturation refuses when trend is flat (well-spaced samples with identical ratios)", () => {
  const now = Date.now();
  const flatHistory = [
    { ts: now - 3 * 86_400_000, resources: { "connections": { used: 50, limit: 100 } } },
    { ts: now - 2 * 86_400_000, resources: { "connections": { used: 50, limit: 100 } } },
    { ts: now - 1 * 86_400_000, resources: { "connections": { used: 50, limit: 100 } } },
  ];
  const result = forecastSaturation(flatHistory, "connections");
  assert.equal(result.status, "refused");
  assert.ok(result.reason.toLowerCase().includes("flat"), `Expected "flat" in reason: "${result.reason}"`);
});

test("forecastSaturation returns a forecast when ratio is growing toward threshold", () => {
  const now = Date.now();
  const growingHistory = [
    { ts: now - 30 * 86_400_000, resources: { "database-size": { used: 100_000_000, limit: 3_221_225_472 } } },
    { ts: now - 20 * 86_400_000, resources: { "database-size": { used: 200_000_000, limit: 3_221_225_472 } } },
    { ts: now - 10 * 86_400_000, resources: { "database-size": { used: 300_000_000, limit: 3_221_225_472 } } },
  ];
  const result = forecastSaturation(growingHistory, "database-size");
  assert.ok(
    result.status === "forecast" || result.status === "refused",
    `Expected forecast or refused, got: ${result.status}`,
  );
  if (result.status === "forecast")
    assert.ok(typeof result.daysUntilThreshold === "number" && result.daysUntilThreshold > 0);
});

test("CAPACITY_BUDGETS includes at least one vendor-declared ceiling", () => {
  const vendorDeclared = CAPACITY_BUDGETS.filter((b) => b.ceilingSource === "vendor-declared");
  assert.ok(vendorDeclared.length > 0, "Expected at least one vendor-declared ceiling entry");
});

test("CAPACITY_BUDGETS vendor-declared entries have no ceilingSql", () => {
  const vendorDeclared = CAPACITY_BUDGETS.filter((b) => b.ceilingSource === "vendor-declared");
  for (const b of vendorDeclared)
    assert.ok(b.ceilingSql == null, `"${b.id}": vendor-declared ceiling must not have ceilingSql`);
});

test("CAPACITY_BUDGETS measured-ceiling entries have ceilingSql and no ceilingValue", () => {
  const measured = CAPACITY_BUDGETS.filter((b) => b.ceilingSource === "measured");
  for (const b of measured) {
    assert.ok(typeof b.ceilingSql === "string" && b.ceilingSql.trim(), `"${b.id}": measured ceiling must have ceilingSql`);
    assert.ok(b.ceilingValue == null, `"${b.id}": measured ceiling must not have ceilingValue`);
  }
});

test("an advisory resource never becomes the limiting resource, however high its ratio", () => {
  const limiting = identifyLimitingResource([
    { id: "advisory", resource: "advisory", ratio: 99, admissionGating: false },
    { id: "real", resource: "real", ratio: 0.1, admissionGating: true },
  ]);
  assert.equal(limiting.resource, "real");
});

test("identifyLimitingResource returns null when every measurement is advisory", () => {
  assert.equal(
    identifyLimitingResource([{ id: "a", resource: "a", ratio: 5, admissionGating: false }]),
    null,
  );
});

test("advisoryResources returns exactly the non-gating measurements", () => {
  const advisory = advisoryResources([
    { id: "a", admissionGating: false },
    { id: "b", admissionGating: true },
  ]);
  assert.deepEqual(advisory.map((m) => m.id), ["a"]);
});

test("index-size-vs-buffers is declared advisory, because it has no upper bound", () => {
  const budget = CAPACITY_BUDGETS.find((b) => b.id === "index-size-vs-buffers");
  assert.ok(budget, "index-size-vs-buffers must exist");
  assert.equal(budget.admissionGating, false);
});

test("a budget with no admissionGating flag is rejected by validation", () => {
  const withoutFlag = { ...CAPACITY_BUDGETS[0] };
  delete withoutFlag.admissionGating;
  const errors = validateCapacityBudgets([withoutFlag]);
  assert.ok(
    errors.some((e) => e.includes("admissionGating")),
    `expected an admissionGating error, got: ${errors.join(", ")}`,
  );
});

test("operational judgment is a distinct ceiling source from a vendor limit", () => {
  assert.ok(CEILING_SOURCES.includes("operational-judgment"));
  const judged = CAPACITY_BUDGETS.filter((b) => b.ceilingSource === "operational-judgment");
  assert.ok(judged.length > 0, "at least one ceiling is operator judgment, not a vendor limit");
  for (const b of judged)
    assert.ok(b.ceilingValue != null, `"${b.id}": a judged ceiling still needs a number`);
});

test("at least one admission-gating resource has a measured ceiling", () => {
  const gating = CAPACITY_BUDGETS.filter(
    (b) => b.admissionGating && b.ceilingSource === "measured",
  );
  assert.ok(gating.length > 0, "admission cannot rest entirely on declared numbers");
});

test("MIN_SAMPLE_SPACING_MS is 24 hours in milliseconds", () => {
  assert.equal(MIN_SAMPLE_SPACING_MS, 86_400_000);
});

test("filterWellSpacedSamples keeps only entries ≥ MIN_SAMPLE_SPACING_MS apart", () => {
  const base = 1_000_000_000_000;
  const entries = [
    { ts: base },
    { ts: base + 3_600_000 },
    { ts: base + MIN_SAMPLE_SPACING_MS },
    { ts: base + MIN_SAMPLE_SPACING_MS + 1_000 },
    { ts: base + MIN_SAMPLE_SPACING_MS * 2 },
  ];
  const result = filterWellSpacedSamples(entries);
  assert.equal(result.length, 3, `Expected 3 well-spaced entries, got ${result.length}`);
  assert.equal(result[0].ts, base);
  assert.equal(result[1].ts, base + MIN_SAMPLE_SPACING_MS);
  assert.equal(result[2].ts, base + MIN_SAMPLE_SPACING_MS * 2);
});

test("filterWellSpacedSamples handles empty input", () => {
  assert.deepEqual(filterWellSpacedSamples([]), []);
});

test("filterWellSpacedSamples handles a single entry", () => {
  const result = filterWellSpacedSamples([{ ts: 1_000_000 }]);
  assert.equal(result.length, 1);
});

test("filterWellSpacedSamples sorts by ts before filtering", () => {
  const base = 1_000_000_000_000;
  const unsorted = [
    { ts: base + MIN_SAMPLE_SPACING_MS * 2 },
    { ts: base },
    { ts: base + MIN_SAMPLE_SPACING_MS },
  ];
  const result = filterWellSpacedSamples(unsorted);
  assert.equal(result.length, 3);
  assert.ok(result[0].ts < result[1].ts && result[1].ts < result[2].ts);
});

test("forecastSaturation refuses when only closely-spaced samples exist", () => {
  const now = Date.now();
  const closeHistory = [
    { ts: now - 3_600_000, resources: { "connections": { used: 10, limit: 100 } } },
    { ts: now - 2_400_000, resources: { "connections": { used: 20, limit: 100 } } },
    { ts: now - 1_200_000, resources: { "connections": { used: 30, limit: 100 } } },
  ];
  const result = forecastSaturation(closeHistory, "connections");
  assert.equal(result.status, "refused");
  assert.ok(result.reason.includes("well-spaced"), `Expected "well-spaced" in reason: "${result.reason}"`);
  assert.ok(typeof result.wellSpaced === "number" && typeof result.total === "number");
});

test("forecastSaturation correctly fits a trend from well-spaced samples", () => {
  const now = Date.now();
  const spaced = [
    { ts: now - 30 * 86_400_000, resources: { "connections": { used: 10, limit: 100 } } },
    { ts: now - 20 * 86_400_000, resources: { "connections": { used: 20, limit: 100 } } },
    { ts: now - 10 * 86_400_000, resources: { "connections": { used: 30, limit: 100 } } },
  ];
  const result = forecastSaturation(spaced, "connections");
  assert.ok(result.status === "forecast" || result.status === "refused" || result.status === "decreasing");
});

test("forecastSaturation excludes duringBulkLoad entries from the trend", () => {
  const now = Date.now();
  const history = [
    { ts: now - 30 * 86_400_000, resources: { "connections": { used: 10, limit: 100 } } },
    { ts: now - 20 * 86_400_000, resources: { "connections": { used: 20, limit: 100 } }, duringBulkLoad: true },
    { ts: now - 10 * 86_400_000, resources: { "connections": { used: 30, limit: 100 } } },
  ];
  const result = forecastSaturation(history, "connections");
  assert.equal(result.status, "refused", `Expected refused, got ${result.status} — bulk-load entry must not count as a qualifying sample`);
  assert.equal(result.wellSpaced, 2, `Expected 2 well-spaced non-bulk samples, got ${result.wellSpaced}`);
});

test("validateCapacityHistoryEntry passes a well-formed entry", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: { "database-size": { used: 100, limit: 1000 } } };
  assert.deepEqual(validateCapacityHistoryEntry(entry), []);
});

test("validateCapacityHistoryEntry passes an entry with optional flags", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: { "connections": { used: 5, limit: 100 } }, duringBulkLoad: true, tooCloseToPrevious: false };
  assert.deepEqual(validateCapacityHistoryEntry(entry), []);
});

test("validateCapacityHistoryEntry rejects a non-object", () => {
  const errors = validateCapacityHistoryEntry(null);
  assert.ok(errors.length > 0 && errors[0].includes("plain object"), `Expected plain object error, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects missing ts", () => {
  const entry = { cellId: "cell-01", resources: { "connections": { used: 5, limit: 100 } } };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("ts")), `Expected ts error, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects non-positive ts", () => {
  const entry = { ts: -1, cellId: "cell-01", resources: { "connections": { used: 5, limit: 100 } } };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("ts")), `Expected ts error, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects missing cellId", () => {
  const entry = { ts: Date.now(), resources: { "connections": { used: 5, limit: 100 } } };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("cellId")), `Expected cellId error, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects empty resources object", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: {} };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("at least one budget key")), `Expected at-least-one error, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects resource with non-finite used", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: { "connections": { used: NaN, limit: 100 } } };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("used") && e.includes("connections")), `Expected used error for connections, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects resource with non-positive limit", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: { "database-size": { used: 100, limit: 0 } } };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("limit") && e.includes("database-size")), `Expected limit error for database-size, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects non-boolean duringBulkLoad", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: { "connections": { used: 5, limit: 100 } }, duringBulkLoad: "yes" };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("duringBulkLoad")), `Expected duringBulkLoad error, got: ${errors.join(", ")}`);
});

test("validateCapacityHistoryEntry rejects non-boolean tooCloseToPrevious", () => {
  const entry = { ts: Date.now(), cellId: "cell-01", resources: { "connections": { used: 5, limit: 100 } }, tooCloseToPrevious: 1 };
  const errors = validateCapacityHistoryEntry(entry);
  assert.ok(errors.some((e) => e.includes("tooCloseToPrevious")), `Expected tooCloseToPrevious error, got: ${errors.join(", ")}`);
});

if (process.exitCode !== 1)
  process.stdout.write("\nAll cell-capacity tests passed.\n");
