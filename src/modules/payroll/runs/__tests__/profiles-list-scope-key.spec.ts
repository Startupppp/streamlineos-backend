import { ProfilesController } from "../profiles.controller";
import type { ProfilesService } from "../profiles.service";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

describe("GET /payroll/employees resolves its read scope from payroll:salaries:view", () => {
  const actor = {
    orgId: "org-1",
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", isOrgOwner: false },
  } as unknown as CurrentUserContext;

  it("asks AccessService for the key the route is gated on, not payroll:runs:view", async () => {
    const scopeFor = jest.fn().mockResolvedValue("all");
    const listProfiles = jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const controller = new ProfilesController(
      { listProfiles } as unknown as ProfilesService,
      { scopeFor } as unknown as AccessService,
    );

    await controller.list({ limit: 20 }, actor);

    expect(scopeFor).toHaveBeenCalledWith(actor, "payroll:salaries:view");
    expect(scopeFor).not.toHaveBeenCalledWith(actor, "payroll:runs:view");
    const read = listProfiles.mock.calls[0]?.[0];
    expect(read.denied).toBe(false);
  });

  it("denies the read when the caller holds neither the key nor ownership", async () => {
    const scopeFor = jest.fn().mockResolvedValue("none");
    const listProfiles = jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const controller = new ProfilesController(
      { listProfiles } as unknown as ProfilesService,
      { scopeFor } as unknown as AccessService,
    );

    await controller.list({ limit: 20 }, actor);

    expect(listProfiles.mock.calls[0]?.[0].denied).toBe(true);
  });
});
