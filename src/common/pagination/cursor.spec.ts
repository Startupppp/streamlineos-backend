import { buildCursorPage, decodeCursor, encodeCursor } from "./cursor";

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
