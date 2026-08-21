import { Test } from "@nestjs/testing";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { InvitationsService } from "../organization/core/invitations.service";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { UsersService } from "./users.service";

describe("UsersService direct member creation", () => {
  it("checks the member seat limit before writing a direct-created member", async () => {
    const assertWithinLimit = jest.fn().mockRejectedValue(new Error("seat limit"));
    const db = {
      query: { users: { findFirst: jest.fn() } },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (work: (tx: typeof db) => Promise<unknown>) => work(db),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: InvitationsService, useValue: { invite: jest.fn() } },
        { provide: AccessService, useValue: {} },
        { provide: OrgMembershipService, useValue: {} },
        { provide: PlanLimitsService, useValue: { assertWithinLimit } },
      ],
    }).compile();
    const service = moduleRef.get(UsersService);

    await expect(
      service.createUser(
        "org-1",
        {
          email: "new@example.com",
          role: "MEMBER",
          sendInvite: false,
        },
        { userId: "owner-1", isOrgOwner: true },
      ),
    ).rejects.toThrow("seat limit");

    expect(assertWithinLimit).toHaveBeenCalledWith(
      "org-1",
      "members",
      1,
      db,
    );
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
