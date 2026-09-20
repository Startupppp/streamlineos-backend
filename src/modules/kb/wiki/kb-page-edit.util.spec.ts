import { HttpStatus } from "@nestjs/common";
import { snapshotIfNeeded, type KbTransaction } from "./kb-page-edit.util";

const PAGE_CONTENT = { type: "doc", content: [] as unknown[] };

function makePage(id = 1) {
  return { id, title: "Test", content: PAGE_CONTENT, contentText: null };
}

function makeTx(opts: {
  newestVersion: { versionNumber: number; createdAt: Date } | null;
  insertRejectsWith?: unknown;
}) {
  const insertValues = jest.fn().mockImplementation(async () => {
    if (opts.insertRejectsWith) throw opts.insertRejectsWith;
    return [];
  });
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

describe("snapshotIfNeeded — the version number is read then written, so it can collide", () => {
  function uniqueViolation(constraint: string): Error {
    return Object.assign(new Error("Failed query: insert into kb_page_versions"), {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint_name: constraint,
      }),
    });
  }

  it("answers a colliding version number with 409, never an unhandled 500", async () => {
    const { tx } = makeTx({
      newestVersion: { versionNumber: 7, createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      insertRejectsWith: uniqueViolation("uniq_kb_page_versions_page_version"),
    });

    const caught: unknown = await snapshotIfNeeded(tx, "org-1", makePage(), "user-1").catch(
      function capture(error: unknown) {
        return error;
      },
    );

    const err = caught as { getStatus?: () => number; getResponse?: () => unknown };
    expect(typeof err.getStatus === "function" ? err.getStatus() : undefined).toBe(
      HttpStatus.CONFLICT,
    );
    expect(typeof err.getResponse === "function" ? err.getResponse() : undefined).toMatchObject({
      code: "STALE_REVISION",
      details: { currentContentRevision: null },
    });
  });

  it("leaves an unrelated unique violation alone rather than reporting it as a conflicting edit", async () => {
    const original = uniqueViolation("uniq_kb_pages_org_public_slug");
    const { tx } = makeTx({
      newestVersion: { versionNumber: 7, createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      insertRejectsWith: original,
    });

    const caught: unknown = await snapshotIfNeeded(tx, "org-1", makePage(), "user-1").catch(
      function capture(error: unknown) {
        return error;
      },
    );

    expect(caught).toBe(original);
  });
});
