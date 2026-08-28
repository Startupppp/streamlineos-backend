import { resolve } from "node:path";
import * as dotenv from "dotenv";
import {
  nextRolloutAction,
  rollbackPlan,
  shouldRollBack,
} from "../common/placement/canary-rollout";
import type {
  RolloutAction,
  RolloutPlan,
  SloSnapshot,
} from "../common/placement/canary-rollout";
import { measureCellSlo } from "./rollout/cell-slo-probe";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const CANARY_CELL = "legacy-1";
const SECOND_CELL = "cell-2";
const PROBE_ORG_ID = "00000000-0000-0000-0000-000000000000";
const SELF_TEST_SAMPLES = 8;
const ROLLOUT_SAMPLES = 10;

function assertNeverAction(k: never): never {
  throw new Error(`Unexpected rollout action: ${String(k)}`);
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function resolveUrls(env: NodeJS.ProcessEnv): {
  canaryApp: string;
  cell2App: string;
} {
  const appBase = env["APP_DATABASE_URL"];
  if (!appBase)
    throw new Error(
      "APP_DATABASE_URL is required (the non-BYPASSRLS app role).",
    );
  const cell2App =
    env["REGION_CELL_2_APP_DATABASE_URL"] ?? withDatabase(appBase, "cell2");
  return { canaryApp: appBase, cell2App };
}

function makePlan(): RolloutPlan {
  return {
    release: {
      releaseId: "rollout-demo-v1",
      schemaVersion: 1,
      eventVersion: 1,
      minSchemaVersion: 1,
      minEventVersion: 1,
    },
    canaryCellId: CANARY_CELL,
    orderedCells: [CANARY_CELL, SECOND_CELL],
  };
}

function toSnapshot(m: {
  readonly p99LatencyMs: number;
  readonly errorRatePercent: number;
  readonly availabilityPercent: number;
}): SloSnapshot {
  return {
    p99LatencyMs: m.p99LatencyMs,
    errorRatePercent: m.errorRatePercent,
    availabilityPercent: m.availabilityPercent,
  };
}

async function selfTest(canaryApp: string): Promise<void> {
  console.log("Measuring canary with healthy workload…");
  const healthy = await measureCellSlo({
    cellId: CANARY_CELL,
    appUrl: canaryApp,
    orgId: PROBE_ORG_ID,
    sampleCount: SELF_TEST_SAMPLES,
    workload: "normal",
  });

  console.log(
    "Measuring canary with regressed workload (generate_series 200k sort)…",
  );
  const regressed = await measureCellSlo({
    cellId: CANARY_CELL,
    appUrl: canaryApp,
    orgId: PROBE_ORG_ID,
    sampleCount: SELF_TEST_SAMPLES,
    workload: "regressed",
  });

  console.log(
    `\nhealthy   p99=${healthy.p99LatencyMs.toFixed(1)}ms` +
      ` error=${healthy.errorRatePercent.toFixed(2)}%` +
      ` avail=${healthy.availabilityPercent.toFixed(2)}%`,
  );
  console.log(
    `regressed p99=${regressed.p99LatencyMs.toFixed(1)}ms` +
      ` error=${regressed.errorRatePercent.toFixed(2)}%` +
      ` avail=${regressed.availabilityPercent.toFixed(2)}%`,
  );

  const plan = makePlan();
  const deployed = [CANARY_CELL];

  const healthySloPassed = !shouldRollBack(
    toSnapshot(healthy),
    toSnapshot(healthy),
  );
  const healthyAction = nextRolloutAction(plan, deployed, healthySloPassed);

  const regressedSloPassed = !shouldRollBack(
    toSnapshot(healthy),
    toSnapshot(regressed),
  );
  const regressedAction = nextRolloutAction(plan, deployed, regressedSloPassed);

  const failures: string[] = [];
  if (healthyAction.kind !== "DEPLOY")
    failures.push(
      `healthy canary yielded ${healthyAction.kind}, expected DEPLOY`,
    );
  if (regressedAction.kind !== "ROLLBACK")
    failures.push(
      `regressed canary yielded ${regressedAction.kind}, expected ROLLBACK`,
    );

  if (failures.length === 0) {
    const ratio = (
      ((regressed.p99LatencyMs - healthy.p99LatencyMs) / healthy.p99LatencyMs) *
      100
    ).toFixed(1);
    console.log(
      `\nSELF-TEST PASS: healthy canary yields DEPLOY (p99=${healthy.p99LatencyMs.toFixed(1)}ms),` +
        ` regressed canary yields ROLLBACK (p99=${regressed.p99LatencyMs.toFixed(1)}ms, +${ratio}% regression)`,
    );
    return;
  }
  for (const f of failures) console.error(`SELF-TEST FAIL: ${f}`);
  process.exitCode = 1;
}

async function regressedCanaryRun(canaryApp: string): Promise<void> {
  const plan = makePlan();
  let deployed: string[] = [];

  console.log("Step 1: determine first action");
  const firstAction = nextRolloutAction(plan, deployed, true);
  if (firstAction.kind !== "DEPLOY") {
    console.error(`Expected DEPLOY, got ${firstAction.kind}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  → DEPLOY to ${firstAction.cellId}`);

  console.log("\nStep 2: measure canary baseline before deploy");
  const baseline = await measureCellSlo({
    cellId: firstAction.cellId,
    appUrl: canaryApp,
    orgId: PROBE_ORG_ID,
    sampleCount: ROLLOUT_SAMPLES,
    workload: "normal",
  });
  console.log(
    `  baseline p99=${baseline.p99LatencyMs.toFixed(1)}ms` +
      ` error=${baseline.errorRatePercent.toFixed(2)}%` +
      ` avail=${baseline.availabilityPercent.toFixed(2)}%`,
  );

  deployed = [firstAction.cellId];

  console.log(
    "\nStep 3: measure canary post-deploy with deliberately regressed workload",
  );
  console.log(
    "  (generate_series 200000 rows sorted by md5 — unindexed sort, pathologically slow)",
  );
  const postDeploy = await measureCellSlo({
    cellId: firstAction.cellId,
    appUrl: canaryApp,
    orgId: PROBE_ORG_ID,
    sampleCount: ROLLOUT_SAMPLES,
    workload: "regressed",
  });
  console.log(
    `  post-deploy p99=${postDeploy.p99LatencyMs.toFixed(1)}ms` +
      ` error=${postDeploy.errorRatePercent.toFixed(2)}%` +
      ` avail=${postDeploy.availabilityPercent.toFixed(2)}%`,
  );

  const latencyRatio =
    baseline.p99LatencyMs > 0
      ? (postDeploy.p99LatencyMs - baseline.p99LatencyMs) /
        baseline.p99LatencyMs
      : 0;
  console.log(
    `  latency regression: ${(latencyRatio * 100).toFixed(1)}% (threshold 20%)`,
  );

  const rollback = shouldRollBack(toSnapshot(baseline), toSnapshot(postDeploy));
  const sloPassed = !rollback;
  const nextAction = nextRolloutAction(plan, deployed, sloPassed);

  console.log(`\nStep 4: rollout decision`);
  console.log(`  shouldRollBack → ${rollback}`);
  console.log(
    `  nextRolloutAction → ${nextAction.kind}${nextAction.kind === "ROLLBACK" ? ` on ${nextAction.cellId}: ${nextAction.reason}` : ""}`,
  );

  if (nextAction.kind !== "ROLLBACK") {
    console.error("FAIL: expected ROLLBACK but got " + nextAction.kind);
    process.exitCode = 1;
    return;
  }

  const rb = rollbackPlan(plan, deployed, null);
  console.log(`\nROLLBACK FIRED on ${nextAction.cellId}`);
  console.log(`  cells to revert: [${rb.cellsToRevert.join(", ")}]`);
  console.log(
    `  baseline p99=${baseline.p99LatencyMs.toFixed(1)}ms → regressed p99=${postDeploy.p99LatencyMs.toFixed(1)}ms`,
  );
  console.log(
    `  latency increase ${(latencyRatio * 100).toFixed(1)}% exceeds 20% rollback threshold`,
  );
  console.log("\nRESULT: ROLLBACK FIRED ON REAL MEASURED REGRESSION");
}

async function fullRollout(canaryApp: string, cell2App: string): Promise<void> {
  const plan = makePlan();
  const deployed: string[] = [];
  let baseline: SloSnapshot | null = null;
  let lastSloPassed = true;

  const cellAppUrls: Record<string, string> = {
    [CANARY_CELL]: canaryApp,
    [SECOND_CELL]: cell2App,
  };

  for (;;) {
    const action: RolloutAction = nextRolloutAction(
      plan,
      deployed,
      lastSloPassed,
    );

    switch (action.kind) {
      case "COMPLETE": {
        console.log(
          `COMPLETE — all ${deployed.length} cell(s) deployed successfully`,
        );
        return;
      }
      case "ROLLBACK": {
        const rb = rollbackPlan(plan, deployed, null);
        console.log(`ROLLBACK → ${action.cellId}: ${action.reason}`);
        console.log(`  cells to revert: [${rb.cellsToRevert.join(", ")}]`);
        process.exitCode = 1;
        return;
      }
      case "DEPLOY": {
        const url = cellAppUrls[action.cellId];
        if (url === undefined) {
          console.error(`No URL configured for cell ${action.cellId}`);
          process.exitCode = 1;
          return;
        }
        const preDeploy = await measureCellSlo({
          cellId: action.cellId,
          appUrl: url,
          orgId: PROBE_ORG_ID,
          sampleCount: ROLLOUT_SAMPLES,
          workload: "normal",
        });
        if (baseline === null) baseline = toSnapshot(preDeploy);

        console.log(`DEPLOY → ${action.cellId}`);

        const postDeploy = await measureCellSlo({
          cellId: action.cellId,
          appUrl: url,
          orgId: PROBE_ORG_ID,
          sampleCount: ROLLOUT_SAMPLES,
          workload: "normal",
        });
        const regressed = shouldRollBack(baseline, toSnapshot(postDeploy));
        console.log(
          `  post-deploy p99=${postDeploy.p99LatencyMs.toFixed(1)}ms regression=${regressed}`,
        );
        lastSloPassed = !regressed;
        deployed.push(action.cellId);
        break;
      }
      default:
        return assertNeverAction(action);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { canaryApp, cell2App } = resolveUrls(process.env);

  if (argv.includes("--self-test")) return selfTest(canaryApp);
  if (argv.includes("--regressed-canary")) return regressedCanaryRun(canaryApp);
  return fullRollout(canaryApp, cell2App);
}

main().catch((e: unknown) => {
  console.error(
    "ROLLOUT RUNNER FAILED:",
    e instanceof Error ? e.message : String(e),
  );
  process.exitCode = 1;
});
