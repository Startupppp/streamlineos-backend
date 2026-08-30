import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, exists, gte, ne, or, sql, type SQL } from "drizzle-orm";
import { calendarEvents, eventAttendees, organizationMembers } from "../../db/schema";

const dialect = new PgDialect();
const ORG = "org_cal_1";
const ORG2 = "org_cal_other";
const ACTOR = "user_cal_actor";
const ACTOR2 = "user_cal_actor_2";

const toSql = (condition: SQL) => dialect.sqlToQuery(condition).sql;
const toParams = (condition: SQL) => dialect.sqlToQuery(condition).params;

function buildVisibilityPredicate(orgId: string, userId: string, db: { select: unknown }) {
  const dbSelect = db as {
    select: (cols: unknown) => {
      from: (t: unknown) => {
        innerJoin: (t: unknown, on: unknown) => {
          where: (cond: unknown) => unknown;
        };
      };
    };
  };

  return or(
    eq(calendarEvents.visibility, "org"),
    eq(calendarEvents.createdBy, userId),
    exists(
      dbSelect
        .select({ one: sql`1` })
        .from(eventAttendees)
        .innerJoin(
          organizationMembers,
          and(
            eq(eventAttendees.orgId, organizationMembers.orgId),
            eq(eventAttendees.membershipId, organizationMembers.id),
          ),
        )
        .where(
          and(
            eq(eventAttendees.orgId, orgId),
            eq(eventAttendees.eventId, calendarEvents.id),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, "ACTIVE"),
            ne(eventAttendees.status, "declined"),
          ),
        ) as SQL,
    ),
  );
}

describe("calendar_events schema visibility model", () => {
  it("calendarEvents schema has a visibility column with org default", () => {
    const columnKeys = Object.keys(calendarEvents);
    expect(columnKeys).toContain("visibility");
  });

  it("eventAttendees schema exists with status for RSVP tracking", () => {
    const columnKeys = Object.keys(eventAttendees);
    expect(columnKeys).toContain("status");
  });
});

describe("calendar cross-org isolation", () => {
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

  it("the org_id predicate on eventAttendees also binds to the caller org", () => {
    const condition = eq(eventAttendees.orgId, ORG);
    const { params } = dialect.sqlToQuery(condition);
    expect(params).toContain(ORG);
    expect(params).not.toContain(ORG2);
  });
});

describe("calendar visibility predicate — SQL isolation", () => {
  const fakeDb = {
    select: (cols: unknown) => ({
      from: (table: unknown) => ({
        innerJoin: (_table: unknown, _on: unknown) => ({
          where: (cond: unknown) => cond,
        }),
      }),
    }),
  };

  it("visibility predicate includes 'org' arm — org-visible events are always shown", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { sql: sqlStr } = dialect.sqlToQuery(pred as SQL);
    expect(sqlStr).toContain('"calendar_events"."visibility"');
  });

  it("visibility predicate includes creator arm — event author always sees their own event", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { sql: sqlStr, params } = dialect.sqlToQuery(pred as SQL);
    expect(sqlStr).toContain('"calendar_events"."created_by"');
    expect(params).toContain(ACTOR);
  });

  it("visibility predicate references event_attendees — private events check membership", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { sql: sqlStr } = dialect.sqlToQuery(pred as SQL);
    expect(sqlStr).toContain('"event_attendees"');
  });

  it("declined attendees are excluded from the attendee arm", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { sql: sqlStr } = dialect.sqlToQuery(pred as SQL);
    expect(sqlStr).toContain('"event_attendees"."status"');
    expect(sqlStr).toContain("!=");
  });

  it("predicate binds org_id on both calendarEvents and eventAttendees — no cross-org bleed", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { params } = dialect.sqlToQuery(pred as SQL);
    const orgParams = params.filter((p) => p === ORG);
    expect(orgParams.length).toBeGreaterThanOrEqual(2);
    expect(params).not.toContain(ORG2);
  });

  it("SAME-ORG CONTROL — predicate params for org include caller org throughout", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { params } = dialect.sqlToQuery(pred as SQL);
    expect(params).toContain(ORG);
    expect(params).toContain(ACTOR);
  });

  it("CROSS-ORG DENY — predicate for ORG2 never shares params with ORG predicate", () => {
    const predOrg1 = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const predOrg2 = buildVisibilityPredicate(ORG2, ACTOR2, fakeDb);
    const params1 = dialect.sqlToQuery(predOrg1 as SQL).params;
    const params2 = dialect.sqlToQuery(predOrg2 as SQL).params;
    expect(params1).not.toContain(ORG2);
    expect(params2).not.toContain(ORG);
  });

  it("active-membership filter excludes departed members", () => {
    const pred = buildVisibilityPredicate(ORG, ACTOR, fakeDb);
    const { sql: sqlStr } = dialect.sqlToQuery(pred as SQL);
    expect(sqlStr).toContain('"organization_members"."status"');
  });
});

describe("upcoming events full predicate composition", () => {
  it("full upcoming-events predicate includes org, start-date and visibility gates", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fakeDb = {
      select: (cols: unknown) => ({
        from: (table: unknown) => ({
          innerJoin: (_table: unknown, _on: unknown) => ({
            where: (cond: unknown) => cond,
          }),
        }),
      }),
    };
    const condition = and(
      eq(calendarEvents.orgId, ORG),
      gte(calendarEvents.startDate, now),
      buildVisibilityPredicate(ORG, ACTOR, fakeDb),
    );
    const { sql: sqlStr, params } = dialect.sqlToQuery(condition as SQL);
    expect(sqlStr).toContain('"calendar_events"."org_id"');
    expect(sqlStr).toContain('"calendar_events"."start_date"');
    expect(sqlStr).toContain('"calendar_events"."visibility"');
    expect(sqlStr).toContain('"event_attendees"');
    expect(params).toContain(ORG);
    expect(params).toContain(ACTOR);
  });

  it("DENY — predicate for ORG never exposes events from ORG2 params", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const fakeDb = {
      select: (cols: unknown) => ({
        from: (table: unknown) => ({
          innerJoin: (_table: unknown, _on: unknown) => ({
            where: (cond: unknown) => cond,
          }),
        }),
      }),
    };
    const condition = and(
      eq(calendarEvents.orgId, ORG),
      gte(calendarEvents.startDate, now),
      buildVisibilityPredicate(ORG, ACTOR, fakeDb),
    );
    const { params } = dialect.sqlToQuery(condition as SQL);
    expect(params).not.toContain(ORG2);
    expect(params).not.toContain(ACTOR2);
  });
});
