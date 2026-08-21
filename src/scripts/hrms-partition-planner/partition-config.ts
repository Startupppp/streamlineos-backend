import { z } from "zod";

export const rangePartitionTables = [
  "attendance_events",
  "attendance_event_evidence",
  "worker_leave_ledger_entries",
  "hr_audit_events",
] as const;

export const hashPartitionTables = [
  "attendance_event_locators",
  "attendance_correction_links",
  "hr_audit_event_sources",
  "worker_leave_entry_locators",
  "worker_leave_reversal_links",
] as const;

export const approvedHashModulus = 16;

export const partitionTableNames = [
  ...rangePartitionTables,
  ...hashPartitionTables,
] as const;

export const partitionTableSchema = z.enum(partitionTableNames);
export const monthSchema = z
  .string()
  .regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, "month must use YYYY-MM");
export const tenantIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "invalid tenant identifier");
export const environmentSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);
export const partitionSecurityProfileSchema = z.literal(
  "base-owner-only-v1",
);

export type PartitionTable = z.infer<typeof partitionTableSchema>;
export type PartitionEnvironment = z.infer<typeof environmentSchema>;
export type PartitionSecurityProfile = z.infer<
  typeof partitionSecurityProfileSchema
>;

export type TriggerRecipe = {
  name: string;
  kind: "mutation" | "truncate" | "deferred-insert";
  functionSchema: "app";
  functionName: string;
  triggerType: 5 | 27 | 34;
  constraint: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
};

export type RangePartitionFamily = {
  kind: "range";
  table: (typeof rangePartitionTables)[number];
  key: "business_date" | "effective_date" | "occurred_at";
  parentGuards: TriggerRecipe[];
  leafTriggers: TriggerRecipe[];
};

export type HashPartitionFamily = {
  kind: "hash";
  table: (typeof hashPartitionTables)[number];
  key: "organization_id";
  parentGuards: TriggerRecipe[];
  leafTriggers: TriggerRecipe[];
};

export type PartitionFamily = RangePartitionFamily | HashPartitionFamily;

function mutation(name: string, functionName: string): TriggerRecipe {
  return {
    name,
    kind: "mutation",
    functionSchema: "app",
    functionName,
    triggerType: 27,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  };
}

function deferredInsert(name: string, functionName: string): TriggerRecipe {
  return {
    name,
    kind: "deferred-insert",
    functionSchema: "app",
    functionName,
    triggerType: 5,
    constraint: true,
    deferrable: true,
    initiallyDeferred: true,
  };
}

const truncate = {
  name: "reject_hrms_truncate",
  kind: "truncate",
  functionSchema: "app",
  functionName: "reject_hrms_append_only_mutation",
  triggerType: 34,
  constraint: false,
  deferrable: false,
  initiallyDeferred: false,
} satisfies TriggerRecipe;

function guardedLeaf(
  guard: TriggerRecipe,
  semantics: TriggerRecipe[] = [],
): { parentGuards: TriggerRecipe[]; leafTriggers: TriggerRecipe[] } {
  return {
    parentGuards: [guard, truncate],
    leafTriggers: [guard, truncate, ...semantics],
  };
}

const attendanceLocator = deferredInsert(
  "verify_attendance_locator_fact",
  "verify_attendance_locator_fact",
);
const attendanceCorrection = deferredInsert(
  "verify_attendance_correction",
  "verify_attendance_correction",
);
const leaveLocator = deferredInsert(
  "verify_worker_leave_locator_fact",
  "verify_worker_leave_locator_fact",
);
const leaveReversal = deferredInsert(
  "verify_worker_leave_reversal",
  "verify_worker_leave_reversal",
);
const auditSource = deferredInsert(
  "verify_hr_audit_source_fact",
  "verify_hr_audit_source_fact",
);

export const partitionFamilies: Record<PartitionTable, PartitionFamily> = {
  attendance_events: {
    kind: "range",
    table: "attendance_events",
    key: "business_date",
    ...guardedLeaf(
      mutation(
        "reject_attendance_event_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [attendanceLocator, attendanceCorrection],
    ),
  },
  attendance_event_evidence: {
    kind: "range",
    table: "attendance_event_evidence",
    key: "business_date",
    ...guardedLeaf(
      mutation(
        "guard_attendance_event_evidence_mutation",
        "reject_attendance_evidence_mutation",
      ),
    ),
  },
  worker_leave_ledger_entries: {
    kind: "range",
    table: "worker_leave_ledger_entries",
    key: "effective_date",
    ...guardedLeaf(
      mutation(
        "reject_worker_leave_fact_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [leaveLocator, leaveReversal],
    ),
  },
  hr_audit_events: {
    kind: "range",
    table: "hr_audit_events",
    key: "occurred_at",
    ...guardedLeaf(
      mutation(
        "reject_hr_audit_event_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [auditSource],
    ),
  },
  attendance_event_locators: {
    kind: "hash",
    table: "attendance_event_locators",
    key: "organization_id",
    ...guardedLeaf(
      mutation(
        "reject_attendance_event_locator_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [attendanceLocator],
    ),
  },
  attendance_correction_links: {
    kind: "hash",
    table: "attendance_correction_links",
    key: "organization_id",
    ...guardedLeaf(
      mutation(
        "reject_attendance_correction_link_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [
        deferredInsert(
          "verify_attendance_correction_link",
          "verify_attendance_correction_link",
        ),
      ],
    ),
  },
  hr_audit_event_sources: {
    kind: "hash",
    table: "hr_audit_event_sources",
    key: "organization_id",
    ...guardedLeaf(
      mutation(
        "reject_hr_audit_event_source_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [auditSource],
    ),
  },
  worker_leave_entry_locators: {
    kind: "hash",
    table: "worker_leave_entry_locators",
    key: "organization_id",
    ...guardedLeaf(
      mutation(
        "reject_worker_leave_locator_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [leaveLocator],
    ),
  },
  worker_leave_reversal_links: {
    kind: "hash",
    table: "worker_leave_reversal_links",
    key: "organization_id",
    ...guardedLeaf(
      mutation(
        "reject_worker_leave_reversal_mutation",
        "reject_hrms_append_only_mutation",
      ),
      [leaveReversal],
    ),
  },
};

export function isRangeFamily(
  family: PartitionFamily,
): family is RangePartitionFamily {
  return family.kind === "range";
}

export function isHashFamily(
  family: PartitionFamily,
): family is HashPartitionFamily {
  return family.kind === "hash";
}
