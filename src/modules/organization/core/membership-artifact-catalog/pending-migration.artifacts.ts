import type { MembershipArtifact } from "../membership-artifact.types";

export const PENDING_MIGRATION_ARTIFACTS = [
  {
    id: "hr_people_actors",
    mechanism: "pending-migration",
    table: "hr_people",
    keyedBy: "updated_by_membership_id / archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Two composite FKs (fk_hr_people_updated_actor, fk_hr_people_archived_actor) are currently RESTRICT in the Drizzle schema. Both are attribution columns; the hr_people record survives. Pending migration to SET NULL (hrms-phase1 sweep). The hr/core-people.ts file IS in the barrel.",
  },
  {
    id: "hr_employments_actors",
    mechanism: "pending-migration",
    table: "hr_employments",
    keyedBy: "updated_by_membership_id / archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Two composite FKs (fk_hr_employments_updated_actor, fk_hr_employments_archived_actor) are currently RESTRICT in the Drizzle schema. Both are attribution columns; the employment record survives. Pending migration to SET NULL (hrms-phase1 sweep). The hr/core-people.ts file IS in the barrel.",
  },
  {
    id: "onboarding_tasks_actors",
    mechanism: "pending-migration",
    table: "onboarding_tasks",
    keyedBy: "created_by_membership_id / updated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Two composite FKs (fk_onboarding_tasks_created_actor, fk_onboarding_tasks_updated_actor) are currently RESTRICT in the Drizzle schema. Both are attribution columns; the task record survives. Pending migration to SET NULL (hrms-phase1 sweep). The hr/onboarding.ts file IS in the barrel.",
  },
  {
    id: "onboarding_documents_actors",
    mechanism: "pending-migration",
    table: "onboarding_documents",
    keyedBy: "updated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite FK fk_onboarding_documents_updated_actor is currently RESTRICT in the Drizzle schema. It is an attribution column; the document record survives. Pending migration to SET NULL (hrms-phase1 sweep). The hr/onboarding.ts file IS in the barrel.",
  },
  {
    id: "workers_actors",
    mechanism: "pending-migration",
    table: "workers",
    keyedBy: "created_by_membership_id / updated_by_membership_id / archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Three composite FKs (fk_workers_created_actor, fk_workers_updated_actor, fk_workers_archived_actor) are currently RESTRICT in the Drizzle schema. All three are attribution columns; the worker record survives. Pending migration to SET NULL (hrms-phase1 sweep). The directory/workers.ts file IS in the barrel.",
  },
  {
    id: "org_units_archived_by_membership",
    mechanism: "pending-migration",
    table: "org_units",
    keyedBy: "archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The Drizzle table declares fk_org_units_archived_by_membership on archived_by_membership_id, but no foreign key from org_units.archived_by_membership_id to organization_members exists in the migrated schema, so nothing enforces this on removal today and the column is left pointing at a deleted membership. The hrms-phase1 sweep is expected to author it as SET NULL, matching the sibling attribution columns on this table.",
  },
  {
    id: "org_units_updated_by_membership",
    mechanism: "pending-migration",
    table: "org_units",
    keyedBy: "updated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The Drizzle table declares fk_org_units_updated_by_membership on updated_by_membership_id, but no foreign key from org_units.updated_by_membership_id to organization_members exists in the migrated schema, so nothing enforces this on removal today and the column is left pointing at a deleted membership. The hrms-phase1 sweep is expected to author it as SET NULL, matching the sibling attribution columns on this table.",
  },
  {
    id: "organization_people_archived_by_membership",
    mechanism: "pending-migration",
    table: "organization_people",
    keyedBy: "archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The Drizzle table declares fk_org_people_archived_actor on archived_by_membership_id, but no foreign key from organization_people.archived_by_membership_id to organization_members exists in the migrated schema, so nothing enforces this on removal today and the column is left pointing at a deleted membership. The hrms-phase1 sweep is expected to author it as SET NULL, matching the sibling attribution columns on this table.",
  },
  {
    id: "organization_people_updated_by_membership",
    mechanism: "pending-migration",
    table: "organization_people",
    keyedBy: "updated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The Drizzle table declares fk_org_people_updated_actor on updated_by_membership_id, but no foreign key from organization_people.updated_by_membership_id to organization_members exists in the migrated schema, so nothing enforces this on removal today and the column is left pointing at a deleted membership. The hrms-phase1 sweep is expected to author it as SET NULL, matching the sibling attribution columns on this table.",
  },
  {
    id: "worker_engagements_archived_by_membership",
    mechanism: "pending-migration",
    table: "worker_engagements",
    keyedBy: "archived_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The Drizzle table declares fk_worker_engagements_archived_actor on archived_by_membership_id, but no foreign key from worker_engagements.archived_by_membership_id to organization_members exists in the migrated schema, so nothing enforces this on removal today and the column is left pointing at a deleted membership. The hrms-phase1 sweep is expected to author it as SET NULL, matching the sibling attribution columns on this table.",
  },
  {
    id: "worker_engagements_updated_by_membership",
    mechanism: "pending-migration",
    table: "worker_engagements",
    keyedBy: "updated_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The Drizzle table declares fk_worker_engagements_updated_actor on updated_by_membership_id, but no foreign key from worker_engagements.updated_by_membership_id to organization_members exists in the migrated schema, so nothing enforces this on removal today and the column is left pointing at a deleted membership. The hrms-phase1 sweep is expected to author it as SET NULL, matching the sibling attribution columns on this table.",
  },
] as const satisfies readonly MembershipArtifact[];
