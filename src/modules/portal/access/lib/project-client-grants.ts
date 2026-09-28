import { ConflictException, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, desc, eq, gt, gte, ilike, isNotNull, isNull, lte, or } from "drizzle-orm";
import { projectClientGrants } from "../../../../db/schema/portal-access/project-client-grants";
import { portalMemberships } from "../../../../db/schema/portal-access/portal-memberships";
import { partyContacts, projects } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { isUniqueViolation } from "../../../../common/db/postgres-error";
import type {
  ListGrantsQuery,
  CreateGrantInput,
  UpdateGrantInput,
  GrantCapabilityKey,
} from "../dto/portal-access.schemas";
import { GRANT_CAPABILITY_KEYS } from "../dto/portal-access.schemas";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import { keysetBeforeUuid } from "../../../../common/pagination/keyset";

/**
 * The per-project half of portal access: which projects a portal member may see,
 * and how much of each.
 *
 * The seam between this and `portal-access.service.ts` is the one the data model
 * already draws. A membership answers "does this contact have a portal login at
 * all"; a grant answers "and what may they open once they are in". They are
 * different tables, different DTOs, different audit resource types and different
 * permissions to reason about — and the dependency between them runs in exactly
 * one direction: creating a grant reads a membership to confirm it is ACTIVE,
 * and nothing on the membership side ever reads a grant. That one direction is
 * why this file can exist without a cycle, and it is passed in as
 * `deps.loadMembership` rather than imported, so the service's org-scoped load
 * stays private and this file cannot accidentally grow a second, unscoped one.
 *
 * The functions take the deps bag rather than reaching for a service, and the DB
 * call ORDER is exactly what the service wrote: `portal-access.service.spec.ts`
 * drives `db.select` off a positional counter — membership first, project second
 * — and would pass or fail on a reordering.
 */

type GrantRow = typeof projectClientGrants.$inferSelect;
type GrantPatch = Partial<typeof projectClientGrants.$inferInsert>;

/**
 * All the grant path reads off a membership, named narrowly on purpose: the
 * only questions it asks are whether the membership is usable and which contact
 * the grant should be stamped with.
 */
export type GrantMembership = Pick<
  typeof portalMemberships.$inferSelect,
  "status" | "partyContactId"
>;

export interface ProjectClientGrantDeps {
  readonly db: Db;
  readonly audit: AuditService;
  /**
   * The service's own membership load, bound. It is org-scoped and throws
   * `NotFoundException` for a membership belonging to another tenant, which is
   * what keeps `createGrant` from being a cross-tenant read; passing it rather
   * than re-implementing it here means there is still only one such query.
   */
  readonly loadMembership: (
    organizationId: string,
    portalMembershipId: string,
  ) => Promise<GrantMembership>;
}

const CAPABILITY_COLUMN_MAP = {
  canViewMilestones: projectClientGrants.canViewMilestones,
  canViewTasks: projectClientGrants.canViewTasks,
  canViewAttachments: projectClientGrants.canViewAttachments,
  canViewComments: projectClientGrants.canViewComments,
  canSubmitChangeRequests: projectClientGrants.canSubmitChangeRequests,
} as const satisfies Record<GrantCapabilityKey, unknown>;

function buildSearchCondition(q: string | undefined) {
  if (!q) return undefined;
  const term = `%${q}%`;
  return or(
    ilike(partyContacts.firstName, term),
    ilike(partyContacts.lastName, term),
    ilike(projectClientGrants.partyContactId, term),
  );
}

function buildPermissionConditions(permission: string | undefined) {
  if (!permission) return [];
  return permission
    .split(",")
    .filter((k): k is GrantCapabilityKey =>
      GRANT_CAPABILITY_KEYS.some((key) => key === k),
    )
    .map((key) => eq(CAPABILITY_COLUMN_MAP[key], true));
}

function buildStateCondition(state: string | undefined) {
  if (!state) return undefined;
  const now = new Date();
  if (state === "active")
    return and(
      eq(projectClientGrants.status, "ACTIVE"),
      or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, now)),
    );
  if (state === "expired")
    return and(
      eq(projectClientGrants.status, "ACTIVE"),
      isNotNull(projectClientGrants.expiresAt),
      lte(projectClientGrants.expiresAt, now),
    );
  if (state === "suspended") return eq(projectClientGrants.status, "SUSPENDED");
  if (state === "revoked") return eq(projectClientGrants.status, "REVOKED");
  return undefined;
}

