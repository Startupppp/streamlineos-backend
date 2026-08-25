import { batchStepName, pauseStepName, rowWindows, BATCH_ROWS } from "./import-batches";

/**
 * The property the whole durable import rests on: a step name always means the
 * same rows. Everything here is a way of failing that if it stops being true.
 */
describe("rowWindows", () => {
  it("covers every row exactly once, with no gap and no overlap", () => {
    const windows = rowWindows(250, 100);

    expect(windows).toEqual([
      { index: 0, fromRow: 1, toRow: 100 },
      { index: 1, fromRow: 101, toRow: 200 },
      { index: 2, fromRow: 201, toRow: 300 },
    ]);
  });

  it("walks to the last row of the file rather than to a count of rows", () => {
    /**
     * The distinction that matters when a plan has been partly deleted: seven
     * rows numbered up to 900 need nine windows, not one. Cutting on a count
     * would stop at row 100 and leave the tail of the file unimported with the
     * run reporting success.
     */
    expect(rowWindows(900, 100)).toHaveLength(9);
    expect(rowWindows(900, 100).at(-1)).toMatchObject({ fromRow: 801, toRow: 900 });
  });

  it("is the same answer every time it is asked", () => {
    expect(rowWindows(4321)).toEqual(rowWindows(4321));
  });

  it("does not depend on how much of the import is already done", () => {
    // The reason boundaries are arithmetic over row numbers rather than an
    // offset into the outstanding rows: an OFFSET-shaped batch re-reads a
    // different set once rows commit, and the memo stops meaning its rows.
    const before = rowWindows(1000);
    const after = rowWindows(1000);
    expect(after).toEqual(before);
  });

  it("has nothing to do with an empty plan", () => {
    expect(rowWindows(0)).toEqual([]);
    expect(rowWindows(-1)).toEqual([]);
  });

  it("puts a one-row file in one window", () => {
    expect(rowWindows(1)).toEqual([{ index: 0, fromRow: 1, toRow: BATCH_ROWS }]);
  });
});

describe("step names", () => {
  it("keeps the commit and the undo apart", () => {
    // Two runs walk the same file. A shared name would let one read the other's
    // memo and skip work it never did.
    expect(batchStepName("commit", 3)).not.toEqual(batchStepName("revert", 3));
    expect(pauseStepName("commit", 3)).not.toEqual(pauseStepName("revert", 3));
  });

  it("keeps a batch and the pause before it apart", () => {
    expect(batchStepName("commit", 3)).not.toEqual(pauseStepName("commit", 3));
  });

  it("gives every window in a file a distinct name", () => {
    const names = rowWindows(5_000).map((window) => batchStepName("commit", window.index));
    expect(new Set(names).size).toBe(names.length);
  });
});
