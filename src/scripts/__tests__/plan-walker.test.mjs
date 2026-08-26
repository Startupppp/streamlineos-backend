import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { walk, checkPlanAssertions } from "../run-read-cost-budgets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "plan-walker-fixture.json"), "utf8"),
);

const root = fixture[0]["QUERY PLAN"][0].Plan;

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

test("walk collects all nodes in the tree", () => {
  const nodes = walk(root, []);
  assert.equal(nodes.length, 4, "expected 4 plan nodes (Limit, Sort, Index Scan, Index Only Scan)");
});

test("walk finds ticket_assignees node with Index Only Scan", () => {
  const nodes = walk(root, []);
  const node = nodes.find((n) => n.relation === "ticket_assignees");
  assert.ok(node, "ticket_assignees node should be present");
  assert.equal(node.type, "Index Only Scan");
  assert.equal(node.index, "idx_ticket_assignees_org_user_ticket");
});

test("walk finds tickets node with Index Scan (not Index Only Scan)", () => {
  const nodes = walk(root, []);
  const node = nodes.find((n) => n.relation === "tickets");
  assert.ok(node, "tickets node should be present");
  assert.equal(node.type, "Index Scan");
});

test("blocks are correctly summed from root Shared Hit + Read", () => {
  const blocks = (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
  assert.equal(blocks, 50);
});

test("require-index-only-scan passes when relation has Index Only Scan", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [{ kind: "require-index-only-scan", relation: "ticket_assignees" }],
    nodes,
    "test",
  );
  assert.deepEqual(failures, []);
});

test("require-index-only-scan fails when relation has Index Scan (not Index Only Scan)", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [{ kind: "require-index-only-scan", relation: "tickets" }],
    nodes,
    "test",
  );
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("Index Scan"), `expected 'Index Scan' in: ${failures[0]}`);
  assert.ok(failures[0].includes("not Index Only Scan"), `expected 'not Index Only Scan' in: ${failures[0]}`);
});

test("require-index-only-scan fails when relation is absent from the plan", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [{ kind: "require-index-only-scan", relation: "nonexistent_table" }],
    nodes,
    "test",
  );
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("query shape changed"), `expected 'query shape changed' in: ${failures[0]}`);
});

test("forbid-seq-scan passes when relation is absent", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [{ kind: "forbid-seq-scan", relation: "nonexistent_table" }],
    nodes,
    "test",
  );
  assert.deepEqual(failures, []);
});

test("forbid-seq-scan passes when relation uses an index scan", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [{ kind: "forbid-seq-scan", relation: "tickets" }],
    nodes,
    "test",
  );
  assert.deepEqual(failures, []);
});

test("forbid-seq-scan fails when relation uses Seq Scan", () => {
  const seqScanNodes = [
    { type: "Seq Scan", relation: "vulnerable_table", index: null },
    { type: "Index Only Scan", relation: "ticket_assignees", index: "idx_x" },
  ];
  const failures = checkPlanAssertions(
    [{ kind: "forbid-seq-scan", relation: "vulnerable_table" }],
    seqScanNodes,
    "test",
  );
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("Seq Scan"), `expected 'Seq Scan' in: ${failures[0]}`);
});

test("unknown assertion kind produces a failure", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [{ kind: "unknown-kind", relation: "tickets" }],
    nodes,
    "test",
  );
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("unknown assertion kind"), `expected 'unknown assertion kind' in: ${failures[0]}`);
});

test("multiple assertions are all checked independently", () => {
  const nodes = walk(root, []);
  const failures = checkPlanAssertions(
    [
      { kind: "require-index-only-scan", relation: "ticket_assignees" },
      { kind: "forbid-seq-scan", relation: "tickets" },
      { kind: "require-index-only-scan", relation: "tickets" },
    ],
    nodes,
    "test",
  );
  assert.equal(failures.length, 1, "only the third assertion should fail");
  assert.ok(failures[0].includes("Index Scan"), `expected 'Index Scan' in: ${failures[0]}`);
});

if (process.exitCode !== 1) {
  console.log("\nAll plan-walker tests passed.");
}
