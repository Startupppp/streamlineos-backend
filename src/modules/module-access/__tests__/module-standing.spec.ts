import {
  canTransferModuleOwnership,
  resolveModuleStanding,
  type ModuleStanding,
  type ModuleStandingLevel,
} from "../module-standing";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-1";
const MODULE = "hr";

type Options = {
  orgMember?: { isOwner: boolean; role: string } | null;
  ownerUserId?: string | null;
  moduleAdmin?: boolean;
  activeMembership?: boolean;
};

function createDb(options: Options): Db {
  const ownerRows = options.ownerUserId ? [{ userId: options.ownerUserId }] : [];
  const adminRows = options.moduleAdmin
    ? [{ rank: 20, moduleKey: MODULE }]
    : [];
  const queue = [ownerRows, adminRows];
  let cursor = 0;

  const chain = () => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where"]) link[method] = () => link;
    link["limit"] = () => Promise.resolve(queue[cursor++] ?? []);
    return link;
  };

  const findFirst = jest.fn(async (args: { columns?: Record<string, boolean> }) => {
    if (args.columns && "role" in args.columns) return options.orgMember ?? null;
    return options.activeMembership ? { id: 1 } : null;
  });

  return {
    query: { organizationMembers: { findFirst } },
    select: jest.fn(() => chain()),
  } as unknown as Db;
}

function actor(isOrgOwner = false): CurrentUserContext {
  return { orgId: ORG, userId: "user-1", isOrgOwner } as CurrentUserContext;
}

const LEVELS: ModuleStandingLevel[] = ["owner", "admin", "member", "none"];

function describeStanding(standing: ModuleStanding): string {
  switch (standing.level) {
    case "owner":
      return "owner";
    case "admin":
      return "admin";
    case "member":
      return "member";
    case "none":
      return "none";
  }
}

describe("resolveModuleStanding", () => {
  it("answers one question with one of exactly four standings", async () => {
    const standing = await resolveModuleStanding(
      createDb({ activeMembership: true }),
      actor(),
      MODULE,
    );
    expect(LEVELS).toContain(standing.level);
    expect(describeStanding(standing)).toBe("member");
  });

  it("resolves the organisation owner as owner everywhere", async () => {
    const standing = await resolveModuleStanding(createDb({}), actor(true), MODULE);
    expect(standing.level).toBe("owner");
    expect(standing.source).toBe("org-owner");
    expect(standing.canManageAccess).toBe(true);
  });

  it("resolves an organisation admin as having module-management authority everywhere", async () => {
    const standing = await resolveModuleStanding(
      createDb({ orgMember: { isOwner: false, role: "ORG_ADMIN" } }),
      actor(),
      MODULE,
    );
    expect(standing.level).toBe("admin");
    expect(standing.source).toBe("org-admin");
    expect(standing.canManageAccess).toBe(true);
  });

  it("resolves the module owner from the ownership record", async () => {
    const standing = await resolveModuleStanding(
      createDb({
        orgMember: { isOwner: false, role: "MEMBER" },
        ownerUserId: "user-1",
      }),
      actor(),
      MODULE,
    );
    expect(standing.source).toBe("module-ownership");
    expect(standing.canTransferOwnership).toBe(true);
  });

  it("resolves a module admin from a ranked role assignment", async () => {
    const standing = await resolveModuleStanding(
      createDb({
        orgMember: { isOwner: false, role: "MEMBER" },
        ownerUserId: "someone-else",
        moduleAdmin: true,
      }),
      actor(),
      MODULE,
    );
    expect(standing.level).toBe("admin");
    expect(standing.source).toBe("module-role");
  });

  it("separates a member of the organisation from a stranger to it", async () => {
    const member = await resolveModuleStanding(
      createDb({ orgMember: { isOwner: false, role: "MEMBER" }, activeMembership: true }),
      actor(),
      MODULE,
    );
    expect(member.level).toBe("member");

    const stranger = await resolveModuleStanding(
      createDb({ orgMember: null, activeMembership: false }),
      actor(),
      MODULE,
    );
    expect(stranger.level).toBe("none");
  });

  it("keeps ownership transfer away from every admin standing", async () => {
    const orgAdmin = await resolveModuleStanding(
      createDb({ orgMember: { isOwner: false, role: "ORG_ADMIN" } }),
      actor(),
      MODULE,
    );
    expect(orgAdmin.canManageAccess).toBe(true);
    expect(orgAdmin.canTransferOwnership).toBe(false);

    const moduleAdmin = await resolveModuleStanding(
      createDb({
        orgMember: { isOwner: false, role: "MEMBER" },
        ownerUserId: "someone-else",
        moduleAdmin: true,
      }),
      actor(),
      MODULE,
    );
    expect(moduleAdmin.canManageAccess).toBe(true);
    expect(moduleAdmin.canTransferOwnership).toBe(false);
  });

  it("is generic on the module key, so a nineteenth module needs no change here", async () => {
    for (const moduleKey of ["hr", "chat", "mail", "a-module-invented-today"]) {
      const standing = await resolveModuleStanding(
        createDb({}),
        actor(true),
        moduleKey,
      );
      expect(standing.level).toBe("owner");
    }
  });
});

describe("canTransferModuleOwnership", () => {
  it("allows the organisation owner as the documented break-glass", async () => {
    expect(await canTransferModuleOwnership(createDb({}), actor(true), MODULE)).toBe(true);
  });

  it("allows the module owner", async () => {
    expect(
      await canTransferModuleOwnership(createDb({ ownerUserId: "user-1" }), actor(), MODULE),
    ).toBe(true);
  });

  it("refuses an organisation admin and a module admin alike", async () => {
    expect(
      await canTransferModuleOwnership(
        createDb({ orgMember: { isOwner: false, role: "ORG_ADMIN" }, ownerUserId: "other" }),
        actor(),
        MODULE,
      ),
    ).toBe(false);
    expect(
      await canTransferModuleOwnership(
        createDb({ ownerUserId: "other", moduleAdmin: true }),
        actor(),
        MODULE,
      ),
    ).toBe(false);
  });

  it("refuses when the module has no owner recorded", async () => {
    expect(
      await canTransferModuleOwnership(createDb({ ownerUserId: null }), actor(), MODULE),
    ).toBe(false);
  });
});
