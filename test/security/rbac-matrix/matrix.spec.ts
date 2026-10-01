import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MatrixRunner } from "./matrix-runner";
import type { AdapterKind, Scenario, ScenarioState } from "./matrix.types";
import { STANDINGS } from "./standings";
import { matrixRows } from "./fixtures";
import { mergeRows, worldDb } from "./world-db";
import { closeHttpHarnesses } from "./adapters/http-adapter";
import { accessScenarios } from "./cells/access-scenarios";
import { buildProjectScenarios } from "./cells/build-project-scenarios";
import { buildWorkScenarios } from "./cells/build-work-scenarios";
import { runtimeScenarios } from "./cells/runtime-scenarios";
import { hrRows, hrScenarios } from "./cells/hr-scenarios";
import { payrollRows, payrollScenarios } from "./cells/payroll-scenarios";
import { kbSurveyExportRows, kbSurveyExportScenarios } from "./cells/kb-survey-export-scenarios";
import { signRows, signScenarios } from "./cells/sign-scenarios";
import { signTokenRows, signTokenScenarios } from "./cells/sign-token-scenarios";
import { inboundChannelScenarios, inboundRows } from "./cells/inbound-channel-scenarios";
import { buildIsolationScenarios } from "./cells/build-isolation-scenarios";
import { hrDirectoryIsolationScenarios } from "./cells/hr-directory-isolation-scenarios";
import { recruitmentIntegrationsIsolationScenarios } from "./cells/recruitment-integrations-isolation-scenarios";
import { recruitmentPipelineIsolationScenarios } from "./cells/recruitment-pipeline-isolation-scenarios";
import { recruitmentInboundIsolationScenarios } from "./cells/recruitment-inbound-isolation-scenarios";
import { kbWebhookIsolationScenarios } from "./cells/kb-webhook-isolation-scenarios";
import { sweepIsolationScenarios } from "./cells/sweep-isolation-scenarios";
import { cronIsolationScenarios } from "./cells/cron-isolation-scenarios";
import { evidenceSuites } from "./evidence-suites";

jest.setTimeout(120_000);

const BACKEND_ROOT = resolve(__dirname, "../../..");
const ADAPTERS: readonly AdapterKind[] = ["http", "realtime", "job", "file", "service"];
const STATES: readonly ScenarioState[] = [
  "normal",
  "module-disabled",
  "cross-project",
  "scope-narrowed",
  "replayed",
  "suspended-membership",
  "removed-membership",
  "expired-role",
  "soft-deleted-parent",
  "archived-project",
];

const world = worldDb(
  mergeRows(matrixRows(), hrRows(), payrollRows(), kbSurveyExportRows(), signRows(), signTokenRows(), inboundRows()),
);
const runner = new MatrixRunner();

const plantedFailure: Scenario = {
  id: "planted-failure",
  actor: "org:member",
  resource: "module-access:build",
  action: "manage-access",
  tenant: "same",
  state: "normal",
  expected: "403",
  because: "the gate self-test plants an allow where a refusal is expected",
  pairedWith: "module-access-manage-org-admin",
  bindings: [{ adapter: "service", entry: "planted", run: async () => ({ outcome: "allow" }) }],
};

const scenarios: Scenario[] = [
  ...accessScenarios(world),
  ...buildProjectScenarios(world),
  ...buildWorkScenarios(world),
  ...runtimeScenarios(world),
  ...hrScenarios(world),
  ...payrollScenarios(world),
  ...kbSurveyExportScenarios(world),
  ...signScenarios(world),
  ...signTokenScenarios(world),
  ...inboundChannelScenarios(world),
  ...buildIsolationScenarios(),
  ...hrDirectoryIsolationScenarios(),
  ...recruitmentIntegrationsIsolationScenarios(),
  ...recruitmentPipelineIsolationScenarios(),
  ...recruitmentInboundIsolationScenarios(),
  ...kbWebhookIsolationScenarios(),
  ...sweepIsolationScenarios(),
  ...cronIsolationScenarios(),
  ...(process.env.RBAC_MATRIX_PLANT_FAILURE === "1" ? [plantedFailure] : []),
];
for (const scenario of scenarios) runner.declare(scenario);
for (const suite of evidenceSuites()) runner.declareSuite(suite);

function suitesOnDisk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return suitesOnDisk(path);
    return /spec\.ts$/.test(name) ? [relative(BACKEND_ROOT, path).split("\\").join("/")] : [];
  });
}

function resourcesOf(predicate: (scenario: Scenario) => boolean): Set<string> {
  return new Set(scenarios.filter(predicate).map((scenario) => scenario.resource));
}

