describe("Notifications pagination — id-cursor boundary", () => {
  const pageSize = 3;

  function buildNotifications(count: number, sharedTimestamp: string) {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      createdAt: new Date(sharedTimestamp),
      title: `Notification ${i + 1}`,
    }));
  }

  function idCursorPage(
    rows: Array<{ id: number; createdAt: Date; title: string }>,
    cursor: number | null,
    limit: number,
  ) {
    const filtered = cursor !== null ? rows.filter((r) => r.id < cursor) : rows;
    const sorted = [...filtered].sort((a, b) => b.id - a.id);
    return sorted.slice(0, limit);
  }

  it("returns all notifications exactly once across consecutive pages when timestamps are tied", () => {
    const allRows = buildNotifications(7, "2026-08-26T10:00:00Z");

    const page1 = idCursorPage(allRows, null, pageSize);
    const page1Cursor = page1[page1.length - 1]?.id ?? null;

    const page2 = idCursorPage(allRows, page1Cursor, pageSize);
    const page2Cursor = page2[page2.length - 1]?.id ?? null;

    const page3 = idCursorPage(allRows, page2Cursor, pageSize);

    const allFetched = [...page1, ...page2, ...page3];
    const ids = allFetched.map((n) => n.id);

    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);

    for (let i = 0; i < ids.length - 1; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i + 1]!);
    }
  });

  it("next page cursor is the minimum id on the current page", () => {
    const allRows = buildNotifications(10, "2026-08-26T10:00:00Z");
    const page1 = idCursorPage(allRows, null, pageSize);
    const minId = Math.min(...page1.map((r) => r.id));
    const lastId = page1[page1.length - 1]?.id;
    expect(lastId).toBe(minId);
  });

  it("an empty next page is returned when the cursor falls below all ids", () => {
    const allRows = buildNotifications(3, "2026-08-26T10:00:00Z");
    const page1 = idCursorPage(allRows, null, pageSize);
    const cursor = page1[page1.length - 1]?.id ?? null;
    const page2 = idCursorPage(allRows, cursor, pageSize);
    expect(page2).toHaveLength(0);
  });

  it("created_at ties do not cause duplicates when id ordering differs from created_at ordering", () => {
    const sharedTs = "2026-08-26T10:00:00Z";
    const rows = [
      { id: 10, createdAt: new Date(sharedTs), title: "A" },
      { id: 5, createdAt: new Date(sharedTs), title: "B" },
      { id: 8, createdAt: new Date(sharedTs), title: "C" },
      { id: 3, createdAt: new Date(sharedTs), title: "D" },
      { id: 1, createdAt: new Date(sharedTs), title: "E" },
    ];

    const page1 = idCursorPage(rows, null, 2);
    const cursorAfterPage1 = page1[page1.length - 1]?.id ?? null;
    const page2 = idCursorPage(rows, cursorAfterPage1, 2);
    const cursorAfterPage2 = page2[page2.length - 1]?.id ?? null;
    const page3 = idCursorPage(rows, cursorAfterPage2, 2);

    const ids = [...page1, ...page2, ...page3].map((r) => r.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});
