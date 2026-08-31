process.env.APP_URL ??= "http://localhost:1000";

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { CompOffGrantService } from "./comp-off-grant.service";

const USER: CurrentUserContext = {
  userId: "admin-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function selectLimit(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    for: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.for.mockReturnValue(chain);
  return chain;
}

describe("CompOffGrantService", () => {
  it("requires the separate administrative leave permission", async () => {
    const db = { transaction: jest.fn() };
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new CompOffGrantService(
      db as never,
      access as never,
      { logCritical: jest.fn() } as never,
      undefined as never,
      undefined as never,
    );

    await expect(
      service.grant(USER, { userId: "employee-1", days: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does not grant comp-off to a user without an active tenant membership", async () => {
    const tx = { select: jest.fn().mockReturnValue(selectLimit([])) };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const access = {
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map([["hr:leaves:manage", "all"]])),
    };
    const service = new CompOffGrantService(
      db as never,
      access as never,
      { logCritical: jest.fn() } as never,
      undefined as never,
      undefined as never,
    );

    await expect(
      service.grant(USER, { userId: "outside-user", days: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("locks the balance and writes the ledger and critical audit atomically", async () => {
    const targetSelect = selectLimit([{ userId: "employee-1" }]);
    const balanceSelect = selectLimit([]);
    const balanceValues = jest.fn().mockResolvedValue(undefined);
    const tx = {
      select: jest
        .fn()
        .mockReturnValueOnce(targetSelect)
        .mockReturnValueOnce(balanceSelect),
      query: {
        leaveTypes: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 9, name: "Compensatory Off" }),
        },
      },
      insert: jest.fn().mockReturnValue({ values: balanceValues }),
    };
    const db = {
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const access = {
      resolveUserPermissions: jest
        .fn()
        .mockResolvedValue(new Map([["hr:leaves:manage", "all"]])),
    };
    const logCritical = jest.fn().mockResolvedValue(undefined);
    const write = jest.fn().mockResolvedValue(undefined);
    const service = new CompOffGrantService(
      db as never,
      access as never,
      { logCritical } as never,
      undefined as never,
      { write } as never,
    );

    await expect(
      service.grant(USER, {
        userId: "employee-1",
        days: 1.5,
        reason: "Approved weekend work",
      }),
    ).resolves.toEqual({ success: true, credited: 1.5, leaveTypeId: 9 });

    expect(balanceSelect.for).toHaveBeenCalledWith("update");
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        userId: "employee-1",
        days: 1.5,
        txnType: "comp_off_earn",
      }),
      tx,
    );
    expect(logCritical).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hr.comp_off_granted",
        targetId: "employee-1",
      }),
    );
  });
});
