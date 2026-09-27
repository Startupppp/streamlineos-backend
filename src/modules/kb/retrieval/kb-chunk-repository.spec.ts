jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
}));

import { replacePageBodyChunks, updatePageChunkAcl } from "./kb-chunk-repository";

function captureInsert() {
  const values = jest.fn().mockResolvedValue([]);
  const deleteWhere = jest.fn().mockResolvedValue([]);
  const setSpy = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
  const tx = {
    delete: jest.fn().mockReturnValue({ where: deleteWhere }),
    insert: jest.fn().mockReturnValue({ values }),
    update: jest.fn().mockReturnValue({ set: setSpy }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
  };
  return {
    db: tx as never,
    rows: () => (values.mock.calls[0]?.[0] ?? []) as Record<string, unknown>[],
    setSpy,
  };
}

const DEAD_COLUMNS = [
  "pageVisibility",
  "pageProjectId",
  "pageCreatedById",
  "pageCreatedByMembershipId",
] as const;

const BASE_ACL = { aclRevision: 2 };
const BASE_META = { ...BASE_ACL, contentHash: "abc", contentRevision: 1 };

describe("replacePageBodyChunks — dead ACL columns must not appear in INSERT so a future re-introduction fails immediately", () => {
  it("omits pageVisibility, pageProjectId, pageCreatedById, pageCreatedByMembershipId from every inserted row", async () => {
    const { db, rows } = captureInsert();

    await replacePageBodyChunks(
      db,
      "org-1",
      10,
      ["chunk one"],
      [[0.1, 0.2]],
      BASE_META,
      async () => undefined,
    );

    const row = rows()[0];
    expect(row).toBeDefined();
    for (const col of DEAD_COLUMNS) {
      expect(row).not.toHaveProperty(col);
    }
  });

  it("BITE — without this guard a row that carries pageVisibility passes undetected", async () => {
    const { db, rows } = captureInsert();

    await replacePageBodyChunks(
      db,
      "org-1",
      10,
      ["chunk one"],
      [[0.1, 0.2]],
      BASE_META,
      async () => undefined,
    );

    const row = rows()[0];
    expect(row).not.toHaveProperty("pageVisibility");
    expect(row).toHaveProperty("aclRevision");
  });

  it("still writes aclRevision and contentHash so the indexing contract is intact", async () => {
    const { db, rows } = captureInsert();

    await replacePageBodyChunks(
      db,
      "org-1",
      10,
      ["chunk two"],
      [[0.3, 0.4]],
      { aclRevision: 7, contentHash: "deadbeef", contentRevision: 3 },
      async () => undefined,
    );

    const row = rows()[0];
    expect(row).toHaveProperty("aclRevision", 7);
    expect(row).toHaveProperty("contentHash", "deadbeef");
  });
});

describe("updatePageChunkAcl — dead ACL columns must not appear in SET so they cannot be re-introduced through the ACL-only update path", () => {
  it("sets only aclRevision and aclSyncedAt, not pageVisibility or its siblings", async () => {
    const { db, setSpy } = captureInsert();

    await updatePageChunkAcl(db, "org-1", 10, BASE_ACL);

    const [setArg] = setSpy.mock.calls[0] as [Record<string, unknown>];
    expect(setArg).toBeDefined();
    for (const col of DEAD_COLUMNS) {
      expect(setArg).not.toHaveProperty(col);
    }
  });

  it("BITE — without this guard the SET could silently carry pageVisibility back in", async () => {
    const { db, setSpy } = captureInsert();

    await updatePageChunkAcl(db, "org-1", 10, BASE_ACL);

    const [setArg] = setSpy.mock.calls[0] as [Record<string, unknown>];
    expect(setArg).not.toHaveProperty("pageVisibility");
    expect(setArg).toHaveProperty("aclRevision", BASE_ACL.aclRevision);
  });

  it("still sets aclRevision with the value supplied and aclSyncedAt as a Date", async () => {
    const { db, setSpy } = captureInsert();

    await updatePageChunkAcl(db, "org-1", 10, { aclRevision: 9 });

    const [setArg] = setSpy.mock.calls[0] as [Record<string, unknown>];
    expect(setArg).toHaveProperty("aclRevision", 9);
    expect(setArg).toHaveProperty("aclSyncedAt");
    expect(setArg["aclSyncedAt"]).toBeInstanceOf(Date);
  });
});
