import type { MembershipArtifact } from "../membership-artifact.types";

export const ACCESS_AND_MEMBERSHIP_ARTIFACTS = [
  {
    id: "calibration_sessions_created_by_actor",
    mechanism: "database-write",
    table: "calibration_sessions",
    keyedBy: "created_by_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Calibration authorship is retained for audit history; departure must explicitly resolve this RESTRICT dependency before removal.",
  },
  {
    id: "calibration_participants_user_actor",
    mechanism: "database-write",
    table: "calibration_participants",
    keyedBy: "user_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason: "Calibration participation is retained for audit history; departure must explicitly resolve this RESTRICT dependency before removal.",
  },
  {
    id: "role_assignments",
    mechanism: "database-cascade",
    table: "role_assignments",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "The composite foreign key removes it with the membership. A suspension is reversible, so the assignment is retained and the membership gate denies instead.",
  },
  {
    id: "user_permission_grants",
    mechanism: "database-cascade",
    table: "user_permission_grants",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "A per-person grant hangs off the membership and dies with it. Retained through a suspension so a restore does not silently drop capability.",
  },
  {
    id: "principal_group_members",
    mechanism: "database-cascade",
    table: "principal_group_members",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Group edges cascade with the membership. Retained through a suspension for the same reason as a role assignment.",
  },
  {
    id: "user_delegations",
    mechanism: "database-write",
    table: "user_delegations",
    keyedBy: "delegator_membership_id / delegatee_membership_id",
    onRemoval: "cascade",
    onSuspension: "revoke",
    reason:
      "A delegation is acting-for authority in both directions. It cascades on removal, and must be revoked on suspension because the delegatee is a different person whose access would otherwise outlive the delegator's standing.",
  },
  {
    id: "user_module_access",
    mechanism: "database-cascade",
    table: "user_module_access",
    keyedBy: "organization_membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "A module deny-override only ever removes access, so retaining it through a suspension cannot widen anything.",
  },
  {
    id: "agent_tokens",
    mechanism: "database-write",
    table: "agent_tokens",
    keyedBy: "issuer_membership_id",
    onRemoval: "cascade",
    onSuspension: "revoke",
    reason:
      "A machine credential is bearer authority that leaves the browser. It must stop working the moment the issuer stops, not when the membership row is finally deleted.",
  },
  {
    id: "module_ownerships",
    mechanism: "database-write",
    table: "module_ownerships",
    keyedBy: "owner_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The foreign key is RESTRICT on purpose: a module may not be left ownerless. Removal is refused until ownership is transferred, which is a precondition rather than a cascade.",
  },
  {
    id: "ownership_transfers",
    mechanism: "database-write",
    table: "ownership_transfers",
    keyedBy: "from_membership_id / to_membership_id / initiated_by_membership_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "A pending transfer naming a membership that is ending must be cancelled, or its RESTRICT foreign key blocks the removal with a misleading error.",
  },
  {
    id: "resource_grants",
    mechanism: "database-write",
    table: "resource_grants",
    keyedBy: "principal_type + principal_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "Record-level grants are polymorphic and carry no foreign key, so nothing removes them automatically. Left behind, re-inviting the same person restores their old record access.",
  },
  {
    id: "organization_people",
    mechanism: "database-write",
    table: "organization_people",
    keyedBy: "organization_membership_id",
    onRemoval: "blocks-removal",
    onSuspension: "retain",
    reason:
      "The composite foreign key (organization_id, organization_membership_id) is ON DELETE NO ACTION, so a person record that still points at a membership blocks its deletion. The removal path must reassign or detach the person record before removing the membership.",
  },
  {
    id: "invitations",
    mechanism: "database-write",
    table: "invitations",
    keyedBy: "canonical email + org",
    onRemoval: "revoke",
    onSuspension: "retain",
    reason:
      "A pending invitation for the same person is a second door into the organization. Terminal invitation history is retained rather than deleted.",
  },
  {
    id: "org_units",
    mechanism: "database-cascade",
    table: "org_units",
    keyedBy: "head_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The composite foreign key fk_org_units_head_membership is ON DELETE SET NULL, so removing the head member clears the slot automatically. A suspension is reversible and the org-membership gate already denies access, so the head pointer is retained.",
  },
  {
    id: "org_unit_members",
    mechanism: "database-cascade",
    table: "org_unit_members",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_org_unit_members_membership was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "portal_memberships",
    mechanism: "database-write",
    table: "portal_memberships",
    keyedBy: "user_membership_id",
    onRemoval: "revoke",
    onSuspension: "revoke",
    reason:
      "The composite foreign key fk_portal_memberships_user_membership is ON DELETE SET NULL, which clears the membership link but leaves the portal membership status unchanged. An active portal membership is an access grant to the external-facing portal; a removed or suspended org member must not retain that access. The revocation path must explicitly set status to REVOKED in addition to what the FK handles, because status is not part of the FK and the portal authenticates on status rather than on the membership link.",
  },
  {
    id: "user_tour_progress",
    mechanism: "database-cascade",
    table: "user_tour_progress",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "retain",
    reason:
      "Corrected 2026-09-03 against pg_catalog at journal head 676 (ticket 03, PRD-C053). This entry previously ruled set-null and asserted in prose that fk_user_tour_progress_actor was ON DELETE SET NULL. It never was: the migration that created it, the Drizzle declaration and the catalog have all said CASCADE the whole time, so the ruling was documentation that nothing implemented. CASCADE is also the correct behaviour here — the row is per-member state keyed on the membership, and org_id leads the composite key as NOT NULL, so a bare SET NULL would raise 23502 on every removal instead of orphaning anything safely. A grant or preference belonging to nobody is residue, not history.",
  },
  {
    id: "invitations_accepted_membership",
    mechanism: "database-cascade",
    table: "invitations",
    keyedBy: "accepted_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "The accepting-member pointer on invitations is cleared by fk_invitations_accepted_membership_id_org, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "invitations_inviter_membership",
    mechanism: "database-cascade",
    table: "invitations",
    keyedBy: "inviter_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Inviter attribution on invitations is cleared by fk_invitations_inviter_membership_id_org, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "invitations_revoked_by_membership",
    mechanism: "database-write",
    table: "invitations",
    keyedBy: "revoked_by_membership_id",
    onRemoval: "delete",
    onSuspension: "retain",
    reason:
      "fk_invitations_org_revoked_by_membership is ON DELETE SET NULL without a column list on the composite FK (org_id, revoked_by_membership_id), so Postgres would attempt to null both org_id (NOT NULL) and revoked_by_membership_id, raising 23502. The revocation path must explicitly clear all revoked_by_membership_id pointers for this membership before the membership row is removed.",
  },
  {
    id: "portal_invitations_inviter_membership",
    mechanism: "database-cascade",
    table: "portal_invitations",
    keyedBy: "inviter_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Inviter attribution on portal_invitations is cleared by fk_portal_invitations_inviter_membership_id_org, an ON DELETE SET NULL composite tenant foreign key, so the record survives the departure without its member pointer. A suspension is reversible, so nothing is written.",
  },
  {
    id: "role_assignments_assigned_by_membership",
    mechanism: "database-cascade",
    table: "role_assignments",
    keyedBy: "assigned_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Distinct from the assignment itself, which cascades: fk_role_assignments_assigner_membership is ON DELETE SET NULL in the migrated schema, so the assignment outlives the granter with the assigner slot cleared. The Drizzle table declares no onDelete for it, which reads as NO ACTION and is stale against the migration.",
  },
  {
    id: "user_integration_connections_membership",
    mechanism: "database-cascade",
    table: "user_integration_connections",
    keyedBy: "membership_id",
    onRemoval: "cascade",
    onSuspension: "revoke",
    reason:
      "fk_user_integration_connections_actor cascades the mirror row with the membership. The provider disconnect is still emitted by the revocation path, which the user_id + org_id artifact covers; the cascade only removes the local row.",
  },
  {
    id: "user_permission_grants_granted_by_membership",
    mechanism: "database-cascade",
    table: "user_permission_grants",
    keyedBy: "granted_by_membership_id",
    onRemoval: "set-null",
    onSuspension: "retain",
    reason:
      "Distinct from the grant itself, which cascades: fk_user_permission_grants_granter_membership is ON DELETE SET NULL in the migrated schema, so a direct permission grant outlives the granter with the granter slot cleared. The Drizzle table declares no onDelete for it, which reads as NO ACTION and is stale against the migration.",
  },
] as const satisfies readonly MembershipArtifact[];
