import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import {
  projectReleases,
  releaseTickets,
  projects,
  tickets,
} from "../../../db/schema";
import type { CreateReleaseInput, UpdateReleaseInput } from "./dto/releases.schemas";
import { assertProjectInOrg } from "./project-access";

type ReleaseRow = typeof projectReleases.$inferSelect;

export function releaseRowWithCount(row: ReleaseRow, ticketCount: number) {
  return { ...row, ticketCount };
}

@Injectable()
export class ProjectsReleasesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listReleases(orgId: string, projectId: number) {
    await assertProjectInOrg(this.db, orgId, projectId);
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

  async createRelease(orgId: string, projectId: number, userId: string, data: CreateReleaseInput) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");

    const [release] = await this.db.insert(projectReleases).values({
      orgId,
      projectId,
      createdBy: userId,
      ...data,
    }).returning();
    return releaseRowWithCount(release, 0);
  }

  async updateRelease(orgId: string, releaseId: number, data: UpdateReleaseInput) {
    const rows = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(projectReleases)
        .set(data)
        .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)))
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
      .where(eq(releaseTickets.releaseId, releaseId));
    return releaseRowWithCount(updated, counted?.ticketCount ?? 0);
  }

  async deleteRelease(orgId: string, releaseId: number) {
    const [stamped] = await this.db
      .update(projectReleases)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)))
      .returning({ id: projectReleases.id });
    if (!stamped) throw new NotFoundException("Release not found");
    return { success: true };
  }

  async addTicketToRelease(orgId: string, releaseId: number, ticketId: number) {
    const release = await this.db.query.projectReleases.findFirst({
      where: and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)),
      columns: { id: true },
    });
    if (!release) throw new NotFoundException("Release not found");

    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    await this.db.insert(releaseTickets).values({ orgId, releaseId, ticketId }).onConflictDoNothing();
    return { success: true };
  }

  async removeTicketFromRelease(orgId: string, releaseId: number, ticketId: number) {
    const release = await this.db.query.projectReleases.findFirst({
      where: and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)),
      columns: { id: true },
    });
    if (!release) throw new NotFoundException("Release not found");

    await this.db.delete(releaseTickets)
      .where(and(eq(releaseTickets.releaseId, releaseId), eq(releaseTickets.ticketId, ticketId)));
    return { success: true };
  }
}
