import type postgres from "postgres";
import {
  assertNoDefaultPartition,
  assertParentReady,
  relationExists,
} from "./partition-catalog";
import { partitionFamilies, type PartitionTable } from "./partition-config";
import { verifyBaseBundleDependencies } from "./partition-dependencies";
import {
  PartitionPlannerError,
  safePartitionFailureCode,
} from "./partition-error";
import {
  securityProfileForTable,
  type VerifiedPartitionManifest,
} from "./partition-manifest";
import { buildPartitionOperationIdentity } from "./partition-operation-identity";
import {
  claimPartitionOperation,
  recordPartitionOperationFailure,
  transitionPartitionOperation,
} from "./partition-operation-ledger";
import { assertPartitionOperationLedgerReady } from "./partition-operation-ledger-readiness";
import type { PartitionPlanItem } from "./partition-plan";
import { assertPartitionSet } from "./partition-set-verification";
import { installPartitionHelpersSql } from "./partition-sql";
import { installLeafTriggers } from "./partition-trigger-install";
import { verifyPartition } from "./partition-verification";

export type PartitionApplyResult = {
  parent: PartitionTable;
  child: string;
  status: "created" | "verified";
};

async function configureTransaction(
  tx: postgres.TransactionSql,
  verified: VerifiedPartitionManifest,
): Promise<void> {
  await tx`
    SELECT
      set_config('lock_timeout', '5s', true),
      set_config('statement_timeout', '30s', true),
      set_config('idle_in_transaction_session_timeout', '60s', true),
      set_config('TimeZone', 'UTC', true),
      set_config(
        'app.bootstrap_role',
        ${verified.manifest.applicationRole},
        true
      ),
      set_config(
        'app.hrms_migration_role',
        ${verified.manifest.migrationRole},
        true
      )
  `;
}

