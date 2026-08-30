import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WhiteboardSharingService } from "./whiteboard-sharing.service";

describe("WhiteboardSharingService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { holds: jest.fn().mockResolvedValue(true) } as never;

  function makeDb(projectRow: unknown | null, boardRows: unknown[]) {
    const limit = jest.fn().mockResolvedValue(boardRows);
    const where = jest.fn().mockReturnValue({ limit });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin, where });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException when whiteboard project not found for different org (cross-tenant isolation)", async () => {
    const db = makeDb(null, []);
    const svc = new WhiteboardSharingService(db, access);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.updateSharing(u, 1, 99, {} as never)).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when board not found for different org (cross-tenant isolation)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const db = makeDb(project, []);
    const svc = new WhiteboardSharingService(db, access);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.updateSharing(u, 1, 99, {} as never)).rejects.toThrow(NotFoundException);
  });

  it("proceeds for the owning org when board is found (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const board = { id: 1, orgId: OWNER_ORG, projectId: 1, visibility: "private", createdBy: "u1", shareToken: null, publicAccess: null, linkExpiresAt: null, allowExport: false };
    const updated = { ...board, visibility: "public", shareToken: "tok", publicAccess: null, linkExpiresAt: null, allowExport: false };
    const returning = jest.fn().mockResolvedValue([updated]);
    const updateWhere = jest.fn().mockReturnValue({ returning });
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
    const update = jest.fn().mockReturnValue({ set: updateSet });
    const db = {
      ...makeDb(project, [{ board, shareRole: "manage" }]),
      update,
    } as unknown as Db;
    const svc = new WhiteboardSharingService(db, access);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    await expect(svc.updateSharing(u, 1, 1, { visibility: "public" } as never)).resolves.not.toThrow();
  });
});
