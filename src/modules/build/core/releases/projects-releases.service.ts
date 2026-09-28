import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { TicketVersionConflictException } from "../tickets";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import {
  projectReleases,
  releaseTickets,
  tickets,
  users,
} from "../../../../db/schema";
import type { CreateReleaseInput, ListReleasesQuery, OrgListReleasesQuery, UpdateReleaseInput } from "../dto/releases.schemas";
import { assertProjectAccess } from "../project-crud/project-access";
import { escapeLike } from "../lib/escape-like";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { buildCursorPage, decodeIntegerCursor } from "../../../../common/pagination/cursor";

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

  async listOrgReleases(u: CurrentUserContext, query: OrgListReleasesQuery) {
    const orgId = u.orgId;
    const { cursor, limit, status } = query;
    const pos = decodeIntegerCursor(cursor ?? null);
    const rows = await this.db
      .select({
        id: projectReleases.id,
        orgId: projectReleases.orgId,
        projectId: projectReleases.projectId,
        name: projectReleases.name,
        version: projectReleases.version,
        rowVersion: projectReleases.rowVersion,
        description: projectReleases.description,
        status: projectReleases.status,
        releaseDate: projectReleases.releaseDate,
        publishedAt: projectReleases.publishedAt,
        createdBy: projectReleases.createdBy,
        createdAt: projectReleases.createdAt,
        updatedAt: projectReleases.updatedAt,
        ticketCount: sql<number>`CAST(
          (SELECT COUNT(*) FROM ${releaseTickets} WHERE ${releaseTickets.releaseId} = ${projectReleases.id})
          AS INT)`,
        createdByUser: {
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        },
      })
      .from(projectReleases)
      .leftJoin(users, eq(users.id, projectReleases.createdBy))
      .where(
        and(
          eq(projectReleases.orgId, orgId),
          isNull(projectReleases.deletedAt),
          status ? eq(projectReleases.status, status) : undefined,
          pos ? lt(projectReleases.id, pos.id) : undefined,
        ),
      )
      .orderBy(desc(projectReleases.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.id),
      id: String(row.id),
    }));
  }

  async listReleases(u: CurrentUserContext, projectId: number, query: ListReleasesQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const orgId = u.orgId;
    const { cursor, limit, status, q, from, to } = query;
    const pos = decodeIntegerCursor(cursor ?? null);
    const rows = await this.db
      .select({
        id: projectReleases.id,
        orgId: projectReleases.orgId,
        projectId: projectReleases.projectId,
        name: projectReleases.name,
        version: projectReleases.version,
        rowVersion: projectReleases.rowVersion,
        description: projectReleases.description,
        status: projectReleases.status,
        releaseDate: projectReleases.releaseDate,
        publishedAt: projectReleases.publishedAt,
        createdBy: projectReleases.createdBy,
        createdAt: projectReleases.createdAt,
        updatedAt: projectReleases.updatedAt,
        ticketCount: sql<number>`CAST(
          (SELECT COUNT(*) FROM ${releaseTickets} WHERE ${releaseTickets.releaseId} = ${projectReleases.id})
          AS INT)`,
        createdByUser: {
          name: users.name,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        },
      })
      .from(projectReleases)
      .leftJoin(users, eq(users.id, projectReleases.createdBy))
      .where(and(
        eq(projectReleases.projectId, projectId),
        eq(projectReleases.orgId, orgId),
        isNull(projectReleases.deletedAt),
        status ? eq(projectReleases.status, status) : undefined,
        q ? sql`${projectReleases.name} ILIKE ${`%${escapeLike(q)}%`}` : undefined,
        from ? gte(projectReleases.releaseDate, from) : undefined,
        to ? lte(projectReleases.releaseDate, to) : undefined,
        pos ? lt(projectReleases.id, pos.id) : undefined,
      ))
      .orderBy(desc(projectReleases.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.id),
      id: String(row.id),
    }));
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
    const before = await this.db.query.projectReleases.findFirst({
      where: and(eq(projectReleases.id, releaseId), eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt)),
      columns: { rowVersion: true, status: true, publishedAt: true },
    });
    if (!before) throw new NotFoundException("Release not found");
    if (data.rowVersion !== before.rowVersion) throw new TicketVersionConflictException(before.rowVersion);

    const { rowVersion: _rv, ...rest } = data;
    const publishedAtPatch: { publishedAt?: Date } =
      data.status === "released" && before.status !== "released"
        ? { publishedAt: new Date() }
        : {};
    const rows = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(projectReleases)
        .set({ ...rest, ...publishedAtPatch })
        .where(and(eq(projectReleases.id, releaseId), eq(projectReleases.projectId, projectId), eq(projectReleases.orgId, orgId), isNull(projectReleases.deletedAt), eq(projectReleases.rowVersion, before.rowVersion)))
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
    if (!updated) {
      const [current] = await this.db.select({ rowVersion: projectReleases.rowVersion }).from(projectReleases).where(and(eq(projectReleases.id, releaseId), eq(projectReleases.orgId, orgId))).limit(1);
      throw new TicketVersionConflictException(current?.rowVersion ?? before.rowVersion);
    }
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
