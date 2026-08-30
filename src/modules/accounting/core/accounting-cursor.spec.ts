import { buildCursorPage, decodeCursor, encodeCursor } from "../../../common/pagination/cursor";

interface Row {
  id: number;
  sortValue: string;
}

function makeRows(n: number, sortValue = "2024-01-01"): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, sortValue }));
}

describe("buildCursorPage — nextCursor is null, not undefined, at exhaustion", () => {
  it("returns null nextCursor when rows fit exactly in the limit", () => {
    const rows = makeRows(3);
    const page = buildCursorPage(rows, 3, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.pagination.hasMore).toBe(false);
    expect(page.data).toHaveLength(3);
  });

  it("returns null nextCursor when the result set is empty", () => {
    const page = buildCursorPage([], 20, (r: Row) => ({ sortValue: r.sortValue, id: String(r.id) }));
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.pagination.hasMore).toBe(false);
    expect(page.data).toHaveLength(0);
  });

  it("returns null nextCursor when rows are fewer than the limit", () => {
    const rows = makeRows(2);
    const page = buildCursorPage(rows, 5, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));
    expect(page.pagination.nextCursor).toBeNull();
    expect(page.pagination.hasMore).toBe(false);
  });

  it("nextCursor type is string | null, never undefined", () => {
    const pageExhausted = buildCursorPage(makeRows(1), 20, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));
    expect(pageExhausted.pagination.nextCursor === undefined).toBe(false);

    const pageHasMore = buildCursorPage(makeRows(3), 2, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));
    expect(pageHasMore.pagination.nextCursor === undefined).toBe(false);
    expect(typeof pageHasMore.pagination.nextCursor).toBe("string");
  });
});

describe("buildCursorPage — tie-breaker: nextCursor encodes the last KEPT row, not the sentinel", () => {
  it("encodes row at index limit-1, not the sentinel at index limit", () => {
    const rows = makeRows(3);
    const page = buildCursorPage(rows, 2, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));

    expect(page.pagination.hasMore).toBe(true);
    expect(page.data).toHaveLength(2);

    const cursor = page.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    const pos = decodeCursor(cursor!);
    expect(pos).not.toBeNull();
    expect(pos!.id).toBe("2");
    expect(pos!.sortValue).toBe("2024-01-01");
  });

  it("sentinel row (id=3) is excluded from the returned data and not encoded in the cursor", () => {
    const rows = makeRows(3);
    const page = buildCursorPage(rows, 2, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));

    const sentinelIdInData = page.data.some((r) => r.id === 3);
    expect(sentinelIdInData).toBe(false);

    const pos = decodeCursor(page.pagination.nextCursor!);
    expect(pos!.id).not.toBe("3");
  });

  it("pointing cursor at the sentinel would permanently skip it — prove the kept-row cursor avoids this", () => {
    const rows = makeRows(4);
    const sentinelRow = rows[2];

    const wrongCursor = encodeCursor({ sortValue: sentinelRow.sortValue, id: String(sentinelRow.id) });
    const pos = decodeCursor(wrongCursor)!;
    expect(pos.id).toBe("3");

    const correctPage = buildCursorPage(rows, 2, (r) => ({ sortValue: r.sortValue, id: String(r.id) }));
    const correctPos = decodeCursor(correctPage.pagination.nextCursor!)!;
    expect(correctPos.id).toBe("2");
    expect(correctPos.id).not.toBe("3");
  });
});

describe("decodeCursor — malformed cursor degrades to first page", () => {
  it("returns null for undefined", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for arbitrary junk", () => {
    expect(decodeCursor("not-a-real-cursor")).toBeNull();
  });

  it("round-trips a valid position", () => {
    const cursor = encodeCursor({ sortValue: "2024-06-15", id: "42" });
    const pos = decodeCursor(cursor);
    expect(pos).not.toBeNull();
    expect(pos!.sortValue).toBe("2024-06-15");
    expect(pos!.id).toBe("42");
  });
});
