import * as fc from "fast-check";
import { buildTupleCursorPage } from "../../../../common/pagination/cursor";

interface Row {
  readonly id: number;
  readonly sortValue: string;
}

function tuple(row: Row): readonly [string, number] {
  return [row.sortValue, row.id];
}

function lessThan(a: readonly [string, number], b: readonly [string, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  return a[1] < b[1];
}

function sortDescending(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.sortValue !== b.sortValue) return a.sortValue < b.sortValue ? 1 : -1;
    return b.id - a.id;
  });
}

function fetchPage(
  table: Map<number, Row>,
  cursor: readonly [string, number] | null,
  limit: number,
): { data: Row[]; nextCursor: readonly [string, number] | null; hasMore: boolean } {
  const visible = [...table.values()].filter(
    (row) => cursor === null || lessThan(tuple(row), cursor),
  );
  const ordered = sortDescending(visible).slice(0, limit + 1);
  const page = buildTupleCursorPage(ordered, limit, (row) => [
    row.sortValue,
    String(row.id),
  ]);
  const last = page.data[page.data.length - 1];
  return {
    data: page.data,
    hasMore: page.pagination.hasMore,
    nextCursor:
      page.pagination.hasMore && last !== undefined
        ? [last.sortValue, last.id]
        : null,
  };
}

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 5000 }),
  sortValue: fc.string({ minLength: 1, maxLength: 4 }),
});

const rowSetArb = fc
  .uniqueArray(rowArb, { selector: (r) => r.id, minLength: 1, maxLength: 40 })
  .map((rows) => new Map(rows.map((r) => [r.id, r] as const)));

describe("KB collection keyset pagination — stability under concurrent mutation", () => {
  it("never returns the same id twice across a full walk when only inserts and deletes occur mid-walk", () => {
    fc.assert(
      fc.property(
        rowSetArb,
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant("insert" as const),
              id: fc.integer({ min: 5001, max: 9000 }),
              sortValue: fc.string({ minLength: 1, maxLength: 4 }),
            }),
            fc.record({
              kind: fc.constant("delete" as const),
              id: fc.integer({ min: 1, max: 9000 }),
            }),
          ),
          { maxLength: 8 },
        ),
        fc.integer({ min: 1, max: 5 }),
        (initial, mutations, limit) => {
          const table = new Map(initial);
          let cursor: readonly [string, number] | null = null;
          const seen: number[] = [];
          let mutationIndex = 0;
          for (let guard = 0; guard < 200; guard += 1) {
            const page = fetchPage(table, cursor, limit);
            for (const row of page.data) seen.push(row.id);
            if (mutationIndex < mutations.length) {
              const m = mutations[mutationIndex];
              mutationIndex += 1;
              if (m.kind === "insert" && !table.has(m.id)) {
                table.set(m.id, { id: m.id, sortValue: m.sortValue });
              } else if (m.kind === "delete") {
                table.delete(m.id);
              }
            }
            if (!page.hasMore) break;
            cursor = page.nextCursor;
          }

          expect(new Set(seen).size).toBe(seen.length);
        },
      ),
    );
  });

  it("returns every row present at read time exactly once, in strictly descending tuple order, with no mutation at all", () => {
    fc.assert(
      fc.property(rowSetArb, fc.integer({ min: 1, max: 7 }), (initial, limit) => {
        const table = new Map(initial);
        let cursor: readonly [string, number] | null = null;
        const seen: Row[] = [];
        for (let guard = 0; guard < 200; guard += 1) {
          const page = fetchPage(table, cursor, limit);
          seen.push(...page.data);
          if (!page.hasMore) break;
          cursor = page.nextCursor;
        }

        expect(seen.map((r) => r.id).sort((a, b) => a - b)).toEqual(
          [...initial.keys()].sort((a, b) => a - b),
        );
        for (let i = 1; i < seen.length; i += 1) {
          expect(lessThan(tuple(seen[i - 1]), tuple(seen[i]))).toBe(false);
        }
      }),
    );
  });

  it("makes a row inserted behind the walking cursor visible on a later page, and one inserted ahead of it invisible to this walk", () => {
    const table = new Map<number, Row>([
      [1, { id: 1, sortValue: "m" }],
      [2, { id: 2, sortValue: "k" }],
      [3, { id: 3, sortValue: "h" }],
    ]);

    const firstPage = fetchPage(table, null, 1);
    expect(firstPage.data.map((r) => r.id)).toEqual([1]);
    expect(firstPage.hasMore).toBe(true);

    table.set(4, { id: 4, sortValue: "z" });
    table.set(5, { id: 5, sortValue: "j" });

    const secondPage = fetchPage(table, firstPage.nextCursor, 3);
    const secondIds = secondPage.data.map((r) => r.id);
    expect(secondIds).not.toContain(4);
    expect(secondIds).toContain(5);
    expect(secondIds).not.toContain(1);
  });

  it("tolerates deleting an already-returned row mid-walk without corrupting the remaining pages", () => {
    const table = new Map<number, Row>([
      [1, { id: 1, sortValue: "d" }],
      [2, { id: 2, sortValue: "c" }],
      [3, { id: 3, sortValue: "b" }],
      [4, { id: 4, sortValue: "a" }],
    ]);

    const firstPage = fetchPage(table, null, 1);
    expect(firstPage.data.map((r) => r.id)).toEqual([1]);

    table.delete(1);

    const secondPage = fetchPage(table, firstPage.nextCursor, 1);
    expect(secondPage.data.map((r) => r.id)).toEqual([2]);

    const thirdPage = fetchPage(table, secondPage.nextCursor, 1);
    expect(thirdPage.data.map((r) => r.id)).toEqual([3]);
  });
});
