import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ProjectsNotFoundException } from "../../../common/http/api-exceptions";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  managedProducts,
  organizationMembers,
  projectMembers,
  projectStatuses,
  projects,
  sprints,
  ticketAssignees,
  ticketAttachments,
  ticketComments,
  ticketLabelMappings,
  tickets,
  timesheets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  LinkManagedProductInput,
  UpdateProjectInput,
} from "./dto/projects.schemas";
import { ProjectsQueryService } from "./projects-query.service";

@Injectable()
export class ProjectsWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
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

    if (!u.isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      const hasManage = perms.has("build:manage");

      if (!hasManage) {
        const project = await this.db.query.projects.findFirst({
          where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
          columns: { managerId: true },
        });
        if (!project) {
          throw new ForbiddenException(
            "Only project managers or admins can update project settings.",
          );
        }
        if (project.managerId !== u.userId) {
          const membership = await this.db
            .select({ role: projectMembers.role })
            .from(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, projectId),
                eq(projectMembers.userId, u.userId),
              ),
            )
            .limit(1);
          if (membership[0]?.role !== "ADMIN") {
            throw new ForbiddenException(
              "Only project managers or admins can update project settings.",
            );
          }
        }
      }
    }

    const projectFields = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && {
        description: body.description,
      }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.managerId !== undefined && { managerId: body.managerId }),
      ...(body.clientId !== undefined && { clientId: body.clientId }),
      ...(body.startDate !== undefined && {
        startDate: body.startDate ? new Date(body.startDate) : null,
      }),
      ...(body.endDate !== undefined && {
        endDate: body.endDate ? new Date(body.endDate) : null,
      }),
      ...(body.priority !== undefined && { priority: body.priority }),
    };

    const hasFieldChanges = Object.keys(projectFields).length > 0;

    if (hasFieldChanges || body.memberIds !== undefined) {
      await this.db.transaction(async (tx) => {
        if (hasFieldChanges) {
          await tx
            .update(projects)
            .set(projectFields)
            .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
        }

        if (body.memberIds !== undefined) {
          const memberIds = body.memberIds;
          const reassignments = body.reassignments;

          const existingMembers = await tx
            .select({ userId: projectMembers.userId })
            .from(projectMembers)
            .where(eq(projectMembers.projectId, projectId));
          const existing = new Set(existingMembers.map((m) => m.userId));

          await tx
            .delete(projectMembers)
            .where(eq(projectMembers.projectId, projectId));

          if (memberIds.length > 0) {
            const validMembers = await tx
              .select({ userId: organizationMembers.userId })
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
                  userId,
                  role: "CONTRIBUTOR" as const,
                })),
              );
            }
          }

          const newMemberSet = new Set(memberIds);
          const removedMembers = [...existing].filter(
            (id) => !newMemberSet.has(id),
          );

          if (removedMembers.length > 0 && reassignments) {
            const openTickets = await tx
              .select({ id: tickets.id, assigneeId: tickets.assigneeId })
              .from(tickets)
              .where(
                and(
                  eq(tickets.orgId, orgId),
                  eq(tickets.projectId, projectId),
                  inArray(tickets.assigneeId, removedMembers),
                  ne(tickets.status, "DONE"),
                  ne(tickets.status, "CANCELLED"),
                ),
              );
            const byNewAssignee = new Map<string | null, number[]>();
            for (const ticket of openTickets) {
              const newAssignee = ticket.assigneeId
                ? (reassignments[ticket.assigneeId] ?? null)
                : null;
              const ids = byNewAssignee.get(newAssignee) ?? [];
              ids.push(ticket.id);
              byNewAssignee.set(newAssignee, ids);
            }
            for (const [newAssignee, ids] of byNewAssignee) {
              await tx
                .update(tickets)
                .set({ assigneeId: newAssignee })
                .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, ids)));
            }
          } else if (removedMembers.length > 0) {
            await tx
              .update(tickets)
              .set({ assigneeId: null })
              .where(
                and(
                  eq(tickets.orgId, orgId),
                  eq(tickets.projectId, projectId),
                  inArray(tickets.assigneeId, removedMembers),
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

    await this.cache.invalidatePattern(`projects:list:${orgId}:*`);

    return this.projectsQuery.getProject(u, projectId);
  }

  async deleteProject(u: CurrentUserContext, projectId: number) {
    if (!u.isOrgOwner) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("build:delete")) {
        throw new ForbiddenException(
          "Only organization owners can delete projects",
        );
      }
    }
    const orgId = u.orgId;

    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
    });
    if (!project) throw new NotFoundException("Project not found");

    await this.db.transaction(async (tx) => {
      const subTickets = tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      await tx
        .delete(ticketAssignees)
        .where(sql`${ticketAssignees.ticketId} IN (${subTickets})`);
      await tx
        .delete(ticketComments)
        .where(sql`${ticketComments.ticketId} IN (${subTickets})`);
      await tx
        .delete(ticketAttachments)
        .where(sql`${ticketAttachments.ticketId} IN (${subTickets})`);
      await tx
        .delete(ticketLabelMappings)
        .where(sql`${ticketLabelMappings.ticketId} IN (${subTickets})`);
      await tx
        .delete(timesheets)
        .where(sql`${timesheets.ticketId} IN (${subTickets})`);
      await tx
        .delete(tickets)
        .where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      await tx
        .delete(sprints)
        .where(and(eq(sprints.projectId, projectId), eq(sprints.orgId, orgId)));
      await tx
        .delete(projectMembers)
        .where(eq(projectMembers.projectId, projectId));
      await tx
        .delete(projectStatuses)
        .where(
          and(
            eq(projectStatuses.projectId, projectId),
            eq(projectStatuses.orgId, orgId),
          ),
        );
      await tx
        .delete(projects)
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

    await this.cache.invalidatePattern(`projects:list:${orgId}:*`);

    return { success: true };
  }

  async linkProjectToManagedProduct(
    u: CurrentUserContext,
    projectId: number,
    input: LinkManagedProductInput,
  ) {
    const orgId = u.orgId;

    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new ProjectsNotFoundException();

    if (input.managedProductId !== null) {
      const [product] = await this.db
        .select({ managedProductId: managedProducts.managedProductId })
        .from(managedProducts)
        .where(
          and(
            eq(managedProducts.managedProductId, input.managedProductId),
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

    await this.cache.invalidatePattern(`projects:list:${orgId}:*`);

    return updated;
  }
}
