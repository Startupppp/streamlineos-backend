import { ForbiddenException } from "@nestjs/common";
import {
  canTransferModuleOwnership,
  resolveModuleManagementStanding,
} from "../module-standing";
import {
  assertOwnerOnly,
  OWNER_ONLY_OPERATIONS,
} from "../../../common/rbac/owner-only-operations";
import { isStructuralOrgAdminContext } from "../../../common/rbac/is-structural-org-admin";
import { ROLE_DEFAULT_PERMISSIONS } from "../../rbac/permissions/role-defaults";
import { ROLE_TEMPLATES } from "../../rbac/role-templates.constants";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { agentTokenPrincipal, humanSessionPrincipal } from "../../../common/auth/principal";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";

const ORG = "org-matrix";
const MODULE = "hr";
const OTHER_MODULE = "crm";

type DbOptions = {
  orgMember?: { isOwner: boolean; role: string } | null;
  ownerUserId?: string | null;
  ownerModule?: string;
  moduleAdmin?: boolean;
};

function makeDb(opts: DbOptions): Db {
  const dialect = new PgDialect();
  const ownedModule = opts.ownerModule ?? MODULE;
  const ownerRows = opts.ownerUserId ? [{ userId: opts.ownerUserId }] : [];
  const adminRows = opts.moduleAdmin ? [{ rank: 20, moduleKey: ownedModule }] : [];
  let cursor = 0;

  const chain = () => {
    const link: Record<string, unknown> = {};
    let asked: string[] = [];
    for (const m of ["from", "innerJoin"]) link[m] = () => link;
    link["where"] = (condition: SQL) => {
      asked = dialect
        .sqlToQuery(condition)
        .params.filter((p): p is string => typeof p === "string");
      return link;
    };
    link["limit"] = () => {
      const rows = cursor === 0 ? ownerRows : adminRows;
      cursor += 1;
      return Promise.resolve(asked.includes(ownedModule) ? rows : []);
    };
    return link;
  };

  const findFirst = jest.fn(async (args: { columns?: Record<string, boolean> }) => {
    if (args.columns && "role" in args.columns) return opts.orgMember ?? null;
    return null;
  });

  return {
    query: { organizationMembers: { findFirst } },
    select: jest.fn(() => chain()),
  } as unknown as Db;
}

function makeActor(userId: string, isOrgOwner: boolean, role = "MEMBER"): CurrentUserContext {
  return {
    orgId: ORG,
    userId,
    role,
    isOrgOwner,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, isOrgOwner),
  };
}

describe("canTransferModuleOwnership — authority matrix", () => {
  it("allows org owner", async () => {
    expect(
      await canTransferModuleOwnership(makeDb({}), makeActor("u-owner", true), MODULE),
    ).toBe(true);
  });

  it("allows org admin", async () => {
    expect(
      await canTransferModuleOwnership(
        makeDb({ orgMember: { isOwner: false, role: ORG_MEMBER_ROLES.ORG_ADMIN } }),
        makeActor("u-admin", false, ORG_MEMBER_ROLES.ORG_ADMIN),
        MODULE,
      ),
    ).toBe(true);
  });

  it("allows the module owner of THAT module", async () => {
    expect(
      await canTransferModuleOwnership(
        makeDb({ ownerUserId: "u-mod-owner" }),
        makeActor("u-mod-owner", false),
        MODULE,
      ),
    ).toBe(true);
  });

  it("refuses the module owner of a DIFFERENT module", async () => {
    expect(
      await canTransferModuleOwnership(
        makeDb({ ownerUserId: "u-mod-owner" }),
        makeActor("u-mod-owner", false),
        OTHER_MODULE,
      ),
    ).toBe(false);
  });

  it("refuses a module admin", async () => {
    expect(
      await canTransferModuleOwnership(
        makeDb({ ownerUserId: "u-mod-owner", moduleAdmin: true }),
        makeActor("u-mod-admin", false),
        MODULE,
      ),
    ).toBe(false);
  });

  it("refuses a plain member", async () => {
    expect(
      await canTransferModuleOwnership(
        makeDb({ ownerUserId: "u-mod-owner" }),
        makeActor("u-plain", false),
        MODULE,
      ),
    ).toBe(false);
  });

  it("refuses when no module owner is recorded", async () => {
    expect(
      await canTransferModuleOwnership(
        makeDb({ ownerUserId: null }),
        makeActor("u-plain", false),
        MODULE,
      ),
    ).toBe(false);
  });
});