export async function loadGrant(
  deps: ProjectClientGrantDeps,
  organizationId: string,
  projectClientGrantId: string,
): Promise<GrantRow> {
  const [row] = await deps.db
    .select()
    .from(projectClientGrants)
    .where(
      and(
        eq(projectClientGrants.projectClientGrantId, projectClientGrantId),
        eq(projectClientGrants.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Project client grant not found");
  return row;
}

export async function listGrants(
  deps: ProjectClientGrantDeps,
  organizationId: string,
  query: ListGrantsQuery,
) {
  const { limit, cursor, projectId, grantId, from, to, q, permission, state } = query;
  const position = cursor === undefined ? undefined : decodeCursor(cursor);
  if (cursor !== undefined && !position) throw new BadRequestException("Invalid pagination cursor");

  const conditions = and(
    eq(projectClientGrants.organizationId, organizationId),
    projectId ? eq(projectClientGrants.projectId, projectId) : undefined,
    grantId ? eq(projectClientGrants.projectClientGrantId, grantId) : undefined,
    from ? gte(projectClientGrants.createdAt, from) : undefined,
    to ? lte(projectClientGrants.createdAt, to) : undefined,
    position
      ? keysetBeforeUuid(projectClientGrants.createdAt, projectClientGrants.projectClientGrantId, position)
      : undefined,
    buildStateCondition(state),
    ...buildPermissionConditions(permission),
    buildSearchCondition(q),
  );

  const rows = await deps.db
    .select({
      projectClientGrantId: projectClientGrants.projectClientGrantId,
      organizationId: projectClientGrants.organizationId,
      portalMembershipId: projectClientGrants.portalMembershipId,
      partyContactId: projectClientGrants.partyContactId,
      projectId: projectClientGrants.projectId,
      canViewMilestones: projectClientGrants.canViewMilestones,
      canViewTasks: projectClientGrants.canViewTasks,
      canViewAttachments: projectClientGrants.canViewAttachments,
      canViewComments: projectClientGrants.canViewComments,
      canSubmitChangeRequests: projectClientGrants.canSubmitChangeRequests,
      status: projectClientGrants.status,
      expiresAt: projectClientGrants.expiresAt,
      createdAt: projectClientGrants.createdAt,
      updatedAt: projectClientGrants.updatedAt,
      contactFirstName: partyContacts.firstName,
      contactLastName: partyContacts.lastName,
    })
    .from(projectClientGrants)
    .leftJoin(
      partyContacts,
      and(
        eq(partyContacts.partyContactId, projectClientGrants.partyContactId),
        eq(partyContacts.organizationId, projectClientGrants.organizationId),
        isNull(partyContacts.deletedAt),
      ),
    )
    .where(conditions)
    .orderBy(desc(projectClientGrants.createdAt), desc(projectClientGrants.projectClientGrantId))
    .limit(limit + 1);
  return buildCursorPage(rows, limit, (row) => ({
    sortValue: row.createdAt.toISOString(),
    id: row.projectClientGrantId,
  }));
}

export async function createGrant(
  deps: ProjectClientGrantDeps,
  organizationId: string,
  userId: string,
  input: CreateGrantInput,
) {
  const membership = await deps.loadMembership(organizationId, input.portalMembershipId);
  if (membership.status !== "ACTIVE") {
    throw new ForbiddenException("Portal membership is not active");
  }

  const [project] = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.orgId, organizationId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) throw new NotFoundException("Project not found");

  const [row] = await deps.db
    .insert(projectClientGrants)
    .values({
      organizationId,
      portalMembershipId: input.portalMembershipId,
      partyContactId: membership.partyContactId,
      projectId: input.projectId,
      canViewMilestones: input.canViewMilestones ?? false,
      canViewTasks: input.canViewTasks ?? false,
      canViewAttachments: input.canViewAttachments ?? false,
      canViewComments: input.canViewComments ?? false,
      canSubmitChangeRequests: input.canSubmitChangeRequests ?? false,
      status: "ACTIVE",
    })
    .returning()
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new ConflictException("A grant already exists for this membership and project.");
      }
      throw err;
    });
  if (!row) throw new NotFoundException("Failed to create project client grant");
  deps.audit.log({
    action: "portal_access.grant.created",
    userId,
    orgId: organizationId,
    resourceType: "project_client_grant",
    resourceId: row.projectClientGrantId,
    metadata: {
      projectClientGrantId: row.projectClientGrantId,
      portalMembershipId: row.portalMembershipId,
      projectId: row.projectId,
    },
  });
  return row;
}

export async function updateGrant(
  deps: ProjectClientGrantDeps,
  organizationId: string,
  userId: string,
  projectClientGrantId: string,
  input: UpdateGrantInput,
) {
  await loadGrant(deps, organizationId, projectClientGrantId);

  const patch: GrantPatch = {};
  if (input.canViewMilestones !== undefined) patch.canViewMilestones = input.canViewMilestones;
  if (input.canViewTasks !== undefined) patch.canViewTasks = input.canViewTasks;
  if (input.canViewAttachments !== undefined) patch.canViewAttachments = input.canViewAttachments;
  if (input.canViewComments !== undefined) patch.canViewComments = input.canViewComments;
  if (input.canSubmitChangeRequests !== undefined) patch.canSubmitChangeRequests = input.canSubmitChangeRequests;
  if (input.status !== undefined) patch.status = input.status;
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  const [updated] = await deps.db
    .update(projectClientGrants)
    .set(patch)
    .where(
      and(
        eq(projectClientGrants.projectClientGrantId, projectClientGrantId),
        eq(projectClientGrants.organizationId, organizationId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundException("Project client grant not found");
  deps.audit.log({
    action: "portal_access.grant.updated",
    userId,
    orgId: organizationId,
    resourceType: "project_client_grant",
    resourceId: projectClientGrantId,
    metadata: { projectClientGrantId },
  });
  return updated;
}

export async function revokeGrant(
  deps: ProjectClientGrantDeps,
  organizationId: string,
  userId: string,
  projectClientGrantId: string,
) {
  await loadGrant(deps, organizationId, projectClientGrantId);

  const [updated] = await deps.db
    .update(projectClientGrants)
    .set({ status: "REVOKED" })
    .where(
      and(
        eq(projectClientGrants.projectClientGrantId, projectClientGrantId),
        eq(projectClientGrants.organizationId, organizationId),
      ),
    )
    .returning();
  if (!updated) throw new NotFoundException("Project client grant not found");
  deps.audit.log({
    action: "portal_access.grant.revoked",
    userId,
    orgId: organizationId,
    resourceType: "project_client_grant",
    resourceId: projectClientGrantId,
    metadata: { projectClientGrantId },
  });
  return updated;
}
