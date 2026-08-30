import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ReconciliationWorkspaceService } from "./reconciliation-workspace.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(orgId: string): CurrentUserContext {
  return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false, enabledModules: [] } as unknown as CurrentUserContext;
}

function makeOrderByChain(rows: unknown[]): Record<string, jest.Mock> {
  const orderBy = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ orderBy });
  return { from: jest.fn().mockReturnValue({ where }) };
}

function makeWhereChain(rows: unknown[]): Record<string, jest.Mock> {
  const where = jest.fn().mockResolvedValue(rows);
  return { from: jest.fn().mockReturnValue({ where }) };
}

describe("ReconciliationWorkspaceService — cross-tenant isolation", () => {
  it("throws NotFoundException when bank account belongs to a different org (BOLA isolation)", async () => {
    const db = {
      query: {
        finBankAccounts: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as Db;
    const svc = new ReconciliationWorkspaceService(db);

    await expect(svc.getWorkspace(makeUser("org-attacker"), 99)).rejects.toThrow(NotFoundException);
  });

  it("returns workspace for the owning org (same-tenant control)", async () => {
    const account = { id: 99, orgId: "org-owner", balance: "1000.00" };
    let call = 0;
    const db = {
      query: {
        finBankAccounts: { findFirst: jest.fn().mockResolvedValue(account) },
      },
      select: jest.fn().mockImplementation(() => {
        call++;
        if (call <= 2) return makeOrderByChain([]);
        return makeWhereChain([{ count: 0 }]);
      }),
    } as unknown as Db;
    const svc = new ReconciliationWorkspaceService(db);

    const result = await svc.getWorkspace(makeUser("org-owner"), 99);

    expect(result).toBeDefined();
  });
});
