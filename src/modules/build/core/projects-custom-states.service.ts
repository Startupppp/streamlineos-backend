import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  projectMembers,
  projects,
  projectStatuses,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type {
  CreateStateInput,
  UpdateCustomStateInput,
} from "./dto/projects.schemas";

function statusTypeOf(type: string | null | undefined): string {
  return type ?? "unstarted";
}

@Injectable()
export class ProjectsCustomStatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async assertCanManageProject(
    u: CurrentUserContext,
    projectId: number,
  ): Promise<void> {
    if (u.isOrgOwner) return;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    if (perms.has("build:manage")) return;
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)),
      columns: { managerId: true, managerMembershipId: true },
    });
    if (!project) throw new NotFoundException("Project not found");
    const callerMid = actingMembershipId(u.principal);
    if ((callerMid !== null && project.managerMembershipId === callerMid) || project.managerId === u.userId) return;
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
    if (membership[0]?.role === "ADMIN") return;
    throw new ForbiddenException(
      "You do not have permission to manage this project",
    );
  }

  async listCustomStates(orgId: string, projectId: number) {
    return this.db
      .select()
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.orgId, orgId),
        ),
      )
      .orderBy(projectStatuses.order);
  }

  async createCustomState(
    orgId: string,
    projectId: number,
    body: CreateStateInput,
  ) {
    const existing = await this.db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.orgId, orgId),
          eq(projectStatuses.name, body.name),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException(
        `A column named "${body.name}" already exists in this project`,
      );
    }

    const [maxResult] = await this.db
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${projectStatuses.order}), -1)`,
      })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.orgId, orgId),
        ),
      );
    const nextOrder = body.order ?? (maxResult?.maxOrder ?? -1) + 1;

    const [state] = await this.db
      .insert(projectStatuses)
      .values({
        projectId,
        orgId,
        name: body.name,
        color: body.color,
        order: nextOrder,
        type: body.type ?? "unstarted",
      })
      .returning();
    return state;
  }

  async updateCustomState(
    u: CurrentUserContext,
    stateId: number,
    data: UpdateCustomStateInput,
  ) {
    const orgId = u.orgId;
    const [existing] = await this.db
      .select()
      .from(projectStatuses)
      .where(
        and(eq(projectStatuses.id, stateId), eq(projectStatuses.orgId, orgId)),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Status not found");
    await this.assertCanManageProject(u, existing.projectId);

    if (data.name !== undefined && data.name !== existing.name) {
      const [duplicate] = await this.db
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(
          and(
            eq(projectStatuses.projectId, existing.projectId),
            eq(projectStatuses.orgId, orgId),
            eq(projectStatuses.name, data.name),
            ne(projectStatuses.id, stateId),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ConflictException(
          `A column named "${data.name}" already exists in this project`,
        );
      }
    }

    const updateData: Partial<typeof projectStatuses.$inferInsert> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.color !== undefined) updateData.color = data.color;
    if (data.order !== undefined) updateData.order = data.order;
    if (data.type !== undefined) updateData.type = data.type;

    const updated = await this.db.transaction(async (tx) => {
      if (data.name !== undefined && data.name !== existing.name) {
        await tx
          .update(tickets)
          .set({ status: data.name })
          .where(
            and(
              eq(tickets.orgId, orgId),
              eq(tickets.projectId, existing.projectId),
              eq(tickets.status, existing.name),
            ),
          );
      }

      const [row] = await tx
        .update(projectStatuses)
        .set(updateData)
        .where(
          and(
            eq(projectStatuses.id, stateId),
            eq(projectStatuses.orgId, orgId),
          ),
        )
        .returning();
      return row;
    });

    if (!updated) throw new NotFoundException("Status not found");
    return updated;
  }

  async deleteCustomState(u: CurrentUserContext, stateId: number) {
    const orgId = u.orgId;
    const [existing] = await this.db
      .select()
      .from(projectStatuses)
      .where(
        and(eq(projectStatuses.id, stateId), eq(projectStatuses.orgId, orgId)),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("Status not found");
    await this.assertCanManageProject(u, existing.projectId);

    const siblings = await this.db
      .select()
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.projectId, existing.projectId),
          eq(projectStatuses.orgId, orgId),
        ),
      )
      .orderBy(projectStatuses.order);

    const remaining = siblings.filter((s) => s.id !== stateId);
    if (remaining.length === 0) {
      throw new BadRequestException("At least one workflow status is required");
    }

    const existingType = statusTypeOf(existing.type);
    if (
      existingType === "unstarted" &&
      !remaining.some((s) => statusTypeOf(s.type) === "unstarted")
    ) {
      throw new BadRequestException("Keep at least one Unstarted status");
    }
    if (
      existingType === "completed" &&
      !remaining.some((s) => statusTypeOf(s.type) === "completed")
    ) {
      throw new BadRequestException("Keep at least one Completed status");
    }

    const fallback =
      remaining.find((s) => statusTypeOf(s.type) === "unstarted") ??
      remaining[0];
    if (!fallback) {
      throw new BadRequestException("At least one workflow status is required");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ status: fallback.name })
        .where(
          and(
            eq(tickets.orgId, orgId),
            eq(tickets.projectId, existing.projectId),
            eq(tickets.status, existing.name),
          ),
        );

      await tx
        .delete(projectStatuses)
        .where(
          and(
            eq(projectStatuses.id, stateId),
            eq(projectStatuses.orgId, orgId),
          ),
        );
    });

    return { success: true };
  }
}
