import {
  buildTimelinePage,
  decodeTimelineCursor,
  describeEntry,
  encodeTimelineCursor,
  groupByDay,
  isAutonomous,
  isOverdue,
  type TimelineEntry,
} from "./activity-timeline";

function entry(overrides: Partial<TimelineEntry> & Pick<TimelineEntry, "activityId" | "occurredAt">): TimelineEntry {
  return {
    kind: "note",
    subject: null,
    body: null,
    threadId: null,
    actorKind: "human",
    actorLabel: null,
    actorName: null,
    dueAt: null,
    completedAt: null,
    source: "manual",
    ...overrides,
  };
}

describe("timeline cursors", () => {
  it("round-trips a position", () => {
    const position = { occurredAt: "2026-08-23T10:00:00.000Z", activityId: "act-1" };
    expect(decodeTimelineCursor(encodeTimelineCursor(position))).toEqual(position);
  });

  /**
   * The reason the cursor carries two columns.
   *
   * A mail import writes hundreds of rows in the same second; a cursor on the
   * timestamp alone skips or repeats rows at every page boundary.
   */
  it("distinguishes two activities that happened in the same instant", () => {
    const shared = "2026-08-23T10:00:00.000Z";
    const first = encodeTimelineCursor({ occurredAt: shared, activityId: "act-1" });
    const second = encodeTimelineCursor({ occurredAt: shared, activityId: "act-2" });

    expect(first).not.toBe(second);
    expect(decodeTimelineCursor(first)?.activityId).toBe("act-1");
    expect(decodeTimelineCursor(second)?.activityId).toBe("act-2");
  });

  it("survives an identifier containing the separator", () => {
    const position = { occurredAt: "2026-08-23T10:00:00.000Z", activityId: "act|with|pipes" };
    expect(decodeTimelineCursor(encodeTimelineCursor(position))).toEqual(position);
  });

  it.each([[null], [undefined], [""], ["not-base64!!"], ["Zm9vYmFy"], ["fGFjdC0x"]])(
    "falls back to the first page rather than throwing on %s",
    (cursor) => {
      expect(decodeTimelineCursor(cursor as string | null)).toBeUndefined();
    },
  );

  it("rejects a cursor whose timestamp is not a date", () => {
    const forged = Buffer.from("yesterday|act-1", "utf8").toString("base64url");
    expect(decodeTimelineCursor(forged)).toBeUndefined();
  });
});

describe("buildTimelinePage", () => {
  const rows = Array.from({ length: 4 }, (_, index) =>
    entry({
      activityId: `act-${index}`,
      occurredAt: new Date(`2026-08-2${index + 1}T10:00:00.000Z`),
    }),
  );

  it("trims the over-fetched row and reports there is more", () => {
    const page = buildTimelinePage(rows, 3);

    expect(page.data).toHaveLength(3);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
  });

  it("points the next cursor at the last row it actually returned", () => {
    const page = buildTimelinePage(rows, 3);
    expect(decodeTimelineCursor(page.pagination.nextCursor)?.activityId).toBe("act-2");
  });

  it("reports no more when the page is not full", () => {
    const page = buildTimelinePage(rows.slice(0, 2), 3);

    expect(page.data).toHaveLength(2);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("handles an empty timeline without inventing a cursor", () => {
    const page = buildTimelinePage([], 20);

    expect(page.data).toEqual([]);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");

  it("is true for an incomplete task past its due date", () => {
    expect(
      isOverdue({ kind: "task", dueAt: new Date("2026-08-22T00:00:00.000Z"), completedAt: null }, now),
    ).toBe(true);
  });

  it("is false once the task is completed, however late", () => {
    expect(
      isOverdue(
        {
          kind: "task",
          dueAt: new Date("2026-08-22T00:00:00.000Z"),
          completedAt: new Date("2026-08-23T11:00:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
  });

  it("is false for a task with no due date", () => {
    expect(isOverdue({ kind: "task", dueAt: null, completedAt: null }, now)).toBe(false);
  });

  it("is false for anything that is not a task, whatever its dates", () => {
    expect(
      isOverdue({ kind: "email", dueAt: new Date("2020-01-01T00:00:00.000Z"), completedAt: null }, now),
    ).toBe(false);
  });
});

describe("isAutonomous", () => {
  it("separates what the system did from what a person did", () => {
    expect(isAutonomous({ actorKind: "system" })).toBe(true);
    expect(isAutonomous({ actorKind: "human" })).toBe(false);
  });
});

describe("describeEntry", () => {
  it("prefers the subject the activity actually carries", () => {
    expect(
      describeEntry(entry({ activityId: "a", occurredAt: new Date(), kind: "email", subject: "Quote for Q3" })),
    ).toBe("Quote for Q3");
  });

  it("falls back to the kind rather than rendering an empty line", () => {
    expect(describeEntry(entry({ activityId: "a", occurredAt: new Date(), kind: "call" }))).toBe("Call");
    expect(
      describeEntry(entry({ activityId: "a", occurredAt: new Date(), kind: "meeting", subject: "   " })),
    ).toBe("Meeting");
  });
});

describe("groupByDay", () => {
  it("groups consecutive entries under one heading", () => {
    const grouped = groupByDay([
      entry({ activityId: "a", occurredAt: new Date("2026-08-23T15:00:00.000Z") }),
      entry({ activityId: "b", occurredAt: new Date("2026-08-23T09:00:00.000Z") }),
      entry({ activityId: "c", occurredAt: new Date("2026-08-22T09:00:00.000Z") }),
    ]);

    expect(grouped.map((day) => day.day)).toEqual(["2026-08-23", "2026-08-22"]);
    expect(grouped[0]?.entries.map((e) => e.activityId)).toEqual(["a", "b"]);
  });

  it("preserves the order it was given inside a day", () => {
    const grouped = groupByDay([
      entry({ activityId: "late", occurredAt: new Date("2026-08-23T18:00:00.000Z") }),
      entry({ activityId: "early", occurredAt: new Date("2026-08-23T06:00:00.000Z") }),
    ]);

    expect(grouped[0]?.entries.map((e) => e.activityId)).toEqual(["late", "early"]);
  });

  it("returns nothing for an empty timeline", () => {
    expect(groupByDay([])).toEqual([]);
  });
});
