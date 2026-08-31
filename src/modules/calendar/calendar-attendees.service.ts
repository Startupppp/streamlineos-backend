import { Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, eq, isNotNull, or } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { RsvpInput } from "./dto/calendar.schemas";

const callerAttendeeLookup = aliasedTable(eventAttendees, "att_visibility_check");

@Injectable()
export class CalendarAttendeesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveCallerMembershipId(orgId: string, userId: string): Promise<number> {
    const row = await this.db.query.organizationMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
    });
    return row?.id ?? 0;
  }

  private async getVisibleEventForOrg(
    orgId: string,
    id: number,
    callerMembershipId: number,
  ) {
    const rows = await this.db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .leftJoin(
        callerAttendeeLookup,
        and(
          eq(callerAttendeeLookup.orgId, calendarEvents.orgId),
          eq(callerAttendeeLookup.eventId, calendarEvents.id),
          eq(callerAttendeeLookup.membershipId, callerMembershipId),
        ),
      )
      .where(
        and(
          eq(calendarEvents.id, id),
          eq(calendarEvents.orgId, orgId),
          or(
            eq(calendarEvents.visibility, "org"),
            eq(calendarEvents.createdByMembershipId, callerMembershipId),
            isNotNull(callerAttendeeLookup.id),
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async rsvp(orgId: string, userId: string, id: number, input: RsvpInput) {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership) return null;

    const event = await this.getVisibleEventForOrg(orgId, id, membership.id);
    if (!event) return null;

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

  async listAttendees(orgId: string, userId: string, id: number) {
    const callerMembershipId = await this.resolveCallerMembershipId(orgId, userId);
    const event = await this.getVisibleEventForOrg(orgId, id, callerMembershipId);
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
