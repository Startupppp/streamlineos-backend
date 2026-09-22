import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  projectReleases,
  releaseTickets,
  tickets,
} from "../../../db/schema";
import type { CreateReleaseInput, UpdateReleaseInput } from "./dto/releases.schemas";
import { assertProjectAccess } from "./project-access";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";

type ReleaseRow = typeof projectReleases.$inferSelect;

export function releaseRowWithCount(row: ReleaseRow, ticketCount: number) {
  return { ...row, ticketCount };
}

@Injectable()
export class ProjectsReleasesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listReleases(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const rows = await this.db
      .select({
        id: projectReleases.id,
        orgId: projectReleases.orgId,
        projectId: projectReleases.projectId,
        name: projectReleases.name,
        version: projectReleases.version,
        description: projectReleases.description,
        status: projectReleases.status,
        releaseDate: projectReleases.releaseDate,
        createdBy: projectReleases.createdBy,
        createdAt: projectReleases.createdAt,
        updatedAt: projectReleases.updatedAt,
        ticketCount: sql<number>`CAST(
          (SELECT COUNT(*) FROM ${releaseTickets} WHERE ${releaseTickets.releaseId} = ${projectReleases.id})
          AS INT)`,
      })
      .from(projectReleases)
      .where(and(eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)))
      .orderBy(sql`${projectReleases.createdAt} DESC`)
      .limit(100);

    return rows;
  }

  async createRelease(u: CurrentUserContext, projectId: number, data: CreateReleaseInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const [release] = await this.db.insert(projectReleases).values({
      orgId,
      projectId,
      createdBy: u.userId,
      ...data,
    }).returning();
    return releaseRowWithCount(release, 0);
  }

  async updateRelease(u: CurrentUserContext, projectId: number, releaseId: number, data: UpdateReleaseInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const rows = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(projectReleases)
        .set(data)
        .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)))
        .returning();
      const row = result[0];
      if (row && data.status === "released") {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "release",
          aggregateId: String(releaseId),
          aggregateVersion: Date.now(),
          eventType: "build.release.published",
          payload: {
            releaseId,
            projectId: row.projectId,
            orgId,
            name: row.name,
            version: row.version ?? null,
          },
          occurredAt: new Date(),
        });
      }
      return result;
    });
    const updated = rows[0];
    if (!updated) throw new NotFoundException("Release not found");
    const [counted] = await this.db
      .select({ ticketCount: sql<number>`CAST(COUNT(*) AS INT)` })
      .from(releaseTickets)
      .where(and(eq(releaseTickets.releaseId, releaseId), eq(releaseTickets.orgId, orgId)));
    return releaseRowWithCount(updated, counted?.ticketCount ?? 0);
  }

  async deleteRelease(u: CurrentUserContext, projectId: number, releaseId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const [stamped] = await this.db
      .update(projectReleases)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)))
      .returning({ id: projectReleases.id });
    if (!stamped) throw new NotFoundException("Release not found");
    return { success: true };
  }

  async addTicketToRelease(u: CurrentUserContext, projectId: number, releaseId: number, ticketId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const release = await this.db.query.projectReleases.findFirst({
      where: and(eq(projectReleases.id, releaseId), eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)),
      columns: { id: true },
    });
    if (!release) throw new NotFoundException("Release not found");

    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    await this.db.insert(releaseTickets).values({ orgId, releaseId, ticketId }).onConflictDoNothing();
    return { success: true };
  }

  async removeTicketFromRelease(u: CurrentUserContext, projectId: number, releaseId: number, ticketId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const release = await this.db.query.projectReleases.findFirst({
      where: and(eq(projectReleases.id, releaseId), eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)),
      columns: { id: true },
    });
    if (!release) throw new NotFoundException("Release not found");

    await this.db.delete(releaseTickets)
      .where(and(eq(releaseTickets.releaseId, releaseId), eq(releaseTickets.ticketId, ticketId), eq(releaseTickets.orgId, orgId)));
    return { success: true };
  }
}
