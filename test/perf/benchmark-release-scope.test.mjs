import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUDGETS } from "../../src/scripts/read-cost-budgets.mjs";
import { MODULES, validateModules } from "./benchmark-modules.mjs";
import { readCostObservation } from "./benchmark-instruments.mjs";
import { buildCodeReleaseScope, validateCodeReleaseScope } from "./benchmark-release-scope.mjs";

function manifestFixture() {
  return {
    codeReleaseScope: buildCodeReleaseScope(),
    modules: MODULES.map((module) => ({
      id: module.id,
      benchmarks: [
        ...Object.keys(module.readCostBudgets).map((id) => ({ id, source: "read-cost-budgets.mjs" })),
        ...module.heavyQueries.map((id) => ({ id, source: "heavy-query-catalog.mjs" })),
      ],
    })),
  };
}

test("release exclusions leave the full inclusive catalog covered", () => {
  assert.deepEqual(validateModules(MODULES, new Set(BUDGETS.map((budget) => budget.id)), null), []);
  assert.deepEqual(validateCodeReleaseScope(manifestFixture()), []);
  const scope = buildCodeReleaseScope();
  assert.equal(scope.included.some((entry) => ["crm", "inventory"].includes(entry.module)), false);
  assert.equal(scope.excluded.filter((entry) => entry.module === "search").length, 4);
  assert.equal(scope.included.some((entry) => entry.id === "accounting-receivables-list"), true);
  assert.equal(scope.included.some((entry) => entry.id === "search-tickets-sdf"), true);
});

test("Build aggregate read-cost budgets belong to the Build benchmark module", () => {
  const build = MODULES.find((module) => module.id === "build");
  assert.ok(build);
  assert.ok(build.readCostBudgets["build-org-project-health-summary"]);
  assert.ok(build.readCostBudgets["build-resource-allocation"]);
});

test("dropping an excluded measurement still fails global coverage", () => {
  const manifest = manifestFixture();
  manifest.modules = manifest.modules.filter((module) => module.id !== "crm");
  assert.match(validateCodeReleaseScope(manifest).join(), /global benchmark capture is missing crm/);
});

test("moving an in-scope benchmark into exclusions cannot shrink release coverage", () => {
  const manifest = manifestFixture();
  const entry = manifest.codeReleaseScope.included.pop();
  assert.ok(entry);
  manifest.codeReleaseScope.excluded.push({ ...entry, reason: "slow measurement" });
  const errors = validateCodeReleaseScope(manifest).join();
  assert.match(errors, /included is missing/);
  assert.match(errors, /excluded contains unexpected/);
});

test("duplicate entries and unspecified domain exclusions fail", () => {
  const manifest = manifestFixture();
  manifest.codeReleaseScope.included.push(manifest.codeReleaseScope.included[0]);
  manifest.codeReleaseScope.excludedDomains.push("support");
  const errors = validateCodeReleaseScope(manifest).join();
  assert.match(errors, /duplicate entries/);
  assert.match(errors, /exactly the CRM and Inventory exclusions/);
});

test("unmeasured and empty read paths never become passing release observations", () => {
  for (const outcome of ["skip", "unmeasured", "error"])
    assert.notEqual(readCostObservation({ outcome, reason: "missing fixture" }).status, "measured");
  assert.equal(readCostObservation({ outcome: "fail", blocks: 1, resultRows: 0, vacuous: true }).status, "vacuous");
});

test("scratch support fixtures meet every declared support row floor", () => {
  const source = readFileSync(new URL("../../src/scripts/seed-scratch-e2e.mjs", import.meta.url), "utf8");
  const match = source.match(/const SUPPORT_TICKET_COUNT = (\d+);/);
  assert.ok(match, "the scratch support fixture count must be explicit");
  const floor = Math.max(100, ...BUDGETS.filter((budget) => budget.id.startsWith("support-")).map((budget) => budget.minRows ?? 0));
  assert.ok(Number(match[1]) >= floor, `support fixtures must reach ${floor} rows`);
});