describe("STANDING — PRD authority matrix for canManageAccess and canTransferOwnership", () => {
  it("org owner: canManageAccess=true, canTransferOwnership=true", async () => {
    const s = await resolveModuleManagementStanding(makeDb({}), makeActor("u", true), MODULE);
    expect(s?.source).toBe("org-owner");
    expect(s?.canManageAccess).toBe(true);
    expect(s?.canTransferOwnership).toBe(true);
  });

  it("org admin: canManageAccess=true, canTransferOwnership=true", async () => {
    const s = await resolveModuleManagementStanding(
      makeDb({ orgMember: { isOwner: false, role: ORG_MEMBER_ROLES.ORG_ADMIN } }),
      makeActor("u", false, ORG_MEMBER_ROLES.ORG_ADMIN),
      MODULE,
    );
    expect(s?.source).toBe("org-admin");
    expect(s?.canManageAccess).toBe(true);
    expect(s?.canTransferOwnership).toBe(true);
  });

  it("module owner: canManageAccess=true, canTransferOwnership=true", async () => {
    const s = await resolveModuleManagementStanding(
      makeDb({ orgMember: { isOwner: false, role: "MEMBER" }, ownerUserId: "u-mo" }),
      makeActor("u-mo", false),
      MODULE,
    );
    expect(s?.source).toBe("module-ownership");
    expect(s?.canManageAccess).toBe(true);
    expect(s?.canTransferOwnership).toBe(true);
  });

  it("module admin: canManageAccess=true, canTransferOwnership=false", async () => {
    const s = await resolveModuleManagementStanding(
      makeDb({ orgMember: { isOwner: false, role: "MEMBER" }, ownerUserId: "other", moduleAdmin: true }),
      makeActor("u-ma", false),
      MODULE,
    );
    expect(s?.source).toBe("module-role");
    expect(s?.canManageAccess).toBe(true);
    expect(s?.canTransferOwnership).toBe(false);
  });

  it("plain member: no management standing", async () => {
    const s = await resolveModuleManagementStanding(
      makeDb({ orgMember: { isOwner: false, role: "MEMBER" } }),
      makeActor("u-m", false),
      MODULE,
    );
    expect(s).toBeNull();
  });

  it("non-member: no management standing", async () => {
    const s = await resolveModuleManagementStanding(
      makeDb({ orgMember: null }),
      makeActor("u-none", false),
      MODULE,
    );
    expect(s).toBeNull();
  });
});

describe("assertOwnerOnly — org admin cannot bypass owner-only operations", () => {
  const orgAdminCtx: CurrentUserContext = {
    orgId: ORG,
    userId: "u-admin",
    role: ORG_MEMBER_ROLES.ORG_ADMIN,
    isOrgOwner: false,
    sessionId: "s-admin",
    tokenScopes: null,
    principal: humanSessionPrincipal(2, false),
  };

  const ownedOperations: Array<keyof typeof OWNER_ONLY_OPERATIONS> = [
    "organization.ownership.transfer",
    "organization.archive",
    "organization.delete",
    "organization.ownership.force-set-module-owner",
    "organization.ownership.direct-module-transfer",
  ];

  for (const op of ownedOperations) {
    it(`denies org admin for "${op}"`, () => {
      expect(() => assertOwnerOnly(orgAdminCtx, op)).toThrow(ForbiddenException);
    });
  }
});

