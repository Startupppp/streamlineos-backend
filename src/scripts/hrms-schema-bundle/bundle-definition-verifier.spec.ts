import { createHash } from "node:crypto";
import {
  assertColumnDefinition,
  assertConstraintDefinition,
  assertExactColumnNames,
  assertExactConstraintSet,
  assertExactIndexSet,
  assertFunctionDefinition,
  assertIndexDefinition,
} from "./bundle-definition-verifier";
import type {
  ColumnRow,
  ConstraintRow,
  FunctionRow,
  IndexRow,
} from "./bundle-definition-schema";
import type {
  ColumnRequirement,
  ExclusionConstraintRequirement,
  ForeignKeyRequirement,
  FunctionRequirement,
  IndexRequirement,
} from "./bundle-definition-types";
import {
  assertOwnerOnlyRelation,
  type OwnerOnlyRelationRow,
} from "./bundle-owner-only-relation";

const columnRow: ColumnRow = {
  data_type: "integer",
  not_null: true,
  default_expression: "1",
  identity: "",
};
const columnRequirement: ColumnRequirement = {
  relation: "workers",
  name: "row_version",
  dataType: "integer",
  notNull: true,
  defaultExpression: "1",
  identity: "",
};

const foreignRow: ConstraintRow = {
  constraint_type: "f",
  validated: true,
  deferrable: true,
  initially_deferred: true,
  no_inherit: false,
  is_local: true,
  inheritance_count: 0,
  has_parent_constraint: false,
  columns: ["organization_id", "event_id"],
  referenced_schema: "public",
  referenced_relation: "event_locators",
  referenced_columns: ["organization_id", "event_id"],
  match_type: "s",
  update_action: "a",
  delete_action: "r",
  nulls_not_distinct: false,
  backing_index_valid: true,
  backing_index_ready: true,
  backing_index_live: true,
  backing_index_method: "btree",
  check_expression: null,
  constraint_definition: "FOREIGN KEY (organization_id, event_id) REFERENCES event_locators(organization_id, event_id) DEFERRABLE INITIALLY DEFERRED",
};
const foreignRequirement: ForeignKeyRequirement = {
  relation: "events",
  name: "fk_events_locator",
  kind: "foreign",
  columns: ["organization_id", "event_id"],
  referencedRelation: "event_locators",
  referencedColumns: ["organization_id", "event_id"],
  validated: true,
  deferrable: true,
  initiallyDeferred: true,
  matchType: "s",
  updateAction: "a",
  deleteAction: "r",
};

const indexRow: IndexRow = {
  relation_name: "workers",
  access_method: "btree",
  unique: true,
  primary: false,
  valid: true,
  ready: true,
  live: true,
  nulls_not_distinct: false,
  key_count: 2,
  attribute_count: 2,
  keys: ["organization_id", "worker_number"],
  predicate: "archived_at IS NULL",
};
const indexRequirement: IndexRequirement = {
  relation: "workers",
  name: "uniq_workers_number",
  unique: true,
  keys: ["organization_id", "worker_number"],
  predicate: "archived_at IS NULL",
};

const exclusionRequirement: ExclusionConstraintRequirement = {
  relation: "worker_assignment_periods",
  name: "excl_worker_assignment_periods_primary_overlap",
  kind: "exclude",
  elements: [
    { expression: "organization_id", operator: "=" },
    { expression: "daterange(valid_from, valid_to, '[)')", operator: "&&" },
  ],
  predicate: "is_primary = true",
  validated: true,
  deferrable: false,
  initiallyDeferred: false,
};
const exclusionDefinition = "EXCLUDE USING gist (organization_id WITH =)";
const exclusionRow: ConstraintRow = {
  ...foreignRow,
  constraint_type: "x",
  deferrable: false,
  initially_deferred: false,
  columns: ["organization_id"],
  referenced_schema: null,
  referenced_relation: null,
  referenced_columns: [],
  match_type: null,
  update_action: null,
  delete_action: null,
  backing_index_method: "gist",
  constraint_definition: exclusionDefinition,
};

