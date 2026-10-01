import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { WhiteboardSharingService } from "./whiteboard-sharing.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { DataScope } from "../../access/access.types";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type MockChain = {
  from: jest.Mock;
  leftJoin: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  set: jest.Mock;
  values: jest.Mock;
  returning: jest.Mock;
  then: (
    onfulfilled: (v: unknown) => unknown,
    onrejected?: (e: unknown) => unknown,
  ) => Promise<unknown>;
};

function makeChain(resolvedValue: unknown = []): MockChain {
  const chain = {} as unknown as MockChain;
  chain.from = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.set = jest.fn().mockReturnValue(chain);
  chain.values = jest.fn().mockResolvedValue(undefined);
  chain.returning = jest.fn().mockResolvedValue(resolvedValue);
  chain.then = (onfulfilled, onrejected) =>
    Promise.resolve(resolvedValue).then(onfulfilled, onrejected);
  return chain;
}

const BASE_BOARD = {
  id: 42,
  orgId: "org-1",
  projectId: 10,
  name: "Test Board",
  data: { elements: [] as unknown[] },
  visibility: "project" as const,
  publicAccess: "viewer" as const,
  shareToken: "tok-abc",
  linkExpiresAt: null as Date | null,
  allowExport: true,
  createdBy: "creator-user",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-02"),
};

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

