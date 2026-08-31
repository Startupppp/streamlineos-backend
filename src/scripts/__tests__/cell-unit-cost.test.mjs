import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UNIT_COSTS, canContributeQuantity, detectAnomalousTenants } from "../cell-unit-costs.mjs";
import { readLoadDriverResults, EXPECTED_FIELDS } from "../cell-cost/load-driver-reader.mjs";
import { readSpanLog, topOrgsByDbTime, ATTRIBUTION_NOTES } from "../cell-cost/span-log-reader.mjs";

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

test("vendored units declare vendorCostSource", () => {
  const vendored = UNIT_COSTS.filter((u) => u.vendorCostSource);
  assert.ok(vendored.length >= 5, `Expected at least 5 units with vendorCostSource, got ${vendored.length}`);
  const ids = vendored.map((u) => u.id);
  assert.ok(ids.includes("per-active-org"), "per-active-org must declare vendorCostSource");
  assert.ok(ids.includes("per-notification"), "per-notification must declare vendorCostSource");
  assert.ok(ids.includes("per-1k-realtime-minutes"), "per-1k-realtime-minutes must declare vendorCostSource");
});

test("per-1k-requests requiredInput mentions .load-driver-results.json", () => {
  const unit = UNIT_COSTS.find((u) => u.id === "per-1k-requests");
  assert.ok(unit, "per-1k-requests unit not found");
  assert.ok(unit.requiredInput.includes(".load-driver-results.json"), `requiredInput must mention the load driver file`);
});

test("EXPECTED_FIELDS names requestCount, durationMs, and realtimeConnectionMinutes", () => {
  assert.ok("requestCount" in EXPECTED_FIELDS, "requestCount must be in EXPECTED_FIELDS");
  assert.ok("durationMs" in EXPECTED_FIELDS, "durationMs must be in EXPECTED_FIELDS");
  assert.ok("realtimeConnectionMinutes" in EXPECTED_FIELDS, "realtimeConnectionMinutes must be in EXPECTED_FIELDS");
});

test("readLoadDriverResults returns null when file does not exist", () => {
  const result = readLoadDriverResults("/tmp/definitely-does-not-exist-xyzzy.json");
  assert.equal(result, null);
});

test("readLoadDriverResults returns ok with correct fields when file is valid", () => {
  const path = join(tmpdir(), `test-load-driver-${Date.now()}.json`);
  try {
    writeFileSync(path, JSON.stringify({ requestCount: 5000, durationMs: 60000, realtimeConnectionMinutes: 12 }));
    const result = readLoadDriverResults(path);
    assert.equal(result.status, "ok");
    assert.equal(result.requestCount, 5000);
    assert.equal(result.durationMs, 60000);
    assert.equal(result.realtimeConnectionMinutes, 12);
    assert.deepEqual(result.missingFields, []);
  } finally {
    rmSync(path, { force: true });
  }
});

test("readLoadDriverResults reports missingFields when requestCount is absent", () => {
  const path = join(tmpdir(), `test-load-driver-missing-${Date.now()}.json`);
  try {
    writeFileSync(path, JSON.stringify({ durationMs: 60000 }));
    const result = readLoadDriverResults(path);
    assert.equal(result.status, "ok");
    assert.equal(result.requestCount, null);
    assert.ok(result.missingFields.includes("requestCount"), "missingFields must include requestCount");
  } finally {
    rmSync(path, { force: true });
  }
});

test("readLoadDriverResults returns parse-error for malformed JSON", () => {
  const path = join(tmpdir(), `test-load-driver-bad-${Date.now()}.json`);
  try {
    writeFileSync(path, "{ not valid json");
    const result = readLoadDriverResults(path);
    assert.equal(result.status, "parse-error");
  } finally {
    rmSync(path, { force: true });
  }
});

test("readSpanLog returns skipped when logFilePath is null", () => {
  const result = readSpanLog(null);
  assert.equal(result.status, "skipped");
  assert.ok(result.reason.includes("APP_LOG_FILE"), `Expected reason to mention APP_LOG_FILE: "${result.reason}"`);
});

test("readSpanLog returns absent when file does not exist", () => {
  const result = readSpanLog("/tmp/does-not-exist-xyzzy-span.log");
  assert.equal(result.status, "absent");
});

test("readSpanLog returns ok and aggregates db.query.execute spans by org.id", () => {
  const path = join(tmpdir(), `test-span-log-${Date.now()}.log`);
  try {
    const lines = [
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 12, "org.id": "org-a" }),
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 8, "org.id": "org-a" }),
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 5, "org.id": "org-b" }),
    ].join("\n");
    writeFileSync(path, lines);
    const result = readSpanLog(path);
    assert.equal(result.status, "ok");
    assert.equal(result.totalSpans, 3);
    assert.equal(result.orgDbTimeMs.get("org-a"), 20);
    assert.equal(result.orgDbTimeMs.get("org-b"), 5);
  } finally {
    rmSync(path, { force: true });
  }
});

