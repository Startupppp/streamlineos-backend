import { OrgProfileService } from "./org-profile.service";

const USER_ID = "user-just-joined";
const JOINED_AT = new Date("2026-09-12T09:00:00.000Z");

const AUTHORITATIVE_ROW = {
  id: "org-p11",
  name: "Acme",
  slug: "acme",
  role: "MEMBER",
  joinedAt: JOINED_AT,
};

/**
 * The recovery half of P11: `touchIndexLastActivated` is a projection, so the
 * question a failed projection raises is whether the accepted member can still
 * reach the organization on a fresh login. `listUserOrganizations` answers from
 * `organization_members` whenever the projection holds nothing for the account.
 */
function buildProfileService(projectedRows: unknown[]) {
  const listForUser = jest.fn().mockResolvedValue(projectedRows);
  const refreshForUser = jest.fn().mockResolvedValue(undefined);

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([AUTHORITATIVE_ROW]),
  };

  const db = {
    transaction: jest
      .fn()
      .mockImplementation((fn: (handle: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const indexService = { listForUser, refreshForUser };

  const service = new OrgProfileService(
    db as never,
    {} as never,
    {} as never,
    indexService as never,
    {} as never,
  );

  return { service, listForUser, refreshForUser, limit: tx.limit };
}

describe("OrgProfileService.listUserOrganizations — after a failed acceptance projection", () => {
  it("lists the newly joined organization from organization_members", async () => {
    const { service } = buildProfileService([]);

    const organizations = await service.listUserOrganizations(USER_ID);

    expect(organizations).toEqual([AUTHORITATIVE_ROW]);
  });

  it("rebuilds the projection so the next login reads it from the index", async () => {
    const { service, refreshForUser } = buildProfileService([]);

    await service.listUserOrganizations(USER_ID);

    expect(refreshForUser).toHaveBeenCalledWith(USER_ID);
  });

  it("serves the projection without the authoritative read once it holds a row", async () => {
    const { service, limit } = buildProfileService([AUTHORITATIVE_ROW]);

    const organizations = await service.listUserOrganizations(USER_ID);

    expect(organizations).toEqual([AUTHORITATIVE_ROW]);
    expect(limit).not.toHaveBeenCalled();
  });
});
