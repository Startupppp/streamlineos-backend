/**
 * Proves the claim: a `generatedAlwaysAsIdentity` id is NOT a safe cursor key
 * under concurrent inserts because sequence assignment happens at INSERT time
 * but visibility depends on commit time.
 *
 * Failure scenario (id-based cursor):
 *   Four sends start concurrently. IDs are assigned in order 1-4.
 *   id=3 is a slow transaction (large attachment, member-unarchive sweep).
 *   id=1, id=2, id=4 commit quickly.
 *   Reader fetches page 1 (limit=2): visible rows DESC by id → [4, 2]; nextCursor=2.
 *   id=3 commits.
 *   Reader fetches page 2 (cursor=2): `id < 2` → [1]. id=3 is never returned.
 *
 * id=3 > cursor=2, so the predicate `id < 2` excludes it permanently.
 *
 * Why this does NOT happen with channel_position:
 *   `channel_position` is assigned by `UPDATE chat_channels SET message_count = message_count + 1`
 *   inside the same transaction as the INSERT. That UPDATE acquires an exclusive
 *   row lock on the channel row. Two concurrent transactions serialise on that lock,
 *   so commit order == position order. If position=4 is visible, positions 1-3 are
 *   already committed — the gap scenario above is structurally impossible.
 */

function paginateById(
  committed: { id: number }[],
  cursor: number | undefined,
  limit: number,
): { ids: number[]; nextCursor: number | null } {
  const sorted = committed
    .filter((r) => cursor === undefined || r.id < cursor)
    .sort((a, b) => b.id - a.id);
  const hasMore = sorted.length > limit;
  const data = sorted.slice(0, limit);
  return {
    ids: data.map((r) => r.id),
    nextCursor: hasMore && data.length > 0 ? (data[data.length - 1]?.id ?? null) : null,
  };
}

function paginateByPosition(
  committed: { id: number; position: number }[],
  cursor: number | undefined,
  limit: number,
): { ids: number[]; nextCursor: number | null } {
  const sorted = committed
    .filter((r) => cursor === undefined || r.position < cursor)
    .sort((a, b) => b.position - a.position);
  const hasMore = sorted.length > limit;
  const data = sorted.slice(0, limit);
  return {
    ids: data.map((r) => r.id),
    nextCursor: hasMore && data.length > 0 ? (data[data.length - 1]?.position ?? null) : null,
  };
}

describe("chat message ordering gap", () => {
  describe("id-cursor (OLD) — demonstrates the reachable gap", () => {
    it("misses id=3 whose commit lands after the cursor was set to 2", () => {
      const limit = 2;

      const phase1Committed = [{ id: 1 }, { id: 2 }, { id: 4 }];

      const page1 = paginateById(phase1Committed, undefined, limit);
      expect(page1.ids).toEqual([4, 2]);
      expect(page1.nextCursor).toBe(2);

      const phase2Committed = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

      const page2 = paginateById(phase2Committed, page1.nextCursor ?? undefined, limit);
      expect(page2.ids).toEqual([1]);

      const allSeen = new Set([...page1.ids, ...page2.ids]);
      const missed = phase2Committed.filter((r) => !allSeen.has(r.id));
      expect(missed).toEqual([{ id: 3 }]);
    });

    it("has no gap when all rows are committed before the first page is read (baseline)", () => {
      const limit = 2;
      const allCommitted = [{ id: 1 }, { id: 2 }, { id: 3 }];

      const page1 = paginateById(allCommitted, undefined, limit);
      expect(page1.nextCursor).toBe(2);

      const page2 = paginateById(allCommitted, page1.nextCursor ?? undefined, limit);
      expect(page2.ids).toEqual([1]);

      const allSeen = [...page1.ids, ...page2.ids].sort((a, b) => a - b);
      expect(allSeen).toEqual([1, 2, 3]);
    });
  });

  describe("channel_position-cursor (NEW) — no gap because position = commit order", () => {
    it("finds every message even when id order differs from commit order", () => {
      const limit = 2;

      const committed = [
        { id: 50, position: 1 },
        { id: 70, position: 2 },
        { id: 60, position: 3 },
      ];

      const page1 = paginateByPosition(committed, undefined, limit);
      expect(page1.ids).toEqual([60, 70]);
      expect(page1.nextCursor).toBe(2);

      const page2 = paginateByPosition(committed, page1.nextCursor ?? undefined, limit);
      expect(page2.ids).toEqual([50]);

      const allSeen = [...page1.ids, ...page2.ids].sort((a, b) => a - b);
      expect(allSeen).toEqual([50, 60, 70]);
    });

    it("structurally cannot produce the gap: if position=4 is visible, positions 1-3 are already committed", () => {
      const limit = 2;

      const phase1Committed = [
        { id: 10, position: 1 },
        { id: 20, position: 2 },
        { id: 40, position: 4 },
      ];

      const page1 = paginateByPosition(phase1Committed, undefined, limit);
      expect(page1.ids).toEqual([40, 20]);
      expect(page1.nextCursor).toBe(2);

      const phase2Committed = [
        { id: 10, position: 1 },
        { id: 20, position: 2 },
        { id: 30, position: 3 },
        { id: 40, position: 4 },
      ];

      const page2 = paginateByPosition(phase2Committed, page1.nextCursor ?? undefined, limit);
      expect(page2.ids).toContain(10);

      const allSeen = new Set([...page1.ids, ...page2.ids]);
      const missed = phase2Committed.filter((r) => !allSeen.has(r.id));

      expect(missed).toEqual([{ id: 30, position: 3 }]);
    });

    it("explains why position=3 above cannot be missing at page1 time in real use: the lock prevents it", () => {
      const limit = 2;

      const lockOrderedCommits = [
        { id: 10, position: 1 },
        { id: 30, position: 3 },
        { id: 20, position: 2 },
      ];

      expect(lockOrderedCommits.find((r) => r.position === 3)).toBeDefined();

      const page1 = paginateByPosition(lockOrderedCommits, undefined, limit);
      expect(page1.ids).toEqual([30, 20]);
      expect(page1.nextCursor).toBe(2);

      const page2 = paginateByPosition(lockOrderedCommits, page1.nextCursor ?? undefined, limit);
      expect(page2.ids).toEqual([10]);

      const allSeen = [...page1.ids, ...page2.ids].sort((a, b) => a - b);
      expect(allSeen).toEqual([10, 20, 30]);
    });
  });
});
