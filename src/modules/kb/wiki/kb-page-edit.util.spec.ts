import { snapshotIfNeeded, type KbTransaction } from "./kb-page-edit.util";

const PAGE_CONTENT = { type: "doc", content: [] as unknown[] };

function makePage(id = 1) {
  return { id, title: "Test", content: PAGE_CONTENT, contentText: null };
}

function makeTx(opts: { newestVersion: { versionNumber: number; createdAt: Date } | null }) {
  const insertValues = jest.fn().mockResolvedValue([]);
  const insertFn = jest.fn().mockReturnValue({ values: insertValues });
  const deleteFn = jest.fn();

  const tx = {
    query: {
      kbPageVersions: {
        findFirst: jest.fn().mockResolvedValue(opts.newestVersion),
      },
    },
    insert: insertFn,
    delete: deleteFn,
  } as unknown as KbTransaction;

  return { tx, insertFn, insertValues, deleteFn };
}

describe("snapshotIfNeeded — immutable versions (no rolling delete)", () => {
  it("(a) inserts a new version without deleting even when version count exceeds the old cap of 100", async () => {
    const { tx, insertFn, deleteFn } = makeTx({
      newestVersion: { versionNumber: 101, createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await snapshotIfNeeded(tx, "org-1", makePage(), "user-1");

    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("(b) suppresses a snapshot when the VERSION_WINDOW_MS has not elapsed", async () => {
    const { tx, insertFn, deleteFn } = makeTx({
      newestVersion: { versionNumber: 1, createdAt: new Date() },
    });

    await snapshotIfNeeded(tx, "org-1", makePage(), "user-1");

    expect(insertFn).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("force=true bypasses the window throttle and always inserts", async () => {
    const { tx, insertFn } = makeTx({
      newestVersion: { versionNumber: 1, createdAt: new Date() },
    });

    await snapshotIfNeeded(tx, "org-1", makePage(), "user-1", null, true);

    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it("skips the snapshot when page.content is falsy", async () => {
    const { tx, insertFn } = makeTx({ newestVersion: null });
    const blankPage = { id: 1, title: "Empty", content: null, contentText: null };

    await snapshotIfNeeded(tx, "org-1", blankPage, "user-1");

    expect(insertFn).not.toHaveBeenCalled();
  });

  it("increments versionNumber by 1 from the newest snapshot", async () => {
    const { tx, insertValues } = makeTx({
      newestVersion: { versionNumber: 42, createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    await snapshotIfNeeded(tx, "org-1", makePage(), "user-1");

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ versionNumber: 43 }),
    );
  });
});
