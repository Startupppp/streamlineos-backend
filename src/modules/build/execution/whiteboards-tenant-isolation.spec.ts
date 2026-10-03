import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WhiteboardsService } from "./whiteboards.service";
import { lifecycleAuditDouble } from "../lifecycle/audit-double.spec-fixtures";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MEMBER_STANDING, principalAccess, projectAccessRow } from "../__tests__/project-access-doubles";

function projectGate(found: boolean) {
  return { from: () => ({ where: () => ({ limit: async () => (found ? [projectAccessRow({ manages: true })] : []) }) }) };
}

function actorIn(orgId: string, isOrgOwner: boolean): CurrentUserContext {
  return {
    userId: "u1",
    orgId,
    role: isOrgOwner ? "OWNER" : "MEMBER",
    isOrgOwner,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, isOrgOwner),
  };
}

describe("WhiteboardsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = stubService<AccessService>({
    holds: jest.fn().mockResolvedValue(true),
    scopeFor: principalAccess(MEMBER_STANDING).scopeFor,
  });

  function makeDb(projectRow: unknown | null, boardRows: unknown[]) {
    const loadSharesWhere = jest
      .fn()
      .mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    const innerJoin2 = jest.fn().mockReturnValue({ where: loadSharesWhere });
    const innerJoin = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
    const boardWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(boardRows) });
    const leftJoin = jest.fn().mockReturnValue({ where: boardWhere });
    const from = jest.fn().mockReturnValue({ where: boardWhere, leftJoin, innerJoin });
    return {
      select: jest.fn((projection: Record<string, unknown>) =>
        "onTeam" in projection ? projectGate(projectRow !== null) : { from },
      ),
    } as unknown as Db;
  }

  it("throws NotFoundException for getWhiteboard when board not in org (cross-tenant isolation)", async () => {
    const project = { id: 1, managerMembershipId: 1 };
    const db = makeDb(project, []);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const u = actorIn(ATTACKER_ORG, false);
    await expect(svc.getWhiteboard(u, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns whiteboard for the owning org (same-tenant control)", async () => {
    const project = { id: 1 };
    const board = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "B", visibility: "private", createdBy: "u1", deletedAt: null, data: {} };
    const db = makeDb(project, [{ board, shareRole: null }]);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const u = actorIn(OWNER_ORG, true);
    const result = await svc.getWhiteboard(u, 1, 1);
    expect(result).toBeDefined();
  });

  it("shareToken is null in getWhiteboard response — hash must not be exposed to manage-access users (D1/D6)", async () => {
    const project = { id: 1 };
    const board = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "B", visibility: "private", createdBy: "u1", deletedAt: null, data: { elements: [] }, shareToken: "abc123hash", publicAccess: "viewer", linkExpiresAt: null, allowExport: true, createdAt: new Date(), updatedAt: new Date() };
    const db = makeDb(project, [{ board, shareRole: null }]);
    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const u = actorIn(OWNER_ORG, true);
    const result = await svc.getWhiteboard(u, 1, 1);
    expect(result.sharing).not.toBeNull();
    expect((result.sharing as Record<string, unknown>)["shareToken"]).toBeNull();
  });

  it("updateWhiteboard: includes isNull(deletedAt) guard to prevent TOCTOU resurrection (D3)", async () => {
    const project = { id: 1 };
    const board = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "B", visibility: "private", createdBy: "u1", deletedAt: null, data: { elements: [] }, shareToken: null, publicAccess: "viewer", linkExpiresAt: null, allowExport: true, createdAt: new Date(), updatedAt: new Date() };

    const returning = jest.fn().mockResolvedValue([]);
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

    const db = {
      ...makeDb(project, [{ board, shareRole: null }]),
      update: dbUpdate,
    } as unknown as Db;

    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const u = actorIn(OWNER_ORG, true);
    await expect(
      svc.updateWhiteboard(u, 1, 1, { name: "New Name" }),
    ).rejects.toThrow(NotFoundException);

    expect(returning).toHaveBeenCalledTimes(1);
  });

  it("listWhiteboards queries limit + 1 rows to detect the next-page sentinel (D5)", async () => {
    const project = { id: 1 };
    const db = makeDb(project, []);

    let capturedLimit: number | undefined;
    const originalSelect = (db as unknown as { select: jest.Mock }).select;
    const limitMock = jest.fn().mockImplementation((n: number) => {
      capturedLimit = n;
      return Promise.resolve([]);
    });
    const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    (db as unknown as { select: jest.Mock }).select = jest.fn((projection: Record<string, unknown>) =>
      "onTeam" in projection ? projectGate(true) : { from: fromMock },
    );
    void originalSelect;

    const svc = new WhiteboardsService(db, access, lifecycleAuditDouble());
    const u = actorIn(OWNER_ORG, true);
    await svc.listWhiteboards(u, 1, { limit: 20 });
    expect(capturedLimit).toBe(21);
  });
});
