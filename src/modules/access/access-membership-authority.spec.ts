import {
  makeMembershipStateStub,
  stateFromRow,
} from "../../../test/helpers/membership-state-stub";
import type { CacheService } from "../../common/cache/cache.service";
import type { Db } from "../../db/drizzle.module";
import { makeMfaPolicyStub } from "../../../test/helpers/mfa-policy-stub";
import type { EntitlementsService } from "./entitlements.service";
import { AccessService } from "./access.service";
import { AccessVersionCache } from "./access-version-cache";

function buildService(membership: {
  isOwner: boolean;
  role: string;
  status: string;
}): AccessService {
  const db = {
    query: {
      accessVersions: {
        findFirst: jest.fn().mockResolvedValue({ permissionsVersion: 1 }),
      },
    },
    execute: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );

  const cache = {
    cached: jest.fn(),
    invalidate: jest.fn(),
  };
  const entitlements = {
    isModuleEnabled: jest.fn().mockResolvedValue(true),
    isCoreModule: jest.fn().mockReturnValue(false),
    getModuleMap: jest.fn().mockResolvedValue({}),
    getEffectiveModuleMap: jest.fn().mockResolvedValue({}),
  };

  return new AccessService(
    db as unknown as Db,
    cache as unknown as CacheService,
    entitlements as unknown as EntitlementsService,
    makeMfaPolicyStub(),
    new AccessVersionCache(db as unknown as Db, cache as unknown as CacheService),
    makeMembershipStateStub(stateFromRow({ ...membership, id: 1 })),
  );
}

describe("AccessService.canManageOrganizationMembership", () => {
  it.each([
    [{ isOwner: true, role: "MEMBER", status: "ACTIVE" }, true],
    [{ isOwner: false, role: "ORG_ADMIN", status: "ACTIVE" }, true],
    [{ isOwner: false, role: "MEMBER", status: "ACTIVE" }, false],
    [{ isOwner: false, role: "ORG_ADMIN", status: "SUSPENDED" }, false],
  ] as const)(
    "derives authority from the active structural membership %#",
    async (membership, expected) => {
      await expect(
        buildService(membership).canManageOrganizationMembership(
          "org-1",
          "user-1",
        ),
      ).resolves.toBe(expected);
    },
  );
});
