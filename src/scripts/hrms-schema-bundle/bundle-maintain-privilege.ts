import type postgres from "postgres";
import { z } from "zod";
import { fail } from "./bundle-error";

const versionRowsSchema = z.array(z.object({
  server_version_num: z.number(),
}));

const maintainRowsSchema = z.array(z.object({
  application_has_maintain: z.boolean(),
  migration_has_maintain: z.boolean(),
}));

export function supportsMaintainPrivilege(serverVersion: number): boolean {
  return serverVersion >= 170000;
}

export async function readMaintainPrivileges(
  tx: postgres.Sql | postgres.TransactionSql,
  relationSchema: string,
  relationName: string,
  applicationRole: string,
  migrationRole: string,
): Promise<{ application: boolean; migration: boolean }> {
  const rawVersion: unknown = await tx`
    SELECT current_setting('server_version_num')::integer
      AS server_version_num
  `;
  const versionRows = versionRowsSchema.parse(rawVersion);
  const version = versionRows[0];
  if (!version || versionRows.length !== 1)
    fail("RUNNER_CATALOG_RELATION_MISMATCH");
  if (!supportsMaintainPrivilege(version.server_version_num))
    return { application: false, migration: false };
  const rawMaintain: unknown = await tx`
    SELECT has_table_privilege(
        ${applicationRole}::name,
        to_regclass(format('%I.%I', ${relationSchema}, ${relationName})),
        'MAINTAIN'
      ) AS application_has_maintain,
      has_table_privilege(
        ${migrationRole}::name,
        to_regclass(format('%I.%I', ${relationSchema}, ${relationName})),
        'MAINTAIN'
      ) AS migration_has_maintain
  `;
  const rows = maintainRowsSchema.parse(rawMaintain);
  const row = rows[0];
  if (!row || rows.length !== 1)
    fail("RUNNER_CATALOG_RELATION_MISMATCH");
  return {
    application: row.application_has_maintain,
    migration: row.migration_has_maintain,
  };
}
