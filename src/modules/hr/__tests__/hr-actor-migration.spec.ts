process.env.APP_URL ??= "http://localhost:1000";

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { WfhService } from "../time/wfh.service";
import { type HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { AccessService } from "../../access/access.service";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function actor(userId: string): CurrentUserContext {
  return {
    userId,
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(42, false),
  };
}

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
    const REQUEST_ID = 1;

    function buildDb(memberRows: unknown[]) {
      return {
        select: jest.fn()
          .mockReturnValueOnce(makeSelectChain(memberRows))
          .mockReturnValueOnce(makeSelectChain([]))
          .mockReturnValueOnce(makeSelectChain([{ id: 1, userMembershipId: 7 }])),
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

    async function buildService(memberRows: unknown[]) {
      const db = buildDb(memberRows);
      const moduleRef = await Test.createTestingModule({
        providers: [
          WfhService,
          { provide: DRIZZLE, useValue: db },
          {
            provide: AccessService,
            useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:attendance:manage", "all"]])) },
          },
          { provide: ApprovalAuthorityService, useValue: {} },
        ],
      }).compile();
      return { service: moduleRef.get(WfhService), db };
    }

    it("rejects a user with no membership in the org — throws NotFoundException, not written", async () => {
      const { service } = await buildService([]);

      await expect(service.update(actor("unknown-user"), REQUEST_ID, { status: "APPROVED" }))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a SUSPENDED member — throws ForbiddenException", async () => {
      const { service } = await buildService([activeMemberRow({ status: "SUSPENDED" })]);

      await expect(service.update(actor("approver-user"), REQUEST_ID, { status: "APPROVED" }))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects a member of a different organization with 404, never 403", async () => {
      const { service } = await buildService([]);

      const error = await service.update(actor("org2-user"), REQUEST_ID, { status: "APPROVED" })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).not.toBeInstanceOf(ForbiddenException);
    });

    it("writes both legacy approverId and approverMembershipId for a valid active member", async () => {
      const { service, db } = await buildService([activeMemberRow()]);
      const setFn = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
      db.update = jest.fn().mockReturnValue({ set: setFn });

      await service.update(actor("approver-user"), REQUEST_ID, { status: "APPROVED" });

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
