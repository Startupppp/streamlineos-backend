import assert from "node:assert/strict";
import { UNIT_COSTS, canContributeQuantity, detectAnomalousTenants } from "../cell-unit-costs.mjs";

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

test("UNIT_COSTS contains exactly nine units", () => {
  assert.equal(UNIT_COSTS.length, 9, `Expected 9 units, got ${UNIT_COSTS.length}`);
});

test("every unit has a unique id", () => {
  const ids = UNIT_COSTS.map((u) => u.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `Duplicate ids: ${ids.join(", ")}`);
});

test("every unit has source of measured, ledger, or unmeasured", () => {
  const valid = new Set(["measured", "ledger", "unmeasured"]);
  for (const u of UNIT_COSTS)
    assert.ok(valid.has(u.source), `"${u.id}": invalid source "${u.source}"`);
});

test("canContributeQuantity returns false for unmeasured units", () => {
  const unmeasured = UNIT_COSTS.filter((u) => u.source === "unmeasured");
  assert.ok(unmeasured.length > 0, "Expected at least one unmeasured unit");
  for (const u of unmeasured)
    assert.equal(canContributeQuantity(u), false, `"${u.id}" is unmeasured but canContributeQuantity returned true`);
});

test("canContributeQuantity returns true for measured and ledger units", () => {
  const measurable = UNIT_COSTS.filter((u) => u.source !== "unmeasured");
  assert.ok(measurable.length > 0, "Expected at least one measurable unit");
  for (const u of measurable)
    assert.equal(canContributeQuantity(u), true, `"${u.id}" (${u.source}) should contribute quantity`);
});

test("unmeasured units have requiredInput and no countSql", () => {
  const unmeasured = UNIT_COSTS.filter((u) => u.source === "unmeasured");
  for (const u of unmeasured) {
    assert.ok(typeof u.requiredInput === "string" && u.requiredInput.length > 0, `"${u.id}": unmeasured unit must declare requiredInput`);
    assert.ok(u.countSql == null, `"${u.id}": unmeasured unit must not have countSql`);
  }
});

test("measured and ledger units have countSql", () => {
  const measurable = UNIT_COSTS.filter((u) => u.source !== "unmeasured");
  for (const u of measurable)
    assert.ok(typeof u.countSql === "string" && u.countSql.trim(), `"${u.id}": ${u.source} unit must have countSql`);
});

test("the per-ai-token unit uses ledger source", () => {
  const ai = UNIT_COSTS.find((u) => u.id === "per-ai-token");
  assert.ok(ai, "per-ai-token unit not found");
  assert.equal(ai.source, "ledger");
});

test("per-1k-requests is unmeasured and names the required input", () => {
  const unit = UNIT_COSTS.find((u) => u.id === "per-1k-requests");
  assert.ok(unit, "per-1k-requests unit not found");
  assert.equal(unit.source, "unmeasured");
  assert.ok(unit.requiredInput.length > 0);
});

test("per-1k-realtime-minutes is unmeasured and names the required input", () => {
  const unit = UNIT_COSTS.find((u) => u.id === "per-1k-realtime-minutes");
  assert.ok(unit, "per-1k-realtime-minutes unit not found");
  assert.equal(unit.source, "unmeasured");
  assert.ok(unit.requiredInput.length > 0);
});

test("detectAnomalousTenants refuses with fewer than 3 samples", () => {
  const result = detectAnomalousTenants([{ orgId: "a", cost: 10 }, { orgId: "b", cost: 20 }]);
  assert.equal(result.status, "refused");
  assert.ok(result.reason.includes("2 sample(s)"), `Expected count in reason: "${result.reason}"`);
});

test("detectAnomalousTenants returns ok with no anomalous when all costs equal", () => {
  const sample = [
    { orgId: "a", cost: 100 },
    { orgId: "b", cost: 100 },
    { orgId: "c", cost: 100 },
  ];
  const result = detectAnomalousTenants(sample);
  assert.equal(result.status, "ok");
  assert.equal(result.anomalous.length, 0);
});

test("detectAnomalousTenants flags a clear outlier in a realistic sample", () => {
  const normals = Array.from({ length: 19 }, (_, i) => ({ orgId: `org-${i}`, cost: 10 + (i % 3) }));
  const sample = [...normals, { orgId: "outlier", cost: 500 }];
  const result = detectAnomalousTenants(sample, 2.0);
  assert.equal(result.status, "ok");
  assert.ok(result.anomalous.length >= 1, `Expected at least 1 anomaly, got ${result.anomalous.length}`);
  assert.ok(result.anomalous.some((a) => a.orgId === "outlier"), "Expected 'outlier' org to be flagged");
});

test("detectAnomalousTenants respects the stdDevThreshold parameter", () => {
  const normals = Array.from({ length: 19 }, (_, i) => ({ orgId: `org-${i}`, cost: 10 + (i % 3) }));
  const sample = [...normals, { orgId: "outlier", cost: 500 }];
  const lenient = detectAnomalousTenants(sample, 10.0);
  const strict = detectAnomalousTenants(sample, 0.5);
  assert.ok(lenient.anomalous.length < strict.anomalous.length, "Lenient threshold should flag fewer entries");
});

if (process.exitCode !== 1)
  process.stdout.write("\nAll cell-unit-cost tests passed.\n");