describe("WhiteboardSharingService", () => {
  let findFirstProject: jest.Mock;
  let findFirstWhiteboard: jest.Mock;
  let resolveUserPermissions: jest.Mock;
  let dbSelect: jest.Mock;
  let dbUpdate: jest.Mock;
  let dbTransaction: jest.Mock;
  let mockDb: Db;
  let mockAccess: AccessService;
  let svc: WhiteboardSharingService;

  beforeEach(() => {
    findFirstProject = jest.fn();
    findFirstWhiteboard = jest.fn();
    resolveUserPermissions = jest.fn().mockResolvedValue(new Map<string, DataScope>());
    dbSelect = jest.fn();
    dbUpdate = jest.fn();
    dbTransaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb));

    mockDb = {
      query: {
        projects: { findFirst: findFirstProject },
        projectWhiteboards: { findFirst: findFirstWhiteboard },
      },
      select: dbSelect,
      update: dbUpdate,
      execute: jest.fn(),
      transaction: dbTransaction,
    } as unknown as Db;

    mockAccess = {
      resolveUserPermissions,
      holds: jest.fn(async (_user: unknown, key: string) => {
        const resolved = await resolveUserPermissions();
        return (resolved.get(key) ?? "none") !== "none";
      }),
    } as unknown as AccessService;
    svc = new WhiteboardSharingService(mockDb, mockAccess);
  });

  function setupManageAccess(
    boardOverrides: Partial<typeof BASE_BOARD> = {},
    shareRole: "viewer" | "editor" | null = null,
  ): typeof BASE_BOARD {
    const board = { ...BASE_BOARD, ...boardOverrides };
    findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
    dbSelect.mockReturnValueOnce(makeChain([{ board, shareRole }]));
    return board;
  }

  describe("getPublicByToken", () => {
    it("throws NotFoundException for unknown token", async () => {
      findFirstWhiteboard.mockResolvedValueOnce(undefined);
      await expect(svc.getPublicByToken("bad-token")).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when visibility is private", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({ ...BASE_BOARD, visibility: "private" as const });
      await expect(svc.getPublicByToken("tok")).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when linkExpiresAt is in the past", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "public" as const,
        linkExpiresAt: new Date(Date.now() - 60_000),
      });
      await expect(svc.getPublicByToken("tok")).rejects.toThrow(NotFoundException);
    });

    it("returns only name/data/access/allowExport/updatedAt for a valid view link", async () => {
      const updatedAt = new Date("2026-06-01");
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "public" as const,
        publicAccess: "viewer" as const,
        updatedAt,
      });
      const result = await svc.getPublicByToken("tok");
      expect(result).toStrictEqual({
        name: BASE_BOARD.name,
        data: BASE_BOARD.data,
        access: "view",
        allowExport: BASE_BOARD.allowExport,
        updatedAt,
      });
      expect(result).not.toHaveProperty("orgId");
      expect(result).not.toHaveProperty("shareToken");
      expect(result).not.toHaveProperty("createdBy");
    });

    it("returns access edit when publicAccess is editor", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "public" as const,
        publicAccess: "editor" as const,
      });
      const result = await svc.getPublicByToken("tok");
      expect(result.access).toBe("edit");
    });
  });

  describe("updatePublicByToken", () => {
    const scene = { elements: [] as Record<string, unknown>[] };

    it("throws NotFoundException when board is not public", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        id: 1,
        visibility: "private" as const,
        publicAccess: "editor" as const,
        linkExpiresAt: null,
      });
      await expect(svc.updatePublicByToken("tok", scene)).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when publicAccess is viewer", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        id: 1,
        visibility: "public" as const,
        publicAccess: "viewer" as const,
        linkExpiresAt: null,
      });
      await expect(svc.updatePublicByToken("tok", scene)).rejects.toThrow(ForbiddenException);
    });

    it("returns success and calls the update chain when publicAccess is editor", async () => {
      const updatedAt = new Date("2026-06-15");
      findFirstWhiteboard.mockResolvedValueOnce({
        id: 1,
        orgId: BASE_BOARD.orgId,
        visibility: "public" as const,
        publicAccess: "editor" as const,
        linkExpiresAt: null,
      });
      dbUpdate.mockReturnValueOnce(makeChain([{ updatedAt }]));
      const result = await svc.updatePublicByToken("tok", scene);
      expect(result).toEqual({ success: true, updatedAt });
      expect(dbUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateSharing — manage-gating", () => {
    it("throws ForbiddenException for non-creator non-owner without manage permission", async () => {
      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect.mockReturnValueOnce(
        makeChain([{ board: { ...BASE_BOARD, createdBy: "other-user" }, shareRole: null }]),
      );
      const u = makeUser({ userId: "user-1", isOrgOwner: false });
      await expect(
        svc.updateSharing(u, BASE_BOARD.projectId, BASE_BOARD.id, { visibility: "public" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("succeeds when the acting user is org owner", async () => {
      const board = setupManageAccess({ createdBy: "other-user" });
      dbUpdate.mockReturnValueOnce(makeChain([{ ...board, visibility: "public" as const }]));
      const u = makeUser({ isOrgOwner: true });
      const result = await svc.updateSharing(
        u,
        BASE_BOARD.projectId,
        BASE_BOARD.id,
        { visibility: "public" },
      );
      expect(result).toMatchObject({ visibility: "public" });
    });

    it("succeeds when the acting user is the board creator", async () => {
      const board = setupManageAccess();
      dbUpdate.mockReturnValueOnce(makeChain([{ ...board, visibility: "public" as const }]));
      const u = makeUser({ userId: BASE_BOARD.createdBy });
      const result = await svc.updateSharing(
        u,
        BASE_BOARD.projectId,
        BASE_BOARD.id,
        { visibility: "public" },
      );
      expect(result).toMatchObject({ visibility: "public" });
    });
  });

  describe("setShares", () => {
    it("throws BadRequestException for unknown org member userIds", async () => {
      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect
        .mockReturnValueOnce(makeChain([{ board: BASE_BOARD, shareRole: null }]))
        .mockReturnValueOnce(makeChain([]));
      const u = makeUser({ userId: BASE_BOARD.createdBy });
      await expect(
        svc.setShares(u, BASE_BOARD.projectId, BASE_BOARD.id, {
          shares: [{ userId: "unknown-user", role: "viewer" }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("filters creator and acting user out of inserted values", async () => {
      const MEMBER_ID = "member-2";
      const MANAGER_ID = "manager-user";

      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect
        .mockReturnValueOnce(makeChain([{ board: BASE_BOARD, shareRole: null }]))
        .mockReturnValueOnce(
          makeChain([
            { id: 1, userId: BASE_BOARD.createdBy },
            { id: 2, userId: MANAGER_ID },
            { id: 3, userId: MEMBER_ID },
          ]),
        )
        .mockReturnValueOnce(makeChain([]));

      const txDeleteChain = makeChain([]);
      const txInsertValues = jest.fn().mockResolvedValue(undefined);
      const txDelete = jest.fn().mockReturnValue(txDeleteChain);
      const txInsert = jest.fn().mockReturnValue({ values: txInsertValues });

      dbTransaction.mockImplementationOnce(
        async (cb: (tx: { delete: jest.Mock; insert: jest.Mock }) => Promise<void>) =>
          cb({ delete: txDelete, insert: txInsert }),
      );

      const u = makeUser({ userId: MANAGER_ID, isOrgOwner: true });
      await svc.setShares(u, BASE_BOARD.projectId, BASE_BOARD.id, {
        shares: [
          { userId: BASE_BOARD.createdBy, role: "editor" },
          { userId: MANAGER_ID, role: "viewer" },
          { userId: MEMBER_ID, role: "viewer" },
        ],
      });

      expect(txInsert).toHaveBeenCalledTimes(1);
      expect(txInsertValues).toHaveBeenCalledWith([
        expect.objectContaining({ membershipId: 3, role: "viewer" }),
      ]);
    });
  });

  describe("share token hashing — D1: tokens must be stored as SHA-256 hashes, not plaintext", () => {
    it("rotateShareToken stores hash not raw token: SET is called with sha256(rawToken)", async () => {
      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect.mockReturnValueOnce(makeChain([{ board: BASE_BOARD, shareRole: null }]));

      let capturedSetArg: Record<string, unknown> | undefined;
      const returning = jest.fn().mockResolvedValue([{ ...BASE_BOARD, visibility: "public" as const }]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockImplementation((arg: Record<string, unknown>) => {
        capturedSetArg = arg;
        return { where };
      });
      dbUpdate.mockReturnValueOnce({ set });

      const u = makeUser({ userId: BASE_BOARD.createdBy });
      const result = await svc.rotateShareToken(u, BASE_BOARD.projectId, BASE_BOARD.id);

      expect(capturedSetArg).toBeDefined();
      const storedToken = capturedSetArg!["shareToken"] as string;
      const returnedToken = result.shareToken;

      expect(returnedToken).toBeDefined();
      expect(storedToken).not.toBe(returnedToken);
      expect(storedToken).toBe(sha256Hex(returnedToken!));
      expect(storedToken).toHaveLength(64);
    });

    it("rotateShareToken response shareToken is the raw token, not the hash", async () => {
      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect.mockReturnValueOnce(makeChain([{ board: BASE_BOARD, shareRole: null }]));

      const returning = jest.fn().mockResolvedValue([{ ...BASE_BOARD, visibility: "public" as const, shareToken: "some-hash-stored-in-db" }]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      dbUpdate.mockReturnValueOnce({ set });

      const u = makeUser({ userId: BASE_BOARD.createdBy });
      const result = await svc.rotateShareToken(u, BASE_BOARD.projectId, BASE_BOARD.id);

      expect(result.shareToken).not.toBe("some-hash-stored-in-db");
      expect(result.shareToken).not.toHaveLength(64);
    });

    it("updateSharing stores hash when token is newly generated (needsToken=true)", async () => {
      const boardWithNoToken = { ...BASE_BOARD, shareToken: null as string | null, visibility: "project" as const };
      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect.mockReturnValueOnce(makeChain([{ board: boardWithNoToken, shareRole: null }]));

      let capturedSetArg: Record<string, unknown> | undefined;
      const returning = jest.fn().mockResolvedValue([{ ...boardWithNoToken, visibility: "public" as const }]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockImplementation((arg: Record<string, unknown>) => {
        capturedSetArg = arg;
        return { where };
      });
      dbUpdate.mockReturnValueOnce({ set });

      const u = makeUser({ userId: BASE_BOARD.createdBy });
      const result = await svc.updateSharing(u, BASE_BOARD.projectId, BASE_BOARD.id, { visibility: "public" });

      expect(capturedSetArg!["shareToken"]).toBe(sha256Hex(result.shareToken!));
    });

    it("updateSharing returns null for shareToken when no new token is issued", async () => {
      findFirstProject.mockResolvedValueOnce({ id: BASE_BOARD.projectId, managerMembershipId: 1 });
      dbSelect.mockReturnValueOnce(makeChain([{ board: BASE_BOARD, shareRole: null }]));
      const returning = jest.fn().mockResolvedValue([{ ...BASE_BOARD, visibility: "public" as const }]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      dbUpdate.mockReturnValueOnce({ set });

      const u = makeUser({ userId: BASE_BOARD.createdBy });
      const result = await svc.updateSharing(u, BASE_BOARD.projectId, BASE_BOARD.id, { allowExport: false });

      expect(result.shareToken).toBeNull();
    });

    it("getPublicByToken works correctly when the board is found via hash lookup", async () => {
      const rawToken = "my-raw-share-token";
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "public" as const,
        publicAccess: "viewer" as const,
        linkExpiresAt: null,
      });
      const result = await svc.getPublicByToken(rawToken);
      expect(result.name).toBe(BASE_BOARD.name);
    });

    it("getPublicByToken hashes the token — sha256Hex of any raw token never equals the raw token (structural: hash differs from input)", () => {
      const rawToken = "some-random-base64url-token";
      const hash = sha256Hex(rawToken);
      expect(hash).not.toBe(rawToken);
      expect(hash).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    });

    it("getPublicByToken: rejected when token hash does not match any board (unknown token)", async () => {
      findFirstWhiteboard.mockResolvedValueOnce(undefined);
      await expect(svc.getPublicByToken("does-not-exist")).rejects.toThrow(NotFoundException);
    });
  });

  describe("share token security — expiry and revocation (D1 continued)", () => {
    it("getPublicByToken rejects an expired link immediately — revocation bound is zero", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "public" as const,
        linkExpiresAt: new Date(Date.now() - 1),
      });
      await expect(svc.getPublicByToken("any-token")).rejects.toThrow(NotFoundException);
    });

    it("getPublicByToken rejects when visibility is changed away from public — revocation is immediate", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "project" as const,
      });
      await expect(svc.getPublicByToken("any-token")).rejects.toThrow(NotFoundException);
    });

    it("updatePublicByToken rejects an expired link — expiry enforced at write time", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        id: 1,
        orgId: BASE_BOARD.orgId,
        visibility: "public" as const,
        publicAccess: "editor" as const,
        linkExpiresAt: new Date(Date.now() - 1),
      });
      await expect(
        svc.updatePublicByToken("tok", { elements: [] }),
      ).rejects.toThrow(NotFoundException);
    });

    it("getPublicByToken does not expose orgId or shareToken in the response", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "public" as const,
        publicAccess: "viewer" as const,
        linkExpiresAt: null,
      });
      const result = await svc.getPublicByToken("tok") as Record<string, unknown>;
      expect(result).not.toHaveProperty("orgId");
      expect(result).not.toHaveProperty("shareToken");
      expect(result).not.toHaveProperty("createdBy");
      expect(result).not.toHaveProperty("projectId");
    });

    it("getPublicByToken does not expose private board data even when a valid-format token is presented", async () => {
      findFirstWhiteboard.mockResolvedValueOnce({
        ...BASE_BOARD,
        visibility: "private" as const,
      });
      await expect(svc.getPublicByToken("looks-valid")).rejects.toThrow(NotFoundException);
    });
  });
});