describe("Row 1 — transfer org ownership: org owner only", () => {
  const OP = "organization.ownership.transfer" as const;

  it("allows org owner (isOrgOwner=true)", () => {
    expect(() => assertOwnerOnly(makeActor("u-owner", true), OP)).not.toThrow();
  });

  it("denies org admin (role=ORG_ADMIN, isOrgOwner=false)", () => {
    expect(() =>
      assertOwnerOnly(makeActor("u-admin", false, ORG_MEMBER_ROLES.ORG_ADMIN), OP),
    ).toThrow(ForbiddenException);
  });

  it("denies module owner standing (isOrgOwner=false, role=MEMBER)", () => {
    expect(() => assertOwnerOnly(makeActor("u-mod-owner", false), OP)).toThrow(ForbiddenException);
  });

  it("denies plain member", () => {
    expect(() => assertOwnerOnly(makeActor("u-member", false), OP)).toThrow(ForbiddenException);
  });

  it("error carries OWNER_ONLY_OPERATION code and names the operation", () => {
    let err: ForbiddenException | undefined;
    try {
      assertOwnerOnly(makeActor("u-admin", false, ORG_MEMBER_ROLES.ORG_ADMIN), OP);
    } catch (e) {
      if (e instanceof ForbiddenException) err = e;
    }
    expect(err?.getResponse()).toMatchObject({ code: "OWNER_ONLY_OPERATION", operation: OP });
  });
});

describe("Row 2 — archive / delete org: org owner only", () => {
  it.each(["organization.archive", "organization.delete"] as const)(
    "allows org owner for %s",
    (op) => {
      expect(() => assertOwnerOnly(makeActor("u-owner", true), op)).not.toThrow();
    },
  );

  it.each(["organization.archive", "organization.delete"] as const)(
    "denies org admin for %s",
    (op) => {
      expect(() =>
        assertOwnerOnly(makeActor("u-admin", false, ORG_MEMBER_ROLES.ORG_ADMIN), op),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(["organization.archive", "organization.delete"] as const)(
    "denies plain member for %s",
    (op) => {
      expect(() => assertOwnerOnly(makeActor("u-member", false), op)).toThrow(ForbiddenException);
    },
  );
});

describe("Row 3 — manage org membership: owner and active org admin; member and machine are denied", () => {
  it("allows org owner (isOrgOwner=true)", () => {
    expect(isStructuralOrgAdminContext(makeActor("u-owner", true))).toBe(true);
  });

  it("allows active org admin (role=ORG_ADMIN, isOrgOwner=false, human principal)", () => {
    expect(
      isStructuralOrgAdminContext(makeActor("u-admin", false, ORG_MEMBER_ROLES.ORG_ADMIN)),
    ).toBe(true);
  });

  it("denies plain member (role=MEMBER, isOrgOwner=false)", () => {
    expect(isStructuralOrgAdminContext(makeActor("u-member", false))).toBe(false);
  });

  it("denies module owner standing — module ownership never implies org-admin authority", () => {
    expect(isStructuralOrgAdminContext(makeActor("u-mod-owner", false, "MEMBER"))).toBe(false);
  });

  it("denies agent-token principal even when role=ORG_ADMIN — machines never hold structural org standing", () => {
    const agentCtx: CurrentUserContext = {
      orgId: ORG,
      userId: "u-agent",
      role: ORG_MEMBER_ROLES.ORG_ADMIN,
      isOrgOwner: false,
      sessionId: "s-agent",
      tokenScopes: null,
      principal: agentTokenPrincipal(99, 7, []),
    };
    expect(isStructuralOrgAdminContext(agentCtx)).toBe(false);
  });
});

describe("Row 4 — enable modules: settings:manage held by owner/admin only, absent from every module role template", () => {
  const SETTINGS_MANAGE = "settings:manage";

  it("OWNER role default includes settings:manage", () => {
    expect(ROLE_DEFAULT_PERMISSIONS["OWNER"]).toContain(SETTINGS_MANAGE);
  });

  it("ORG_ADMIN role default includes settings:manage", () => {
    expect(ROLE_DEFAULT_PERMISSIONS["ORG_ADMIN"]).toContain(SETTINGS_MANAGE);
  });

  it("MEMBER role default does not include settings:manage", () => {
    expect(ROLE_DEFAULT_PERMISSIONS["MEMBER"]).not.toContain(SETTINGS_MANAGE);
  });

  it("no module role template grants settings:manage", () => {
    for (const template of ROLE_TEMPLATES) {
      expect({
        templateId: template.id,
        hasSettingsManage: (template.permissions as string[]).includes(SETTINGS_MANAGE),
      }).toEqual({ templateId: template.id, hasSettingsManage: false });
    }
  });
});