async function lockParent(
  tx: postgres.TransactionSql,
  parent: PartitionTable,
): Promise<void> {
  const rows = await tx<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_xact_lock(
      hashtextextended(${`hrms-partition-planner:${parent}`}, 0)
    ) AS acquired
  `;
  if (rows[0]?.acquired !== true)
    throw new PartitionPlannerError("PARTITION_PARENT_LOCK_UNAVAILABLE");
}

async function preflightParent(
  client: postgres.Sql,
  items: PartitionPlanItem[],
  verified: VerifiedPartitionManifest,
): Promise<void> {
  const first = items[0];
  if (!first) return;
  await client.begin(async (tx) => {
    await configureTransaction(tx, verified);
    await lockParent(tx, first.parent);
    await verifyBaseBundleDependencies(tx, verified);
    const profile = securityProfileForTable(verified.manifest, first.parent);
    await assertParentReady(tx, partitionFamilies[first.parent], profile);
    await assertNoDefaultPartition(tx, first.parent);
    await assertPartitionSet(tx, first.parent, items, true);
    for (const item of items) {
      if (await relationExists(tx, item.child))
        await verifyPartition(tx, item, profile);
    }
  });
}

async function preflightPlan(
  client: postgres.Sql,
  plan: PartitionPlanItem[],
  verified: VerifiedPartitionManifest,
): Promise<Map<PartitionTable, PartitionPlanItem[]>> {
  await client.begin(async (tx) => {
    await configureTransaction(tx, verified);
    await verifyBaseBundleDependencies(tx, verified);
    await assertPartitionOperationLedgerReady(
      tx,
      verified.manifest.databaseRole,
      verified.manifest.applicationRole,
      verified.manifest.migrationRole,
    );
  });
  const byParent = new Map<PartitionTable, PartitionPlanItem[]>();
  for (const item of plan) {
    const items = byParent.get(item.parent) ?? [];
    items.push(item);
    byParent.set(item.parent, items);
  }
  for (const items of byParent.values())
    await preflightParent(client, items, verified);
  return byParent;
}

async function verifyFinalPartitionSet(
  client: postgres.Sql,
  byParent: Map<PartitionTable, PartitionPlanItem[]>,
  verified: VerifiedPartitionManifest,
): Promise<void> {
  for (const [parent, items] of byParent) {
    await client.begin(async (tx) => {
      await configureTransaction(tx, verified);
      await lockParent(tx, parent);
      await verifyBaseBundleDependencies(tx, verified);
      const profile = securityProfileForTable(verified.manifest, parent);
      await assertParentReady(tx, partitionFamilies[parent], profile);
      await assertNoDefaultPartition(tx, parent);
      await assertPartitionSet(tx, parent, items, false);
      for (const item of items) await verifyPartition(tx, item, profile);
    });
  }
}

async function createPartition(
  tx: postgres.TransactionSql,
  item: PartitionPlanItem,
): Promise<void> {
  if (item.kind === "range") {
    await tx`
      SELECT pg_temp.hrms_create_range_partition(
        ${item.parent}, ${item.child}, ${item.from}::date, ${item.to}::date
      )
    `;
    return;
  }
  await tx`
    SELECT pg_temp.hrms_create_hash_partition(
      ${item.parent}, ${item.child}, ${item.modulus}, ${item.remainder}
    )
  `;
}

async function applySinglePartition(
  client: postgres.Sql,
  item: PartitionPlanItem,
  verified: VerifiedPartitionManifest,
): Promise<PartitionApplyResult> {
  let failedIdentity: ReturnType<typeof buildPartitionOperationIdentity> | null =
    null;
  let operationStarted = false;
  try {
    return await client.begin(async (tx) => {
      await configureTransaction(tx, verified);
      await lockParent(tx, item.parent);
      const base = await verifyBaseBundleDependencies(tx, verified);
      const profile = securityProfileForTable(verified.manifest, item.parent);
      await assertParentReady(tx, partitionFamilies[item.parent], profile);
      await assertNoDefaultPartition(tx, item.parent);

      const identity = buildPartitionOperationIdentity(
        item,
        verified,
        base,
        profile,
      );
      failedIdentity = identity;
      const decision = await claimPartitionOperation(tx, identity);
      if (decision === "complete") {
        if (!(await relationExists(tx, item.child)))
          throw new PartitionPlannerError("PARTITION_COMPLETE_CHILD_MISSING");
        await verifyPartition(tx, item, profile);
        await assertNoDefaultPartition(tx, item.parent);
        return { parent: item.parent, child: item.child, status: "verified" };
      }

      operationStarted = true;
      await tx.unsafe(installPartitionHelpersSql);
      const exists = await relationExists(tx, item.child);
      if (!exists) await createPartition(tx, item);
      await installLeafTriggers(tx, item);
      await transitionPartitionOperation(tx, identity, "RUNNING", "VERIFYING");
      await verifyPartition(tx, item, profile);
      await assertNoDefaultPartition(tx, item.parent);
      await transitionPartitionOperation(tx, identity, "VERIFYING", "COMPLETE");
      return {
        parent: item.parent,
        child: item.child,
        status: exists ? "verified" : "created",
      };
    });
  } catch (error: unknown) {
    const code = safePartitionFailureCode(error);
    if (operationStarted && failedIdentity)
      await recordPartitionOperationFailure(client, failedIdentity, code);
    throw new PartitionPlannerError(code);
  }
}

export async function applyPartitionPlan(
  client: postgres.Sql,
  plan: PartitionPlanItem[],
  verified: VerifiedPartitionManifest,
  reportResult: (result: PartitionApplyResult) => void,
): Promise<PartitionApplyResult[]> {
  const byParent = await preflightPlan(client, plan, verified);
  const completed: PartitionApplyResult[] = [];
  for (const item of plan) {
    const result = await applySinglePartition(client, item, verified);
    completed.push(result);
    reportResult(result);
  }
  await verifyFinalPartitionSet(client, byParent, verified);
  return completed;
}
