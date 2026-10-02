import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ProjectsNotFoundException } from "../../../../common/http/api-exceptions";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { bulkUpdateFromValues } from "../../../../common/db/bulk-update";
import {
  managedProducts,
  organizationMembers,
  projectMembers,
  projects,
  ticketComments,
  tickets,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type {
  LinkManagedProductInput,
  ProjectInvoiceLineDetail,
  UpdateProjectInput,
} from "../dto/projects.schemas";
import { ProjectsQueryService } from "./projects-query.service";
import { assertProjectAccess, assertCanDeleteProject, assertCanManageProjectLink, authorizeProjectUpdate } from "./project-access";

@Injectable()
export class ProjectsWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly projectsQuery: ProjectsQueryService,
  ) {}

  async updateProject(
    u: CurrentUserContext,
    projectId: number,
    body: UpdateProjectInput,
  ) {
    const orgId = u.orgId;

    await authorizeProjectUpdate(this.db, this.access, u, projectId, body.status !== undefined);

    const managerMembershipId = body.managerId === undefined
      ? undefined
      : body.managerId === null
        ? null
        : (await this.db.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, body.managerId), eq(organizationMembers.status, "ACTIVE")),
            columns: { id: true },
          }))?.id ?? null;

    const projectFields = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && {
        description: body.description,
      }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.managerId !== undefined && { managerMembershipId }),
      ...(body.startDate !== undefined && {
        startDate: body.startDate ? new Date(body.startDate) : null,
      }),
      ...(body.endDate !== undefined && {
        endDate: body.endDate ? new Date(body.endDate) : null,
      }),
      ...(body.priority !== undefined && { priority: body.priority }),
      ...(body.invoiceLineDetail !== undefined && {
        invoiceLineDetail: body.invoiceLineDetail,
      }),
    };

    const hasFieldChanges = Object.keys(projectFields).length > 0;
    const hasCrmClientChange = body.clientId !== undefined;

    if (hasFieldChanges || body.memberIds !== undefined || hasCrmClientChange) {
      await this.db.transaction(async (tx) => {
        if (hasFieldChanges) {
          await tx
            .update(projects)
            .set(projectFields)
            .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
        }

        if (hasCrmClientChange) {
          const crmClientId = body.clientId === null
            ? null
            : parseInt(body.clientId!, 10);
          if (crmClientId === null || (!isNaN(crmClientId) && crmClientId > 0)) {
            await tx.execute(
              sql`UPDATE build.projects SET crm_client_id = ${crmClientId} WHERE org_id = ${orgId} AND id = ${projectId}`,
            );
          }
        }

        if (body.memberIds !== undefined) {
          const memberIds = body.memberIds;
          const reassignments = body.reassignments;
          let validMembers: Array<{ id: number; userId: string }> = [];

          const existingMembers = await tx
            .select({ userId: organizationMembers.userId, membershipId: projectMembers.membershipId })
            .from(projectMembers)
            .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
            .where(eq(projectMembers.projectId, projectId));
          const existing = new Map(existingMembers.map((m) => [m.userId, m.membershipId]));

          await tx
            .delete(projectMembers)
            .where(
              and(
                eq(projectMembers.orgId, u.orgId),
                eq(projectMembers.projectId, projectId),
              ),
            );

          if (memberIds.length > 0) {
            validMembers = await tx
              .select({ id: organizationMembers.id, userId: organizationMembers.userId })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.orgId, orgId),
                  inArray(organizationMembers.userId, memberIds),
                ),
              );
            const validMemberIds = validMembers.map((m) => m.userId);
            if (validMemberIds.length > 0) {
              await tx.insert(projectMembers).values(
                validMemberIds.map((userId) => ({
                  orgId,
                  projectId,
                  membershipId: validMembers.find((m) => m.userId === userId)?.id ?? 0,
                  role: "CONTRIBUTOR" as const,
                })),
              );
            }
          }

          const newMemberSet = new Set(memberIds);
          const removedMembers = [...existing.keys()].filter(
            (id) => !newMemberSet.has(id),
          );
          const removedMembershipIds = removedMembers
            .map((id) => existing.get(id))
            .filter((id): id is number => id !== undefined);

          if (removedMembers.length > 0 && reassignments) {
            const openTickets = await tx
              .select({ id: tickets.id, assigneeUserId: sql<string | null>`(SELECT user_id FROM organization_members WHERE org_id = ${orgId} AND id = ${tickets.assigneeMembershipId})` })
              .from(tickets)
              .where(
                and(
                  eq(tickets.orgId, orgId),
                  eq(tickets.projectId, projectId),
                  inArray(tickets.assigneeMembershipId, removedMembershipIds),
                  isNull(tickets.deletedAt),
                  ne(tickets.status, "DONE"),
                  ne(tickets.status, "CANCELLED"),
                ),
              );
            const membershipIdByUserId = new Map(validMembers.map((m) => [m.userId, m.id]));
            await bulkUpdateFromValues(tx, {
              table: tickets,
              orgId,
              key: { column: "id", type: "integer" },
              columns: [{ column: "assignee_membership_id", type: "integer" }],
              rows: openTickets.map((ticket) => {
                const newAssignee = ticket.assigneeUserId
                  ? (reassignments[ticket.assigneeUserId] ?? null)
                  : null;
                return {
                  key: ticket.id,
                  values: [newAssignee ? (membershipIdByUserId.get(newAssignee) ?? null) : null],
                };
              }),
            });
          } else if (removedMembers.length > 0) {
            await tx
              .update(tickets)
              .set({ assigneeMembershipId: null })
              .where(
                and(
                  eq(tickets.orgId, orgId),
                  eq(tickets.projectId, projectId),
                  inArray(tickets.assigneeMembershipId, removedMembershipIds),
                  ne(tickets.status, "DONE"),
                  ne(tickets.status, "CANCELLED"),
                ),
              );
          }
        }
      });
    }

    this.audit.log({
      action: "project.updated",
      userId: u.userId,
      orgId,
      targetId: String(projectId),
      targetType: "project",
      metadata: { changedFields: Object.keys(body) },
    });

    return this.projectsQuery.getProject(u, projectId);
  }

  async getInvoiceLineDetail(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<ProjectInvoiceLineDetail> {
    await assertProjectAccess(this.db, this.access, u, projectId);

    const [row] = await this.db
      .select({ invoiceLineDetail: projects.invoiceLineDetail })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.orgId, u.orgId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new ProjectsNotFoundException();

    return { projectId, invoiceLineDetail: row.invoiceLineDetail };
  }

  async deleteProject(u: CurrentUserContext, projectId: number) {
    await assertCanDeleteProject(this.access, u);
    const orgId = u.orgId;

    const project = await this.db.query.projects.findFirst({
      columns: { id: true, name: true },
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
    });
    if (!project) throw new NotFoundException("Project not found");

    const now = new Date();
    await this.db.transaction(async (tx) => {
      const subTickets = tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      await tx
        .update(ticketComments)
        .set({ deletedAt: now })
        .where(
          and(
            sql`${ticketComments.ticketId} IN (${subTickets})`,
            isNull(ticketComments.deletedAt),
          ),
        );
      await tx
        .update(tickets)
        .set({ deletedAt: now })
        .where(
          and(
            eq(tickets.projectId, projectId),
            eq(tickets.orgId, orgId),
            isNull(tickets.deletedAt),
          ),
        );
      await tx
        .update(projects)
        .set({ deletedAt: now })
        .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
    });

    this.audit.log({
      action: "project.deleted",
      userId: u.userId,
      orgId,
      targetId: String(projectId),
      targetType: "project",
      metadata: { name: project.name },
    });

    return { success: true };
  }

  async linkProjectToManagedProduct(
    u: CurrentUserContext,
    projectId: number,
    input: LinkManagedProductInput,
  ) {
    const orgId = u.orgId;
    await assertCanManageProjectLink(this.db, this.access, u, projectId);

    if (input.managedProductId !== null) {
      const [product] = await this.db
        .select({
          managedProductId: managedProducts.id,
        })
        .from(managedProducts)
        .where(
          and(
            eq(managedProducts.id, input.managedProductId),
            eq(managedProducts.orgId, orgId),
            isNull(managedProducts.deletedAt),
          ),
        )
        .limit(1);
      if (!product) {
        throw new NotFoundException("Managed product not found");
      }
    }

    const [updated] = await this.db
      .update(projects)
      .set({ managedProductId: input.managedProductId })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .returning({
        id: projects.id,
        orgId: projects.orgId,
        name: projects.name,
        key: projects.key,
        managedProductId: projects.managedProductId,
      });

    this.audit.log({
      action: "project.managed_product_linked",
      userId: u.userId,
      orgId,
      targetId: String(projectId),
      targetType: "project",
      metadata: { projectId, managedProductId: input.managedProductId },
    });

    return updated;
  }
}
