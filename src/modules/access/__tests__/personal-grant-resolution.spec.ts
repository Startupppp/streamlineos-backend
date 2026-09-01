import { AccessPermissionResolver } from "../access-permission.resolver";
import type { Db } from "../../../db/drizzle.module";

const GRANT_KEY = "hr:employees:view";
const ORG = "org-1";
const USER = "u-1";

type Options = {
  personalGrants?: { permissionKey: string; scope: string }[];
  roleIds?: { roleId: number }[];
  roleGrants?: { roleId: number; permissionKey: string; scope: string }[];
  memberRole?: string;
};

function buildResolver(options: Options) {
  const queue: unknown[][] = [
    options.roleIds ?? [],
    [],
    [],
    options.personalGrants ?? [],
    ...(options.roleIds && options.roleIds.length > 0
      ? [
          [{ id: options.roleIds[0]?.roleId ?? 1, slug: "HR_MODULE_MEMBER" }],
          options.roleGrants ?? [],
        ]
      : []),
    [],
  ];
  let cursor = 0;

  const chain = () => {
    const link: Record<string, unknown> = {};
    link["from"] = () => link;
    link["innerJoin"] = () => link;
    link["where"] = () => link;
    link["limit"] = () => Promise.resolve(queue[cursor++] ?? []);
    return link;
  };

  const db = {
    query: {
      organizationMembers: {
        findFirst: () =>
          Promise.resolve({
            isOwner: false,
            status: "ACTIVE",
            id: 42,
            role: options.memberRole ?? "MEMBER",
          }),
      },
    },
    select: () => chain(),
  } as unknown as Db;

  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
  );
}

describe("per-person grants fold into the resolved permission set", () => {
  it("gives a person with no roles at all the capability granted to them directly", async () => {
    const resolver = buildResolver({
      personalGrants: [{ permissionKey: GRANT_KEY, scope: "all" }],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[GRANT_KEY]).toBe("all");
  });

  it("resolves nothing extra when the person holds no personal grant", async () => {
    const resolver = buildResolver({ personalGrants: [] });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[GRANT_KEY]).toBeUndefined();
  });

  it("honours the scope stored on the grant rather than assuming all", async () => {
    const resolver = buildResolver({
      personalGrants: [{ permissionKey: GRANT_KEY, scope: "own" }],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[GRANT_KEY]).toBe("own");
  });

  it("keeps the broader of a role grant and a personal grant, never narrowing an existing one", async () => {
    const resolver = buildResolver({
      roleIds: [{ roleId: 1 }],
      roleGrants: [{ roleId: 1, permissionKey: GRANT_KEY, scope: "all" }],
      personalGrants: [{ permissionKey: GRANT_KEY, scope: "own" }],
    });
    const resolved = (await resolver.computeUserPermissions(ORG, USER, 1)).perms;
    expect(resolved[GRANT_KEY]).toBe("all");
  });

  it("survives a role change, because the grant hangs off the person and not off any role", async () => {
    const withRole = await buildResolver({
      roleIds: [{ roleId: 1 }],
      roleGrants: [],
      personalGrants: [{ permissionKey: GRANT_KEY, scope: "all" }],
    }).computeUserPermissions(ORG, USER, 1);

    const withoutRole = await buildResolver({
      personalGrants: [{ permissionKey: GRANT_KEY, scope: "all" }],
    }).computeUserPermissions(ORG, USER, 1);

    expect(withRole.perms[GRANT_KEY]).toBe("all");
    expect(withoutRole.perms[GRANT_KEY]).toBe("all");
  });

  it("gives an inactive member nothing, personal grant or not", async () => {
    const db = {
      query: {
        organizationMembers: {
          findFirst: () =>
            Promise.resolve({
              isOwner: false,
              status: "SUSPENDED",
              id: 42,
              role: "MEMBER",
            }),
        },
      },
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as Db;

    const resolver = new AccessPermissionResolver(
      () => db,
      (read) => read() as Promise<never>,
      new Set<string>(),
      new Map(),
      1000,
    );
    expect((await resolver.computeUserPermissions(ORG, USER, 1)).perms).toEqual({});
  });
});
