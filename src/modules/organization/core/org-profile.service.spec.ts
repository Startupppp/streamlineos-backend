import { ConflictException } from "@nestjs/common";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { OrgProfileService } from "./org-profile.service";

function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue(rows);
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

function buildService(input: {
  memberships?: unknown[];
  membership?: { role: string; status: string } | null;
  organizations?: unknown[];
}) {
  const membershipChain = makeSelectChain(input.memberships ?? []);
  const organizationChain = makeSelectChain(input.organizations ?? []);
  const select = jest
    .fn()
    .mockReturnValue(
      input.memberships !== undefined ? membershipChain : organizationChain,
    );
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select,
    update: jest.fn().mockReturnValue({ set: updateSet }),
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(input.membership),
      },
    },
  };
  const db = {
    transaction: jest
      .fn()
      .mockImplementation(
        async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
      ),
  };
  const audit = { log: jest.fn() };
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const indexService = {
    listForUser: jest.fn().mockResolvedValue([]),
    refreshForUser: jest.fn().mockResolvedValue(undefined),
    rebuild: jest.fn(),
  };
  const saga = {
    begin: jest.fn(),
    runStep: jest.fn(),
    complete: jest.fn(),
    compensate: jest.fn(),
    reserve: jest.fn(),
    release: jest.fn(),
  };
  const service = new OrgProfileService(
    db as never,
    audit as never,
    cache as never,
    indexService as never,
    saga as never,
  );

  return { service, db, tx, audit, cache, updateSet, indexService, saga };
}

describe("OrgProfileService identity-scoped organization recovery", () => {
  it("lists active organizations inside an identity transaction", async () => {
    const joinedAt = new Date("2026-01-01T00:00:00.000Z");
    const { service, db, tx } = buildService({
      memberships: [
        {
          id: "org-2",
          name: "Second workspace",
          slug: "second-workspace",
          role: "ADMIN",
          joinedAt,
        },
      ],
    });

    await expect(service.listUserOrganizations("user-1")).resolves.toEqual([
      {
        id: "org-2",
        name: "Second workspace",
        slug: "second-workspace",
        role: "ADMIN",
        joinedAt,
      },
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("switches to an active sibling organization in the same identity transaction", async () => {
    const { service, db, tx, audit, cache, updateSet } = buildService({
      membership: { role: "ADMIN", status: "ACTIVE" },
      organizations: [
        {
          id: "org-2",
          name: "Second workspace",
          slug: "second-workspace",
          status: "ACTIVE",
          deletedAt: null,
        },
      ],
    });

    await expect(service.switchOrg("user-1", "org-2")).resolves.toEqual({
      orgId: "org-2",
      name: "Second workspace",
      slug: "second-workspace",
      role: "ADMIN",
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ lastActiveOrgId: "org-2" });
    expect(cache.invalidate).toHaveBeenCalledWith(
      CACHE_KEYS.userSession("user-1"),
    );
    expect(audit.log).toHaveBeenCalledWith({
      action: "org.switched",
      userId: "user-1",
      orgId: "org-2",
    });
  });

  it("does not switch to a suspended organization", async () => {
    const { service, tx, cache } = buildService({
      membership: { role: "ADMIN", status: "SUSPENDED" },
    });

    await expect(service.switchOrg("user-1", "org-2")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.update).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
});
