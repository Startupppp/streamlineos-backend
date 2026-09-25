import { BuildCalendarSource } from "./build-calendar-source";
import type { CalendarSourceContext } from "../calendar/calendar-event-source";
import { sourceLoadEvents, sourceLoadTruncated } from "../calendar/calendar-event-source";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CALENDAR_PER_SOURCE_CAP, CalendarSourceRegistry } from "../calendar/calendar-source.registry";
import { Test } from "@nestjs/testing";

const ctx: CalendarSourceContext = {
  orgId: "org-1",
  userId: "user-1",
  start: new Date("2026-08-01"),
  end: new Date("2026-08-31"),
};

function buildDb(rows: unknown[]): unknown {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

async function buildSource(db: unknown): Promise<BuildCalendarSource> {
  const module = await Test.createTestingModule({
    providers: [
      BuildCalendarSource,
      { provide: DRIZZLE, useValue: db },
      { provide: CalendarSourceRegistry, useValue: { register: jest.fn() } },
    ],
  }).compile();
  return module.get(BuildCalendarSource);
}

describe("BuildCalendarSource", () => {
  it("has the expected key, label and module", () => {
    const source = new BuildCalendarSource(null as never, { register: jest.fn() } as never);
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

  it("only surfaces tickets where the user is a project member (enforced by join in query)", async () => {
    const source = await buildSource(buildDb([]));
    const result = await source.load(ctx);
    expect(sourceLoadEvents(result)).toHaveLength(0);
  });

  it("skips rows where dueDate is null", async () => {
    const source = await buildSource(
      buildDb([{ id: 5, title: "No due", dueDate: null, status: "open", ticketNumber: 1, projectId: 1, projectKey: "P" }]),
    );
    const result = await source.load(ctx);
    expect(sourceLoadEvents(result)).toHaveLength(0);
  });

  it("surfaces a ticket from a project the user is a member of and returns nothing when the join yields no rows", async () => {
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
    const source = new BuildCalendarSource(null as never, { register: jest.fn() } as never);
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
