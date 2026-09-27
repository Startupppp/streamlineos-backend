import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { projectUpdates } from "../../../db/schema/build/project-updates";
import { organizationMembers, users } from "../../../db/schema/common/auth";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  buildCursorPage,
  decodeTimestampCursor,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import type { CreateUpdateInput, EditUpdateInput, ListUpdatesQuery } from "./dto/updates.schemas";

const DEFAULT_LIMIT = 25;

const AUTHOR_NAME = sql<string>`COALESCE(${users.name}, ${users.email}, 'Unknown')`;

@Injectable()
export class UpdatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async loadUpdate(orgId: string, projectId: number, updateId: number) {
    const [row] = await this.db
      .select({
        id: projectUpdates.id,
        authorMembershipId: projectUpdates.authorMembershipId,
      })
      .from(projectUpdates)
      .where(
        and(
          eq(projectUpdates.id, updateId),
          eq(projectUpdates.orgId, orgId),
          eq(projectUpdates.projectId, projectId),
          isNull(projectUpdates.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Update not found");
    return row;
  }

  private async selectFullRow(orgId: string, id: number) {
    const [row] = await this.db
      .select({
        id: projectUpdates.id,
        orgId: projectUpdates.orgId,
        projectId: projectUpdates.projectId,
        authorMembershipId: projectUpdates.authorMembershipId,
        authorName: AUTHOR_NAME,
        body: projectUpdates.body,
        wins: projectUpdates.wins,
        risks: projectUpdates.risks,
        next: projectUpdates.next,
        citations: projectUpdates.citations,
        status: projectUpdates.status,
        audience: projectUpdates.audience,
        createdAt: projectUpdates.createdAt,
        updatedAt: projectUpdates.updatedAt,
        deletedAt: projectUpdates.deletedAt,
      })
      .from(projectUpdates)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectUpdates.authorMembershipId),
          eq(organizationMembers.orgId, projectUpdates.orgId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(projectUpdates.orgId, orgId), eq(projectUpdates.id, id)));
    if (!row) throw new NotFoundException("Update not found");
    return row;
  }

  async listUpdates(u: CurrentUserContext, projectId: number, query: ListUpdatesQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const position = decodeTimestampCursor(query.cursor ?? null);

    const rows = await this.db
      .select({
        id: projectUpdates.id,
        orgId: projectUpdates.orgId,
        projectId: projectUpdates.projectId,
        authorMembershipId: projectUpdates.authorMembershipId,
        authorName: AUTHOR_NAME,
        body: projectUpdates.body,
        wins: projectUpdates.wins,
        risks: projectUpdates.risks,
        next: projectUpdates.next,
        citations: projectUpdates.citations,
        status: projectUpdates.status,
        audience: projectUpdates.audience,
        createdAt: microsecondCursorValue(projectUpdates.createdAt),
        updatedAt: projectUpdates.updatedAt,
        deletedAt: projectUpdates.deletedAt,
      })
      .from(projectUpdates)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectUpdates.authorMembershipId),
          eq(organizationMembers.orgId, projectUpdates.orgId),
        ),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(projectUpdates.orgId, u.orgId),
          eq(projectUpdates.projectId, projectId),
          isNull(projectUpdates.deletedAt),
          position
            ? keysetBeforeMicros(projectUpdates.createdAt, projectUpdates.id, position)
            : undefined,
          query.authorId !== undefined
            ? eq(projectUpdates.authorMembershipId, query.authorId)
            : undefined,
          query.status !== undefined
            ? eq(projectUpdates.status, query.status)
            : undefined,
          query.from !== undefined
            ? gte(projectUpdates.createdAt, new Date(query.from))
            : undefined,
          query.to !== undefined
            ? lte(projectUpdates.createdAt, new Date(query.to))
            : undefined,
        ),
      )
      .orderBy(desc(projectUpdates.createdAt), desc(projectUpdates.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt,
      id: String(row.id),
    }));
  }

  async createUpdate(u: CurrentUserContext, projectId: number, input: CreateUpdateInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      throw new ForbiddenException("No active membership found");

    const [inserted] = await this.db
      .insert(projectUpdates)
      .values({
        orgId: u.orgId,
        projectId,
        authorMembershipId: membershipId,
        body: input.body,
        wins: input.wins ?? null,
        risks: input.risks ?? null,
        next: input.next ?? null,
        citations: input.citations ?? null,
      })
      .returning({ id: projectUpdates.id });
    if (!inserted) throw new NotFoundException("Failed to create update");

    this.audit.log({
      action: "project_update.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_update",
      resourceId: String(inserted.id),
      metadata: { projectId, updateId: inserted.id },
    });
    return this.selectFullRow(u.orgId, inserted.id);
  }

  async editUpdate(u: CurrentUserContext, projectId: number, updateId: number, input: EditUpdateInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const update = await this.loadUpdate(u.orgId, projectId, updateId);
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null || update.authorMembershipId !== membershipId) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("build:updates:manage") && !u.isOrgOwner)
        throw new ForbiddenException("You can only edit your own updates");
    }
    const [updated] = await this.db
      .update(projectUpdates)
      .set({
        body: input.body,
        ...(input.wins !== undefined ? { wins: input.wins } : {}),
        ...(input.risks !== undefined ? { risks: input.risks } : {}),
        ...(input.next !== undefined ? { next: input.next } : {}),
        ...(input.citations !== undefined ? { citations: input.citations } : {}),
      })
      .where(
        and(
          eq(projectUpdates.id, updateId),
          eq(projectUpdates.orgId, u.orgId),
          eq(projectUpdates.projectId, projectId),
          isNull(projectUpdates.deletedAt),
        ),
      )
      .returning({ id: projectUpdates.id });
    if (!updated) throw new NotFoundException("Update not found after edit");
    this.audit.log({
      action: "project_update.edited",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_update",
      resourceId: String(updateId),
      metadata: { projectId, updateId },
    });
    return this.selectFullRow(u.orgId, updated.id);
  }

  async softDeleteUpdate(u: CurrentUserContext, projectId: number, updateId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const update = await this.loadUpdate(u.orgId, projectId, updateId);
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null || update.authorMembershipId !== membershipId) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("build:updates:manage") && !u.isOrgOwner)
        throw new ForbiddenException("You can only delete your own updates");
    }
    await this.db
      .update(projectUpdates)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectUpdates.id, updateId), eq(projectUpdates.orgId, u.orgId)));
    this.audit.log({
      action: "project_update.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_update",
      resourceId: String(updateId),
      metadata: { projectId, updateId },
    });
  }
}
