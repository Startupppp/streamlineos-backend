import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { WhiteboardsService } from "./whiteboards.service";

describe("WhiteboardsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { holds: jest.fn().mockResolvedValue(true) } as never;

  function makeDb(projectRow: unknown | null, boardRows: unknown[]) {
    const loadSharesWhere = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn().mockReturnValue({ where: loadSharesWhere });
    const boardWhere = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(boardRows) });
    const leftJoin = jest.fn().mockReturnValue({ where: boardWhere });
    const from = jest.fn().mockReturnValue({ where: boardWhere, leftJoin, innerJoin });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException for getWhiteboard when board not in org (cross-tenant isolation)", async () => {
    const project = { id: 1 };
    const db = makeDb(project, []);
    const svc = new WhiteboardsService(db, access);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.getWhiteboard(u, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns whiteboard for the owning org (same-tenant control)", async () => {
    const project = { id: 1 };
    const board = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "B", visibility: "private", createdBy: "u1", deletedAt: null, data: {} };
    const db = makeDb(project, [{ board, shareRole: null }]);
    const svc = new WhiteboardsService(db, access);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    const result = await svc.getWhiteboard(u, 1, 1);
    expect(result).toBeDefined();
  });
});
