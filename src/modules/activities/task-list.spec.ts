import {
  buildTaskPage,
  numericDealIds,
  decodeTaskCursor,
  encodeTaskCursor,
  taskAnchor,
  type TaskPosition,
  type TaskRow,
} from "./task-list";

function row(overrides: Partial<TaskRow> & Pick<TaskRow, "activityId">): TaskRow {
  return {
    kind: "task",
    occurredAt: new Date("2026-08-20T09:00:00.000Z"),
    subject: null,
    body: null,
    threadId: null,
    actorKind: "human",
    actorLabel: null,
    actorName: null,
    dueAt: null,
    completedAt: null,
    source: "manual",
    partyId: null,
    dealId: null,
    subjectId: null,
    partyName: null,
    dealName: null,
    subjectTitle: null,
    ...overrides,
  };
}

describe("task cursors", () => {
  it("round-trips a position", () => {
    const position: TaskPosition = { dueAt: "2026-08-23T10:00:00.000Z", activityId: "act-1" };
    expect(decodeTaskCursor(encodeTaskCursor(position))).toEqual(position);
  });

  /**
   * The case a timeline cursor cannot express.
   *
   * A task without a due date is a real task — it sorts last rather than being
   * excluded — so the cursor has to carry the absence of a date, not just a date.
   */
  it("round-trips a position with no due date", () => {
    const position: TaskPosition = { dueAt: null, activityId: "act-1" };
    expect(decodeTaskCursor(encodeTaskCursor(position))).toEqual(position);
  });

  it("distinguishes two tasks due in the same instant", () => {
    const shared = "2026-08-23T10:00:00.000Z";
    const first = encodeTaskCursor({ dueAt: shared, activityId: "act-1" });
    const second = encodeTaskCursor({ dueAt: shared, activityId: "act-2" });

    expect(first).not.toBe(second);
    expect(decodeTaskCursor(first)?.activityId).toBe("act-1");
    expect(decodeTaskCursor(second)?.activityId).toBe("act-2");
  });

  it("survives an identifier containing the separator", () => {
    const position: TaskPosition = { dueAt: null, activityId: "act|with|pipes" };
    expect(decodeTaskCursor(encodeTaskCursor(position))).toEqual(position);
  });

  it.each([[null], [undefined], [""], ["not-base64!!"], ["Zm9vYmFy"]])(
    "falls back to the first page rather than throwing on %s",
    (cursor) => {
      expect(decodeTaskCursor(cursor as string | null)).toBeUndefined();
    },
  );

  it("rejects a cursor claiming a due date that is not a date", () => {
    const forged = Buffer.from("0|yesterday|act-1", "utf8").toString("base64url");
    expect(decodeTaskCursor(forged)).toBeUndefined();
  });

  it("rejects a cursor that claims no due date and carries one anyway", () => {
    const forged = Buffer.from("1|2026-08-23T10:00:00.000Z|act-1", "utf8").toString("base64url");
    expect(decodeTaskCursor(forged)).toBeUndefined();
  });

  it("rejects a cursor with no identifier", () => {
    const forged = Buffer.from("1||", "utf8").toString("base64url");
    expect(decodeTaskCursor(forged)).toBeUndefined();
  });
});

