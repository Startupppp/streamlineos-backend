import type postgres from "postgres";
import type {
  PartitionSecurityProfile,
  PartitionTable,
} from "./partition-config";
import { assertRelationSecurityReady } from "./partition-security";

const attendanceTables = new Set<PartitionTable>([
  "attendance_events",
  "attendance_event_evidence",
  "attendance_event_locators",
  "attendance_correction_links",
]);

const restrictedRelations = [
  "attendance_event_evidence",
  "attendance_evidence_legal_holds",
];

type RestrictedRelationRow = {
  relation_name: string;
  relation_kind: string;
  is_partition: boolean;
};

export function needsAttendanceSecurityVerification(
  tables: PartitionTable[],
): boolean {
  return tables.some((table) => attendanceTables.has(table));
}

export async function assertAttendanceSecurityReady(
  client: postgres.Sql,
  securityProfile: PartitionSecurityProfile,
  applicationRole: string,
  migrationRole: string,
): Promise<void> {
  await client.begin(async (tx) => {
    await tx`
      SELECT
        set_config('app.bootstrap_role', ${applicationRole}, true),
        set_config('app.hrms_migration_role', ${migrationRole}, true)
    `;
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    await tx.unsafe("SET LOCAL statement_timeout = '30s'");
    const rows = await tx<RestrictedRelationRow[]>`
      SELECT
        relation.relname AS relation_name,
        relation.relkind AS relation_kind,
        relation.relispartition AS is_partition
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY(${restrictedRelations}::text[])
    `;
    const byName = new Map(rows.map((row) => [row.relation_name, row]));
    for (const relationName of restrictedRelations) {
      const row = byName.get(relationName);
      if (!row) throw new Error(`${relationName} does not exist`);
      const expectedKind = relationName === "attendance_event_evidence" ? "p" : "r";
      if (row.relation_kind !== expectedKind || row.is_partition)
        throw new Error(`${relationName} has an unexpected relation shape`);
      await assertRelationSecurityReady(
        tx,
        relationName,
        "organization_id",
        false,
        securityProfile,
      );
    }
  });
}
