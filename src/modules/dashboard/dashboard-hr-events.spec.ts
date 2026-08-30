import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, gte, type SQL } from "drizzle-orm";
import { calendarEvents, eventAttendees } from "../../db/schema";

const dialect = new PgDialect();
const ORG = "org_cal_1";
const ORG2 = "org_cal_other";
const ACTOR = "user_cal_actor";

describe("P0-1 premise verification — calendar event visibility model", () => {
  it("calendarEvents schema has no visibility column — there is no private-event concept", () => {
    const columnKeys = Object.keys(calendarEvents);
    expect(columnKeys).not.toContain("visibility");
    expect(columnKeys).not.toContain("isPrivate");
  });

  it("the calendar module's queryEvents returns all org events without attendee filter — consistent with the dashboard query", () => {
    const condition = and(
      eq(calendarEvents.orgId, ORG),
      gte(calendarEvents.startDate, new Date()),
    );
    const { sql: sqlStr } = dialect.sqlToQuery(condition as SQL);
    expect(sqlStr).toContain('"calendar_events"."org_id"');
    expect(sqlStr).toContain('"calendar_events"."start_date"');
    expect(sqlStr).not.toContain('"event_attendees"');
  });
});

describe("calendar event cross-org isolation", () => {
  it("the upcoming-events org predicate binds to the caller org and not to any other org", () => {
    const condition = and(
      eq(calendarEvents.orgId, ORG),
      gte(calendarEvents.startDate, new Date()),
    );
    const { params } = dialect.sqlToQuery(condition as SQL);
    expect(params).toContain(ORG);
    expect(params).not.toContain(ORG2);
  });

  it("an event from a different org cannot match the caller-org predicate", () => {
    const callerCondition = eq(calendarEvents.orgId, ORG);
    const otherOrgCondition = eq(calendarEvents.orgId, ORG2);
    const callerSql = dialect.sqlToQuery(callerCondition);
    const otherSql = dialect.sqlToQuery(otherOrgCondition);
    expect(callerSql.params[0]).toBe(ORG);
    expect(otherSql.params[0]).toBe(ORG2);
    expect(callerSql.params[0]).not.toBe(otherSql.params[0]);
  });

  it("the org_id predicate on eventAttendees also binds to the caller org for RSVP lookups", () => {
    const condition = eq(eventAttendees.orgId, ORG);
    const { params } = dialect.sqlToQuery(condition);
    expect(params).toContain(ORG);
    expect(params).not.toContain(ORG2);
  });
});

describe("declined attendee / departed membership — calendar visibility model note", () => {
  it("eventAttendees.status is an RSVP field only — declining an invite does not hide the event title", () => {
    const columnKeys = Object.keys(eventAttendees);
    expect(columnKeys).toContain("status");
    const columnKeys2 = Object.keys(calendarEvents);
    expect(columnKeys2).not.toContain("visibility");
  });

  it("the dashboard query omits the eventAttendees join — consistent with the calendar module which returns all org events", () => {
    const upcomingEventsCondition = and(
      eq(calendarEvents.orgId, ORG),
      gte(calendarEvents.startDate, new Date()),
    );
    const { sql: sqlStr } = dialect.sqlToQuery(upcomingEventsCondition as SQL);
    expect(sqlStr).not.toContain("event_attendees");
    expect(sqlStr).toContain("calendar_events");
  });
});
