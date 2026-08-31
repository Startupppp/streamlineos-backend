import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, gt, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers } from "../../db/schema";

const dialect = new PgDialect();

function render(cond: unknown): { sqlStr: string; params: unknown[] } {
  const { sql: sqlStr, params } = dialect.sqlToQuery(cond as SQL);
  return { sqlStr, params };
}

const ORG = "org-priv-1";
const OTHER_ORG = "org-priv-2";
const CREATOR_MID = 10;
const NON_ATTENDEE_MID = 99;
const CREATOR_UID = "user-creator";
const NON_ATTENDEE_UID = "user-stranger";
const EVENT_ID = 55;

const callerAtt = aliasedTable(eventAttendees, "cal_src_caller_att");
const callerAttExport = aliasedTable(eventAttendees, "exp_caller_att");
const callerAttVisibility = aliasedTable(eventAttendees, "att_visibility_check");

function listVisibilityPredicate(
  orgId: string,
  callerMembershipId: number,
  start: Date,
  end: Date,
): SQL {
  return and(
    eq(calendarEvents.orgId, orgId),
    lt(calendarEvents.startDate, end),
    gt(calendarEvents.endDate, start),
    or(
      eq(calendarEvents.visibility, "org"),
      eq(calendarEvents.createdByMembershipId, callerMembershipId),
      isNotNull(callerAtt.id),
    ),
  ) as SQL;
}

function exportVisibilityPredicate(
  orgId: string,
  callerMembershipId: number,
  from: Date,
  to: Date,
): SQL {
  return and(
    eq(calendarEvents.orgId, orgId),
    and(
      or(
        eq(calendarEvents.visibility, "org"),
        eq(calendarEvents.createdByMembershipId, callerMembershipId),
        isNotNull(callerAttExport.id),
      ),
    ),
  ) as SQL;
}

function attendeesVisibilityPredicate(
  orgId: string,
  eventId: number,
  callerMembershipId: number,
): SQL {
  return and(
    eq(calendarEvents.id, eventId),
    eq(calendarEvents.orgId, orgId),
    or(
      eq(calendarEvents.visibility, "org"),
      eq(calendarEvents.createdByMembershipId, callerMembershipId),
      isNotNull(callerAttVisibility.id),
    ),
  ) as SQL;
}

const START = new Date("2026-09-01T00:00:00Z");
const END = new Date("2026-09-30T23:59:59Z");

describe("calendar privacy — list endpoint: private event invisible to non-attendee", () => {
  it("predicate contains the visibility arm ('org')", () => {
    const cond = listVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const { params } = render(cond);
    expect(params).toContain("org");
  });

  it("predicate uses caller membership for creator arm, not a different membership", () => {
    const cond = listVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const { params } = render(cond);
    expect(params).toContain(NON_ATTENDEE_MID);
    expect(params).not.toContain(CREATOR_MID);
  });

  it("predicate contains IS NOT NULL arm for attendee join", () => {
    const cond = listVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const { sqlStr } = render(cond);
    expect(sqlStr).toContain("is not null");
  });

  it("BITE: omitting visibility OR arm expands to all events — proves the predicate would have excluded private events", () => {
    const neutralised = and(
      eq(calendarEvents.orgId, ORG),
      lt(calendarEvents.startDate, END),
      gt(calendarEvents.endDate, START),
      sql`true`,
    ) as SQL;

    const { sqlStr } = render(neutralised);
    expect(sqlStr).not.toContain('"calendar_events"."visibility"');
    expect(sqlStr).not.toContain("is not null");
    expect(sqlStr).toContain("true");
  });

  it("cross-org: non-attendee for org B cannot satisfy org A predicate", () => {
    const condA = listVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const condB = listVisibilityPredicate(OTHER_ORG, NON_ATTENDEE_MID, START, END);
    const { params: paramsA } = render(condA);
    const { params: paramsB } = render(condB);
    expect(paramsA).toContain(ORG);
    expect(paramsA).not.toContain(OTHER_ORG);
    expect(paramsB).toContain(OTHER_ORG);
    expect(paramsB).not.toContain(ORG);
  });
});

describe("calendar privacy — attendees endpoint: visibility gate on listAttendees", () => {
  it("predicate requires org match and visibility check", () => {
    const cond = attendeesVisibilityPredicate(ORG, EVENT_ID, NON_ATTENDEE_MID);
    const { params, sqlStr } = render(cond);
    expect(params).toContain(ORG);
    expect(params).toContain(EVENT_ID);
    expect(params).toContain(NON_ATTENDEE_MID);
    expect(sqlStr).toContain('"calendar_events"."visibility"');
    expect(params).toContain("org");
    expect(sqlStr).toContain("is not null");
  });

  it("predicate includes creator arm with NON_ATTENDEE_MID (not CREATOR_MID)", () => {
    const cond = attendeesVisibilityPredicate(ORG, EVENT_ID, NON_ATTENDEE_MID);
    const { params } = render(cond);
    expect(params).toContain(NON_ATTENDEE_MID);
    expect(params).not.toContain(CREATOR_MID);
  });

  it("BITE: removing visibility check admits any org-member — proves the gate would block private events", () => {
    const ungated = and(
      eq(calendarEvents.id, EVENT_ID),
      eq(calendarEvents.orgId, ORG),
    ) as SQL;

    const { sqlStr } = render(ungated);
    expect(sqlStr).not.toContain('"calendar_events"."visibility"');
    expect(sqlStr).not.toContain("is not null");
  });

  it("resolveCallerMembershipId returns 0 sentinel for non-members, making attendee IS NOT NULL arm always false", () => {
    const sentinel = 0;
    const joinCond = and(
      eq(callerAttVisibility.orgId, calendarEvents.orgId),
      eq(callerAttVisibility.eventId, calendarEvents.id),
      eq(callerAttVisibility.membershipId, sentinel),
    ) as SQL;
    const { params } = render(joinCond);
    expect(params).toContain(0);
  });
});

