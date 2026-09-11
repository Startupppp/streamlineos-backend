import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { projectClientGrants } from "../../../../db/schema/portal-access/project-client-grants";
import { portalMemberships } from "../../../../db/schema/portal-access/portal-memberships";
import { partyContacts, projects } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import type {
  ListGrantsQuery,
  CreateGrantInput,
  UpdateGrantInput,
} from "../dto/portal-access.schemas";

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

const PG_UNIQUE_VIOLATION = "23505";

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
  const { page, limit, projectId } = query;
  const offset = (page - 1) * limit;

  const conditions = and(
    eq(projectClientGrants.organizationId, organizationId),
    projectId ? eq(projectClientGrants.projectId, projectId) : undefined,
  );

  const [rows, [totalRow]] = await Promise.all([
    deps.db
      .select({
        projectClientGrantId: projectClientGrants.projectClientGrantId,
        organizationId: projectClientGrants.organizationId,
        portalMembershipId: projectClientGrants.portalMembershipId,
        partyContactId: projectClientGrants.partyContactId,
        projectId: projectClientGrants.projectId,
        pmWorkspaceId: projectClientGrants.pmWorkspaceId,
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
      .limit(limit)
      .offset(offset),
    deps.db.select({ total: count() }).from(projectClientGrants).where(conditions),
  ]);

  const total = Number(totalRow?.total ?? 0);
  return {
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
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
    .select({ id: projects.id, pmWorkspaceId: projects.pmWorkspaceId })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.orgId, organizationId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) throw new NotFoundException("Project not found");

  const resolvedWorkspaceId = input.pmWorkspaceId ?? project.pmWorkspaceId ?? null;
  if (
    input.pmWorkspaceId &&
    project.pmWorkspaceId &&
    input.pmWorkspaceId !== project.pmWorkspaceId
  ) {
    throw new ForbiddenException("Project does not belong to the specified PM workspace");
  }

  const [row] = await deps.db
    .insert(projectClientGrants)
    .values({
      organizationId,
      portalMembershipId: input.portalMembershipId,
      partyContactId: membership.partyContactId,
      projectId: input.projectId,
      pmWorkspaceId: resolvedWorkspaceId,
      canViewMilestones: input.canViewMilestones ?? false,
      canViewTasks: input.canViewTasks ?? false,
      canViewAttachments: input.canViewAttachments ?? false,
      canViewComments: input.canViewComments ?? false,
      canSubmitChangeRequests: input.canSubmitChangeRequests ?? false,
      status: "ACTIVE",
    })
    .returning()
    .catch((err: unknown) => {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === PG_UNIQUE_VIOLATION
      ) {
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
