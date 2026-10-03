jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { ConflictException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CalendarService } from "./calendar.service";
import { updateEventSchema } from "./dto/calendar.schemas";
import type { Db } from "../../db/drizzle.module";
import type { CalendarEventsAggregateService } from "./calendar-events-aggregate.service";
import type { CalendarConflictService } from "./calendar-conflict.service";
import type { CalendarAttendeesService } from "./calendar-attendees.service";
import type { CalendarRecurrenceService } from "./calendar-recurrence.service";
import type { CalendarExportService } from "./calendar-export.service";
import type { CalendarEventDetailService } from "./calendar-event-detail.service";

const ORG = "org-1";
const USER = "user-1";
const EVENT_ID = 42;

interface Harness {
  service: CalendarService;
  wheres: string[];
}

function buildHarness(options: {
  updatedRows: Array<Record<string, unknown>>;
  currentVersion: number | null;
}): Harness {
  const dialect = new PgDialect();
  const wheres: string[] = [];

  const tx = {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      calendarEvents: {
        findFirst: jest.fn().mockResolvedValue(
          options.currentVersion === null ? undefined : { localVersion: options.currentVersion },
        ),
      },
      businessParties: { findMany: jest.fn().mockResolvedValue([]) },
    },
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn((predicate: SQL) => {
          wheres.push(dialect.sqlToQuery(predicate).sql);
          return { returning: jest.fn().mockResolvedValue(options.updatedRows) };
        }),
      })),
    })),
    insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue([]) })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })),
    })),
    execute: jest.fn().mockResolvedValue([]),
  };

  const db = {
    transaction: jest.fn((run: (t: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as Db;

  const stub = <T,>() => ({}) as T;

  const service = new CalendarService(
    db,
    stub<CalendarEventsAggregateService>(),
    stub<CalendarConflictService>(),
    stub<CalendarAttendeesService>(),
    stub<CalendarRecurrenceService>(),
    stub<CalendarExportService>(),
    stub<CalendarEventDetailService>(),
  );

  return { service, wheres };
}

describe("calendar edit conflicts — expectedVersion makes a concurrent edit visible", () => {
  it("accepts the field on the edit contract", () => {
    expect(updateEventSchema.safeParse({ location: "Room 2", expectedVersion: 3 }).success).toBe(true);
  });

  it("rejects a negative or fractional version rather than coercing it", () => {
    expect(updateEventSchema.safeParse({ expectedVersion: -1 }).success).toBe(false);
    expect(updateEventSchema.safeParse({ expectedVersion: 1.5 }).success).toBe(false);
  });

  it("stays optional, so an existing client that sends no version still edits", () => {
    expect(updateEventSchema.safeParse({ location: "Room 2" }).success).toBe(true);
  });

  it("BITE: binds local_version into the UPDATE predicate when a version is supplied", async () => {
    const h = buildHarness({ updatedRows: [{ id: EVENT_ID, localVersion: 4 }], currentVersion: 3 });

    await h.service.updateEvent(ORG, USER, EVENT_ID, { location: "Room 2", expectedVersion: 3 });

    expect(h.wheres).toHaveLength(1);
    expect(h.wheres[0]).toContain('"local_version" = $');
  });

  it("BITE: omits the version predicate entirely when the caller sends none", async () => {
    const h = buildHarness({ updatedRows: [{ id: EVENT_ID, localVersion: 4 }], currentVersion: 3 });

    await h.service.updateEvent(ORG, USER, EVENT_ID, { location: "Room 2" });

    expect(h.wheres[0]).not.toContain('"local_version" = $');
  });

  it("BITE: a stale version raises 409 rather than silently overwriting the other edit", async () => {
    const h = buildHarness({ updatedRows: [], currentVersion: 9 });

    await expect(
      h.service.updateEvent(ORG, USER, EVENT_ID, { location: "Room 2", expectedVersion: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("a missing or unauthorised event reports not-found, never a false conflict", async () => {
    const h = buildHarness({ updatedRows: [], currentVersion: null });

    await expect(
      h.service.updateEvent(ORG, USER, EVENT_ID, { location: "Room 2", expectedVersion: 3 }),
    ).resolves.toBeNull();
  });

  it("a version that still matches reports not-found for the other reason, not a conflict", async () => {
    const h = buildHarness({ updatedRows: [], currentVersion: 3 });

    await expect(
      h.service.updateEvent(ORG, USER, EVENT_ID, { location: "Room 2", expectedVersion: 3 }),
    ).resolves.toBeNull();
  });
});