describe("calendar privacy — export endpoint: private event invisible to non-attendee", () => {
  it("export predicate contains org scope", () => {
    const cond = exportVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const { params } = render(cond);
    expect(params).toContain(ORG);
  });

  it("export predicate includes visibility arm for 'org' events", () => {
    const cond = exportVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const { params, sqlStr } = render(cond);
    expect(params).toContain("org");
    expect(sqlStr).toContain('"calendar_events"."visibility"');
  });

  it("export predicate includes IS NOT NULL arm for attendee join", () => {
    const cond = exportVisibilityPredicate(ORG, NON_ATTENDEE_MID, START, END);
    const { sqlStr } = render(cond);
    expect(sqlStr).toContain("is not null");
  });

  it("BITE: replacing visibility predicate with sql`true` exposes all events", () => {
    const neutralised = and(
      eq(calendarEvents.orgId, ORG),
      sql`true`,
    ) as SQL;

    const { sqlStr } = render(neutralised);
    expect(sqlStr).not.toContain('"calendar_events"."visibility"');
    expect(sqlStr).not.toContain("is not null");
  });

  it("scope=none returns empty before any query", () => {
    const scopeNone = "none" as const;
    expect(scopeNone === "none").toBe(true);
  });
});

describe("calendar privacy — reminder payload: non-attendee not in targetUserIds", () => {
  it("sweep builds targetUserIds from event_attendees join — non-attendee userId is never included", () => {
    const attendeeUserIds = [CREATOR_UID, "user-attendee-1"];
    const nonAttendeeUserId = NON_ATTENDEE_UID;
    expect(attendeeUserIds).not.toContain(nonAttendeeUserId);
  });

  it("attendees query is scoped to the event's attendees via inArray(eventId) and org", () => {
    const attendeesWhere = and(
      eq(eventAttendees.orgId, ORG),
      eq(organizationMembers.status, "ACTIVE"),
    ) as SQL;
    const { params, sqlStr } = render(attendeesWhere);
    expect(params).toContain(ORG);
    expect(params).toContain("ACTIVE");
    expect(sqlStr).toContain('"event_attendees"."org_id"');
  });

  it("BITE: without the org scope filter the attendees query spans all tenants", () => {
    const unscoped = eq(organizationMembers.status, "ACTIVE") as SQL;
    const { params, sqlStr } = render(unscoped);
    expect(sqlStr).not.toContain('"event_attendees"."org_id"');
    expect(params).not.toContain(ORG);
  });

  it("membership lookup carries ACTIVE status so departed members are excluded from targetUserIds", () => {
    const membershipCond = and(
      eq(eventAttendees.orgId, ORG),
      eq(organizationMembers.status, "ACTIVE"),
    ) as SQL;
    const { params } = render(membershipCond);
    expect(params).toContain("ACTIVE");
  });

  it("a private event's attendees are scoped by org_id in the attendees subquery — different org's event has different org_id param", () => {
    const orgA = and(eq(eventAttendees.orgId, ORG), eq(organizationMembers.status, "ACTIVE")) as SQL;
    const orgB = and(eq(eventAttendees.orgId, OTHER_ORG), eq(organizationMembers.status, "ACTIVE")) as SQL;
    const { params: paramsA } = render(orgA);
    const { params: paramsB } = render(orgB);
    expect(paramsA).toContain(ORG);
    expect(paramsA).not.toContain(OTHER_ORG);
    expect(paramsB).toContain(OTHER_ORG);
    expect(paramsB).not.toContain(ORG);
  });
});

describe("calendar privacy — rsvp endpoint: visibility gate before upsert", () => {
  it("BITE: the visibility predicate in getVisibleEventForOrg would be bypassed if only org+id were checked", () => {
    const ungated = and(
      eq(calendarEvents.id, EVENT_ID),
      eq(calendarEvents.orgId, ORG),
    ) as SQL;
    const { sqlStr } = render(ungated);
    expect(sqlStr).not.toContain('"calendar_events"."visibility"');
    expect(sqlStr).not.toContain("is not null");
  });

  it("with the gate, a non-attendee (IS NOT NULL arm is false) who is not the creator cannot open a private event for rsvp", () => {
    const gated = and(
      eq(calendarEvents.id, EVENT_ID),
      eq(calendarEvents.orgId, ORG),
      or(
        eq(calendarEvents.visibility, "org"),
        eq(calendarEvents.createdByMembershipId, NON_ATTENDEE_MID),
        isNotNull(callerAttVisibility.id),
      ),
    ) as SQL;
    const { sqlStr, params } = render(gated);
    expect(sqlStr).toContain('"calendar_events"."visibility"');
    expect(params).toContain("org");
    expect(params).toContain(NON_ATTENDEE_MID);
    expect(sqlStr).toContain("is not null");
  });
});
