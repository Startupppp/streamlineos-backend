jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { CalendarController } from "./calendar.controller";
import { CalendarExportService, EXPORT_ROW_CAP } from "./calendar-export.service";
import { CalendarRecurrenceService } from "./calendar-recurrence.service";
import { CalendarService } from "./calendar.service";
import { ScopedRead } from "../access/scoped-read";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { Db } from "../../db/drizzle.module";
import type { Request, Response } from "express";

const ORG = "org-export";
const USER = "user-export";
const WINDOW_START = new Date("2026-01-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-10-01T00:00:00.000Z");

interface ExportRow {
  id: number;
  title: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timezone: string;
  category: string;
  location: string | null;
  description: string | null;
  color: string | null;
  rrule: string | null;
  recurrenceEnd: Date | null;
}

function makeRow(id: number, rrule: string | null = null): ExportRow {
  return {
    id,
    title: `Event ${id}`,
    startDate: new Date("2026-01-05T09:00:00.000Z"),
    endDate: new Date("2026-01-05T09:30:00.000Z"),
    allDay: false,
    timezone: "UTC",
    category: "work",
    location: null,
    description: null,
    color: null,
    rrule,
    recurrenceEnd: null,
  };
}

function makeDb(rows: ExportRow[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  let selectCall = 0;
  const db = {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 42 }) },
    },
    select: jest.fn().mockImplementation(() => {
      selectCall++;
      if (selectCall === 1) {
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockReturnValue({ limit }) }),
          }),
        };
      }
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
      };
    }),
  };
  return { db: db as unknown as Db, eventsLimit: limit };
}

function makeCalendarService(db: Db): CalendarService {
  return new CalendarService(
    db,
    {} as never,
    {} as never,
    {} as never,
    new CalendarRecurrenceService(db),
    new CalendarExportService(db),
    {} as never,
  );
}

function actor(): CurrentUserContext {
  return {
    userId: USER,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-export",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function mockResponse() {
  const headers: Record<string, string> = {};
  const sent: string[] = [];
  const res = {
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    send: jest.fn((body: string) => {
      sent.push(body);
    }),
  };
  return { res: res as unknown as Response, headers, sent };
}

function scopedRequest(): Request {
  return { rbacScope: "all" } as unknown as Request;
}

beforeEach(() => jest.resetAllMocks());

describe("CalendarExportService — the row cap is reported, never hidden", () => {
  it("probes one row past the cap and reports truncation when the range holds more events", async () => {
    const rows = Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => makeRow(i + 1));
    const { db, eventsLimit } = makeDb(rows);
    const svc = new CalendarExportService(db);

    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), WINDOW_START, WINDOW_END);

    expect(eventsLimit).toHaveBeenCalledWith(EXPORT_ROW_CAP + 1);
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(EXPORT_ROW_CAP);
    expect(result.rowCount).toBe(EXPORT_ROW_CAP);
  });

  it("reports no truncation when every matching event fits inside the cap", async () => {
    const rows = [makeRow(1), makeRow(2), makeRow(3)];
    const { db } = makeDb(rows);
    const svc = new CalendarExportService(db);

    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), WINDOW_START, WINDOW_END);

    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(3);
    expect(result.events).toHaveLength(3);
  });

  it("reports truncation when recurrence expansion — not the row count — overflows the cap", async () => {
    const rows = [makeRow(1, "FREQ=DAILY"), makeRow(2, "FREQ=DAILY")];
    const { db } = makeDb(rows);
    const svc = new CalendarExportService(db);

    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), WINDOW_START, WINDOW_END);

    expect(result.events.length).toBeGreaterThan(rows.length);
    expect(result.events).toHaveLength(EXPORT_ROW_CAP);
    expect(result.truncated).toBe(true);
  });

  it("reports truncation when one dense series alone fills the cap and nothing follows it", async () => {
    const { db } = makeDb([makeRow(1, "FREQ=HOURLY")]);
    const svc = new CalendarExportService(db);

    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "all"), WINDOW_START, WINDOW_END);

    expect(result.events).toHaveLength(EXPORT_ROW_CAP);
    expect(result.truncated).toBe(true);
  });

  it("a denied scope reports an empty, untruncated export rather than a capped one", async () => {
    const { db } = makeDb([]);
    const svc = new CalendarExportService(db);

    const result = await svc.exportEvents(ScopedRead.of(ORG, USER, "none"), WINDOW_START, WINDOW_END);

    expect(result.events).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(0);
  });
});

describe("CalendarController.exportEvents — truncation reaches the browser", () => {
  function buildController(rows: ExportRow[]): CalendarController {
    const { db } = makeDb(rows);
    return new CalendarController(
      makeCalendarService(db),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  const query = { from: WINDOW_START.toISOString(), to: WINDOW_END.toISOString() };

  it("marks a capped file truncated, publishes its row count and exposes both headers cross-origin", async () => {
    const controller = buildController(Array.from({ length: EXPORT_ROW_CAP + 1 }, (_, i) => makeRow(i + 1)));
    const { res, headers, sent } = mockResponse();

    await controller.exportEvents(query, actor(), scopedRequest(), res);

    expect(headers["X-Export-Truncated"]).toBe("true");
    expect(headers["X-Export-Row-Count"]).toBe(String(EXPORT_ROW_CAP));
    expect(headers["Access-Control-Expose-Headers"]).toContain("X-Export-Truncated");
    expect(headers["Access-Control-Expose-Headers"]).toContain("X-Export-Row-Count");
    expect(sent[0]?.split("\r\n")).toHaveLength(EXPORT_ROW_CAP + 1);
  });

  it("keeps the existing download headers intact", async () => {
    const controller = buildController([makeRow(1)]);
    const { res, headers } = mockResponse();

    await controller.exportEvents(query, actor(), scopedRequest(), res);

    expect(headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(headers["Content-Disposition"]).toContain("attachment; filename=");
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("does not mark a complete file truncated", async () => {
    const controller = buildController([makeRow(1), makeRow(2)]);
    const { res, headers } = mockResponse();

    await controller.exportEvents(query, actor(), scopedRequest(), res);

    expect(headers["X-Export-Truncated"]).toBeUndefined();
    expect(headers["X-Export-Row-Count"]).toBe("2");
  });
});
