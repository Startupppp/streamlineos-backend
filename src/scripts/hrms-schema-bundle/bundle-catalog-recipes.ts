export type RoleAccess = {
  tablePrivileges: string[];
  columnPrivileges: Array<{ column: string; privilege: string }>;
};

export type ApplicationAccess = RoleAccess;

export type TriggerRecipe = {
  name: string;
  functionName: string;
  triggerType: number;
  constraint: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  columns: string[];
};

export type RelationRequirement = {
  name: string;
  kind: "r" | "p";
  tenantColumn: "org_id" | "organization_id";
  access: ApplicationAccess;
  migrationAccess: RoleAccess;
  partitionKey: string | null;
  partitionStrategy: "h" | "r" | null;
  hashModulus: number | null;
  expectedRangeChildren: Array<{
    name: string;
    bound: string;
  }> | null;
  leafTriggers: TriggerRecipe[];
};

export type TriggerRequirement = TriggerRecipe & { relation: string };

export type ConstraintRequirement = {
  relation: string;
  name: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
};

export type FileCatalogRequirement = {
  relations: RelationRequirement[];
  functions: string[];
  triggers: TriggerRequirement[];
  exactTriggerRelations: string[];
  constraints: ConstraintRequirement[];
  sequences: string[];
  migrationSequencePrivileges: string[];
};

export const none: RoleAccess = {
  tablePrivileges: [],
  columnPrivileges: [],
};
export const select: ApplicationAccess = {
  tablePrivileges: ["SELECT"],
  columnPrivileges: [],
};
export const profileColumns: ApplicationAccess = {
  tablePrivileges: [],
  columnPrivileges: [
    { column: "changed_at", privilege: "SELECT" },
    { column: "organization_id", privilege: "SELECT" },
    { column: "profile_revision", privilege: "SELECT" },
  ],
};

export function roleAccess(...tablePrivileges: string[]): RoleAccess {
  return { tablePrivileges, columnPrivileges: [] };
}

export function table(
  name: string,
  tenantColumn: RelationRequirement["tenantColumn"],
  access: ApplicationAccess = none,
  migrationAccess: RoleAccess = none,
): RelationRequirement {
  return {
    name,
    kind: "r",
    tenantColumn,
    access,
    migrationAccess,
    partitionKey: null,
    partitionStrategy: null,
    hashModulus: null,
    expectedRangeChildren: null,
    leafTriggers: [],
  };
}

export function partition(
  name: string,
  strategy: "h" | "r",
  key: string,
  leafTriggers: TriggerRecipe[],
): RelationRequirement {
  return {
    name,
    kind: "p",
    tenantColumn: "organization_id",
    access: none,
    migrationAccess: none,
    partitionKey: key,
    partitionStrategy: strategy,
    hashModulus: strategy === "h" ? 16 : null,
    expectedRangeChildren: strategy === "r" ? [] : null,
    leafTriggers,
  };
}

export function recipe(
  name: string,
  functionName: string,
  triggerType: number,
  constraint = false,
  columns: string[] = [],
): TriggerRecipe {
  return {
    name,
    functionName,
    triggerType,
    constraint,
    deferrable: constraint,
    initiallyDeferred: constraint,
    columns,
  };
}

export function trigger(
  relation: string,
  name: string,
  functionName: string,
  triggerType: number,
  constraint = false,
  columns: string[] = [],
): TriggerRequirement {
  return {
    relation,
    ...recipe(name, functionName, triggerType, constraint, columns),
  };
}

const truncate = recipe(
  "reject_hrms_truncate",
  "reject_hrms_append_only_mutation",
  34,
);
const immutable = (name: string) =>
  recipe(name, "reject_hrms_append_only_mutation", 27);
const deferredInsert = (name: string, functionName = name) =>
  recipe(name, functionName, 5, true);

export const locatorLeaf = [
  immutable("reject_worker_leave_locator_mutation"),
  truncate,
  deferredInsert("verify_worker_leave_locator_fact"),
];
export const leaveFactLeaf = [
  immutable("reject_worker_leave_fact_mutation"),
  truncate,
  deferredInsert("verify_worker_leave_locator_fact"),
  deferredInsert("verify_worker_leave_reversal"),
];
export const leaveReversalLeaf = [
  immutable("reject_worker_leave_reversal_mutation"),
  truncate,
  deferredInsert("verify_worker_leave_reversal"),
];
export const attendanceLocatorLeaf = [
  immutable("reject_attendance_event_locator_mutation"),
  truncate,
  deferredInsert("verify_attendance_locator_fact"),
];
export const attendanceFactLeaf = [
  immutable("reject_attendance_event_mutation"),
  truncate,
  deferredInsert("verify_attendance_locator_fact"),
  deferredInsert("verify_attendance_correction"),
];
export const attendanceCorrectionLeaf = [
  immutable("reject_attendance_correction_link_mutation"),
  truncate,
  deferredInsert("verify_attendance_correction_link"),
];
export const evidenceLeaf = [
  recipe(
    "guard_attendance_event_evidence_mutation",
    "reject_attendance_evidence_mutation",
    27,
  ),
  truncate,
];
export const auditSourceLeaf = [
  immutable("reject_hr_audit_event_source_mutation"),
  truncate,
  deferredInsert("verify_hr_audit_source_fact"),
];
export const auditFactLeaf = [
  immutable("reject_hr_audit_event_mutation"),
  truncate,
  deferredInsert("verify_hr_audit_source_fact"),
];

export const deferrable = (
  relation: string,
  name: string,
): ConstraintRequirement => ({
  relation,
  name,
  deferrable: true,
  initiallyDeferred: true,
});
