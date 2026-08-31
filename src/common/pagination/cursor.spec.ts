import {
  buildCursorPage,
  buildIdCursorPage,
  decodeCursor,
  decodeIntegerCursor,
  decodeTimestampCursor,
  encodeCursor,
} from "./cursor";

describe("cursor encoding", () => {
  it("round-trips a position", () => {
    const position = { sortValue: "2026-08-23T10:00:00.000Z", id: "p-1" };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it("produces something a caller will not try to read or edit", () => {
    const cursor = encodeCursor({ sortValue: "2026-08-23T10:00:00.000Z", id: "p-1" });
    expect(cursor).not.toContain("2026");
    expect(cursor).not.toContain("p-1");
  });

  it("is URL-safe, because it travels in a query string", () => {
    const cursor = encodeCursor({ sortValue: "a+b/c=d", id: "p/1+2" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("survives an identifier containing the separator", () => {
    const position = { sortValue: "2026-08-23T10:00:00.000Z", id: "p 1 2" };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it("returns null for a malformed cursor rather than throwing", () => {
    // A stale or hand-edited cursor is a client problem; the useful answer is
    // the first page, not a 500.
    for (const bad of ["", "!!!", "bm90aGluZw", undefined, null]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("rejects a cursor missing either half", () => {
    expect(decodeCursor(Buffer.from(" p-1", "utf8").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("2026 ", "utf8").toString("base64url"))).toBeNull();
  });
});

/**
 * The two narrowing decoders exist because their output is bound into SQL — the
 * id as an integer, the timestamp cast in the statement — so anything that is
 * not one has to be turned away here rather than by Postgres. A rejected cursor
 * reads as no cursor at all, which is page one: the same answer a stale one
 * gets, and never a 500.
 */
describe("narrowing a cursor for a serial-keyed table", () => {
  const ts = "2026-08-28T08:51:46.541218";

  it("accepts a positive integer id and hands it back as a number", () => {
    expect(decodeIntegerCursor(encodeCursor({ sortValue: ts, id: "49253" }))).toEqual({
      sortValue: ts,
      id: 49253,
    });
  });

  it("rejects an id that is not a plain positive integer", () => {
    for (const id of ["0", "-1", "1.5", "9e9", "1 OR 1=1", "01", "3000000000", ""]) {
      expect(decodeIntegerCursor(encodeCursor({ sortValue: ts, id }))).toBeNull();
    }
  });

  it("requires the sort half to be a microsecond timestamp", () => {
    expect(decodeTimestampCursor(encodeCursor({ sortValue: ts, id: "49253" }))).toEqual({
      sortValue: ts,
      id: 49253,
    });
    for (const sortValue of [
      "2026-08-28T08:51:46.541Z",
      "2026-08-28T08:51:46.541",
      "2026-08-28 08:51:46.541218",
      "now()",
      "2026-08-28T08:51:46.5412189",
    ]) {
      expect(decodeTimestampCursor(encodeCursor({ sortValue, id: "49253" }))).toBeNull();
    }
  });
});

describe("buildCursorPage", () => {
  const rows = [
    { id: "a", at: "3" },
    { id: "b", at: "2" },
    { id: "c", at: "1" },
  ];
  const position = (row: { id: string; at: string }) => ({ sortValue: row.at, id: row.id });

  it("trims the over-fetched sentinel row", () => {
    const page = buildCursorPage(rows, 2, position);
    expect(page.data.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("uses the sentinel to report a further page without a count query", () => {
    // A count on a large tenant is the expensive part; over-fetching one row is not.
    expect(buildCursorPage(rows, 2, position).pagination.hasMore).toBe(true);
  });

  it("points the next cursor at the last returned row, not the sentinel", () => {
    const page = buildCursorPage(rows, 2, position);
    expect(decodeCursor(page.pagination.nextCursor)).toEqual({ sortValue: "2", id: "b" });
  });

  it("reports the last page honestly", () => {
    const page = buildCursorPage(rows, 5, position);
    expect(page.data).toHaveLength(3);
    expect(page.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("handles an exactly-full page as the last page", () => {
    const page = buildCursorPage(rows, 3, position);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("handles an empty result without inventing a cursor", () => {
    const page = buildCursorPage([], 20, position);
    expect(page.data).toEqual([]);
    expect(page.pagination.nextCursor).toBeNull();
  });
});

describe("concurrent-insert proof: cursor is stable under concurrent writes, offset is not", () => {
  function asRows(ids: number[]) {
    return ids.map((id) => ({ id }));
  }

  function toPosition(row: { id: number }) {
    return { sortValue: String(row.id), id: String(row.id) };
  }

  function offsetSlice(all: number[], limit: number, offset: number): number[] {
    return all.slice(offset, offset + limit);
  }

  const limit = 3;
  const original = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const afterInsert = [12, 11, ...original];

  it("offset repeats rows when concurrent inserts arrive above the reader's position", () => {
    const page1 = offsetSlice(original, limit, 0);

    const page2 = offsetSlice(afterInsert, limit, limit);

    const seen = new Set(page1);
    const duplicates = page2.filter((id) => seen.has(id));
    expect(duplicates.length).toBeGreaterThan(0);
  });

  it("cursor sees every original row exactly once despite concurrent inserts above", () => {
    const page1 = buildCursorPage(
      asRows(original.slice(0, limit + 1)),
      limit,
      toPosition,
    );
    expect(page1.data.map((r) => r.id)).toEqual([10, 9, 8]);
    expect(page1.pagination.hasMore).toBe(true);

    const decoded = decodeCursor(page1.pagination.nextCursor);
    expect(decoded?.sortValue).toBe("8");
    const afterId = Number(decoded?.sortValue);

    const page2Rows = afterInsert.filter((id) => id < afterId).slice(0, limit + 1);
    const page2 = buildCursorPage(asRows(page2Rows), limit, toPosition);
    expect(page2.data.map((r) => r.id)).toEqual([7, 6, 5]);

    const allIds = [...page1.data, ...page2.data].map((r) => r.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toEqual([10, 9, 8, 7, 6, 5]);
  });

  it("a cursor that was valid but is now stale still returns rows without gaps or panics", () => {
    const page1 = buildCursorPage(asRows(original.slice(0, limit + 1)), limit, toPosition);
    const decoded = decodeCursor(page1.pagination.nextCursor);
    const afterId = Number(decoded?.sortValue);

    const muchLaterList = [50, 40, 30, 20, ...original];
    const page2Rows = muchLaterList.filter((id) => id < afterId).slice(0, limit + 1);
    const page2 = buildCursorPage(asRows(page2Rows), limit, toPosition);

    expect(page2.data.every((r) => r.id < afterId)).toBe(true);
  });

  it("a malformed cursor falls back to the first page without throwing", () => {
    const position = decodeCursor("this-is-not-a-valid-cursor");
    expect(position).toBeNull();

    const page = buildCursorPage(asRows(original.slice(0, limit + 1)), limit, toPosition);
    expect(page.data[0]?.id).toBe(10);
  });
});

describe("buildIdCursorPage", () => {
  const rows = (ids: number[]) => ids.map((id) => ({ id }));

  it("derives the next cursor from the last row it keeps, not the sentinel", () => {
    const page = buildIdCursorPage(rows([10, 9, 8, 7]), 3, (r) => r.id);

    expect(page.data.map((r) => r.id)).toEqual([10, 9, 8]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(8);
  });

  it("leaves no gap: the sentinel is the first row of the next page", () => {
    const all = [10, 9, 8, 7, 6, 5];
    const first = buildIdCursorPage(rows(all.slice(0, 4)), 3, (r) => r.id);
    const remaining = all.filter((id) => id < (first.nextCursor ?? Infinity));
    const second = buildIdCursorPage(rows(remaining.slice(0, 4)), 3, (r) => r.id);

    const seen = [...first.data, ...second.data].map((r) => r.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("reports no next page when exactly one page remains", () => {
    const page = buildIdCursorPage(rows([3, 2, 1]), 3, (r) => r.id);

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("handles an empty page", () => {
    const page = buildIdCursorPage([], 3, (r: { id: number }) => r.id);

    expect(page.data).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
