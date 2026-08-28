import assert from "node:assert/strict";
import { ENVELOPE, CELL_SHARE, extrapolate, EXTRAPOLATION_NOTES, LATENCY_OBJECTIVES } from "../envelope-profile.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    process.exitCode = 1;
  }
}

test("ENVELOPE has all 12 required dimensions", () => {
  const required = [
    "registeredAccounts", "organizations", "dailyActiveUsers", "peakSessions",
    "realtimeConnections", "largestOrgMembers", "sustainedRps", "burstRps",
    "burstDurationMinutes", "asyncEventsPerMinute", "singleBroadcastRecipients", "knowledgeChunks",
  ];
  for (const key of required)
    assert.ok(key in ENVELOPE, `ENVELOPE is missing: ${key}`);
});

test("ENVELOPE matches PRD planning targets exactly", () => {
  assert.equal(ENVELOPE.registeredAccounts, 20_000_000);
  assert.equal(ENVELOPE.organizations, 1_000_000);
  assert.equal(ENVELOPE.dailyActiveUsers, 2_000_000);
  assert.equal(ENVELOPE.peakSessions, 250_000);
  assert.equal(ENVELOPE.realtimeConnections, 100_000);
  assert.equal(ENVELOPE.largestOrgMembers, 100_000);
  assert.equal(ENVELOPE.sustainedRps, 50_000);
  assert.equal(ENVELOPE.burstRps, 100_000);
  assert.equal(ENVELOPE.burstDurationMinutes, 10);
  assert.equal(ENVELOPE.asyncEventsPerMinute, 1_000_000);
  assert.equal(ENVELOPE.singleBroadcastRecipients, 100_000);
  assert.equal(ENVELOPE.knowledgeChunks, 1_000_000_000);
});

test("CELL_SHARE has a divisor field", () => {
  assert.ok(typeof CELL_SHARE.divisor === "number" && CELL_SHARE.divisor > 1,
    "divisor must be a number > 1");
});

test("CELL_SHARE derived dimensions equal ENVELOPE / divisor", () => {
  const div = CELL_SHARE.divisor;
  assert.equal(CELL_SHARE.organizations, Math.floor(ENVELOPE.organizations / div));
  assert.equal(CELL_SHARE.dailyActiveUsers, Math.floor(ENVELOPE.dailyActiveUsers / div));
  assert.equal(CELL_SHARE.peakSessions, Math.floor(ENVELOPE.peakSessions / div));
  assert.equal(CELL_SHARE.sustainedRps, Math.floor(ENVELOPE.sustainedRps / div));
  assert.equal(CELL_SHARE.asyncEventsPerMinute, Math.floor(ENVELOPE.asyncEventsPerMinute / div));
});

test("CELL_SHARE.largestOrgMembers is NOT divided — seeded at full ENVELOPE size", () => {
  assert.equal(CELL_SHARE.largestOrgMembers, ENVELOPE.largestOrgMembers,
    "largestOrgMembers must equal ENVELOPE.largestOrgMembers, not ENVELOPE / divisor");
});

test("CELL_SHARE.singleBroadcastRecipients is NOT divided — worst case is per-org", () => {
  assert.equal(CELL_SHARE.singleBroadcastRecipients, ENVELOPE.singleBroadcastRecipients,
    "singleBroadcastRecipients must equal ENVELOPE.singleBroadcastRecipients");
});

test("extrapolate scales a linear dimension by divisor", () => {
  const result = extrapolate(1, "organizations");
  assert.equal(result, CELL_SHARE.divisor,
    "extrapolate(1, 'organizations') should return 1 * divisor");
});

test("extrapolate throws for non-extrapolable dimension realtimeConnections", () => {
  assert.throws(
    () => extrapolate(1, "realtimeConnections"),
    /not extrapolable/,
    "should throw with 'not extrapolable' message",
  );
});

test("extrapolate throws for non-extrapolable dimension singleBroadcastRecipients", () => {
  assert.throws(
    () => extrapolate(1, "singleBroadcastRecipients"),
    /not extrapolable/,
  );
});

test("extrapolate throws for non-extrapolable dimension knowledgeChunks", () => {
  assert.throws(
    () => extrapolate(1, "knowledgeChunks"),
    /not extrapolable/,
  );
});

test("extrapolate throws for unknown dimension", () => {
  assert.throws(
    () => extrapolate(1, "unknownDimension"),
    /Unknown dimension/,
  );
});

test("EXTRAPOLATION_NOTES covers all ENVELOPE dimensions", () => {
  for (const key of Object.keys(ENVELOPE))
    assert.ok(key in EXTRAPOLATION_NOTES, `EXTRAPOLATION_NOTES missing: ${key}`);
});

test("LATENCY_OBJECTIVES is non-empty", () => {
  assert.ok(Array.isArray(LATENCY_OBJECTIVES) && LATENCY_OBJECTIVES.length > 0,
    "LATENCY_OBJECTIVES must be a non-empty array");
});

test("LATENCY_OBJECTIVES each have name, target, and unit", () => {
  for (const obj of LATENCY_OBJECTIVES) {
    assert.ok(typeof obj.name === "string" && obj.name.length > 0, `objective missing name: ${JSON.stringify(obj)}`);
    assert.ok(typeof obj.target === "number", `objective missing numeric target: ${obj.name}`);
    assert.ok(typeof obj.unit === "string" && obj.unit.length > 0, `objective missing unit: ${obj.name}`);
  }
});

test("LATENCY_OBJECTIVES includes p95-simple-db-roundtrip at 20ms", () => {
  const obj = LATENCY_OBJECTIVES.find((o) => o.name === "p95-simple-db-roundtrip");
  assert.ok(obj, "p95-simple-db-roundtrip objective must be present");
  assert.equal(obj.target, 20);
});

test("LATENCY_OBJECTIVES includes availability objective at 99.95%", () => {
  const obj = LATENCY_OBJECTIVES.find((o) => o.name === "authenticated-interactive-availability");
  assert.ok(obj, "authenticated-interactive-availability must be present");
  assert.equal(obj.target, 99.95);
});

test("LATENCY_OBJECTIVES includes durable-event-loss-after-ack at zero", () => {
  const obj = LATENCY_OBJECTIVES.find((o) => o.name === "durable-event-loss-after-ack");
  assert.ok(obj, "durable-event-loss-after-ack must be present");
  assert.equal(obj.target, 0);
});

if (process.exitCode !== 1)
  console.log("\nAll envelope-profile tests passed.");
