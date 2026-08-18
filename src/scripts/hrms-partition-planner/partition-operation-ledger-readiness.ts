import type postgres from "postgres";
import { z } from "zod";
import { verifyBundleFileDefinitions } from "../hrms-schema-bundle/bundle-definition-verifier";
import { failPartition } from "./partition-error";

const roleRowsSchema = z.array(
  z.object({
    application_role: z.string().min(1),
    migration_role: z.string().min(1),
    database_role: z.string().min(1),
  }),
);

export async function assertPartitionOperationLedgerReady(
  tx: postgres.TransactionSql,
  expectedDatabaseRole: string,
  applicationRole: string,
  migrationRole: string,
): Promise<void> {
  const rawRows: unknown = await tx`
    SELECT
      nullif(current_setting('app.bootstrap_role', true), '')
        AS application_role,
      nullif(current_setting('app.hrms_migration_role', true), '')
        AS migration_role,
      current_user AS database_role
  `;
  const parsed = roleRowsSchema.safeParse(rawRows);
  if (!parsed.success || parsed.data.length !== 1)
    failPartition("PARTITION_LEDGER_ROLE_MISMATCH");
  const roles = parsed.data[0];
  if (
    !roles ||
    roles.database_role !== expectedDatabaseRole ||
    roles.application_role !== applicationRole ||
    roles.migration_role !== migrationRole
  )
    failPartition("PARTITION_LEDGER_ROLE_MISMATCH");
  try {
    await verifyBundleFileDefinitions(
      tx,
      "0004_hrms_hierarchy_audit.sql",
      applicationRole,
      migrationRole,
      roles.database_role,
    );
  } catch {
    failPartition("PARTITION_LEDGER_CONTRACT_MISMATCH");
  }
}
