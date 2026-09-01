import { NotFoundException } from "@nestjs/common";
import { DelegationsService } from "./delegations.service";

describe("DelegationsService membership authority", () => {
  it("rejects a proxy user that cannot be resolved in the grantor organization", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const db = { query: { organizationMembers: { findFirst } } };
    const service = new DelegationsService(db as never, { log: jest.fn() } as never);

    await expect(
      service.create({
        orgId: "org-a",
        userId: "grantor-user",
        principal: { kind: "human-session", membershipId: 9, isOrgOwner: false },
      } as never, {
        proxyUserId: "org-b-user",
        scope: "approvals",
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-02-01T00:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.query.organizationMembers.findFirst).toHaveBeenCalledTimes(1);
  });
});