const source = "BEGIN\n  RETURN NEW;\nEND;";
const functionRow: FunctionRow = {
  owner_name: "schema_owner",
  argument_types: [],
  result_type: "trigger",
  language_name: "plpgsql",
  security_definer: true,
  volatility: "v",
  strict: false,
  configuration: ["search_path=pg_catalog, public"],
  direct_grants: ["schema_owner:EXECUTE"],
  application_execute: false,
  migration_execute: false,
  leakproof: false,
  parallel_safety: "u",
  source,
};
const functionRequirement: FunctionRequirement = {
  name: "verify_example",
  argumentTypes: [],
  resultType: "trigger",
  language: "plpgsql",
  securityDefiner: true,
  volatility: "v",
  strict: false,
  publicExecute: false,
  bodySha256: [createHash("sha256").update(source).digest("hex")],
};

const ownerOnlyRelation: OwnerOnlyRelationRow = {
  owner_name: "schema_owner",
  current_role: "schema_owner",
  relation_kind: "r",
  row_security: false,
  force_row_security: false,
  policy_count: 0,
  owner_default_acl: true,
  column_acl_exists: false,
  application_access: false,
  migration_access: false,
};

describe("schema bundle definition assertions", () => {
  it("rejects a same-name column with the wrong default", () => {
    expect(() =>
      assertColumnDefinition(
        { ...columnRow, default_expression: "2" },
        columnRequirement,
      ),
    ).toThrow("RUNNER_CATALOG_COLUMN_MISMATCH");
  });

  it("rejects a foreign key with the wrong delete action", () => {
    expect(() =>
      assertConstraintDefinition(
        { ...foreignRow, delete_action: "c" },
        foreignRequirement,
        null,
      ),
    ).toThrow("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
  });

  it("rejects an exclusion constraint with a different canonical shape", () => {
    expect(() =>
      assertConstraintDefinition(
        exclusionRow,
        exclusionRequirement,
        exclusionDefinition,
      ),
    ).not.toThrow();
    expect(() =>
      assertConstraintDefinition(
        exclusionRow,
        exclusionRequirement,
        "EXCLUDE USING gist (organization_id WITH <>)",
      ),
    ).toThrow("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
  });

  it("rejects an extra column on a canonical table", () => {
    expect(() =>
      assertExactColumnNames(
        ["organization_id", "event_id", "unexpected"],
        ["organization_id", "event_id"],
      ),
    ).toThrow("RUNNER_CATALOG_COLUMN_MISMATCH");
  });

  it("rejects extra canonical constraints and indexes", () => {
    expect(() =>
      assertExactConstraintSet(
        [
          { name: "events_pkey", type: "p" },
          { name: "unexpected_check", type: "c" },
        ],
        [{ name: "events_pkey", type: "p" }],
      ),
    ).toThrow("RUNNER_CATALOG_CONSTRAINT_MISMATCH");
    expect(() =>
      assertExactIndexSet(
        ["events_pkey", "unexpected_index"],
        ["events_pkey"],
      ),
    ).toThrow("RUNNER_CATALOG_INDEX_MISMATCH");
  });

  it("rejects an index with a different canonical predicate", () => {
    expect(() =>
      assertIndexDefinition(
        { ...indexRow, predicate: "archived_at IS NOT NULL" },
        indexRow,
        indexRequirement,
      ),
    ).toThrow("RUNNER_CATALOG_INDEX_MISMATCH");
  });

  it("rejects function search-path and body drift", () => {
    expect(() =>
      assertFunctionDefinition(
        { ...functionRow, configuration: ["search_path=public"] },
        functionRequirement,
        "schema_owner",
      ),
    ).toThrow("RUNNER_CATALOG_FUNCTION_MISMATCH");
    expect(() =>
      assertFunctionDefinition(
        { ...functionRow, source: "BEGIN RETURN NULL; END;" },
        functionRequirement,
        "schema_owner",
      ),
    ).toThrow("RUNNER_CATALOG_FUNCTION_MISMATCH");
  });

  it("rejects effective access on an owner-only operation ledger", () => {
    expect(() =>
      assertOwnerOnlyRelation(
        { ...ownerOnlyRelation, migration_access: true },
        "schema_owner",
        { application: false, migration: false },
      ),
    ).toThrow("RUNNER_CATALOG_ACCESS_MISMATCH");
    expect(() =>
      assertOwnerOnlyRelation(
        ownerOnlyRelation,
        "schema_owner",
        { application: false, migration: false },
      ),
    ).not.toThrow();
  });
});
