import { ForbiddenException } from "@nestjs/common";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ROLE_RANK, isDelegablePermission } from "../../../common/rbac/grantability";
import { deleteRole, updateRole } from "../lib/role-mutation";
import type { RoleMutationDeps } from "../lib/role-mutation";
import { materializeTemplate } from "../lib/role-template-seeding";
import type { RoleTemplateSeedingDeps } from "../lib/role-template-seeding";
import { PERMISSIONS } from "../permissions";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db),
  ),
}));
jest.mock("../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/rbac/is-structural-org-admin", () => ({
  isStructuralOrgAdmin: jest.fn(),
}));
jest.mock("../../../common/rbac/resolve-actor-rank", () => ({
  resolveActorRankContext: jest.fn(),
}));

import { isStructuralOrgAdmin } from "../../../common/rbac/is-structural-org-admin";
import { resolveActorRankContext } from "../../../common/rbac/resolve-actor-rank";

const orgAdminCheck = isStructuralOrgAdmin as jest.MockedFunction<
  typeof isStructuralOrgAdmin
>;
const rankContext = resolveActorRankContext as jest.MockedFunction<
  typeof resolveActorRankContext
>;

const ORG = "org-1";

/** A real catalogued key that is delegable, so only the grantability rule can refuse it. */
const CATALOGUED_KEY = PERMISSIONS.map((permission) => permission.name).find(
  (name) => isDelegablePermission(name),
)!;

function actor(isOrgOwner: boolean): CurrentUserContext {
  return {
    orgId: ORG,
    userId: "u-actor",
    role: isOrgOwner ? "OWNER" : "MEMBER",
    isOrgOwner,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, isOrgOwner),
  };
}

function makeDeps(existingRole: Record<string, unknown> | undefined) {
  const chain = {
    set: jest.fn(),
    where: jest.fn().mockResolvedValue(undefined),
    values: jest.fn(),
    returning: jest.fn().mockResolvedValue([{ id: 1 }]),
    from: jest.fn(),
    limit: jest.fn().mockResolvedValue([]),
  };
  chain.set.mockReturnValue(chain);
  chain.values.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);

  const db = {
    query: { roles: { findFirst: jest.fn().mockResolvedValue(existingRole) } },
    update: jest.fn().mockReturnValue(chain),
    delete: jest.fn().mockReturnValue(chain),
    insert: jest.fn().mockReturnValue(chain),
    select: jest.fn().mockReturnValue(chain),
  };

  const mutationDeps = {
    db,
    audit: { log: jest.fn() },
    access: {
      resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, string>()),
    },
  } as unknown as RoleMutationDeps;

  return {
    mutationDeps,
    seedingDeps: { db } as unknown as RoleTemplateSeedingDeps,
  };
}

/**
 * These four refusals are the whole authorization surface of role mutation, and
 * every one of them was uncovered: neutering any of them left all 533 rbac
 * tests green on 2026-09-11, which is how they came to be written when the code
 * moved into lib/role-mutation.ts and lib/role-template-seeding.ts.
 */
describe("role mutation authorization gates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    orgAdminCheck.mockResolvedValue(true);
    rankContext.mockResolvedValue({
      bestRank: ROLE_RANK.FUNCTIONAL,
      allowedModules: null,
    });
  });

  it("updateRole refuses a permission key the actor does not itself hold", async () => {
    const { mutationDeps } = makeDeps({
      id: 7,
      isSystem: false,
      moduleKey: null,
      rank: ROLE_RANK.FUNCTIONAL,
    });

    await expect(
      updateRole(mutationDeps, actor(false), 7, { permissions: [CATALOGUED_KEY] }),
    ).rejects.toThrow(/cannot grant permissions you do not hold/i);
  });

  it("updateRole allows the same key once the actor holds it", async () => {
    const { mutationDeps } = makeDeps({
      id: 7,
      isSystem: false,
      moduleKey: null,
      rank: ROLE_RANK.FUNCTIONAL + 10,
    });
    (
      mutationDeps.access.resolveUserPermissions as unknown as jest.Mock
    ).mockResolvedValue(new Map([[CATALOGUED_KEY, "all"]]));

    await expect(
      updateRole(mutationDeps, actor(false), 7, { permissions: [CATALOGUED_KEY] }),
    ).resolves.toEqual({ success: true });
  });

  it("updateRole refuses any edit to an org-level system role", async () => {
    const { mutationDeps } = makeDeps({
      id: 1,
      isSystem: true,
      moduleKey: null,
      rank: ROLE_RANK.ORG_ADMIN,
    });

    await expect(
      updateRole(mutationDeps, actor(true), 1, { name: "Renamed" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("deleteRole refuses a caller without structural org-admin standing", async () => {
    orgAdminCheck.mockResolvedValue(false);
    const { mutationDeps } = makeDeps({
      id: 7,
      isSystem: false,
      moduleKey: null,
      rank: ROLE_RANK.FUNCTIONAL,
    });

    await expect(deleteRole(mutationDeps, actor(false), 7)).rejects.toThrow(
      /Only org admins may delete roles/i,
    );
    expect(
      mutationDeps.db.query.roles.findFirst as unknown as jest.Mock,
    ).not.toHaveBeenCalled();
  });

  it("materializeTemplate refuses a caller without structural org-admin standing", async () => {
    orgAdminCheck.mockResolvedValue(false);
    const { seedingDeps } = makeDeps(undefined);

    await expect(
      materializeTemplate(seedingDeps, actor(false), "engineering"),
    ).rejects.toThrow(/organization owner or administrator/i);
    expect(
      seedingDeps.db.query.roles.findFirst as unknown as jest.Mock,
    ).not.toHaveBeenCalled();
  });
});
