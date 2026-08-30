process.env.APP_URL ??= "http://localhost:1000";

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { WfhService } from "../time/wfh.service";

function makeWfhRequest(overrides: Record<string, unknown> = {}) {
  return { id: 1, orgId: "org-1", userId: "employee-1", date: "2026-09-01", status: "PENDING", ...overrides };
}

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function activeMemberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    orgId: "org-1",
    userId: "approver-user",
    role: "MEMBER",
    isOwner: false,
    status: "ACTIVE",
    ...overrides,
  };
}

describe("HR actor migration — organization membership identity enforcement", () => {
  describe("WfhService.update", () => {
    const ORG = "org-1";
    const REQUEST_ID = 1;

    function buildDb(memberRows: unknown[]) {
      return {
        select: jest.fn()
          .mockReturnValueOnce(makeSelectChain(memberRows))
          .mockReturnValueOnce(makeSelectChain([])),
        query: {
          wfhRequests: {
            findFirst: jest.fn().mockResolvedValue(makeWfhRequest()),
          },
        },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };
    }

    it("rejects a user with no membership in the org — throws NotFoundException, not written", async () => {
      const db = buildDb([]);
      const service = new WfhService(db as never, null as never);

      await expect(service.update(ORG, "unknown-user", REQUEST_ID, { status: "APPROVED" }))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a SUSPENDED member — throws ForbiddenException", async () => {
      const db = buildDb([activeMemberRow({ status: "SUSPENDED" })]);
      const service = new WfhService(db as never, null as never);

      await expect(service.update(ORG, "approver-user", REQUEST_ID, { status: "APPROVED" }))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a member of a different organization with 404, never 403", async () => {
      const db = buildDb([]);
      const service = new WfhService(db as never, null as never);

      const error = await service.update(ORG, "org2-user", REQUEST_ID, { status: "APPROVED" })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).not.toBeInstanceOf(ForbiddenException);
    });

    it("writes both legacy approverId and approverMembershipId for a valid active member", async () => {
      const db = buildDb([activeMemberRow()]);
      const setFn = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
      db.update = jest.fn().mockReturnValue({ set: setFn });

      const service = new WfhService(db as never, null as never);

      await service.update(ORG, "approver-user", REQUEST_ID, { status: "APPROVED" });

      expect(setFn).toHaveBeenCalledWith(
        expect.objectContaining({
          approverId: "approver-user",
          approverMembershipId: 42,
        }),
      );

      const [[setArg]] = setFn.mock.calls;
      expect(setArg).toHaveProperty("approverId", "approver-user");
      expect(setArg).toHaveProperty("approverMembershipId", 42);
    });
  });
});
