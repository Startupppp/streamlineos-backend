import { z } from "zod";

export const columnRowsSchema = z.array(z.object({
  data_type: z.string(),
  not_null: z.boolean(),
  default_expression: z.string().nullable(),
  identity: z.string(),
}));

export const constraintRowsSchema = z.array(z.object({
  constraint_type: z.string(),
  validated: z.boolean(),
  deferrable: z.boolean(),
  initially_deferred: z.boolean(),
  no_inherit: z.boolean(),
  is_local: z.boolean(),
  inheritance_count: z.number(),
  has_parent_constraint: z.boolean(),
  columns: z.array(z.string()),
  referenced_schema: z.string().nullable(),
  referenced_relation: z.string().nullable(),
  referenced_columns: z.array(z.string()),
  match_type: z.string().nullable(),
  update_action: z.string().nullable(),
  delete_action: z.string().nullable(),
  nulls_not_distinct: z.boolean(),
  backing_index_valid: z.boolean().nullable(),
  backing_index_ready: z.boolean().nullable(),
  backing_index_live: z.boolean().nullable(),
  backing_index_method: z.string().nullable(),
  check_expression: z.string().nullable(),
  constraint_definition: z.string(),
}));

export const indexRowsSchema = z.array(z.object({
  relation_name: z.string(),
  access_method: z.string(),
  unique: z.boolean(),
  primary: z.boolean(),
  valid: z.boolean(),
  ready: z.boolean(),
  live: z.boolean(),
  nulls_not_distinct: z.boolean(),
  key_count: z.number(),
  attribute_count: z.number(),
  keys: z.array(z.string()),
  predicate: z.string().nullable(),
}));

export const functionRowsSchema = z.array(z.object({
  owner_name: z.string(),
  argument_types: z.array(z.string()),
  result_type: z.string(),
  language_name: z.string(),
  security_definer: z.boolean(),
  volatility: z.string(),
  strict: z.boolean(),
  configuration: z.array(z.string()),
  direct_grants: z.array(z.string()),
  application_execute: z.boolean(),
  migration_execute: z.boolean(),
  leakproof: z.boolean(),
  parallel_safety: z.string(),
  source: z.string(),
}));

export const enumRowsSchema = z.array(z.object({
  owner_name: z.string(),
  labels: z.array(z.string()),
  acl_matches_default: z.boolean(),
  application_usage: z.boolean(),
  migration_usage: z.boolean(),
}));

export type ColumnRow = z.infer<typeof columnRowsSchema>[number];
export type ConstraintRow = z.infer<typeof constraintRowsSchema>[number];
export type IndexRow = z.infer<typeof indexRowsSchema>[number];
export type FunctionRow = z.infer<typeof functionRowsSchema>[number];
export type EnumRow = z.infer<typeof enumRowsSchema>[number];
