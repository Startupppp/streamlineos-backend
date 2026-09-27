import { eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { kbPages, kbPageRestrictions } from "../../../../db/schema";
import {
  accessLevelsSatisfying,
  type KbActorStanding,
  type KbPageAction,
  type KbSharedWithMeScope,
  type VisiblePageScope,
} from "./knowledge-authorization.types";

export interface VisiblePageBranches {
  indexedBranch: SQL<unknown>;
  grantBranch: SQL<unknown> | null;
  fingerprint: string;
}

function restrictionLevelFor(action: KbPageAction): "view" | "edit" {
  return action === "edit" || action === "manage" ? "edit" : "view";
}

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

export function buildSharedWithMeScope(
  standing: KbActorStanding,
): KbSharedWithMeScope | null {
  const grantBranch = buildGrantBranch(standing, "view");
  if (grantBranch === null) return null;

  const notAlreadyMine: SQL<unknown>[] = [
    sql`(${kbPages.createdById} IS NULL OR ${kbPages.createdById} <> ${standing.userId})`,
  ];
  if (standing.membershipId !== null) {
    notAlreadyMine.push(
      sql`(${kbPages.ownerMembershipId} IS NULL OR ${kbPages.ownerMembershipId} <> ${standing.membershipId})`,
      sql`(${kbPages.createdByMembershipId} IS NULL OR ${kbPages.createdByMembershipId} <> ${standing.membershipId})`,
    );
  }

  return {
    predicate: sql`(${eq(kbPages.orgId, standing.orgId)} AND ${grantBranch} AND ${sql.join(notAlreadyMine, sql` AND `)})`,
    membershipId: standing.membershipId,
    roleSlugs: standing.roleSlugs,
  };
}

export function buildIndexedBranch(
  standing: KbActorStanding,
  action: KbPageAction,
): SQL<unknown> {
  const clauses: SQL<unknown>[] = [];

  if (action === "view") {
    const spaceGuard =
      standing.accessibleSpaceIds.length > 0
        ? sql`(${kbPages.spaceId} IS NULL OR ${kbPages.spaceId} = ANY(${intArray(standing.accessibleSpaceIds)}))`
        : sql`${kbPages.spaceId} IS NULL`;
    clauses.push(
      sql`(${kbPages.visibility} IN ('org', 'public') AND ${kbPages.projectId} IS NULL AND ${spaceGuard})`,
    );
  }

  clauses.push(sql`${kbPages.createdById} = ${standing.userId}`);

  if (standing.membershipId !== null) {
    clauses.push(sql`${kbPages.ownerMembershipId} = ${standing.membershipId}`);
    clauses.push(
      sql`${kbPages.createdByMembershipId} = ${standing.membershipId}`,
    );
  }

  const containerGrantsAction = action === "view" || action === "comment";

  if (containerGrantsAction && standing.accessibleSpaceIds.length > 0) {
    clauses.push(
      sql`(${kbPages.visibility} IN ('org', 'public') AND ${kbPages.spaceId} IS NOT NULL AND ${kbPages.spaceId} = ANY(${intArray(standing.accessibleSpaceIds)}))`,
    );
  }

  if (containerGrantsAction && standing.accessibleProjectIds.length > 0) {
    clauses.push(
      sql`(${kbPages.visibility} IN ('org', 'public') AND ${kbPages.projectId} IS NOT NULL AND ${kbPages.projectId} = ANY(${intArray(standing.accessibleProjectIds)}))`,
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
  const restriction = buildArticleRestrictionBranch(
    standing.orgId,
    { membershipId: standing.membershipId, roleSlugs: standing.roleSlugs },
    action,
  );
  const reachable =
    grantBranch === null
      ? indexedBranch
      : sql`(${indexedBranch} OR ${grantBranch})`;

  return {
    predicate: sql`(${tenant} AND ${reachable} AND ${restriction})`,
    grantBranch:
      grantBranch === null
        ? null
        : sql`(${tenant} AND ${grantBranch} AND ${restriction})`,
    indexedBranch: sql`(${tenant} AND ${indexedBranch} AND ${restriction})`,
    fingerprint,
  };
}

export function buildArticleRestrictionBranch(
  orgId: string,
  principal: { membershipId: number | null; roleSlugs: string[] },
  action: KbPageAction = "view",
): SQL {
  const kpr = kbPageRestrictions;
  const level = restrictionLevelFor(action);
  const membershipMatch =
    principal.membershipId !== null
      ? sql`${kpr.membershipId} = ${principal.membershipId} OR `
      : sql``;
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM ${kpr}
      WHERE ${kpr.pageId} = ${kbPages.id}
        AND ${kpr.orgId} = ${orgId}
        AND ${kpr.level} = ${level}
    )
    OR EXISTS (
      SELECT 1 FROM ${kpr}
      WHERE ${kpr.pageId} = ${kbPages.id}
        AND ${kpr.orgId} = ${orgId}
        AND ${kpr.level} = ${level}
        AND (${membershipMatch}${
          principal.roleSlugs.length > 0
            ? inArray(kpr.role, principal.roleSlugs)
            : sql`false`
        })
    )
  )`;
}

export function visiblePageBranches(
  standing: KbActorStanding,
  action: KbPageAction,
): VisiblePageBranches {
  const tenant = eq(kbPages.orgId, standing.orgId);
  const fingerprint = permissionFingerprintOf(standing, action);

  if (standing.isOrgOwner || standing.isKbAdmin) {
    return { indexedBranch: tenant, grantBranch: null, fingerprint };
  }

  const indexed = buildIndexedBranch(standing, action);
  const grant = buildGrantBranch(standing, action);
  const restriction = buildArticleRestrictionBranch(
    standing.orgId,
    { membershipId: standing.membershipId, roleSlugs: standing.roleSlugs },
    action,
  );

  const indexedBranch = sql`(${tenant} AND ${indexed} AND ${restriction})`;
  const grantBranch =
    grant === null ? null : sql`(${tenant} AND ${grant} AND ${restriction})`;

  return { indexedBranch, grantBranch, fingerprint };
}
