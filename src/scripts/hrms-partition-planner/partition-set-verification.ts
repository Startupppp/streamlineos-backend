import type postgres from "postgres";
import { z } from "zod";
import { failPartition } from "./partition-error";
import type { PartitionPlanItem } from "./partition-plan";
import type { PartitionTable } from "./partition-config";

const directPartitionRowsSchema = z.array(
  z.object({
    child_schema: z.string(),
    child_name: z.string(),
    relation_kind: z.string(),
  }),
);

type DirectPartitionRow = z.infer<typeof directPartitionRowsSchema>[number];

export function assertPartitionSetRows(
  rawRows: unknown,
  expectedItems: PartitionPlanItem[],
  allowMissing: boolean,
): void {
  const parsed = directPartitionRowsSchema.safeParse(rawRows);
  if (!parsed.success) failPartition("PARTITION_SET_ROWS_INVALID");
  const expected = new Set(expectedItems.map((item) => item.child));
  const actual = new Set<string>();
  for (const row of parsed.data) {
    if (
      row.child_schema !== "public" ||
      row.relation_kind !== "r" ||
      !expected.has(row.child_name) ||
      actual.has(row.child_name)
    )
      failPartition("PARTITION_SET_UNAPPROVED_CHILD");
    actual.add(row.child_name);
  }
  if (!allowMissing && actual.size !== expected.size)
    failPartition("PARTITION_SET_INCOMPLETE");
}

export async function assertPartitionSet(
  tx: postgres.TransactionSql,
  parent: PartitionTable,
  expectedItems: PartitionPlanItem[],
  allowMissing: boolean,
): Promise<void> {
  if (expectedItems.some((item) => item.parent !== parent))
    failPartition("PARTITION_SET_PARENT_MISMATCH");
  const rawRows: unknown = await tx`
    SELECT child_namespace.nspname AS child_schema,
      child.relname AS child_name, child.relkind::text AS relation_kind
    FROM pg_class parent
    JOIN pg_namespace parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    JOIN pg_inherits inheritance ON inheritance.inhparent = parent.oid
    JOIN pg_class child ON child.oid = inheritance.inhrelid
    JOIN pg_namespace child_namespace
      ON child_namespace.oid = child.relnamespace
    WHERE parent_namespace.nspname = 'public'
      AND parent.relname = ${parent}
    ORDER BY child_namespace.nspname, child.relname
  `;
  assertPartitionSetRows(rawRows, expectedItems, allowMissing);
}
