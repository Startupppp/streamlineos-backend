import { SessionsService } from "./sessions.service";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    async (_db: unknown, _orgId: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

const mockRunInNewTenantTransaction = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

function makeDb(findFirstResult: { id: string; userAgent: string | null } | undefined): {
  db: Db;
  findFirst: jest.Mock;
  insertValues: jest.Mock;
  updateSet: jest.Mock;
  updateWhere: jest.Mock;
} {
  const findFirst = jest.fn().mockResolvedValue(findFirstResult);
  const findMany = jest.fn().mockResolvedValue([]);
  const updateWhere = jest.fn().mockResolvedValue([]);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const insertValues = jest.fn().mockResolvedValue([]);

  const db = {
    query: {
      userSessions: { findFirst, findMany },
    },
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    update: jest.fn().mockReturnValue({ set: updateSet }),
  } as unknown as Db;

  return { db, findFirst, insertValues, updateSet, updateWhere };
}

describe("SessionsService.list — upsert behaviour", () => {
  const userId = "user-abc";
  const sessionId = "sess-123";
  const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125";
  const axiosUA = "axios/1.18.1";

  function buildService(findFirstResult: { id: string; userAgent: string | null } | undefined) {
    const mocks = makeDb(findFirstResult);
    const service = new SessionsService(mocks.db, null);
    return { service, ...mocks };
  }

  it("inserts a new row when no session exists in DB", async () => {
    const { service, insertValues } = buildService(undefined);

    await service.list(userId, "org-1", sessionId, browserUA, "1.2.3.4");

    expect(insertValues).toHaveBeenCalledTimes(1);
    const inserted = insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.id).toBe(sessionId);
    expect(inserted.userId).toBe(userId);
    expect(inserted.userAgent).toBe(browserUA);
    expect(inserted.ipAddress).toBe("1.2.3.4");
    expect(inserted.isRevoked).toBe(false);
  });

  it("does not INSERT when the session row already exists", async () => {
    const { service, insertValues } = buildService({ id: sessionId, userAgent: browserUA });

    await service.list(userId, "org-1", sessionId, browserUA, "1.2.3.4");

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("overwrites userAgent when existing row has a browser UA and incoming is also browser", async () => {
    const newBrowser = "Mozilla/5.0 Safari/17";
    const { service, updateSet } = buildService({ id: sessionId, userAgent: browserUA });

    await service.list(userId, "org-1", sessionId, newBrowser, "5.6.7.8");

    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.userAgent).toBe(newBrowser);
    expect(setArg.ipAddress).toBe("5.6.7.8");
  });

  it("does NOT overwrite a real browser UA when incoming UA is an API client", async () => {
    const { service, updateSet } = buildService({ id: sessionId, userAgent: browserUA });

    await service.list(userId, "org-1", sessionId, axiosUA, "9.0.0.1");

    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.userAgent).toBeUndefined();
    expect(setArg.ipAddress).toBeUndefined();
    expect(setArg.lastActive).toBeDefined();
  });

  it("overwrites an API-client UA when the incoming UA is a real browser", async () => {
    const { service, updateSet } = buildService({ id: sessionId, userAgent: axiosUA });

    await service.list(userId, "org-1", sessionId, browserUA, "2.2.2.2");

    expect(updateSet).toHaveBeenCalledTimes(1);
    const setArg = updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.userAgent).toBe(browserUA);
  });

  it("overwrites a null stored UA regardless of incoming UA type", async () => {
    const { service, updateSet } = buildService({ id: sessionId, userAgent: null });

    await service.list(userId, "org-1", sessionId, axiosUA, "3.3.3.3");

    const setArg = updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.userAgent).toBe(axiosUA);
  });

  it("skips the upsert entirely for PAT session ids", async () => {
    const { service, findFirst, insertValues } = buildService(undefined);

    await service.list(userId, "org-1", "pat:some-token", browserUA, "1.1.1.1");

    expect(findFirst).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("skips the upsert when currentSessionId is empty", async () => {
    const { service, findFirst, insertValues } = buildService(undefined);

    await service.list(userId, "org-1", "", browserUA, "1.1.1.1");

    expect(findFirst).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("runs the upsert in an independent transaction so a read-replica accessMode:read-only request does not fail on the write", async () => {
    const { service, insertValues } = buildService(undefined);
    const orgId = "org-xyz";

    await service.list(userId, orgId, sessionId, browserUA, "1.2.3.4");

    expect(mockRunInNewTenantTransaction).toHaveBeenCalledWith(
      expect.anything(),
      orgId,
      expect.any(Function),
    );
    expect(insertValues).toHaveBeenCalledTimes(1);
  });
});
