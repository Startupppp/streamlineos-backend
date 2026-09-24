import { KbIndexingService } from "./kb-indexing.service";
import { KbMembersService } from "../wiki/kb-members.service";

function makeCheckpoint() {
  return {
    loadCheckpoints: jest.fn().mockResolvedValue(new Map()),
    saveCheckpoints: jest.fn().mockResolvedValue(undefined),
    clearCheckpoints: jest.fn().mockResolvedValue(undefined),
  };
}

function makeEmbeddings() {
  return {
    isEmbeddingConfigured: jest.fn().mockReturnValue(false),
    embedQueryWithCredit: jest.fn(),
    embedBatchWithCredit: jest.fn(),
  };
}

function makeIndexingDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const db = {
    execute,
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue(null) } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
  };
  return { db, execute };
}

function extractSqlTexts(calls: Array<[unknown]>): string[] {
  return calls.map(([arg]) => {
    if (!arg || typeof arg !== "object") return "";
    const parts: string[] = [];
    const visit = (node: unknown, seen = new WeakSet<object>()): void => {
      if (typeof node === "string") { parts.push(node); return; }
      if (!node || typeof node !== "object" || seen.has(node as object)) return;
      seen.add(node as object);
      for (const v of Object.values(node as Record<string, unknown>)) visit(v, seen);
    };
    visit(arg);
    return parts.join(" ");
  });
}

describe("KbIndexingService.syncAclRevisionForSpace — chunk aclRevision sync", () => {
  it("executes UPDATE for page chunks referencing the given spaceId and orgId", async () => {
    const { db, execute } = makeIndexingDb();
    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.syncAclRevisionForSpace("org-x", 99);

    const texts = extractSqlTexts(execute.mock.calls as Array<[unknown]>);
    const pageSyncCall = texts.find((t) => t.includes("kb_pages") && t.includes("acl_revision"));
    expect(pageSyncCall).toBeDefined();
    expect(pageSyncCall).toContain("org-x");
  });

  it("executes UPDATE for article chunks referencing the given spaceId and orgId", async () => {
    const { db, execute } = makeIndexingDb();
    const svc = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    await svc.syncAclRevisionForSpace("org-y", 77);

    const texts = extractSqlTexts(execute.mock.calls as Array<[unknown]>);
    const articleSyncCall = texts.find((t) => t.includes("kb_articles") && t.includes("acl_revision"));
    expect(articleSyncCall).toBeDefined();
    expect(articleSyncCall).toContain("org-y");
  });

});

describe("KbMembersService — a membership ACL change always reaches the chunk aclRevision sync", () => {
  function makeRealIndexing(db: unknown) {
    const indexing = new KbIndexingService(db as never, makeEmbeddings() as never, makeCheckpoint() as never);
    const syncSpy = jest.spyOn(indexing, "syncAclRevisionForSpace").mockResolvedValue(undefined);
    return { indexing, syncSpy };
  }

  function makeMembersDb(member: Record<string, unknown>) {
    const updateChain = {
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    };
    const selectChain: Record<string, jest.Mock> = {
      leftJoin: jest.fn(() => selectChain),
      where: jest.fn().mockResolvedValue([member]),
    };
    return {
      query: { kbSpaceMembers: { findFirst: jest.fn().mockResolvedValue(member) } },
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      update: jest.fn().mockReturnValue(updateChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([member]),
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([member]),
          }),
        }),
      }),
      select: jest.fn().mockReturnValue({ from: jest.fn(() => selectChain) }),
      execute: jest.fn().mockResolvedValue([]),
    };
  }

  it("calls indexing.syncAclRevisionForSpace with the correct orgId and spaceId after removing a member", async () => {
    const member = {
      id: 20,
      orgId: "org-1",
      spaceId: 3,
      spaceRole: "member",
      userId: "user-z",
      role: null,
      team: null,
      createdAt: new Date(),
    };
    const db = makeMembersDb(member);
    const access = { invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined) };
    const { indexing, syncSpy } = makeRealIndexing(db);

    const svc = new KbMembersService(db as never, access as never, indexing);
    await svc.remove("org-1", 3, 20);

    expect(syncSpy).toHaveBeenCalledWith("org-1", 3);
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it("calls indexing.syncAclRevisionForSpace after adding a member", async () => {
    const space = { id: 5, orgId: "org-2" };
    const newMember = { id: 99, orgId: "org-2", spaceId: 5, spaceRole: "member" };
    const insertChain = { values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([newMember]) }) };
    const memberSelectChain: Record<string, jest.Mock> = {
      leftJoin: jest.fn(() => memberSelectChain),
      where: jest.fn().mockResolvedValue([newMember]),
    };
    const db = {
      query: {
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(space) },
        kbSpaceMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      insert: jest.fn().mockReturnValue(insertChain),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      select: jest.fn().mockReturnValue({ from: jest.fn(() => memberSelectChain) }),
      execute: jest.fn().mockResolvedValue([]),
    };
    const access = { invalidateAccessibleSpaceIds: jest.fn().mockResolvedValue(undefined) };
    const { indexing, syncSpy } = makeRealIndexing(db);

    const svc = new KbMembersService(db as never, access as never, indexing);
    await svc.add("org-2", 5, { spaceRole: "viewer" });

    expect(syncSpy).toHaveBeenCalledWith("org-2", 5);
    expect(db.update).toHaveBeenCalledTimes(2);
  });
});
