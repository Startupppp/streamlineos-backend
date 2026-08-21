import { z } from "zod";

export const relationRowsSchema = z.array(
  z.object({
    owner_name: z.string(),
    relation_kind: z.string(),
    partition_strategy: z.string().nullable(),
    partition_key: z.string().nullable(),
    rls_enabled: z.boolean(),
    force_rls_enabled: z.boolean(),
    policy_count: z.number(),
    tenant_policy_valid: z.boolean(),
    public_access_exists: z.boolean(),
    application_table_privileges: z.array(z.string()),
    application_column_privileges: z.array(z.string()),
    migration_table_privileges: z.array(z.string()),
    migration_column_privileges: z.array(z.string()),
    direct_grants: z.array(z.string()),
    owner_acl_valid: z.boolean(),
  }),
);

export const childRowsSchema = z.array(
  z.object({
    child_name: z.string(),
    partition_bound: z.string(),
  }),
);

export const triggerRowsSchema = z.array(
  z.object({
    trigger_name: z.string(),
    function_schema: z.string(),
    function_name: z.string(),
    trigger_type: z.number(),
    enabled: z.string(),
    constraint_trigger: z.boolean(),
    deferrable: z.boolean(),
    initially_deferred: z.boolean(),
    trigger_columns: z.array(z.string()),
    argument_count: z.number(),
    has_condition: z.boolean(),
  }),
);

export const countRowsSchema = z.array(z.object({ count: z.number() }));
export const constraintRowsSchema = z.array(
  z.object({
    deferrable: z.boolean(),
    initially_deferred: z.boolean(),
    validated: z.boolean(),
  }),
);
export const sequenceRowsSchema = z.array(
  z.object({
    owner_name: z.string(),
    public_access: z.boolean(),
    application_privileges: z.array(z.string()),
    migration_privileges: z.array(z.string()),
    direct_grants: z.array(z.string()),
    owner_acl_valid: z.boolean(),
  }),
);

export type RelationRow = z.infer<typeof relationRowsSchema>[number];
export type ChildRows = z.infer<typeof childRowsSchema>;
export type TriggerRow = z.infer<typeof triggerRowsSchema>[number];
export type TriggerRows = z.infer<typeof triggerRowsSchema>;
