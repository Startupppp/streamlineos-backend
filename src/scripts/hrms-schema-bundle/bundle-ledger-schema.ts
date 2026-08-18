import { z } from "zod";

export const operationStateSchema = z.enum([
  "RUNNING",
  "VERIFYING",
  "COMPLETE",
  "FAILED",
  "ROLLED_BACK",
]);

export const operationRowsSchema = z.array(
  z.object({
    operation_id: z.string().min(1),
    bundle_id: z.string().min(1),
    file_name: z.string().min(1),
    sql_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    manifest_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    root_migration_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    state: operationStateSchema,
    database_name: z.string().min(1),
    database_role: z.string().min(1),
    server_version_num: z.number().int().positive(),
  }),
);

export const ledgerColumnRowsSchema = z.array(
  z.object({
    column_name: z.string(),
    data_type: z.string(),
    not_null: z.boolean(),
  }),
);

export const ledgerConstraintRowsSchema = z.array(
  z.object({
    constraint_name: z.string(),
    constraint_type: z.string(),
    validated: z.boolean(),
  }),
);

export const ledgerAccessRowsSchema = z.array(
  z.object({
    owner_matches: z.boolean(),
    owner_acl_valid: z.boolean(),
    public_access: z.boolean(),
    direct_grants: z.array(z.string()),
    application_access: z.boolean(),
    migration_select: z.boolean(),
    migration_insert: z.boolean(),
    migration_update: z.boolean(),
    migration_delete: z.boolean(),
    migration_truncate: z.boolean(),
    migration_references: z.boolean(),
    migration_trigger: z.boolean(),
    migration_maintain: z.boolean(),
  }),
);

export const affectedRowsSchema = z.array(
  z.object({ operation_id: z.string() }),
);

export const existsRowsSchema = z.array(z.object({ exists: z.boolean() }));

export type OperationRow = z.infer<typeof operationRowsSchema>[number];