test("readSpanLog aggregates cache.roundtrip spans by org.id", () => {
  const path = join(tmpdir(), `test-span-cache-${Date.now()}.log`);
  try {
    const lines = [
      JSON.stringify({ message: "SPAN", name: "cache.roundtrip", latencyMs: 2, "org.id": "org-a" }),
      JSON.stringify({ message: "SPAN", name: "cache.roundtrip", latencyMs: 3, "org.id": "org-b" }),
    ].join("\n");
    writeFileSync(path, lines);
    const result = readSpanLog(path);
    assert.equal(result.status, "ok");
    assert.equal(result.orgCacheTimeMs.get("org-a"), 2);
    assert.equal(result.orgCacheTimeMs.get("org-b"), 3);
  } finally {
    rmSync(path, { force: true });
  }
});

test("readSpanLog puts spans without org.id into the null bucket", () => {
  const path = join(tmpdir(), `test-span-noorg-${Date.now()}.log`);
  try {
    const lines = [
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 7 }),
    ].join("\n");
    writeFileSync(path, lines);
    const result = readSpanLog(path);
    assert.equal(result.status, "ok");
    assert.equal(result.orgDbTimeMs.get(null), 7);
  } finally {
    rmSync(path, { force: true });
  }
});

test("readSpanLog ignores non-SPAN lines and non-relevant seams", () => {
  const path = join(tmpdir(), `test-span-ignore-${Date.now()}.log`);
  try {
    const lines = [
      JSON.stringify({ message: "LOG", name: "db.query.execute", latencyMs: 99, "org.id": "org-a" }),
      JSON.stringify({ message: "SPAN", name: "db.pool.wait", latencyMs: 1, "org.id": "org-a" }),
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 3, "org.id": "org-a" }),
    ].join("\n");
    writeFileSync(path, lines);
    const result = readSpanLog(path);
    assert.equal(result.status, "ok");
    assert.equal(result.totalSpans, 1);
    assert.equal(result.orgDbTimeMs.get("org-a"), 3);
  } finally {
    rmSync(path, { force: true });
  }
});

test("topOrgsByDbTime returns orgs sorted descending by db time, excluding null bucket", () => {
  const path = join(tmpdir(), `test-span-top-${Date.now()}.log`);
  try {
    const lines = [
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 5, "org.id": "org-a" }),
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 50, "org.id": "org-b" }),
      JSON.stringify({ message: "SPAN", name: "db.query.execute", latencyMs: 20 }),
    ].join("\n");
    writeFileSync(path, lines);
    const result = readSpanLog(path);
    const top = topOrgsByDbTime(result, 10);
    assert.equal(top.length, 2);
    assert.equal(top[0].orgId, "org-b");
    assert.equal(top[1].orgId, "org-a");
  } finally {
    rmSync(path, { force: true });
  }
});

test("ATTRIBUTION_NOTES names egress, dbTime, cacheTime, pgStatStatements, pgStatDatabase, redisMemory", () => {
  assert.ok("egress" in ATTRIBUTION_NOTES, "egress must be in ATTRIBUTION_NOTES");
  assert.ok("dbTime" in ATTRIBUTION_NOTES, "dbTime must be in ATTRIBUTION_NOTES");
  assert.ok("cacheTime" in ATTRIBUTION_NOTES, "cacheTime must be in ATTRIBUTION_NOTES");
  assert.ok("pgStatStatements" in ATTRIBUTION_NOTES, "pgStatStatements must be in ATTRIBUTION_NOTES");
  assert.ok("pgStatDatabase" in ATTRIBUTION_NOTES, "pgStatDatabase must be in ATTRIBUTION_NOTES");
  assert.ok("redisMemory" in ATTRIBUTION_NOTES, "redisMemory must be in ATTRIBUTION_NOTES");
});

test("ATTRIBUTION_NOTES.egress mentions CDN or load balancer", () => {
  assert.ok(
    ATTRIBUTION_NOTES.egress.toLowerCase().includes("cdn") || ATTRIBUTION_NOTES.egress.toLowerCase().includes("load balancer"),
    `egress note must name the external measurement source: "${ATTRIBUTION_NOTES.egress}"`,
  );
});

test("ATTRIBUTION_NOTES.pgStatStatements explains why it cannot attribute per org", () => {
  assert.ok(
    ATTRIBUTION_NOTES.pgStatStatements.toLowerCase().includes("org"),
    `pgStatStatements note must explain the org-attribution limitation: "${ATTRIBUTION_NOTES.pgStatStatements}"`,
  );
});

if (process.exitCode !== 1)
  process.stdout.write("\nAll cell-unit-cost tests passed.\n");
