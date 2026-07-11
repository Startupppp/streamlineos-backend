import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrEmergencyEvents,
  hrEmergencyResponses,
} from "../../../db/schema/hr/enterprise-ops";
import type {
  CreateEmergencyEventInput,
  UpdateEmergencyEventInput,
  ListEmergencyEventsInput,
  BroadcastInput,
  RespondInput,
} from "../dto/emergency.schemas";

@Injectable()
export class EmergencyService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listEvents(orgId: string, input: ListEmergencyEventsInput) {
    const { page, limit, status } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrEmergencyEvents.orgId, orgId)];
    if (status) conditions.push(eq(hrEmergencyEvents.status, status));

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrEmergencyEvents)
        .where(where)
        .orderBy(desc(hrEmergencyEvents.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrEmergencyEvents).where(where),
    ]);

    const total = totalResult[0]?.total ?? 0;
    return { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getEvent(orgId: string, eventId: string) {
    const row = await this.db.query.hrEmergencyEvents.findFirst({
      where: and(eq(hrEmergencyEvents.orgId, orgId), eq(hrEmergencyEvents.id, eventId)),
    });
    if (!row) throw new NotFoundException("Emergency event not found");
    return row;
  }

  async createEvent(orgId: string, actorId: string, input: CreateEmergencyEventInput) {
    const [row] = await this.db
      .insert(hrEmergencyEvents)
      .values({ orgId, createdBy: actorId, ...input, status: "active" })
      .returning();
    return row;
  }

  async updateEvent(orgId: string, eventId: string, input: UpdateEmergencyEventInput) {
    await this.getEvent(orgId, eventId);

    const patch: {
      name?: string;
      message?: string;
      status?: "active" | "resolved";
      updatedAt: Date;
      resolvedAt?: Date;
    } = { updatedAt: new Date() };

    if (input.name !== undefined) patch.name = input.name;
    if (input.message !== undefined) patch.message = input.message;
    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status === "resolved") patch.resolvedAt = new Date();
    }

    const [row] = await this.db
      .update(hrEmergencyEvents)
      .set(patch)
      .where(and(eq(hrEmergencyEvents.orgId, orgId), eq(hrEmergencyEvents.id, eventId)))
      .returning();
    return row;
  }

  async deleteEvent(orgId: string, eventId: string) {
    await this.getEvent(orgId, eventId);
    await this.db
      .delete(hrEmergencyEvents)
      .where(and(eq(hrEmergencyEvents.orgId, orgId), eq(hrEmergencyEvents.id, eventId)));
  }

  async broadcast(orgId: string, eventId: string, input: BroadcastInput) {
    const event = await this.getEvent(orgId, eventId);

    const employees = event.locationId
      ? await this.db.execute(
          sql`SELECT DISTINCT u.id FROM users u
              INNER JOIN organization_members om ON om.user_id = u.id AND om.org_id = ${orgId}
              WHERE om.deleted_at IS NULL`,
        )
      : await this.db.execute(
          sql`SELECT DISTINCT u.id FROM users u
              INNER JOIN organization_members om ON om.user_id = u.id AND om.org_id = ${orgId}
              WHERE om.deleted_at IS NULL`,
        );

    const userIds: string[] = [];
    for (const row of employees) {
      const r = row as Record<string, unknown>;
      const uid = String(r["id"] ?? "");
      if (uid) userIds.push(uid);
    }

    for (const uid of userIds) {
      const existing = await this.db.query.hrEmergencyResponses.findFirst({
        where: and(
          eq(hrEmergencyResponses.orgId, orgId),
          eq(hrEmergencyResponses.eventId, eventId),
          eq(hrEmergencyResponses.userId, uid),
        ),
      });
      if (!existing) {
        await this.db.insert(hrEmergencyResponses).values({
          orgId,
          eventId,
          userId: uid,
          status: "no_response",
        });
      }
    }

    return { broadcasted: userIds.length, eventId };
  }

  async respond(orgId: string, eventId: string, userId: string, input: RespondInput) {
    await this.getEvent(orgId, eventId);

    const existing = await this.db.query.hrEmergencyResponses.findFirst({
      where: and(
        eq(hrEmergencyResponses.orgId, orgId),
        eq(hrEmergencyResponses.eventId, eventId),
        eq(hrEmergencyResponses.userId, userId),
      ),
    });

    const now = new Date();

    if (existing) {
      const [row] = await this.db
        .update(hrEmergencyResponses)
        .set({ status: input.status, note: input.note ?? null, respondedAt: now, updatedAt: now })
        .where(and(eq(hrEmergencyResponses.orgId, orgId), eq(hrEmergencyResponses.id, existing.id)))
        .returning();
      return row;
    }

    const [row] = await this.db
      .insert(hrEmergencyResponses)
      .values({
        orgId,
        eventId,
        userId,
        status: input.status,
        note: input.note ?? null,
        respondedAt: now,
      })
      .returning();
    return row;
  }

  async getEventStatus(orgId: string, eventId: string) {
    await this.getEvent(orgId, eventId);

    const responses = await this.db
      .select()
      .from(hrEmergencyResponses)
      .where(and(eq(hrEmergencyResponses.orgId, orgId), eq(hrEmergencyResponses.eventId, eventId)));

    const aggregate = { safe: 0, need_help: 0, no_response: 0 };
    const byLocation: Record<string, typeof aggregate> = {};

    for (const r of responses) {
      aggregate[r.status]++;
    }

    return { eventId, aggregate, byLocation, total: responses.length };
  }
}
