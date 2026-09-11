import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { AccessPermissionResolver } from "../access-permission.resolver";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";
import { isOrgOnlyPermission } from "../../../common/rbac/grantability";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
} from "../../rbac/permissions";
import type { Db } from "../../../db/drizzle.module";

const ORG_ONLY_KEY = "chat:org-settings:manage";
const BILLING_KEY = "billing:invoices:view";
const NORMAL_KEY = "hr:employees:view";
const ORG = "org-1";
const USER = "u-1";

type Options = {
  personalGrants?: { permissionKey: string; scope: string }[];
  roleGrants?: { roleId: number; permissionKey: string; scope: string }[];
  delegated?: { permissionKey: string; startsAt: Date; endsAt: Date }[];
  isOwner?: boolean;
  memberRole?: string;
};

function buildResolver(options: Options) {
  const hasRole = (options.roleGrants ?? []).length > 0;
  const queue: unknown[][] = [
    hasRole ? [{ roleId: 1 }] : [],
    [],
    [],
    options.personalGrants ?? [],
    ...(hasRole
      ? [[{ id: 1, slug: "HOME_MODULE_ADMIN" }], options.roleGrants ?? []]
      : []),
    options.delegated ?? [],
  ];
  let cursor = 0;

  const chain = () => {
    const link: Record<string, unknown> = {};
    link["from"] = () => link;
    link["innerJoin"] = () => link;
    link["where"] = () => link;
    link["orderBy"] = () => link;
    link["limit"] = () => Promise.resolve(queue[cursor++] ?? []);
    return link;
  };

  const db = {
    query: {
    },
    select: () => chain(),
  } as unknown as Db;

  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
    memberRowReader({ isOwner: options.isOwner ?? false, status: "ACTIVE", id: 42, role: options.memberRole ?? "MEMBER", }),
  );
}

describe("an org-only key never resolves from a grant table", () => {
  it("drops it when a role grant carries it, which is how migration 0437 seated it", async () => {
    const resolver = buildResolver({
      roleGrants: [
        { roleId: 1, permissionKey: ORG_ONLY_KEY, scope: "all" },
        { roleId: 1, permissionKey: NORMAL_KEY, scope: "all" },
      ],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;

    expect(resolved[ORG_ONLY_KEY]).toBeUndefined();
    expect(resolved[NORMAL_KEY]).toBe("all");
  });

  it("drops it when a per-person grant carries it", async () => {
    const resolver = buildResolver({
      personalGrants: [{ permissionKey: ORG_ONLY_KEY, scope: "all" }],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[ORG_ONLY_KEY]).toBeUndefined();
  });

  it("drops it when a delegation carries it", async () => {
    const resolver = buildResolver({
      delegated: [
        {
          permissionKey: ORG_ONLY_KEY,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 60_000),
        },
      ],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[ORG_ONLY_KEY]).toBeUndefined();
  });

  it("drops the whole billing namespace, not just the one enumerated key", async () => {
    const resolver = buildResolver({
      personalGrants: [{ permissionKey: BILLING_KEY, scope: "all" }],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[BILLING_KEY]).toBeUndefined();
  });

  it("still gives the org owner the key, who holds the catalog structurally", async () => {
    const resolver = buildResolver({ isOwner: true });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[ORG_ONLY_KEY]).toBe("all");
  });

  it("still gives an org admin the key", async () => {
    const resolver = buildResolver({ memberRole: "ORG_ADMIN" });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[ORG_ONLY_KEY]).toBe("all");
  });
});

describe("no code-level default seats an org-only key", () => {
  it("keeps them out of the universal and self-service grants, which bypass the grant filter", () => {
    const offenders = [
      ...UNIVERSAL_MEMBER_PERMISSION_GRANTS,
      ...EMPLOYEE_SELF_SERVICE_GRANTS,
    ]
      .map((grant) => grant.permissionKey)
      .filter(isOrgOnlyPermission);
    expect(offenders).toEqual([]);
  });

  it("keeps them out of every role default template below org level", () => {
    const structural = new Set(["OWNER", "ORG_ADMIN"]);
    const offenders = Object.entries(ROLE_DEFAULT_PERMISSIONS)
      .filter(([slug]) => !structural.has(slug))
      .flatMap(([slug, keys]) =>
        keys.filter(isOrgOnlyPermission).map((key) => `${slug}:${key}`),
      );
    expect(offenders).toEqual([]);
  });
});
