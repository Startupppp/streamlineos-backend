import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { RsvpInput } from "./dto/calendar.schemas";

@Injectable()
export class CalendarAttendeesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private getEventForOrg(orgId: string, id: number) {
    return this.db.query.calendarEvents.findFirst({
      where: and(eq(calendarEvents.id, id), eq(calendarEvents.orgId, orgId)),
    });
  }

  async rsvp(orgId: string, userId: string, id: number, input: RsvpInput) {
    const event = await this.getEventForOrg(orgId, id);
    if (!event) return null;

    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership) return null;

    const [attendee] = await this.db
      .insert(eventAttendees)
      .values({
        orgId,
        eventId: id,
        membershipId: membership.id,
        status: input.status,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [eventAttendees.orgId, eventAttendees.eventId, eventAttendees.membershipId],
        set: { status: input.status, updatedAt: new Date() },
      })
      .returning();

    return attendee;
  }

  async listAttendees(orgId: string, id: number) {
    const event = await this.getEventForOrg(orgId, id);
    if (!event) return null;

    const rows = await this.db
      .select({
        id: eventAttendees.id,
        status: eventAttendees.status,
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(eventAttendees)
      .innerJoin(
        organizationMembers,
        and(eq(eventAttendees.orgId, organizationMembers.orgId), eq(eventAttendees.membershipId, organizationMembers.id)),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, id)))
      .limit(100);

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      user: { id: row.userId, name: row.userName, email: row.userEmail, image: row.userImage },
    }));
  }
}
