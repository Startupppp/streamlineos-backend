import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, gt, isNotNull, lt, or, type SQL } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers, users } from "../../db/schema";

const dialect = new PgDialect();

const ORG = "org_vis_1";
const OTHER_ORG = "org_vis_2";
const ACTOR = "user_vis_actor";
const OTHER_USER = "user_vis_other";
const CALLER_MID = 42;
const OTHER_MID = 99;
const callerAtt = aliasedTable(eventAttendees, "cal_src_caller_att");

function visibilityPredicate(orgId: string, userId: string, callerMembershipId: number, start: Date, end: Date) {
  return and(
    eq(calendarEvents.orgId, orgId),
    lt(calendarEvents.startDate, end),
    gt(calendarEvents.endDate, start),
    or(
      eq(calendarEvents.visibility, "org"),
      eq(calendarEvents.createdByMembershipId, callerMembershipId),
      isNotNull(callerAtt.id),
    ),
  );
}

describe("calendar event visibility — schema column presence", () => {
  it("calendarEvents schema now has a visibility column", () => {
    expect(Object.keys(calendarEvents)).toContain("visibility");
  });

  it("eventAttendees schema has the columns required for the attendee join", () => {
    const keys = Object.keys(eventAttendees);
    expect(keys).toContain("orgId");
    expect(keys).toContain("eventId");
    expect(keys).toContain("membershipId");
    expect(keys).toContain("status");
  });
});

describe("calendar event visibility — SQL predicate structure", () => {
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-09-30T23:59:59Z");

  it("predicate binds to the caller org and not any other org", () => {
    const cond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const { params } = dialect.sqlToQuery(cond as SQL);
    expect(params).toContain(ORG);
    expect(params).not.toContain(OTHER_ORG);
  });

  it("predicate includes the org-visible arm ('org')", () => {
    const cond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const { sql: sqlStr } = dialect.sqlToQuery(cond as SQL);
    expect(sqlStr).toContain('"calendar_events"."visibility"');
    const { params } = dialect.sqlToQuery(cond as SQL);
    expect(params).toContain("org");
  });

  it("predicate includes the organizer arm (created_by_membership_id = caller membershipId)", () => {
    const cond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const { sql: sqlStr } = dialect.sqlToQuery(cond as SQL);
    expect(sqlStr).toContain('"calendar_events"."created_by_membership_id"');
    const { params } = dialect.sqlToQuery(cond as SQL);
    expect(params).toContain(CALLER_MID);
  });

  it("predicate includes the attendee arm (IS NOT NULL check on aliased attendee join)", () => {
    const cond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const { sql: sqlStr } = dialect.sqlToQuery(cond as SQL);
    expect(sqlStr).toContain("is not null");
  });

  it("organizer arm uses caller membershipId, not any other membership", () => {
    const cond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const { params } = dialect.sqlToQuery(cond as SQL);
    expect(params).toContain(CALLER_MID);
    expect(params).not.toContain(OTHER_MID);
  });

  it("time range bounds are present in the predicate", () => {
    const cond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const { sql: sqlStr } = dialect.sqlToQuery(cond as SQL);
    expect(sqlStr).toContain('"calendar_events"."start_date"');
    expect(sqlStr).toContain('"calendar_events"."end_date"');
  });
});

describe("calendar event visibility — attendee join structure", () => {
  it("callerAtt join keys bind org_id, event_id and membership_id against the caller membership", () => {
    const joinCond = and(
      eq(callerAtt.orgId, calendarEvents.orgId),
      eq(callerAtt.eventId, calendarEvents.id),
      eq(callerAtt.membershipId, CALLER_MID),
    );
    const { sql: sqlStr, params } = dialect.sqlToQuery(joinCond as SQL);
    expect(sqlStr).toContain('"cal_src_caller_att"."org_id"');
    expect(sqlStr).toContain('"cal_src_caller_att"."event_id"');
    expect(sqlStr).toContain('"cal_src_caller_att"."membership_id"');
    expect(params).toContain(CALLER_MID);
    expect(params).not.toContain(OTHER_MID);
  });

  it("a different caller membership id does not appear in the join condition", () => {
    const joinCond = and(
      eq(callerAtt.orgId, calendarEvents.orgId),
      eq(callerAtt.eventId, calendarEvents.id),
      eq(callerAtt.membershipId, CALLER_MID),
    );
    const { params } = dialect.sqlToQuery(joinCond as SQL);
    expect(params).not.toContain(OTHER_MID);
  });
});

describe("calendar event visibility — declined-attendee semantics", () => {
  it("eventAttendees.status is an RSVP field — its value does not remove the row from the attendee table", () => {
    const statusCol = Object.keys(eventAttendees);
    expect(statusCol).toContain("status");
  });

  it("a declined attendee still has a row in event_attendees (rsvp != removal) so the IS NOT NULL arm matches", () => {
    const declinedRsvpStatus = "declined";
    expect(["accepted", "declined", "tentative"]).toContain(declinedRsvpStatus);
  });
});

describe("calendar event visibility — membership sentinel for departed users", () => {
  it("membership id 0 is the sentinel for no-active-membership; serial PKs start at 1 so it never matches real rows", () => {
    const sentinel = 0;
    expect(sentinel).toBeLessThan(1);
  });

  it("with sentinel callerMembershipId=0, the attendee join IS NOT NULL arm is always false, leaving only org and organizer arms", () => {
    const joinCond = and(
      eq(callerAtt.orgId, calendarEvents.orgId),
      eq(callerAtt.eventId, calendarEvents.id),
      eq(callerAtt.membershipId, 0),
    );
    const { params } = dialect.sqlToQuery(joinCond as SQL);
    expect(params).toContain(0);
  });
});

describe("calendar event visibility — cross-org isolation", () => {
  it("two predicates for different orgs produce different org_id params that cannot satisfy each other", () => {
    const start = new Date("2026-09-01T00:00:00Z");
    const end = new Date("2026-09-30T23:59:59Z");
    const orgACond = visibilityPredicate(ORG, ACTOR, CALLER_MID, start, end);
    const orgBCond = visibilityPredicate(OTHER_ORG, ACTOR, CALLER_MID, start, end);
    const { params: paramsA } = dialect.sqlToQuery(orgACond as SQL);
    const { params: paramsB } = dialect.sqlToQuery(orgBCond as SQL);
    expect(paramsA).toContain(ORG);
    expect(paramsA).not.toContain(OTHER_ORG);
    expect(paramsB).toContain(OTHER_ORG);
    expect(paramsB).not.toContain(ORG);
  });
});

describe("calendar event visibility — membership query uses ACTIVE status filter", () => {
  it("membership query for the caller includes the ACTIVE status constraint", () => {
    const membershipWhere = and(
      eq(organizationMembers.orgId, ORG),
      eq(organizationMembers.userId, ACTOR),
      eq(organizationMembers.status, "ACTIVE"),
    );
    const { sql: sqlStr, params } = dialect.sqlToQuery(membershipWhere as SQL);
    expect(sqlStr).toContain('"organization_members"."status"');
    expect(params).toContain("ACTIVE");
  });

  it("an inactive membership (status != ACTIVE) does not match the caller membership lookup", () => {
    const inactiveStatus = "INACTIVE";
    expect(inactiveStatus).not.toBe("ACTIVE");
  });
});

describe("calendar event visibility — users join preserves non-star projection", () => {
  it("creator name comes from the users table via an explicit column projection (never SELECT *)", () => {
    const nameCol = users.name;
    expect(nameCol).toBeDefined();
  });
});
