import { BuildCalendarSource } from "./build-calendar-source";
import type { CalendarSourceContext } from "../calendar/calendar-event-source";
import { sourceLoadEvents, sourceLoadTruncated } from "../calendar/calendar-event-source";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CALENDAR_PER_SOURCE_CAP, CalendarSourceRegistry } from "../calendar/calendar-source.registry";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import { MEMBER_STANDING, principalAccess } from "./core/project-crud/__tests__/project-access-doubles";

const MEMBERSHIP_ID = 77;

const ctx: CalendarSourceContext = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date("2026-08-01"),
  end: new Date("2026-08-31"),
};

let capturedWhere: SQL | undefined;

function buildDb(ticketRows: unknown[]): unknown {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockImplementation(function (this: unknown, where: SQL) {
          capturedWhere = where;
          return this;
        }),
        limit: jest.fn().mockResolvedValue(ticketRows),
      }),
    })),
  };
}

async function buildSource(db: unknown, membership: { active: boolean; isOwner: boolean } = { active: true, isOwner: false }): Promise<BuildCalendarSource> {
  const module = await Test.createTestingModule({
    providers: [
      BuildCalendarSource,
      { provide: DRIZZLE, useValue: db },
      { provide: CalendarSourceRegistry, useValue: { register: jest.fn() } },
      { provide: AccessService, useValue: principalAccess(MEMBER_STANDING) },
      {
        provide: MembershipStateService,
        useValue: {
          resolve: jest.fn().mockResolvedValue({
            active: membership.active,
            isOwner: membership.isOwner,
            role: "MEMBER",
            membershipId: membership.active ? MEMBERSHIP_ID : null,
          }),
        },
      },
    ],
  }).compile();
  return module.get(BuildCalendarSource);
}

const renderedWhere = () => {
  if (!capturedWhere) throw new Error("the calendar read must carry a predicate");
  return new PgDialect().sqlToQuery(capturedWhere).sql;
};

describe("BuildCalendarSource", () => {
  it("has the expected key, label and module", () => {
    const source = new BuildCalendarSource(null as never, { register: jest.fn() } as never, null as never, null as never);
    expect(source.key).toBe("build");
    expect(source.label).toBe("Build");
    expect(source.module).toBe("build");
  });

  it("returns an empty array when no tickets exist in the range", async () => {
    const source = await buildSource(buildDb([]));
    const result = await source.load(ctx);
    expect(sourceLoadEvents(result)).toHaveLength(0);
    expect(sourceLoadTruncated(result)).toBe(false);
  });

  it("returns an empty event list when the caller has no active org membership so a non-member or suspended user sees no calendar events", async () => {
    const source = await buildSource(buildDb([]), { active: false, isOwner: false });
    const result = await source.load(ctx);
    expect(sourceLoadEvents(result)).toHaveLength(0);
    expect(sourceLoadTruncated(result)).toBe(false);
  });

  it("maps a ticket to a projection with the formatted key in the title", async () => {
    const source = await buildSource(
      buildDb([
        {
          id: 7,
          title: "Login broken",
          dueDate: "2026-08-20",
          status: "open",
          ticketNumber: 12,
          projectId: 3,
          projectKey: "WEB",
        },
      ]),
    );
    const result = await source.load(ctx);

    expect(sourceLoadEvents(result)).toHaveLength(1);
    const proj = sourceLoadEvents(result)[0];
    expect(proj?.id).toBe("ticket-7");
    expect(proj?.title).toBe("WEB-12: Login broken");
    expect(proj?.allDay).toBe(true);
    expect(proj?.category).toBe("task");
    expect(proj?.meta["source"]).toBe("task");
    expect(proj?.meta["entityType"]).toBe("ticket");
    expect(proj?.meta["entityId"]).toBe("7");
    expect(proj?.meta["projectId"]).toBe(3);
  });

  it("filters a member's calendar through the project-access ticket visibility rule", async () => {
    const source = await buildSource(buildDb([]));
    await source.load(ctx);
    expect(renderedWhere()).toContain("project_members");
    expect(renderedWhere()).toContain("project_team_assignments");
  });

  it("gives the org owner every project, matching the owner bypass of the project list", async () => {
    const source = await buildSource(buildDb([]), { active: true, isOwner: true });
    await source.load(ctx);
    expect(renderedWhere()).not.toContain("project_members");
  });

  it("skips rows where dueDate is null", async () => {
    const source = await buildSource(
      buildDb([{ id: 5, title: "No due", dueDate: null, status: "open", ticketNumber: 1, projectId: 1, projectKey: "P" }]),
    );
    const result = await source.load(ctx);
    expect(sourceLoadEvents(result)).toHaveLength(0);
  });

  it("surfaces a ticket from a project the user can reach and returns nothing when reachability yields no rows", async () => {
    const ticketRow = {
      id: 15,
      title: "Fix crash",
      dueDate: "2026-08-20",
      status: "open",
      ticketNumber: 5,
      projectId: 2,
      projectKey: "APP",
    };

    const allowSource = await buildSource(buildDb([ticketRow]));
    const allowResult = await allowSource.load(ctx);
    expect(sourceLoadEvents(allowResult)).toHaveLength(1);
    expect(sourceLoadEvents(allowResult)[0]?.id).toBe("ticket-15");

    const denySource = await buildSource(buildDb([]));
    const denyResult = await denySource.load(ctx);
    expect(sourceLoadEvents(denyResult)).toHaveLength(0);
  });

  it("has no per-source module gate — CalendarSourceRegistry gates on source.module before calling load (see calendar-source.registry.spec.ts)", () => {
    const source = new BuildCalendarSource(null as never, { register: jest.fn() } as never, null as never, null as never);
    expect(source.module).toBe("build");
  });

  it("ticket projection includes correct start, end and color fields", async () => {
    const source = await buildSource(
      buildDb([
        {
          id: 8,
          title: "Update docs",
          dueDate: "2026-08-25",
          status: "open",
          ticketNumber: 3,
          projectId: 1,
          projectKey: "DOC",
        },
      ]),
    );
    const result = await source.load(ctx);

    const proj = sourceLoadEvents(result)[0];
    expect(proj?.start).toEqual(new Date("2026-08-25"));
    expect(proj?.end).toEqual(new Date("2026-08-25"));
    expect(proj?.color).toBe("blue");
  });

  it("returns truncation metadata when the source exceeds its cap", async () => {
    const rows = Array.from({ length: CALENDAR_PER_SOURCE_CAP + 1 }, (_, index) => ({
      id: index + 1,
      title: `Ticket ${index + 1}`,
      dueDate: "2026-08-25",
      status: "open",
      ticketNumber: index + 1,
      projectId: 1,
      projectKey: "DOC",
    }));
    const source = await buildSource(buildDb(rows));

    const result = await source.load(ctx);

    expect(sourceLoadEvents(result)).toHaveLength(CALENDAR_PER_SOURCE_CAP);
    expect(sourceLoadTruncated(result)).toBe(true);
  });
});