afterAll(async () => {
  await closeHttpHarnesses();
  const ledger = runner.ledger();
  const target = process.env.RBAC_MATRIX_LEDGER_OUT;
  if (target !== undefined && target !== "") {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(ledger, null, 2)}\n`);
  }
  process.stdout.write(
    `\nRBAC Matrix Ledger: scenarios=${ledger.scenarios} proven=${ledger.proven} failed=${ledger.failed} unrun=${ledger.unrun} total=${ledger.total}\n`,
  );
});

describe("RBAC verification matrix", () => {
  for (const scenario of scenarios)
    describe(`${scenario.id}: ${scenario.actor} ${scenario.action} on ${scenario.resource} in the ${scenario.tenant} tenant (${scenario.state}) is ${scenario.expected} because ${scenario.because}`, () => {
      for (const binding of scenario.bindings)
        it(`through the ${binding.adapter} adapter (${binding.entry})`, async () => {
          expect(await runner.execute(scenario, binding)).toEqual({ status: "proven", detail: null });
        });
    });
});

describe("RBAC verification matrix shape", () => {
  it("pairs every refusal with an allowed scenario on the same resource and action that binds every adapter the refusal binds, so no negative passes on a surface nothing can reach", () => {
    const unpaired = scenarios
      .filter((scenario) => scenario.expected !== "allow")
      .filter((scenario) => {
        const pair = scenario.pairedWith === undefined ? undefined : runner.find(scenario.pairedWith);
        if (pair === undefined || pair.expected !== "allow" || pair.resource !== scenario.resource || pair.action !== scenario.action) return true;
        const pairAdapters = new Set(pair.bindings.map((binding) => binding.adapter));
        return scenario.bindings.some((binding) => !pairAdapters.has(binding.adapter));
      })
      .map((scenario) => scenario.id);
    expect(unpaired).toEqual([]);
  });

  it("names a pair only on refusals so an allowed scenario never masquerades as a negative", () => {
    expect(scenarios.filter((scenario) => scenario.expected === "allow" && scenario.pairedWith !== undefined).map((scenario) => scenario.id)).toEqual([]);
  });

  it("runs shared scenarios through more than one adapter, so one decision is proven on several transports", () => {
    expect(scenarios.filter((scenario) => scenario.bindings.length > 1).length).toBeGreaterThanOrEqual(30);
  });

  it("gives every BE-102 standing refusals on at least three resources and every standing but the outsider allows on at least three", () => {
    const short = STANDINGS.map((standing) => ({
      standing,
      refused: [...resourcesOf((scenario) => scenario.actor === standing && scenario.expected !== "allow")],
      allowed: [...resourcesOf((scenario) => scenario.actor === standing && scenario.expected === "allow")],
    })).filter((row) => row.refused.length < 3 || (row.standing !== "outsider" && row.allowed.length < 3));
    expect(short).toEqual([]);
  });

  it("drives every adapter with both an allowed and a refused binding", () => {
    for (const adapter of ADAPTERS) {
      const bound = scenarios.filter((scenario) => scenario.bindings.some((binding) => binding.adapter === adapter));
      expect({ adapter, allow: bound.some((scenario) => scenario.expected === "allow"), refuse: bound.some((scenario) => scenario.expected !== "allow") }).toEqual({
        adapter,
        allow: true,
        refuse: true,
      });
    }
  });

  it("states every contract outcome at least once and answers every cross-tenant scenario 404", () => {
    for (const outcome of ["allow", "403", "404", "402"]) expect(scenarios.some((scenario) => scenario.expected === outcome)).toBe(true);
    expect(scenarios.filter((scenario) => scenario.tenant === "other" && scenario.expected !== "404").map((scenario) => scenario.id)).toEqual([]);
  });

  it("covers every lifecycle state, membership state and role-expiry state the matrix names", () => {
    expect(STATES.filter((state) => !scenarios.some((scenario) => scenario.state === state))).toEqual([]);
  });

  it("labels a scenario tenant-only exactly when its entry point takes no actor, and never pairs it with an actor scenario", () => {
    const mixed = scenarios.filter((scenario) => {
      const pair = scenario.pairedWith === undefined ? undefined : runner.find(scenario.pairedWith);
      return pair !== undefined && (pair.actor === "tenant-only") !== (scenario.actor === "tenant-only");
    });
    expect(mixed.map((scenario) => scenario.id)).toEqual([]);
  });

  it("registers every BOLA suite on disk as evidence so the ledger shows what the gate ran and what it could not", () => {
    const declared = new Set(evidenceSuites().map((suite) => suite.suite));
    const onDisk = [
      ...suitesOnDisk(join(BACKEND_ROOT, "test/security/bola")),
      ...readdirSync(join(BACKEND_ROOT, "test/security"))
        .filter((name) => /^bola-.*spec\.ts$/.test(name))
        .map((name) => `test/security/${name}`),
    ];
    expect(onDisk.filter((suite) => !declared.has(suite))).toEqual([]);
    expect([...declared].filter((suite) => !existsSync(join(BACKEND_ROOT, suite)))).toEqual([]);
  });

  it("never marks a seeded e2e suite runnable, so the gate cannot execute it against a database", () => {
    expect(evidenceSuites().filter((suite) => suite.suite.includes("seeded-e2e") && suite.runnable)).toEqual([]);
  });
});
