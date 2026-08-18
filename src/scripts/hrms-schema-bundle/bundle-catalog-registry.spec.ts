import { bundleCatalogRegistry } from "./bundle-catalog-registry";
import { assertRangeChildren } from "./bundle-partition-shape";
import { definitions0000 } from "./bundle-definitions-0000";
import { definitions0001 } from "./bundle-definitions-0001";
import { definitions0004 } from "./bundle-definitions-0004";
import { functionBodyHashes } from "./bundle-function-hashes";

function namesForRelation(
  relation: string,
  values: Array<{ relation: string; name: string }>,
): string[] {
  return values
    .filter((value) => value.relation === relation)
    .map((value) => value.name);
}

describe("schema bundle deep catalog registry", () => {
  it("pins the retained bundle-operation ledger contract", () => {
    const relation = "app.hrms_sql_bundle_operations";
    expect(namesForRelation(relation, definitions0000.columns)).toEqual([
      "operation_id",
      "bundle_id",
      "file_name",
      "sql_hash",
      "manifest_hash",
      "root_migration_hash",
      "state",
      "attempts",
      "database_name",
      "database_role",
      "server_version_num",
      "started_at",
      "completed_at",
      "last_error",
    ]);
    expect(namesForRelation(relation, definitions0000.constraints)).toEqual([
      "hrms_sql_bundle_operations_pkey",
      "chk_hrms_sql_bundle_operations_identity",
      "chk_hrms_sql_bundle_operations_hashes",
      "chk_hrms_sql_bundle_operations_state",
      "chk_hrms_sql_bundle_operations_attempts",
      "chk_hrms_sql_bundle_operations_server_version",
      "chk_hrms_sql_bundle_operations_error",
      "chk_hrms_sql_bundle_operations_timestamps",
      "chk_hrms_sql_bundle_operations_shape",
    ]);
    const catalog = bundleCatalogRegistry["0000_hrms_profiles_workforce.sql"];
    expect(catalog.exactTriggerRelations).toEqual([relation]);
    expect(namesForRelation(relation, catalog.triggers)).toEqual([
      "enforce_hrms_bundle_operation_transition",
      "reject_hrms_bundle_operation_delete",
      "reject_hrms_bundle_operation_truncate",
    ]);
    expect(
      definitions0000.functions.find(
        (value) => value.name === "enforce_hrms_bundle_operation_transition",
      ),
    ).toMatchObject({ securityDefiner: false, publicExecute: false });
    expect(
      definitions0000.constraints.find(
        (value) => value.name === "chk_hrms_sql_bundle_operations_state",
      ),
    ).toMatchObject({
      kind: "check",
      expression: "state IN ('RUNNING', 'VERIFYING', 'COMPLETE', 'FAILED', 'ROLLED_BACK')",
    });
    expect(functionBodyHashes("enforce_hrms_bundle_operation_transition"))
      .toEqual([
        "34a45daaa5a93e4459596293dd5f07e61b57a3313556dde7a0f8e02f025a1665",
      ]);
  });

  it("pins the owner-only partition-operation ledger contract", () => {
    const relation = "app.hrms_partition_operations";
    expect(namesForRelation(relation, definitions0004.columns)).toHaveLength(24);
    expect(namesForRelation(relation, definitions0004.constraints)).toHaveLength(11);
    expect(definitions0004.ownerOnlyRelations).toEqual([relation]);
    const catalog = bundleCatalogRegistry["0004_hrms_hierarchy_audit.sql"];
    expect(catalog.exactTriggerRelations).toEqual([relation]);
    expect(namesForRelation(relation, catalog.triggers)).toEqual([
      "enforce_hrms_partition_operation_transition",
      "reject_hrms_partition_operation_delete",
      "reject_hrms_partition_operation_truncate",
    ]);
  });

  it("registers both effective-history exclusion constraints", () => {
    expect(
      definitions0001.constraints
        .filter((value) => value.kind === "exclude")
        .map((value) => value.name),
    ).toEqual([
      "excl_worker_assignment_periods_primary_overlap",
      "excl_worker_reporting_lines_overlap",
    ]);
  });

  it("requires zero range leaves only during initial application", () => {
    const child = {
      child_name: "attendance_events_y2026m08",
      partition_bound: "FOR VALUES FROM ('2026-08-01') TO ('2026-09-01')",
    };
    expect(() =>
      assertRangeChildren([child], [], "initial-apply"),
    ).toThrow("RUNNER_CATALOG_PARTITION_MISMATCH");
    expect(() =>
      assertRangeChildren([child], [], "verified-existing"),
    ).not.toThrow();
    expect(() =>
      assertRangeChildren(
        [{ child_name: "attendance_events_default", partition_bound: "DEFAULT" }],
        [],
        "verified-existing",
      ),
    ).toThrow("RUNNER_CATALOG_DEFAULT_PARTITION");
    const requirement = bundleCatalogRegistry[
      "0003_hrms_attendance_events.sql"
    ].relations.find((relation) => relation.name === "attendance_events");
    expect(requirement?.expectedRangeChildren).toEqual([]);
  });
});
