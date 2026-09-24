import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { projectUpdates } from "../../../db/schema/build/project-updates";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
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
        body: projectUpdates.body,
        createdAt: microsecondCursorValue(projectUpdates.createdAt),
        updatedAt: projectUpdates.updatedAt,
        deletedAt: projectUpdates.deletedAt,
      })
      .from(projectUpdates)
      .where(
        and(
          eq(projectUpdates.orgId, u.orgId),
          eq(projectUpdates.projectId, projectId),
          isNull(projectUpdates.deletedAt),
          position
            ? keysetBeforeMicros(projectUpdates.createdAt, projectUpdates.id, position)
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

    const [update] = await this.db
      .insert(projectUpdates)
      .values({
        orgId: u.orgId,
        projectId,
        authorMembershipId: membershipId,
        body: input.body,
      })
      .returning();
    if (!update) throw new NotFoundException("Failed to create update");

    this.audit.log({
      action: "project_update.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_update",
      resourceId: String(update.id),
      metadata: { projectId, updateId: update.id },
    });
    return update;
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
      .set({ body: input.body })
      .where(
        and(
          eq(projectUpdates.id, updateId),
          eq(projectUpdates.orgId, u.orgId),
          eq(projectUpdates.projectId, projectId),
          isNull(projectUpdates.deletedAt),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Update not found after edit");
    this.audit.log({
      action: "project_update.edited",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_update",
      resourceId: String(updateId),
      metadata: { projectId, updateId },
    });
    return updated;
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
