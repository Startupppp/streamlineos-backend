import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages } from "../../../../db/schema";
import {
  accessLevelsSatisfying,
  type KbActorStanding,
  type KbPageAction,
  type VisiblePageScope,
} from "./knowledge-authorization.types";

function intArray(ids: number[]): SQL<unknown> {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

function textArray(values: string[]): SQL<unknown> {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

export function buildGrantBranch(
  standing: KbActorStanding,
  action: KbPageAction,
): SQL<unknown> | null {
  const hasMembership = standing.membershipId !== null;
  const hasRoles = standing.roleSlugs.length > 0;
  if (!hasMembership && !hasRoles) return null;

  const levels = textArray([...accessLevelsSatisfying(action)]);
  const membershipMatch = hasMembership
    ? sql`"kb_page_grants"."membership_id" = ${standing.membershipId}`
    : null;
  const roleMatch = hasRoles
    ? sql`"kb_page_grants"."role" = ANY(${textArray(standing.roleSlugs)})`
    : null;
  const grantee =
    membershipMatch !== null && roleMatch !== null
      ? sql`(${membershipMatch} OR ${roleMatch})`
      : (membershipMatch ?? roleMatch);

  return sql`EXISTS (
    SELECT 1 FROM "kb_page_grants"
    WHERE "kb_page_grants"."org_id" = ${standing.orgId}
      AND "kb_page_grants"."page_id" = ${kbPages.id}
      AND "kb_page_grants"."revoked_at" IS NULL
      AND "kb_page_grants"."access" = ANY(${levels})
      AND ${grantee}
  )`;
}

export function buildIndexedBranch(
  standing: KbActorStanding,
  action: KbPageAction,
): SQL<unknown> {
  const clauses: SQL<unknown>[] = [];

  if (action === "view") {
    clauses.push(
      sql`(${kbPages.visibility} IN ('org', 'public') AND ${kbPages.projectId} IS NULL)`,
    );
  }

  clauses.push(sql`${kbPages.createdById} = ${standing.userId}`);

  if (standing.membershipId !== null) {
    clauses.push(sql`${kbPages.ownerMembershipId} = ${standing.membershipId}`);
    clauses.push(
      sql`${kbPages.createdByMembershipId} = ${standing.membershipId}`,
    );
  }

  if (standing.accessibleSpaceIds.length > 0) {
    clauses.push(
      sql`(${kbPages.spaceId} IS NOT NULL AND ${kbPages.spaceId} = ANY(${intArray(standing.accessibleSpaceIds)}))`,
    );
  }

  if (standing.accessibleProjectIds.length > 0) {
    clauses.push(
      sql`(${kbPages.projectId} IS NOT NULL AND ${kbPages.projectId} = ANY(${intArray(standing.accessibleProjectIds)}))`,
    );
  }

  return sql`(${sql.join(clauses, sql` OR `)})`;
}

export function permissionFingerprintOf(
  standing: KbActorStanding,
  action: KbPageAction,
): string {
  const spaces = [...standing.accessibleSpaceIds]
    .sort((a, b) => a - b)
    .join(".");
  const projects = [...standing.accessibleProjectIds]
    .sort((a, b) => a - b)
    .join(".");
  const roles = [...standing.roleSlugs].sort().join(".");
  const owner = standing.isOrgOwner || standing.isKbAdmin ? "1" : "0";
  return [
    standing.orgId,
    standing.permissionsVersion,
    standing.membershipId ?? "-",
    owner,
    action,
    roles,
    spaces,
    projects,
  ].join("|");
}

export function buildVisiblePageScope(
  standing: KbActorStanding,
  action: KbPageAction,
): VisiblePageScope {
  const tenant = eq(kbPages.orgId, standing.orgId);
  const fingerprint = permissionFingerprintOf(standing, action);

  if (standing.isOrgOwner || standing.isKbAdmin) {
    return {
      predicate: tenant,
      grantBranch: null,
      indexedBranch: tenant,
      fingerprint,
    };
  }

  const indexedBranch = buildIndexedBranch(standing, action);
  const grantBranch = buildGrantBranch(standing, action);
  const reachable =
    grantBranch === null
      ? indexedBranch
      : sql`(${indexedBranch} OR ${grantBranch})`;

  return {
    predicate: sql`(${tenant} AND ${reachable})`,
    grantBranch:
      grantBranch === null ? null : sql`(${tenant} AND ${grantBranch})`,
    indexedBranch: sql`(${tenant} AND ${indexedBranch})`,
    fingerprint,
  };
}
