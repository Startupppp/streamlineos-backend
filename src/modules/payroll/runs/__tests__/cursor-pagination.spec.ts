import { buildCursorPage, buildIdCursorPage } from "../../../../common/pagination/cursor";

describe("cursor pagination — nextCursor null contract", () => {
  it("buildCursorPage sets nextCursor to explicit null when all rows fit on one page", () => {
    const rows = [
      { id: 3, month: "2024-03" },
      { id: 2, month: "2024-02" },
    ];
    const page = buildCursorPage(rows, 20, (r) => ({ sortValue: r.month, id: String(r.id) }));
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBe(null);
    expect(page.pagination.nextCursor).not.toBeUndefined();
  });

  it("buildCursorPage sets nextCursor to a non-null string when more rows exist", () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: 21 - i,
      month: `2024-${String(21 - i).padStart(2, "0")}`,
    }));
    const page = buildCursorPage(rows, 20, (r) => ({ sortValue: r.month, id: String(r.id) }));
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).not.toBeNull();
    expect(typeof page.pagination.nextCursor).toBe("string");
    expect(page.data).toHaveLength(20);
  });

  it("buildCursorPage data length equals limit when hasMore is true", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, month: "2024-01" }));
    const page = buildCursorPage(rows, 10, (r) => ({ sortValue: r.month, id: String(r.id) }));
    expect(page.data).toHaveLength(10);
    expect(page.pagination.hasMore).toBe(true);
  });

  it("buildIdCursorPage sets nextCursor to explicit null when exhausted", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const page = buildIdCursorPage(rows, 20, (r) => r.id);
    expect(page.nextCursor).toBe(null);
    expect(page.nextCursor).not.toBeUndefined();
  });

  it("buildIdCursorPage sets nextCursor to last row id when more rows exist", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: i + 1 }));
    const page = buildIdCursorPage(rows, 10, (r) => r.id);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(10);
    expect(page.nextCursor).not.toBeUndefined();
  });
});