describe("buildTaskPage", () => {
  const due = (iso: string | null, id: string): TaskRow =>
    row({ activityId: id, dueAt: iso ? new Date(iso) : null });

  it("trims the over-fetched row and reports there is more", () => {
    const page = buildTaskPage(
      [due("2026-08-21T09:00:00.000Z", "a"), due("2026-08-22T09:00:00.000Z", "b"), due("2026-08-23T09:00:00.000Z", "c")],
      2,
    );

    expect(page.data.map((entry) => entry.activityId)).toEqual(["a", "b"]);
    expect(page.pagination.hasMore).toBe(true);
  });

  /** The cursor is a position in the order the list is actually read in. */
  it("points the next cursor at the last row's due date, not at when it happened", () => {
    const page = buildTaskPage(
      [due("2026-08-21T09:00:00.000Z", "a"), due("2026-08-22T09:00:00.000Z", "b")],
      1,
    );

    expect(decodeTaskCursor(page.pagination.nextCursor)).toEqual({
      dueAt: "2026-08-21T09:00:00.000Z",
      activityId: "a",
    });
  });

  it("carries a null due date into the next cursor", () => {
    const page = buildTaskPage([due(null, "a"), due(null, "b")], 1);

    expect(decodeTaskCursor(page.pagination.nextCursor)).toEqual({ dueAt: null, activityId: "a" });
  });

  it("reports no more when the page is not full", () => {
    const page = buildTaskPage([due("2026-08-21T09:00:00.000Z", "a")], 25);

    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("handles an empty list without inventing a cursor", () => {
    const page = buildTaskPage([], 25);

    expect(page.data).toEqual([]);
    expect(page.pagination).toEqual({ limit: 25, hasMore: false, nextCursor: null });
  });
});

describe("taskAnchor", () => {
  /**
   * The reason the list carries one at all.
   *
   * "Follow up" with no customer beside it is not actionable — a personal task
   * list without its subject is a list of verbs.
   */
  it("names the party a task belongs to", () => {
    expect(taskAnchor(row({ activityId: "a", partyId: "p1", partyName: "Northwind" }))).toEqual({
      kind: "party",
      id: "p1",
      name: "Northwind",
    });
  });

  it("names the deal a task belongs to", () => {
    expect(taskAnchor(row({ activityId: "a", dealId: "d1", dealName: "Q3 renewal" }))).toEqual({
      kind: "deal",
      id: "d1",
      name: "Q3 renewal",
    });
  });

  it("names the subject a task belongs to, from its title", () => {
    expect(taskAnchor(row({ activityId: "a", subjectId: "s1", subjectTitle: "Flat 3B" }))).toEqual({
      kind: "subject",
      id: "s1",
      name: "Flat 3B",
    });
  });

  /** A deleted anchor leaves the id without a name; the row still has to render. */
  it("keeps the anchor when the join found no name", () => {
    expect(taskAnchor(row({ activityId: "a", partyId: "p1" }))).toEqual({
      kind: "party",
      id: "p1",
      name: null,
    });
  });

  it("returns nothing when the row is anchored to nothing", () => {
    expect(taskAnchor(row({ activityId: "a" }))).toBeNull();
  });

  it("puts every entry's anchor on the page it builds", () => {
    const page = buildTaskPage([row({ activityId: "a", dealId: "d1", dealName: "Q3 renewal" })], 25);

    expect(page.data[0]?.anchor).toEqual({ kind: "deal", id: "d1", name: "Q3 renewal" });
  });
});

describe("numericDealIds", () => {
  it("takes the ids that are deal ids", () => {
    expect(numericDealIds(["1", "42", "1000000"])).toEqual([1, 42, 1000000]);
  });

  it("asks for each one once", () => {
    expect(numericDealIds(["7", "7", "7"])).toEqual([7]);
  });

  /**
   * `dealId` on the create schema is a free string, so a caller who may log an
   * activity can anchor one to `'abc'`. Coerced in SQL that is a 22P02 and a 500
   * on every subsequent read of that person's task list.
   */
  it.each([["abc"], ["12x"], ["1.5"], ["-3"], ["0"], [""], ["  "], [null]])(
    "leaves out %s rather than letting the database try to parse it",
    (id) => {
      expect(numericDealIds([id])).toEqual([]);
    },
  );

  it("leaves out a number too large to be a serial", () => {
    expect(numericDealIds(["2147483647", "2147483648", "9999999999"])).toEqual([2147483647]);
  });

  it("returns nothing for a page with no deal anchors", () => {
    expect(numericDealIds([null, null])).toEqual([]);
  });
});
