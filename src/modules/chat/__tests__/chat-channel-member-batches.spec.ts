import { forEachChannelMemberBatch } from "../chat-channel-member-batches";

/**
 * The keyset drain both huddle fan-outs share, asserted on the round trips it issues.
 *
 * Two things are being held here, and neither is a type. The first is the paging itself: a cursor
 * that fails to advance re-reads page one forever, which is an infinite loop against a live table
 * rather than a wrong answer, so the drain is driven with a double that RECORDS every cursor it is
 * asked for. The second is the handle. `forEachChannelMemberBatch` takes the handle and passes it to
 * `fetchBatch` instead of letting each caller close over its own; the calendar backfill runs inside
 * the huddle's transaction (`tx`) and the notification fan-out runs on the pooled handle (`db`), and
 * threading it is what keeps a deferred caller from reaching for a transaction that has already
 * committed (backend §4). It is also what keeps `check:db-call-count` able to see the loop — when
 * these two drains were lifted out of `chat-huddles.service.ts` behind a closure, the detector
 * stopped matching them and the classification entry went stale as a FALSE NEGATIVE.
 */

interface Member {
  membershipId: number;
}

function pagesOf(total: number, batchSize: number) {
  const cursors: (number | null)[] = [];
  const fetchBatch = (handle: unknown, afterMembershipId: number | null): Promise<Member[]> => {
    cursors.push(afterMembershipId);
    const from = afterMembershipId ?? 0;
    const rows: Member[] = [];
    for (let id = from + 1; id <= total && rows.length < batchSize; id += 1)
      rows.push({ membershipId: id });
    return Promise.resolve(rows);
  };
  return { cursors, fetchBatch };
}

describe("forEachChannelMemberBatch — the shared channel-member keyset drain", () => {
  it("hands the caller's handle to every fetch, so the query is not closed over", async () => {
    const handle = { marker: "tx-under-test" };
    const seen: unknown[] = [];

    await forEachChannelMemberBatch(
      handle,
      500,
      (db) => {
        seen.push(db);
        return Promise.resolve([]);
      },
      () => undefined,
    );

    expect(seen).toEqual([handle]);
  });

  it("advances the cursor past the last row of each page, and stops on a short page", async () => {
    const { cursors, fetchBatch } = pagesOf(12, 5);
    const drained: number[] = [];

    await forEachChannelMemberBatch({}, 5, fetchBatch, (rows) => {
      for (const row of rows) drained.push(row.membershipId);
    });

    expect(cursors).toEqual([null, 5, 10]);
    expect(drained).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("reads one page past a full last page, because a full page cannot prove it was the last", async () => {
    const { cursors, fetchBatch } = pagesOf(10, 5);

    await forEachChannelMemberBatch({}, 5, fetchBatch, () => undefined);

    expect(cursors).toEqual([null, 5, 10]);
  });

  it("issues no work call at all for a channel with no members", async () => {
    const handleBatch = jest.fn();

    await forEachChannelMemberBatch({}, 500, () => Promise.resolve([]), handleBatch);

    expect(handleBatch).not.toHaveBeenCalled();
  });

  it("BITE: a fetch that ignores the cursor would re-read page one forever — the cursor is what stops it", async () => {
    const seen: (number | null)[] = [];
    let calls = 0;

    await forEachChannelMemberBatch(
      {},
      2,
      (_db, afterMembershipId) => {
        seen.push(afterMembershipId);
        calls += 1;
        // A stuck fetch returns the SAME full page every time. The drain must still
        // move its cursor; the guard here is the test's, standing in for the table
        // running out. Without the advance, `seen` would be [null, null, ...].
        return Promise.resolve(calls > 3 ? [] : [{ membershipId: 1 }, { membershipId: 2 }]);
      },
      () => undefined,
    );

    expect(seen).toEqual([null, 2, 2, 2]);
  });

  it("costs one round trip per PAGE, not one per member", async () => {
    const { cursors, fetchBatch } = pagesOf(1000, 500);
    const handleBatch = jest.fn();

    await forEachChannelMemberBatch({}, 500, fetchBatch, handleBatch);

    expect(cursors).toHaveLength(3);
    expect(handleBatch).toHaveBeenCalledTimes(2);
  });
});
